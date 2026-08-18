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
import { emit, evalSkillCondition, resolveDeclaration, runEffects } from "./effects/interpret.ts";
import { applyDamage, applyHeal, outgoingDtypeOverride, tickShieldsForTeam } from "./damage.ts";
import { Rng } from "./rng.ts";
import { applyStatus, clearRoundStatuses, removeStatus, tickDurationsForTeam } from "./status.ts";

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

/**
 * Grant energy income to a team (ENERGY_INCOME, CONFIRMED). Each living hero yields 1
 * energy: normally 1 GENERIC, but an un-Silenced Elemental Essence charge is CONSUMED to
 * yield 1 of the hero's CURRENT element INSTEAD (not in addition). Silence yields generic
 * and keeps the charge. Minions generate nothing.
 */
export function grantIncome(state: MatchState, id: TeamId): void {
  const pool = team(state, id).energy;
  for (const hero of livingHeroes(state, id)) {
    const essence = hero.statuses.some((s) => s.kind === "elemental_essence");
    const silenced = hero.statuses.some((s) => s.kind === "silence");
    if (essence && !silenced) {
      pool[hero.currentElement] = (pool[hero.currentElement] ?? 0) + 1;
      removeStatus(hero, "elemental_essence"); // the charge is consumed by the swap
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
        continue;
      }
      const targets = (s.channelTargets ?? []).map((t) => state.units[t]).filter((t): t is Unit => !!t && t.alive);
      runEffects(state, skill.effects, { caster: u, self: u, targets });
      if (s.magnitude !== undefined) {
        s.magnitude -= 1;
        if (s.magnitude <= 0) removeStatus(u, "channeling", s.name);
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
      if (!(byThisTeam && s.duration !== null && s.appliedTurn < state.turn)) continue;
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
          runEffects(state, e.effect, { caster, targets });
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
      if (u && caster) runEffects(state, status.onExpire, { caster, targets: [u] });
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
  // A "Stun Immunity" mark (granted by some augments) makes the unit immune to all stuns.
  if (unit.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity")) return false;
  return unit.statuses.some((s) => {
    if (s.kind !== "stun") return false;
    if (!s.scope) return true; // unscoped stun stops every skill
    const hasTag = skill.tags.includes(s.scope.tag);
    return s.scope.mode === "only" ? hasTag : !hasTag;
  });
}

/** Total energy in a pool. */
function poolTotal(pool: EnergyPool): number {
  let t = 0;
  for (const k of Object.keys(pool)) t += pool[k] ?? 0;
  return t;
}

/** A skill's cost after the caster's cost_mod statuses (delta applied to generic, spilling to specific). */
export function effectiveCost(caster: Unit, skill: SkillInstance): SkillInstance["cost"] {
  let delta = 0;
  // Global cost_mods (no skillId) apply to every skill; scoped ones only to their skill.
  for (const s of caster.statuses) if (s.kind === "cost_mod" && (!s.skillId || s.skillId === skill.id)) delta += s.magnitude ?? 0;
  if (delta === 0) return skill.cost;
  let generic = skill.cost.generic + delta;
  let specific = skill.cost.specific;
  if (generic < 0) {
    specific += generic; // spill the leftover discount onto the specific cost
    generic = 0;
  }
  return { generic, specific: Math.max(0, specific) };
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

/** Deduct a cost: specific from the element, generic from generic-first then elements. */
function pay(pool: EnergyPool, element: string, cost: SkillInstance["cost"]): void {
  pool[element] = (pool[element] ?? 0) - cost.specific;
  let generic = cost.generic;
  const order = ["generic", ...Object.keys(pool).filter((k) => k !== "generic")];
  for (const k of order) {
    if (generic <= 0) break;
    const take = Math.min(generic, pool[k] ?? 0);
    pool[k] = (pool[k] ?? 0) - take;
    generic -= take;
  }
}

function resolveTargets(state: MatchState, caster: Unit, skill: SkillInstance, chosen?: string[]): Unit[] {
  // "Twisted Nightmares" (xyris3): while the caster is marked, its all-* skills hit only one.
  const narrowed = caster.statuses.some((s) => s.kind === "mark" && s.name === "Twisted Nightmares");
  const maybeNarrow = (us: Unit[]): Unit[] => (narrowed && us.length > 1 ? us.slice(0, 1) : us);
  switch (skill.targeting) {
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
      const picked = ids.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.alive);
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
  const bypass = skill.tags.includes("Bypassing");
  // Reanimation (maggie:reanimation): while marked, the reanimated ally may only target Maggie
  // (the mark's applier) or enemies affected by Bramblelash.
  const reanimated = caster.statuses.find((s) => s.kind === "mark" && s.name === "Reanimated");
  const reanimatedOk = (u: Unit): boolean =>
    !reanimated ||
    (reanimated.appliedBy != null && u.id === reanimated.appliedBy) ||
    u.statuses.some((s) => s.kind === "mark" && s.name === "Bramblelash");
  const isLegal = (u: Unit): boolean =>
    u.alive &&
    reanimatedOk(u) &&
    !(u.id !== caster.id && hasStatus(u, "untargetable")) && // others can't target it; self can
    !(harmful && !bypass && hasStatus(u, "invulnerable")) &&
    !(helpful && !bypass && hasStatus(u, "isolated"));

  if (skill.targeting !== "single") return chosen.filter(isLegal);

  // Taunt (single-target Harmful): forced onto the taunter.
  if (harmful) {
    const taunt = caster.statuses.find((s) => s.kind === "taunt" && s.unitRef);
    if (taunt?.unitRef) {
      const forced = state.units[taunt.unitRef];
      return forced && isLegal(forced) ? [forced] : [];
    }
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
  const targets = legalTargets(state, caster, skill, resolveTargets(state, caster, skill), rng);
  const needsTarget = skill.targeting === "single" && (skill.tags.includes("Harmful") || skill.tags.includes("Helpful"));
  if (needsTarget && targets.length === 0) return false;
  return canPay(team(state, caster.team).energy, caster.currentElement, effectiveCost(caster, skill));
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

  // Targeting legality (before paying cost — an illegal action can't be declared).
  const rng = Rng.fromState(state.rngState);
  const targets = legalTargets(state, caster, skill, resolveTargets(state, caster, skill, action.targets), rng);
  state.rngState = rng.state;
  const needsTarget = skill.targeting === "single" && (skill.tags.includes("Harmful") || skill.tags.includes("Helpful"));
  if (needsTarget && targets.length === 0) return { ok: false, reason: "no-legal-target" };

  const pool = team(state, caster.team).energy;
  const cost = effectiveCost(caster, skill);
  if (!canPay(pool, caster.currentElement, cost)) {
    return { ok: false, reason: "insufficient-energy" };
  }
  pay(pool, caster.currentElement, cost);
  if (!state.actedThisTurn.includes(caster.id)) state.actedThisTurn.push(caster.id); // ledger: this unit acted

  // Declare phase: a Counter can negate the skill; a Reflect can redirect it.
  const decl = resolveDeclaration(state, caster, skill, targets);
  if (decl.cancelled) {
    // Countered: the skill was used (cost consumed above) and goes on cooldown, but
    // its effects do not run. (Provisional ruling: a countered skill still pays its cost.)
    skill.currentCd = effectiveCooldown(caster, skill);
    skill.cdSetTurn = state.turn;
    state.log.push(`${caster.name}'s ${skill.name} was countered`);
    removeDeadMinions(state);
    return { ok: true, countered: true };
  }

  // Declaration reactions: react-kind `skillDeclared` triggers fire pre-resolution — the skill was NOT
  // cancelled (counter/reflect already resolved inside resolveDeclaration) but its effects have not run,
  // so reads here see pre-cast state (e.g. the Stinking Marsh 0-stack penalty reads Call Tides before the
  // skill mutates it). Interrupt-kind (counter/reflect/replace) triggers are dispatched only by
  // resolveDeclaration, never by this react emit (collectTriggers filters to react-kind).
  emit(state, { type: "skillDeclared", caster: caster.id, skillId: skill.id, tags: skill.tags, targets: decl.finalTargets.map((t) => t.id) });

  // Using a new skill cancels any active channel (unless this skill opts out).
  if (!skill.doesNotInterrupt) removeStatus(caster, "channeling");

  const affected = runEffects(state, skill.effects, { caster, self: caster, targets: decl.finalTargets });
  skill.currentCd = effectiveCooldown(caster, skill);
  skill.cdSetTurn = state.turn; // birth turn — advanceCooldowns skips it (see below), so cooldown N blocks N turns
  caster.lastSkillId = skill.id; // the "used a skill" ledger (read by clone/last-skill mechanics)

  // A Channel skill installs a sustained channel that re-runs at the caster's turns — unless an
  // instant_cast status for this skill suppresses the channel (it resolved entirely on cast above).
  const instantCast = caster.statuses.some((s) => s.kind === "instant_cast" && s.skillId === skill.id);
  if (isChannel(skill) && !instantCast) {
    applyStatus(caster, {
      kind: "channeling", name: skill.id,
      magnitude: skill.channelTurns ?? undefined,
      channelTargets: decl.finalTargets.map((t) => t.id),
      duration: null, appliedBy: caster.id, appliedTurn: state.turn,
    });
  }

  state.log.push(`${caster.name} used ${skill.name}`);
  emit(state, { type: "skillUsed", caster: caster.id, skillId: skill.id, targets: decl.finalTargets.map((t) => t.id), tags: skill.tags, affected });
  removeDeadMinions(state);
  return { ok: true };
}

/** Resolve a team's staged actions in submission order (RESOLUTION_ORDER). */
export function resolveTurn(state: MatchState, actions: Action[]): ActionResult[] {
  return actions.map((a) => performAction(state, a));
}
