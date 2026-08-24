/**
 * The turn scheduler — the phase machine that makes a match runnable.
 *
 * Implements the RULINGS.md turn structure against the confirmed rulings:
 *   - fresh battle each round: HP resets, round-scoped statuses clear, cooldowns reset
 *     (HP_CARRYOVER, PERMANENT_SCOPE)
 *   - shared per-team energy pool (ENERGY_POOL_SCOPE); GENERIC payable by any energy,
 *     SPECIFIC by the skill's current element
 *   - durations tick at the applier's turn-end (DURATION_ANCHOR)
 *   - a team loses the round when all its heroes are dead; match is best-of-N
 *     (WIN_CONDITION)
 *
 * Turns alternate between teams; `state.turn` is the monotonic per-turn counter the
 * duration logic already keys on. ENERGY_INCOME's base rate is provisional (ruling
 * still open) and lives behind one constant.
 */
import type { EnergyPool, MatchState, TeamId, Unit } from "./types.ts";
import type { SkillInstance } from "./skill.ts";
import type { Value } from "./effects/ast.ts";
import { emit, evalConditionReadOnly, evalSkillCondition, evalTargetPredicate, evalValueReadOnly, resolveDeclaration, runEffects } from "./effects/interpret.ts";
import { applyDamage, applyHeal, outgoingDtypeOverride, tickShieldsForTeam } from "./damage.ts";
import { Rng } from "./rng.ts";
import { applyStatus, clearRoundStatuses, removeStatus, tickDurationsForTeam } from "./status.ts";
import { isConcealed } from "./visibility.ts";

/** Provisional base income (ENERGY_INCOME, ruling open): +1 generic per living hero. */
const GENERIC_PER_LIVING_HERO = 1;

function team(state: MatchState, id: TeamId) {
  return state.teams[id];
}
function otherTeam(id: TeamId): TeamId {
  return id === "A" ? "B" : "A";
}
function unitsOf(state: MatchState, id: TeamId): Unit[] {
  return team(state, id).units.map((u) => state.units[u]).filter((u): u is Unit => !!u);
}
function livingHeroes(state: MatchState, id: TeamId): Unit[] {
  return unitsOf(state, id).filter((u) => u.kind === "hero" && u.alive);
}

/** Remove minions matching a predicate from the field (delete unit + team slot). */
function removeMinionsWhere(state: MatchState, pred: (u: Unit) => boolean): void {
  for (const tid of ["A", "B"] as TeamId[]) {
    const team = state.teams[tid];
    const kept: string[] = [];
    for (const id of team.units) {
      const u = state.units[id];
      if (u && u.kind === "minion" && pred(u)) {
        delete state.units[id];
        continue;
      }
      kept.push(id);
    }
    team.units = kept;
  }
}

/** Sweep dead minions off the field (they free a cap slot; dead heroes stay for the win check). */
export function removeDeadMinions(state: MatchState): void {
  removeMinionsWhere(state, (u) => !u.alive);
}

// --------------------------------------------------------------------------- //
//  Round lifecycle
// --------------------------------------------------------------------------- //

/** Start a fresh-battle round: reset HP, clear statuses + shields, reset cooldowns. */
export function startRound(state: MatchState, firstTeam: TeamId = "A"): void {
  state.round += 1;
  clearRoundStatuses(state);
  state.scheduled = []; // scheduled effects are round-scoped (like statuses/dynamic triggers): they target
  // this round's HP/stacks/statuses, so an unfired one must not carry into the next fresh battle.
  for (const u of Object.values(state.units)) {
    u.hp = u.maxHp;
    u.shields = [];
    u.alive = true;
    u.lastSkillId = undefined; // the "used a skill last" ledger is per-round (units persist across rounds)
    for (const s of u.skills ?? []) s.currentCd = 0;
    // Dynamic "watch window" triggers are round-scoped (like statuses); static ones persist.
    if (u.triggers) u.triggers = u.triggers.filter((t) => t.duration === undefined);
  }
  // Minions are re-created per round by their summoners' start-of-round passives;
  // for now leave the field as-is (summon passives are a later increment).
  // Fresh battle: clear last round's minions; round-start passives re-summon them.
  removeMinionsWhere(state, () => true);
  state.activeTeam = firstTeam;
  state.log.push(`round ${state.round} start`);
  emit(state, { type: "roundStart" });
}

/** A team has lost the round when it has no living heroes. Returns the winner, or null. */
export function roundWinner(state: MatchState): TeamId | null {
  const aDead = livingHeroes(state, "A").length === 0;
  const bDead = livingHeroes(state, "B").length === 0;
  if (aDead && bDead) return state.activeTeam; // simultaneous wipe → active team takes it
  if (aDead) return "B";
  if (bDead) return "A";
  return null;
}

/** Award the round; return the match winner if best-of-N is decided, else null. */
export function endRound(state: MatchState, winner: TeamId, roundsToWin: number): TeamId | null {
  team(state, winner).roundsWon += 1;
  state.log.push(`round ${state.round} won by ${winner} (${team(state, winner).roundsWon}/${roundsToWin})`);
  return team(state, winner).roundsWon >= roundsToWin ? winner : null;
}

// --------------------------------------------------------------------------- //
//  Turn lifecycle
// --------------------------------------------------------------------------- //

/** The middle formation slot (0..2). Its hero permanently generates elemental income (see grantIncome). */
export const MIDDLE_SLOT = 1;

/** A hero has Elemental Essence income this turn if it holds a charge OR sits in the middle slot (a
 *  permanent source), and isn't Silenced. The middle-slot rule needs no charge and consumes none. */
export function hasEssenceIncome(hero: Unit): boolean {
  if (hero.statuses.some((s) => s.kind === "silence")) return false;
  return hero.slot === MIDDLE_SLOT || hero.statuses.some((s) => s.kind === "elemental_essence");
}

/**
 * Grant energy income to a team (ENERGY_INCOME, CONFIRMED). Each living hero yields 1
 * energy: normally 1 GENERIC, but Elemental Essence yields 1 of the hero's CURRENT element
 * INSTEAD (not in addition). Essence comes from a one-shot charge (CONSUMED on use) or from
 * sitting in the MIDDLE slot (permanent, consumes nothing). Silence yields generic and keeps
 * any charge. Minions generate nothing.
 */
export function grantIncome(state: MatchState, id: TeamId): void {
  const pool = team(state, id).energy;
  for (const hero of livingHeroes(state, id)) {
    // A hero under income_suppressed (hector:brimstone Dennisyphus "no longer generates an Energy each turn")
    // yields nothing — not even the fallback Generic.
    if (hero.statuses.some((s) => s.kind === "income_suppressed")) continue;
    if (hasEssenceIncome(hero)) {
      pool[hero.currentElement] = (pool[hero.currentElement] ?? 0) + 1;
      // Consume exactly ONE charge (essence is countable): N banked charges convert over N turns. A no-op
      // for the middle-slot source (no elemental_essence status present).
      const idx = hero.statuses.findIndex((s) => s.kind === "elemental_essence");
      if (idx >= 0) hero.statuses.splice(idx, 1);
      emit(state, { type: "energyFromEssence", unit: hero.id, element: hero.currentElement });
    } else {
      pool.generic = (pool.generic ?? 0) + GENERIC_PER_LIVING_HERO;
    }
  }
}

/** Advance the active team's cooldowns (gated per-unit by Paralysis). */
/**
 * Tick a team's skill cooldowns down by one, at the END of that team's turn. A skill used THIS turn is
 * skipped (its `cdSetTurn` equals the current turn) — the same "don't tick on the birth turn" rule the
 * status-duration ticker uses (appliedTurn < state.turn). Without that skip, a cooldown-1 skill would be
 * back to 0 by its owner's very next turn (cooldown N would block only N−1 turns); with it, cooldown N
 * blocks the caster's next N turns. Paralysis freezes cooldowns entirely.
 */
export function advanceCooldowns(state: MatchState, id: TeamId): void {
  for (const u of unitsOf(state, id)) {
    if (u.statuses.some((s) => s.kind === "paralysis")) continue;
    for (const s of u.skills ?? []) if (s.currentCd > 0 && s.cdSetTurn !== state.turn) s.currentCd -= 1;
  }
}

function isChannel(skill: SkillInstance): boolean {
  return skill.tags.includes("Channel");
}

/**
 * Re-run active channels for a team at its turn start. A channel is CANCELLED if its
 * user is Stunned (glossary); otherwise it re-runs the skill's effects against its
 * stored targets and counts down its remaining turns (null = indefinite).
 */
export function runChannels(state: MatchState, id: TeamId): void {
  for (const u of unitsOf(state, id)) {
    if (!u.alive) continue;
    for (const s of u.statuses.filter((x) => x.kind === "channeling")) {
      const skill = (u.skills ?? []).find((k) => k.id === s.name);
      if (!skill || isStunnedFor(u, skill)) {
        removeStatus(u, "channeling", s.name); // interrupted
        emit(state, { type: "statusExpired", unit: u.id, kind: "channeling", name: s.name }); // channel ended (interrupt)
        continue;
      }
      const targets = (s.channelTargets ?? []).map((t) => state.units[t]).filter((t): t is Unit => !!t && t.alive);
      runEffects(state, skill.effects, { caster: u, self: u, targets, skillId: skill.id, bypassing: skillBypasses(state, u, skill) });
      if (s.magnitude !== undefined) {
        s.magnitude -= 1;
        // Remove only THIS expiring copy (by identity), not every same-named channel — so the other
        // copies of a finite multi-copy channel keep ticking until their own turns run out.
        if (s.magnitude <= 0) {
          u.statuses = u.statuses.filter((x) => x !== s);
          emit(state, { type: "statusExpired", unit: u.id, kind: "channeling", name: s.name }); // channel ended (ran out)
        }
      }
    }
  }
}

/** Begin the active team's turn: income, cooldowns, channels, then turn-start triggers. */
export function startTurn(state: MatchState): void {
  state.actedThisTurn = []; // fresh ledger of who acts this turn (drives "acts alone")
  grantIncome(state, state.activeTeam);
  runChannels(state, state.activeTeam);
  emit(state, { type: "turnStart", team: state.activeTeam });
}

/**
 * Damage-over-time tick: every `dot` this team applied deals its magnitude to the
 * bearer. Uses the same predicate as duration decrement (not on the birth turn), so a
 * duration-N dot deals exactly N ticks over the applier's next N turns.
 */
export function tickDots(state: MatchState, id: TeamId): void {
  for (const u of Object.values(state.units)) {
    if (!u.alive) continue;
    for (const s of u.statuses) {
      if (s.kind !== "dot" && s.kind !== "regen") continue;
      const owner = state.units[s.appliedBy];
      const byThisTeam = owner ? owner.team === id : false;
      // A permanent (duration:null) dot/regen ticks EVERY turn — "deals 5 affliction permanently" / "heals 5
      // each turn" mean a non-expiring per-turn effect, not a no-op. (Finite dots are unaffected: their
      // duration is non-null and counts down elsewhere.) `appliedTurn < state.turn` still skips the apply turn.
      if (!(byThisTeam && s.appliedTurn < state.turn)) continue;
      if (s.kind === "regen") {
        applyHeal(u, s.magnitude ?? 0);
        continue;
      }
      const wasAlive = u.alive;
      // A gated outgoing dtype override (e.g. Stinking Marsh, live on the applier's raw-stack state) converts
      // this DoT's damage type too — DoT ticks don't pass through the damage op, so apply it here.
      const dtype = (owner ? outgoingDtypeOverride(owner) : undefined) ?? s.dtype ?? "affliction";
      const r = applyDamage(u, { amount: s.magnitude ?? 0, type: dtype, sourceId: s.name });
      emit(state, { type: "damageDealt", source: s.appliedBy, target: u.id, amount: r.hpLost, dtype, sourceId: s.name });
      if (wasAlive && r.lethal) emit(state, { type: "unitDied", unit: u.id, killer: s.appliedBy });
    }
  }
}

/** Fire deferred effects whose delay has elapsed (anchored to the caster's turn-end). */
function fireScheduled(state: MatchState, id: TeamId): void {
  const remaining: typeof state.scheduled = [];
  for (const e of state.scheduled) {
    const owner = state.units[e.caster];
    if (owner && owner.team === id && e.appliedTurn < state.turn) {
      e.turns -= 1;
      if (e.turns <= 0) {
        const caster = state.units[e.caster];
        if (caster) {
          const targets = e.targets.map((t) => state.units[t]).filter((t): t is Unit => !!t);
          runEffects(state, e.effect, { caster, targets, skillId: e.skillId });
        }
        continue; // fired — drop
      }
    }
    remaining.push(e);
  }
  state.scheduled = remaining;
}

/** Expire dynamic "watch window" triggers at their installer's turn-end (same anchor as statuses). */
export function tickTriggersForTeam(state: MatchState, team: TeamId): void {
  for (const u of Object.values(state.units)) {
    if (!u.triggers) continue;
    u.triggers = u.triggers.filter((t) => {
      if (t.duration === undefined || t.duration === null) return true; // static, or round-permanent (cleared at round start)
      const owner = t.appliedBy ? state.units[t.appliedBy] : undefined;
      if (owner && owner.team === team && t.appliedTurn !== undefined && t.appliedTurn < state.turn) {
        t.duration -= 1;
        if (t.duration <= 0) return false; // window closed
      }
      return true;
    });
  }
}

/** End the active team's turn: periodic ticks, expiries (+onExpire), scheduled effects, hand over. */
export function endTurn(state: MatchState): void {
  const team = state.activeTeam;
  advanceCooldowns(state, team); // tick this team's cooldowns (skips skills used this turn — state.turn not yet bumped)
  tickDots(state, team);
  const expired = tickDurationsForTeam(state, team);
  tickShieldsForTeam(state, team);
  tickTriggersForTeam(state, team);
  for (const { unitId, status } of expired) {
    emit(state, { type: "statusExpired", unit: unitId, kind: status.kind, name: status.name });
    if (status.onExpire && status.onExpire.length) {
      const u = state.units[unitId];
      const caster = state.units[status.appliedBy] ?? u;
      if (u && caster) runEffects(state, status.onExpire, { caster, targets: [u], skillId: status.sourceId });
    }
  }
  fireScheduled(state, team);
  emit(state, { type: "turnEnd", team });
  removeDeadMinions(state);
  state.activeTeam = otherTeam(team);
  state.turn += 1;
}

// --------------------------------------------------------------------------- //
//  Actions
// --------------------------------------------------------------------------- //

export interface Action {
  unit: string;
  skillId: string;
  /** Explicitly chosen target unit ids (for single-target skills). */
  targets?: string[];
}

export type ActionRejection =
  | "unit-dead"
  | "unit-not-found"
  | "skill-not-found"
  | "on-cooldown"
  | "stunned"
  | "requirements-not-met"
  | "no-legal-target"
  | "insufficient-energy";

export interface ActionResult {
  ok: boolean;
  reason?: ActionRejection;
  /** The skill was used but a Counter negated it (cost paid, cooldown set). */
  countered?: boolean;
}

function isStunnedFor(unit: Unit, skill: SkillInstance): boolean {
  // An "Unstunnable" skill (ayana:divine Verse of Ascension) is castable even while its caster is stunned.
  if (skill.tags.includes("Unstunnable")) return false;
  // A "Stun Immunity" mark (granted by some augments) makes the unit immune to all stuns.
  if (unit.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity")) return false;
  return unit.statuses.some((s) => {
    if (s.kind !== "stun") return false;
    if (!s.scope) return true; // unscoped stun stops every skill
    const hasTag = skill.tags.includes(s.scope.tag);
    return s.scope.mode === "only" ? hasTag : !hasTag;
  });
}

// Does this unit's invulnerable block the given (harmful) skill? An unscoped invulnerable blocks every harmful
// skill; a scoped one ("invulnerable to Strategic skills" / "…to non-Strategic skills") blocks only skills that
// match its {tag, mode} — same tag/mode test as a scoped stun. A unit with several invulnerables blocks if ANY
// applies.
function invulnerableBlocks(unit: Unit, skill: SkillInstance): boolean {
  return unit.statuses.some((s) => {
    if (s.kind !== "invulnerable") return false;
    if (!s.scope) return true;
    const hasTag = skill.tags.includes(s.scope.tag);
    return s.scope.mode === "only" ? hasTag : !hasTag;
  });
}

/** Whether a skill Bypasses (ignores Invulnerability + DR + Shield): the static Bypassing tag, OR a live
 *  `bypassingIf` condition (gommar:night Midnight Mountain Bypasses while Stealthed). */
function skillBypasses(state: MatchState, caster: Unit, skill: SkillInstance): boolean {
  return skill.tags.includes("Bypassing") ||
    (skill.bypassingIf != null && evalConditionReadOnly(state, caster, skill.bypassingIf));
}

/** Total energy in a pool. */
function poolTotal(pool: EnergyPool): number {
  let t = 0;
  for (const k of Object.keys(pool)) t += pool[k] ?? 0;
  return t;
}

/**
 * A skill's cost after cost mods. `cost_mod` statuses apply a flat delta (spilling onto specific);
 * per-cast `skill.costMods` (keeper3 "Plot Twist") apply a delta gated by a live Condition (needs `state`);
 * a `cost_currency_remap` status (titania5 "Jealousy") moves the remaining Specific cost onto Generic so
 * any color pays it.
 *
 * ALWAYS pass `state` when you have it: conditional `costMods` can only be evaluated with it, so the 2-arg
 * form silently omits them — every UI/display caller MUST pass `state` or it will show a cost the engine
 * won't charge. `state` stays optional only so pure cost_mod-status unit tests (no costMods) can stay 2-arg.
 */
export function effectiveCost(caster: Unit, skill: SkillInstance, state?: MatchState): SkillInstance["cost"] {
  let delta = 0, genDelta = 0, specDelta = 0;
  // Global cost_mods (no skillId) apply to every skill; scoped ones only to their skill.
  for (const s of caster.statuses) {
    if (s.kind !== "cost_mod" || (s.skillId && s.skillId !== skill.id)) continue;
    // A tag-scoped cost_mod (titania Hallucinogenic Spores: "non-Strategic skills cost +1") applies only to
    // skills matching its scope — same tag/mode test as a scoped stun.
    if (s.scope && (s.scope.mode === "only") !== skill.tags.includes(s.scope.tag)) continue;
    delta += s.magnitude ?? 0;
    genDelta += s.genericDelta ?? 0; // per-channel deltas (scratch3 "-1 Generic AND -1 Specific"): applied
    specDelta += s.specificDelta ?? 0; // to each channel independently, floored, with NO spill.
  }
  // Per-cast conditional cost mods carried on the skill, re-evaluated live at each cast.
  if (state && skill.costMods) {
    const val = (v: number | Value): number => (typeof v === "number" ? v : evalValueReadOnly(state, caster, v));
    for (const m of skill.costMods) {
      if (m.when && !evalConditionReadOnly(state, caster, m.when)) continue;
      if (m.magnitude !== undefined) delta += val(m.magnitude); // scalar (spills generic->specific)
      if (m.genericDelta !== undefined) genDelta += val(m.genericDelta); // per-channel, independent, floored, no spill
      if (m.specificDelta !== undefined) specDelta += val(m.specificDelta);
    }
  }
  const remap = caster.statuses.some((s) => s.kind === "cost_currency_remap" && (!s.skillId || s.skillId === skill.id));
  if (delta === 0 && genDelta === 0 && specDelta === 0 && !remap) return skill.cost;
  let generic = skill.cost.generic + delta;
  let specific = skill.cost.specific;
  if (generic < 0) {
    specific += generic; // spill the leftover scalar discount onto the specific cost
    generic = 0;
  }
  generic = Math.max(0, generic + genDelta); // per-channel: independent, floored, no cross-channel spill
  specific = Math.max(0, specific + specDelta);
  if (remap && specific > 0) { // Specific → Generic: any color may now pay the remapped portion
    generic += specific;
    specific = 0;
  }
  return { generic, specific };
}

/** The cooldown a skill goes on when used, after the caster's cooldown_mod statuses (floored at 0). */
export function effectiveCooldown(caster: Unit, skill: SkillInstance): number {
  let delta = 0;
  for (const s of caster.statuses) if (s.kind === "cooldown_mod") delta += s.magnitude ?? 0;
  return Math.max(0, skill.cooldown + delta);
}

/** Can the pool cover a cost for a skill of `element`? */
export function canPay(pool: EnergyPool, element: string, cost: SkillInstance["cost"]): boolean {
  const specificHave = pool[element] ?? 0;
  if (specificHave < cost.specific) return false;
  // Generic is payable by anything left after the specific reservation.
  return poolTotal(pool) - cost.specific >= cost.generic;
}

/**
 * Deduct a cost: specific from the element; generic from the player's chosen colors first (`alloc`,
 * a mutable remaining-budget consumed across the turn), then the default generic-first order for any
 * remainder. Any color may pay generic; specific is never taken from the generic pool.
 */
function pay(pool: EnergyPool, element: string, cost: SkillInstance["cost"], alloc?: EnergyPool): void {
  pool[element] = (pool[element] ?? 0) - cost.specific;
  let generic = cost.generic;
  if (alloc) {
    for (const k of Object.keys(alloc)) {
      if (generic <= 0) break;
      const take = Math.min(generic, alloc[k] ?? 0, pool[k] ?? 0);
      pool[k] = (pool[k] ?? 0) - take;
      alloc[k] = (alloc[k] ?? 0) - take;
      generic -= take;
    }
  }
  const order = ["generic", ...Object.keys(pool).filter((k) => k !== "generic")];
  for (const k of order) {
    if (generic <= 0) break;
    const take = Math.min(generic, pool[k] ?? 0);
    pool[k] = (pool[k] ?? 0) - take;
    generic -= take;
  }
}

/** A skill's effective targeting, honoring a temporary skill_targeting_override (bannerAffectsAllEnemies). */
export function effectiveTargeting(caster: Unit, skill: SkillInstance): SkillInstance["targeting"] {
  const o = caster.statuses.find((s) => s.kind === "skill_targeting_override" && s.skillId === skill.id);
  return (o?.name as SkillInstance["targeting"] | undefined) ?? skill.targeting;
}

function resolveTargets(state: MatchState, caster: Unit, skill: SkillInstance, chosen?: string[]): Unit[] {
  // "Twisted Nightmares" (xyris3): while the caster is marked, its all-* skills hit only one.
  const narrowed = caster.statuses.some((s) => s.kind === "mark" && s.name === "Twisted Nightmares");
  const maybeNarrow = (us: Unit[]): Unit[] => (narrowed && us.length > 1 ? us.slice(0, 1) : us);
  switch (effectiveTargeting(caster, skill)) {
    case "self":
      return [caster];
    case "none":
      return [];
    case "all-enemies":
      return maybeNarrow(unitsOf(state, otherTeam(caster.team)).filter((u) => u.alive));
    case "all-allies":
      return maybeNarrow(unitsOf(state, caster.team).filter((u) => u.alive));
    case "all":
      return maybeNarrow([...unitsOf(state, "A"), ...unitsOf(state, "B")].filter((u) => u.alive));
    case "single": {
      const ids = chosen ?? [];
      const picked = ids.map((id) => state.units[id]).filter((u): u is Unit => !!u && (u.alive || !!skill.canTargetDead));
      if (picked.length > 0) return picked;
      // default: first living enemy
      const enemy = unitsOf(state, otherTeam(caster.team)).find((u) => u.alive);
      return enemy ? [enemy] : [];
    }
  }
}

function hasStatus(u: Unit, kind: string): boolean {
  return u.statuses.some((s) => s.kind === kind);
}

/**
 * Apply targeting legality to a skill's candidate targets (glossary rules):
 *  - Invulnerable blocks NEW Harmful targeting; Isolated blocks Helpful — unless the
 *    skill is Bypassing.
 *  - Taunt forces a single-target Harmful skill onto the taunter.
 *  - Blind retargets a single-target skill to a random valid unit (rng).
 */
export function legalTargets(state: MatchState, caster: Unit, skill: SkillInstance, chosen: Unit[], rng: Rng): Unit[] {
  const harmful = skill.tags.includes("Harmful");
  const helpful = skill.tags.includes("Helpful");
  const bypass = skillBypasses(state, caster, skill);
  // Reanimation (maggie:reanimation): while marked, the reanimated ally may only target Maggie
  // (the mark's applier) or enemies affected by Bramblelash.
  const reanimated = caster.statuses.find((s) => s.kind === "mark" && s.name === "Reanimated");
  const reanimatedOk = (u: Unit): boolean =>
    !reanimated ||
    (reanimated.appliedBy != null && u.id === reanimated.appliedBy) ||
    u.statuses.some((s) => s.kind === "mark" && s.name === "Bramblelash");
  const isLegal = (u: Unit): boolean =>
    (u.alive || !!skill.canTargetDead) && // revives (keeper5/keeper3) may select a dead ally
    !(skill.cannotTargetSelf && u.id === caster.id) && // xyris5 "cannot target Xyris"
    reanimatedOk(u) &&
    // targetKind restricts by unit kind (e.g. Feed -> a minion, the Eagle); targetFilter OR-extends it with
    // a per-candidate predicate (syl:winter Feed also admits "any stunned ally").
    (!skill.targetKind || u.kind === skill.targetKind ||
      (skill.targetFilter != null && evalTargetPredicate(state, caster, u, skill.targetFilter))) &&
    // scratch Bump Those Numbers: a Deal can't affect a unit that already bears the round-scoped lock mark.
    !(skill.excludeMarkedTargets != null && u.statuses.some((s) => s.kind === "mark" && s.name === skill.excludeMarkedTargets)) &&
    !(u.id !== caster.id && hasStatus(u, "untargetable")) && // others can't target it; self can
    !(harmful && !bypass && invulnerableBlocks(u, skill)) &&
    !(helpful && !bypass && hasStatus(u, "isolated"));

  if (effectiveTargeting(caster, skill) !== "single") return chosen.filter(isLegal);

  // Taunt (single-target Harmful): forced onto the taunter.
  if (harmful) {
    const taunt = caster.statuses.find((s) => s.kind === "taunt" && s.unitRef);
    if (taunt?.unitRef) {
      const forced = state.units[taunt.unitRef];
      return forced && isLegal(forced) ? [forced] : [];
    }
  }
  // Auto-target-by-mark (zephyrex Ominous Rumble): while a living enemy bears the named mark, this skill is
  // forcibly aimed at it (else the chosen target stands). Taunt above still wins.
  if (skill.autoTargetMark) {
    const marked = unitsOf(state, otherTeam(caster.team)).find((u) => u.statuses.some((s) => s.kind === "mark" && s.name === skill.autoTargetMark) && isLegal(u));
    if (marked) return [marked];
  }
  // Blind: choose a random valid target from the relevant side (excluding units immune to Blinded targeting).
  if (hasStatus(caster, "blind")) {
    const side = harmful ? unitsOf(state, otherTeam(caster.team)) : helpful ? unitsOf(state, caster.team) : chosen;
    const pool = side.filter((u) => isLegal(u) && !u.statuses.some((s) => s.kind === "mark" && s.name === "Blind-Untargetable"));
    return pool.length ? [rng.pick(pool)] : [];
  }
  return chosen.filter(isLegal);
}

/**
 * Read-only preview: could `caster` legally use `skill` right now? Runs the same gates as
 * performAction (alive / cooldown / stun / requires / has a legal target / can pay) WITHOUT
 * mutating state — for an action provider or a client greying out unusable skills.
 */
export function canUse(state: MatchState, caster: Unit, skill: SkillInstance): boolean {
  if (!caster.alive) return false;
  if (skill.currentCd > 0) return false;
  if (isStunnedFor(caster, skill)) return false;
  if (skill.requires && !evalSkillCondition(state, caster, skill.requires)) return false;
  const rng = Rng.fromState(state.rngState); // a throwaway clone; we never write it back (read-only)
  const needsTarget = effectiveTargeting(caster, skill) === "single" && (skill.tags.includes("Harmful") || skill.tags.includes("Helpful"));
  if (needsTarget) {
    // Probe the proper side's FULL roster (heroes AND minions) so a kind-restricted skill (Feed → minion)
    // finds its target — not resolveTargets' "first living enemy" default, which a targetKind filter rejects.
    const side = skill.tags.includes("Harmful") ? otherTeam(caster.team) : caster.team;
    const cands = unitsOf(state, side).filter((u) => u.alive);
    if (legalTargets(state, caster, skill, cands, rng).length === 0) return false;
  }
  return canPay(team(state, caster.team).energy, caster.currentElement, effectiveCost(caster, skill, state));
}

/** Validate + perform one action: legality → pay → run effects → set cooldown. */
export function performAction(state: MatchState, action: Action): ActionResult {
  const caster = state.units[action.unit];
  if (!caster) return { ok: false, reason: "unit-not-found" };
  if (!caster.alive) return { ok: false, reason: "unit-dead" };
  const skill = (caster.skills ?? []).find((s) => s.id === action.skillId);
  if (!skill) return { ok: false, reason: "skill-not-found" };
  if (skill.currentCd > 0) return { ok: false, reason: "on-cooldown" };
  if (isStunnedFor(caster, skill)) return { ok: false, reason: "stunned" };
  if (skill.requires && !evalSkillCondition(state, caster, skill.requires)) return { ok: false, reason: "requirements-not-met" };

  // Was the caster concealed at cast time? Captured BEFORE the veil-break below (a Harmful cast strips a
  // caster's veiled), so a skill struck from stealth is reported Invisible for its OWN cast even though the
  // cloak drops afterwards. Feeds the `hidden` flag on this cast's events + the log-telegraph suppression.
  const invisibleCast = skill.isHidden || isConcealed(caster);
  // Display disguise (zephyrex:mist Cleave the Veil → Elegant Sweep): the cover-name to telegraph under and
  // to stamp onto every status this cast leaves, so the opponent's view is re-skinned by redactState.
  const disguiseName = skill.disguiseAs ? ((caster.skills ?? []).find((s) => s.id === skill.disguiseAs)?.name ?? skill.disguiseAs) : undefined;

  // Targeting legality (before paying cost — an illegal action can't be declared).
  const rng = Rng.fromState(state.rngState);
  const targets = legalTargets(state, caster, skill, resolveTargets(state, caster, skill, action.targets), rng);
  state.rngState = rng.state;
  // A single-target skill needs a legal target when it is Harmful/Helpful, OR when the player explicitly chose
  // one that turned out illegal (e.g. xyris5's own-self choice under cannotTargetSelf) — rather than silently
  // redirecting or (Strategic) landing on the caster via the effect's `target` fallback.
  const choseTarget = (action.targets?.length ?? 0) > 0;
  const needsTarget = effectiveTargeting(caster, skill) === "single" && (skill.tags.includes("Harmful") || skill.tags.includes("Helpful") || choseTarget);
  if (needsTarget && targets.length === 0) return { ok: false, reason: "no-legal-target" };

  const pool = team(state, caster.team).energy;
  const cost = effectiveCost(caster, skill, state);
  if (!canPay(pool, caster.currentElement, cost)) {
    return { ok: false, reason: "insufficient-energy" };
  }
  pay(pool, caster.currentElement, cost, state.genericPay);
  if (!state.actedThisTurn.includes(caster.id)) state.actedThisTurn.push(caster.id); // ledger: this unit acted

  // Declare phase: a Counter can negate the skill; a Reflect can redirect it.
  const decl = resolveDeclaration(state, caster, skill, targets);
  if (decl.cancelled) {
    // Countered: the skill was used (cost consumed above) and goes on cooldown, but
    // its effects do not run. (Provisional ruling: a countered skill still pays its cost.)
    skill.currentCd = effectiveCooldown(caster, skill);
    skill.cdSetTurn = state.turn;
    if (!invisibleCast) state.log.push(`${caster.name}'s ${skill.name} was countered`); // an Invisible cast leaves no counter telegraph either
    removeDeadMinions(state);
    return { ok: true, countered: true };
  }

  // Declaration reactions: react-kind `skillDeclared` triggers fire pre-resolution — the skill was NOT
  // cancelled (counter/reflect already resolved inside resolveDeclaration) but its effects have not run,
  // so reads here see pre-cast state (e.g. the Stinking Marsh 0-stack penalty reads Call Tides before the
  // skill mutates it). Interrupt-kind (counter/reflect/replace) triggers are dispatched only by
  // resolveDeclaration, never by this react emit (collectTriggers filters to react-kind).
  emit(state, { type: "skillDeclared", caster: caster.id, skillId: skill.id, tags: skill.tags, targets: decl.finalTargets.map((t) => t.id), hidden: invisibleCast });

  // Snapshot active channels before a possible interrupt so we can announce any that END this action (channeling
  // is a status; channel-end reactors like Static Maelstrom gate on statusExpired{channeling}). A same-channel
  // recast re-adds an identical marker (same name+instanceId) and is NOT reported as ended; cancelling by acting,
  // or switching to a different channel, is. Teardown emits fire after the action fully resolves (below).
  const channelsBefore = caster.statuses.filter((s) => s.kind === "channeling").map((s) => ({ name: s.name, instanceId: s.instanceId }));

  // Set the cooldown BEFORE running effects, so a skill that reduces its OWN cooldown mid-cast (xyris3 "set
  // to 1", sera2 "-1 per marked enemy") adjusts the just-set value via modifyCooldown instead of having it
  // clobbered by this assignment afterwards. cdSetTurn = birth turn — advanceCooldowns skips it, so cooldown N
  // blocks N turns.
  skill.currentCd = effectiveCooldown(caster, skill);
  skill.cdSetTurn = state.turn;
  const affected = runEffects(state, skill.effects, { caster, self: caster, targets: decl.finalTargets, skillId: skill.id, targeting: effectiveTargeting(caster, skill), invisible: skill.isHidden, disguiseAs: skill.disguiseAs, bypassing: skillBypasses(state, caster, skill), reflected: decl.reflected });
  caster.lastSkillId = skill.id; // the "used a skill" ledger (read by clone/last-skill mechanics)

  // Using a new skill cancels active channels — unless it opts out, or it is another copy of a multi-copy
  // channel (galazax1 Twin Storms), in which case it preserves its sibling copies and cancels only other
  // channels. The interrupt runs AFTER the skill's own effects so a skill used DURING a channel can still read
  // `has(channeling)` — zevkir Leyline Bolt / Abyssal Grasp deal Piercing "during Call Tides". The new channel
  // (if this skill is itself a Channel) is installed just below, so a same-channel recast still removes-then-reinstalls.
  if (!skill.doesNotInterrupt) {
    if ((skill.channelCopies ?? 1) > 1) caster.statuses = caster.statuses.filter((s) => !(s.kind === "channeling" && s.name !== skill.id));
    else removeStatus(caster, "channeling");
  }

  // A Channel skill installs a sustained channel that re-runs at the caster's turns — unless an
  // instant_cast status for this skill suppresses the channel (it resolved entirely on cast above).
  const instantCast = caster.statuses.some((s) => s.kind === "instant_cast" && s.skillId === skill.id);
  if (isChannel(skill) && !instantCast) {
    // A multi-copy channel gives each concurrent instance a distinct id, so they occupy separate slots
    // (galazax1#0, galazax1#1) and each re-runs independently; a single-copy channel keeps instanceId undefined.
    const copies = skill.channelCopies ?? 1;
    const instanceId = copies > 1
      ? `${skill.id}#${caster.statuses.filter((s) => s.kind === "channeling" && s.name === skill.id).length}`
      : undefined;
    applyStatus(caster, {
      kind: "channeling", name: skill.id,
      magnitude: skill.channelTurns ?? undefined,
      channelTargets: decl.finalTargets.map((t) => t.id),
      instanceId,
      duration: null, appliedBy: caster.id, appliedTurn: state.turn,
      invisible: skill.isHidden || undefined, // an Invisible Channel skill hides its own channeling marker
      // A disguised Channel skill re-skins its channeling marker too (the name stays the real skill id for the
      // channel machinery; redactState swaps only the displayed name for the opponent).
      disguiseAs: skill.disguiseAs, disguiseName,
    });
    // Channeling is a status like any other, so announce its application: reactors that key on a channel
    // beginning (e.g. Static Maelstrom) can gate on {eventStatusKind:"channeling"} instead of the over-firing
    // has(channeling) state proxy. The channel's name is the skill id.
    emit(state, { type: "statusApplied", unit: caster.id, source: caster.id, kind: "channeling", name: skill.id });
  }

  // Announce any channels that ENDED as a result of this action — cancel-by-acting, or switching channels. A
  // marker still present by name+instanceId was preserved (a same-channel recast) and is not reported, so the
  // remap/teardown reactors fire exactly once when a channel truly stops (not on a refresh).
  for (const c of channelsBefore) {
    if (!caster.statuses.some((s) => s.kind === "channeling" && s.name === c.name && s.instanceId === c.instanceId)) {
      emit(state, { type: "statusExpired", unit: caster.id, kind: "channeling", name: c.name });
    }
  }

  // Veiled breaks on a HARMFUL action by the veiled unit itself (stealth-break-on-action), unless the skill
  // opts out (aramao1/aramao2 "does not break Veiled"). Concealment while veiled is a separate redaction concern.
  if (skill.tags.includes("Harmful") && !skill.doesNotBreakVeil) removeStatus(caster, "veiled");

  // An Invisible skill (inherently, or cast from a cloak) leaves no telegraph in the shared log; a disguised
  // skill telegraphs under its cover name (Cleave the Veil → "Elegant Sweep") so the log doesn't out it.
  if (!invisibleCast) state.log.push(`${caster.name} used ${disguiseName ?? skill.name}`);
  emit(state, { type: "skillUsed", caster: caster.id, skillId: skill.id, targets: decl.finalTargets.map((t) => t.id), tags: skill.tags, affected, hidden: invisibleCast });
  removeDeadMinions(state);
  return { ok: true };
}

/** Resolve a team's staged actions in submission order (RESOLUTION_ORDER). */
export function resolveTurn(state: MatchState, actions: Action[]): ActionResult[] {
  const results = actions.map((a) => performAction(state, a));
  state.genericPay = undefined; // a generic-payment allocation applies to exactly one turn
  return results;
}
