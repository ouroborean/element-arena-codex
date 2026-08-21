/**
 * The effect interpreter: executes an Effect[] tree against a MatchState.
 *
 * It resolves Selectors to units and Values to numbers against a resolution context,
 * then calls the increment-1 primitives (applyDamage, applyStatus, ...). All chance
 * draws come from a seeded Rng derived from state.rngState and written back, so a
 * cast is fully deterministic and replayable.
 */
import type { MatchState, TeamId, Unit } from "../types.ts";
import { Rng } from "../rng.ts";
import { addShield, applyDamage, applyHeal, applyHealthLoss, bypassesAgainst, outgoingDamageMod, outgoingDamageMult, outgoingDtypeOverride, skillDamageBonus, totalShield } from "../damage.ts";
import { applyStatus, removeStatus, stackCount } from "../status.ts";
import { applyRounding } from "../rulings.ts";
import type { GameEvent, TriggeredEffect } from "../events.ts";
import { MAX_TRIGGER_DEPTH } from "../events.ts";
import type { SkillInstance } from "../skill.ts";
import { getMinionTemplate } from "../minions.ts";
import { skillIsInvisible } from "../visibility.ts";
import type { Condition, Effect, Selector, StatusMatch, StatusSpec, Value } from "./ast.ts";

export interface Ctx {
  state: MatchState;
  rng: Rng;
  caster: Unit;
  self: Unit;
  targets: Unit[];
  it: Unit | null;
  vars: Record<string, number>;
  /** The skill / passive id currently executing — stamped onto any status it applies (provenance). */
  skillId?: string;
  /** The declared targeting of the skill currently executing ("single" vs an AOE category) — the true
   *  signal for "single-target damage" (a resolved defender count of 1 can also be an AOE hitting one enemy). */
  targeting?: string;
  /** Invisible execution context: while true, each status applied within it is stamped `invisible` (frozen)
   *  — every direct status creator honours it (buildStatus/applyStatus, addStack, the channeling install,
   *  seeded minion statuses), so an isHidden skill's whole effect tree is concealed with no per-node
   *  authoring. Propagates through nested contexts (forEach / inline useSkill) via `{ ...ctx }`. A `schedule`d
   *  effect's later re-run does NOT inherit it (a deferred effect re-runs with a fresh context) — an
   *  "invisible until triggered" trap is handled by the temporal-reveal work, not this flag. */
  invisible?: boolean;
  /** Display-disguise context: statuses applied here are stamped to display as skill `disguiseAs` in the
   *  opponent's view (redactState). Seeded from the casting skill's disguiseAs. */
  disguiseAs?: string;
  /** Set of unit ids this skill's effects touched (damaged/statused) — for "affected N targets" reads. */
  affected?: Set<string>;
  /** Present inside a trigger: the event that fired it. */
  event?: GameEvent;
  /** Emit a game event (fires reactive triggers, depth-guarded). */
  emit: (e: GameEvent) => void;
}

/** Native escape-hatch functions for the ~3% of skills that need bespoke code. */
export type CustomFn = (ctx: Ctx, args: Record<string, unknown>) => void;
const CUSTOM = new Map<string, CustomFn>();
export function registerCustom(name: string, fn: CustomFn): void {
  CUSTOM.set(name, fn);
}
/** Is a native handler registered for this custom fn? (Lets content stub the not-yet-implemented ones.) */
export function hasCustom(name: string): boolean {
  return CUSTOM.has(name);
}

// --------------------------------------------------------------------------- //
//  Unit lookup helpers
// --------------------------------------------------------------------------- //
function teamUnits(state: MatchState, team: TeamId): Unit[] {
  const t = state.teams[team];
  const out: Unit[] = [];
  for (const id of t.units) {
    const u = state.units[id];
    if (u) out.push(u);
  }
  return out;
}

function otherTeam(team: TeamId): TeamId {
  return team === "A" ? "B" : "A";
}

/** A unit's current passive id (base or fusion form) — the provenance for its statically authored
 *  triggers, so a status they apply is attributed to the right passive icon. */
function ownerPassiveId(u: Unit): string | undefined {
  return u.heroId ? `${u.heroId}${u.fused ?? ""}0` : undefined;
}

// --------------------------------------------------------------------------- //
//  Selector resolution
// --------------------------------------------------------------------------- //
// `admitUnderstudy` (default true) admits an understudy hero (Dennis) for a selector naming the minion
// template it stands in for. Structural minion-lifecycle ops (defeat/revive/transform/useSkill-by) pass
// false: a hero can be REFERENCED like the minion but never summoned/consumed/revived/made-to-act as one.
export function resolveSelector(sel: Selector, ctx: Ctx, admitUnderstudy = true): Unit[] {
  if (sel === "self") return [ctx.self];
  if (sel === "caster") return [ctx.caster];
  if (sel === "target") return ctx.targets.slice();
  if (sel === "it") return ctx.it ? [ctx.it] : [];
  if (sel === "summoner") {
    const s = ctx.self.summoner ? ctx.state.units[ctx.self.summoner] : undefined;
    return s ? [s] : [ctx.self];
  }
  if (sel === "across") {
    const slot = ctx.self.slot;
    if (slot === undefined) return [];
    const enemyTeam = ctx.self.team === "A" ? "B" : "A";
    return teamUnits(ctx.state, enemyTeam).filter((u) => u.alive && u.kind === "hero" && u.slot === slot);
  }
  if (sel === "adjacent") {
    const slot = ctx.self.slot;
    if (slot === undefined) return [];
    return teamUnits(ctx.state, ctx.self.team).filter(
      (u) => u.alive && u.kind === "hero" && u.id !== ctx.self.id && u.slot !== undefined && Math.abs(u.slot - slot) === 1,
    );
  }
  if (sel === "eventSource" || sel === "eventTarget" || sel === "eventUnit") {
    return eventUnits(sel, ctx);
  }
  if (sel === "eventTargets") {
    const e = ctx.event;
    if (!e || !("targets" in e)) return [];
    return e.targets.map((id) => ctx.state.units[id]).filter((u): u is Unit => !!u);
  }
  if (sel === "eventAffected") {
    // (skillUsed) every unit the skill actually touched (damaged OR statused) — for "all targets affected".
    const e = ctx.event;
    const affected = e && "affected" in e ? e.affected : undefined;
    if (!affected) return [];
    return affected.map((id) => ctx.state.units[id]).filter((u): u is Unit => !!u);
  }

  if ("faction" in sel) {
    const casterTeam = ctx.caster.team;
    let pool: Unit[];
    if (sel.faction === "all") pool = [...teamUnits(ctx.state, "A"), ...teamUnits(ctx.state, "B")];
    else if (sel.faction === "allies") pool = teamUnits(ctx.state, casterTeam);
    else pool = teamUnits(ctx.state, otherTeam(casterTeam));

    // alive defaults to true (living units); alive:false selects the dead (for
    // "each dead ally" style counts). There is intentionally no "both" here.
    const wantAlive = sel.alive ?? true;
    return pool.filter((u) => {
      if (u.alive !== wantAlive) return false;
      // An "understudy" hero stands in for a named minion template (Dennis for Hector's "Dennis the
      // Apprentice"): a selector naming that EXACT template admits it, bypassing the kind (minion) check.
      // A blanket kind selector (no template) never admits it — only a Dennis-by-name reference retargets.
      const isUnderstudy = admitUnderstudy && sel.template !== undefined && u.understudyFor === sel.template;
      if (sel.kind && u.kind !== sel.kind && !isUnderstudy) return false;
      if (sel.template && u.name !== sel.template && !isUnderstudy) return false;
      if (sel.includeSelf === false && u.id === ctx.caster.id) return false;
      return true;
    });
  }

  if ("pick" in sel) {
    const from = resolveSelector(sel.from, ctx, admitUnderstudy); // propagate so a lifecycle op nesting a template selector stays excluded
    const count = sel.count ?? 1;
    if (sel.pick === "random") return ctx.rng.shuffle(from.slice()).slice(0, count);
    const sorted = from
      .slice()
      .sort((a, b) => (sel.pick === "lowestHp" ? a.hp - b.hp : b.hp - a.hp));
    return sorted.slice(0, count);
  }

  // filter
  const base = resolveSelector(sel.filter, ctx, admitUnderstudy);
  return base.filter((u) => {
    if (sel.with && !hasStatusMatch(u, sel.with)) return false;
    if (sel.without && hasStatusMatch(u, sel.without)) return false;
    return true;
  });
}

/** Does a unit hold a status matching a bare kind, or a kind + specific name? */
function hasStatusMatch(u: Unit, m: StatusMatch): boolean {
  if (typeof m === "string") return u.statuses.some((s) => s.kind === m);
  return u.statuses.some((s) => s.kind === m.kind && (m.name === undefined || s.name === m.name));
}

/** Anti-heal: a heal_lock blocks the heal unless the healer is the allowed one. */
function healLocked(u: Unit, healerId: string): boolean {
  const lock = u.statuses.find((s) => s.kind === "heal_lock");
  if (!lock) return false;
  return lock.unitRef === undefined ? true : lock.unitRef !== healerId;
}

function eventUnits(sel: "eventSource" | "eventTarget" | "eventUnit", ctx: Ctx): Unit[] {
  const e = ctx.event;
  if (!e) return [];
  let id: string | null = null;
  if (sel === "eventSource") {
    id = "source" in e ? e.source : "caster" in e ? e.caster : e.type === "unitDied" ? e.killer : null;
  } else if (sel === "eventTarget" && "target" in e) id = e.target;
  else if (sel === "eventUnit") id = "unit" in e ? e.unit : null;
  const u = id ? ctx.state.units[id] : undefined;
  return u ? [u] : [];
}

function resolveOne(sel: Selector | undefined, ctx: Ctx): Unit {
  if (!sel) return ctx.caster;
  return resolveSelector(sel, ctx)[0] ?? ctx.caster;
}

/** The units an effect applies to: its own `to`, else the skill's chosen targets. */
function effectTargets(to: Selector | undefined, ctx: Ctx, admitUnderstudy = true): Unit[] {
  return to ? resolveSelector(to, ctx, admitUnderstudy) : ctx.targets;
}

// --------------------------------------------------------------------------- //
//  Value evaluation
// --------------------------------------------------------------------------- //
export function evalValue(v: Value, ctx: Ctx): number {
  if (typeof v === "number") return v;

  if ("ref" in v) {
    switch (v.ref) {
      case "stackCount":
        return stackCount(resolveOne(v.of, ctx), v.name);
      case "missingHp": {
        const u = resolveOne(v.of, ctx);
        return Math.max(0, u.maxHp - u.hp);
      }
      case "currentHp":
        return resolveOne(v.of, ctx).hp;
      case "shield":
        return totalShield(resolveOne(v.of, ctx));
      case "spendableShield": {
        // Shield spendable toward a Shield cost, counting each Chronicle Fragments stack as 10 Shield.
        const u = resolveOne(v.of, ctx);
        return totalShield(u) + 10 * stackCount(u, "Chronicle Fragments");
      }
      case "count":
        return resolveSelector(v.of, ctx).length;
      case "statusDuration": {
        const s = resolveOne(v.of, ctx).statuses.find((x) => x.kind === v.kind && (v.name === undefined || x.name === v.name));
        return s && s.duration !== null ? s.duration : 0;
      }
      case "statusMag": {
        const s = resolveOne(v.of, ctx).statuses.find((x) => x.kind === v.kind && (v.name === undefined || x.name === v.name));
        return s?.magnitude ?? 0;
      }
      case "statusCount":
        return resolveOne(v.of, ctx).statuses.filter((x) => x.kind === v.kind && (v.name === undefined || x.name === v.name)).length;
      case "sum": {
        let total = 0;
        for (const u of resolveSelector(v.of, ctx)) {
          if (v.metric === "missingHp") total += Math.max(0, u.maxHp - u.hp);
          else if (v.metric === "currentHp") total += u.hp;
          else total += totalShield(u);
        }
        return total;
      }
      case "stackSum": {
        // Total stacks of a named resource summed across a selector — distinct from `count` (how many units
        // hold it) and `stackCount` (one unit's stacks). Powers laria:night's "10+ TOTAL Deepening Shadows".
        let total = 0;
        for (const u of resolveSelector(v.of, ctx)) total += stackCount(u, v.name);
        return total;
      }
      case "var":
        return ctx.vars[v.name] ?? 0;
    }
  }

  if (v.op === "div") {
    const n = evalValue(v.num, ctx) / v.by;
    return v.floor === false ? n : Math.floor(n);
  }

  const nums = v.args.map((a) => evalValue(a, ctx));
  switch (v.op) {
    case "add":
      return nums.reduce((a, b) => a + b, 0);
    case "sub":
      return nums.reduce((a, b) => a - b);
    case "mul":
      return nums.reduce((a, b) => a * b, 1);
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

// --------------------------------------------------------------------------- //
//  Condition evaluation
// --------------------------------------------------------------------------- //
export function evalCondition(c: Condition, ctx: Ctx): boolean {
  if ("has" in c) {
    const u = resolveOne(c.of, ctx);
    return u.statuses.some((s) => s.kind === c.has && (c.name === undefined || s.name === c.name));
  }
  if ("cmp" in c) {
    const l = evalValue(c.left, ctx);
    const r = evalValue(c.right, ctx);
    switch (c.cmp) {
      case ">": return l > r;
      case ">=": return l >= r;
      case "<": return l < r;
      case "<=": return l <= r;
      case "==": return l === r;
      case "!=": return l !== r;
    }
  }
  if ("sameUnit" in c) {
    const a = resolveSelector(c.sameUnit[0], ctx)[0];
    const b = resolveSelector(c.sameUnit[1], ctx)[0];
    return !!a && !!b && a.id === b.id;
  }
  if ("isFaction" in c) {
    const u = resolveSelector(c.isFaction, ctx)[0];
    if (!u) return false;
    const ally = u.team === ctx.caster.team;
    return c.faction === "ally" ? ally : !ally;
  }
  if ("isKind" in c) {
    const u = resolveSelector(c.isKind, ctx)[0];
    return !!u && u.kind === c.kind;
  }
  if ("declaredTargetsSelf" in c) {
    const e = ctx.event;
    return !!e && "targets" in e && e.targets.includes(ctx.self.id);
  }
  if ("eventHasTag" in c) {
    const e = ctx.event;
    return !!e && "tags" in e && !!e.tags && e.tags.includes(c.eventHasTag);
  }
  if ("eventStatusKind" in c) {
    const e = ctx.event;
    return !!e && "kind" in e && e.kind === c.eventStatusKind && (c.name === undefined || ("name" in e && e.name === c.name));
  }
  if ("eventSourceId" in c) {
    // (damageDealt) match the event's sourceId — a dot's name for dot ticks, a damage node's id for direct hits.
    const e = ctx.event;
    return !!e && "sourceId" in e && (e as { sourceId?: string }).sourceId === c.eventSourceId;
  }
  if ("eventTeamIsSelf" in c) {
    const e = ctx.event;
    return !!e && "team" in e && e.team === ctx.self.team;
  }
  if ("eventRedirectedToSelf" in c) {
    // On skillRedirected (a reflect): did the skill get redirected ONTO this unit? (reads the destination `to`.)
    const e = ctx.event;
    return !!e && e.type === "skillRedirected" && e.to === ctx.self.id;
  }
  if ("eventHidden" in c) {
    // (skillUsed/skillDeclared) whether the used skill is Invisible (isHidden). Absent flag = visible.
    const e = ctx.event;
    return !!e && "hidden" in e && !!(e as { hidden?: boolean }).hidden === c.eventHidden;
  }
  if ("skillOnCooldown" in c) {
    // The caster's own skill (by id) is on cooldown right now — a castability gate (zephyrex3 Sonic Thrust).
    const sk = (ctx.self.skills ?? []).find((s) => s.id === c.skillOnCooldown);
    return !!sk && sk.currentCd > 0;
  }
  if ("and" in c) return c.and.every((x) => evalCondition(x, ctx));
  if ("or" in c) return c.or.some((x) => evalCondition(x, ctx));
  if ("not" in c) return !evalCondition(c.not, ctx);
  return ctx.rng.next() < c.chance;
}

// --------------------------------------------------------------------------- //
//  Effect execution
// --------------------------------------------------------------------------- //
function evalDuration(d: Value | null, ctx: Ctx): number | null {
  return d === null ? null : applyRounding(evalValue(d, ctx));
}

/** The label to show a disguised status in the opponent's view: the disguise skill's display name (resolved
 *  from the caster's own kit), falling back to the raw id. Returns the disguise fields, or empty when none. */
export function disguiseFieldsOf(ctx: Ctx): { disguiseAs?: string; disguiseName?: string } {
  if (!ctx.disguiseAs) return {};
  return { disguiseAs: ctx.disguiseAs, disguiseName: ctx.caster.skills?.find((s) => s.id === ctx.disguiseAs)?.name ?? ctx.disguiseAs };
}

function buildStatus(spec: StatusSpec, ctx: Ctx) {
  return {
    kind: spec.kind,
    magnitude: spec.magnitude === undefined ? undefined : applyRounding(evalValue(spec.magnitude, ctx)),
    name: spec.name,
    dtype: spec.dtype,
    scope: spec.scope,
    genericDelta: spec.genericDelta,
    specificDelta: spec.specificDelta,
    viaSourceId: spec.viaSourceId,
    unitRef: spec.unitRef ? resolveSelector(spec.unitRef, ctx)[0]?.id : undefined,
    onExpire: spec.onExpire,
    duration: evalDuration(spec.duration, ctx),
    appliedBy: ctx.caster.id,
    appliedTurn: ctx.state.turn,
    sourceId: ctx.skillId,
    // Frozen invisibility: an isHidden skill's context (ctx.invisible) hides ALL its effects; a status-spec
    // `invisible:true` hides just this one. Either makes the opponent's wire-state omit this status.
    invisible: ctx.invisible || spec.invisible || undefined,
    // Display disguise (if the casting skill wears one): shown as the disguise skill in the opponent's view.
    ...disguiseFieldsOf(ctx),
  };
}

export function exec(effect: Effect, ctx: Ctx): void {
  switch (effect.op) {
    case "damage": {
      // The credited dealer is the caster, unless the node names one (from) — a fanned self-hit like dennis4
      // "all enemies deal 5 to him" sets from:"it" so each enemy is the real dealer (its type/mods, and the
      // source of the damageDealt/unitDied events, so damager-identity reactions like Fury see the enemy).
      const dealer = effect.from ? (resolveSelector(effect.from, ctx)[0] ?? ctx.caster) : ctx.caster;
      const dtype = outgoingDtypeOverride(dealer) ?? effect.dtype ?? "normal";
      // Attacker-side empower/weaken: additive mods (global + this-skill-scoped), then multiplicative mult.
      const amount = Math.max(0, (evalValue(effect.amount, ctx) + outgoingDamageMod(dealer, dtype) + skillDamageBonus(dealer, ctx.skillId)) * outgoingDamageMult(dealer));
      // Land one share of this damage on one defender (`src` = the credited dealer), running its full
      // mitigation and emitting its events. The damage's own character (type + bypass) stays the attacker's.
      const land = (u: Unit, amt: number, src: string): void => {
        ctx.affected?.add(u.id);
        const wasAlive = u.alive;
        const r = applyDamage(u, { amount: amt, type: dtype, isNew: true, sourceId: effect.id, bypass: bypassesAgainst(dealer, u) });
        if (r.shieldAbsorbed > 0) ctx.emit({ type: "shieldDamaged", unit: u.id, source: src, amount: r.shieldAbsorbed });
        if (r.shieldBroke) ctx.emit({ type: "shieldBroken", unit: u.id, source: src });
        // The event's sourceId identifies what dealt the damage for reactions (eventSourceId): a damage node's
        // own id if authored, else the casting skill's id — so a trigger can scope to one source skill even
        // when its damage node is untagged. (The pipeline's sourceId at applyDamage stays the node id.)
        ctx.emit({ type: "damageDealt", source: src, target: u.id, amount: r.hpLost, dtype, sourceId: effect.id ?? ctx.skillId, isNew: true });
        if (wasAlive && r.lethal) ctx.emit({ type: "unitDied", unit: u.id, killer: src });
      };
      // "single-target damage" is the CASTING SKILL's declared targeting, not the resolved defender count:
      // an all-enemies AOE can resolve to a single living enemy, and a forEach fans single-defender ops.
      const splittable = ctx.targeting === "single";
      for (const u of effectTargets(effect.to, ctx)) {
        // Blackened Soul (split_incoming): a single-target hit on the holder is divided evenly among the
        // holder + living opposing-team bearers of the named mark. The holder's share is credited to the
        // attacker (they legitimately hit the holder); the redistributed shares are credited to the split
        // holder (Jarrik) — matching the DoT/thorns precedent (scheduler.ts sources redirected damage to the
        // effect owner), so the attacker's on-deal reactions don't fire on friendly-fire shares. Shares land
        // via `land`, NOT by re-entering the damage op, so a co-bearer holding split_incoming doesn't re-split.
        const split = splittable && u.alive ? u.statuses.find((s) => s.kind === "split_incoming") : undefined;
        if (split) {
          const co = teamUnits(ctx.state, otherTeam(u.team)).filter(
            (x) => x.alive && x.id !== u.id && x.statuses.some((s) => s.kind === "mark" && s.name === split.name),
          );
          const per = applyRounding(amount / (1 + co.length));
          land(u, per, dealer.id);
          for (const d of co) land(d, per, u.id);
        } else {
          land(u, amount, dealer.id);
        }
      }
      return;
    }
    case "heal": {
      const amount = evalValue(effect.amount, ctx);
      for (const u of effectTargets(effect.to, ctx)) {
        if (healLocked(u, ctx.caster.id)) continue; // anti-heal (heal_lock)
        const wasAlive = u.alive;
        const before = u.hp;
        const hbd = u.statuses.find((s) => s.kind === "heal_becomes_damage");
        const r = applyHeal(u, amount, { allowOverheal: effect.overheal });
        const overheal = Math.max(0, r.requested - r.healed);
        // Emit on any real heal, and also on a pure overheal (target already at max) so
        // overheal-redirect mechanics can see it. hbd's healed:0 is a damage conversion, not overheal.
        if (r.healed > 0 || (overheal > 0 && !hbd)) ctx.emit({ type: "healReceived", unit: u.id, source: ctx.caster.id, amount: r.healed, overheal });
        // A typed heal→damage conversion is real (reactable) damage; surface it as a damageDealt event.
        else if (hbd?.dtype && u.hp < before) ctx.emit({ type: "damageDealt", source: ctx.caster.id, target: u.id, amount: before - u.hp, dtype: hbd.dtype, isNew: true });
        // A heal can be lethal under inverted HP (dies at max) or heal→damage — surface the death.
        if (wasAlive && !u.alive) ctx.emit({ type: "unitDied", unit: u.id, killer: ctx.caster.id });
      }
      return;
    }
    case "healthLoss": {
      const amount = evalValue(effect.amount, ctx);
      for (const u of effectTargets(effect.to, ctx)) {
        const wasAlive = u.alive;
        applyHealthLoss(u, amount);
        if (wasAlive && !u.alive) ctx.emit({ type: "unitDied", unit: u.id, killer: ctx.caster.id });
      }
      return;
    }
    case "grantShield": {
      const amount = applyRounding(evalValue(effect.amount, ctx));
      for (const u of effectTargets(effect.to, ctx))
        addShield(u, amount, effect.duration ?? null, ctx.caster.id, ctx.state.turn, effect.id);
      return;
    }
    case "applyStatus": {
      for (const u of effectTargets(effect.to, ctx)) {
        ctx.affected?.add(u.id);
        const st = buildStatus(effect.status, ctx);
        applyStatus(u, st);
        ctx.emit({ type: "statusApplied", unit: u.id, source: ctx.caster.id, kind: st.kind, name: st.name });
      }
      return;
    }
    case "removeStatus": {
      for (const u of effectTargets(effect.from, ctx)) {
        // Emit statusLost only when a matching status was actually present (an EXPLICIT loss, distinct from
        // natural expiry which emits statusExpired). Lets "until <unit> loses <mark>" mechanics react.
        const had = u.statuses.some((s) => s.kind === effect.kind && (effect.name === undefined || s.name === effect.name));
        removeStatus(u, effect.kind, effect.name);
        if (had) ctx.emit({ type: "statusLost", unit: u.id, kind: effect.kind, name: effect.name });
      }
      return;
    }
    case "modifyStatus": {
      const dMag = effect.magnitudeDelta ? applyRounding(evalValue(effect.magnitudeDelta, ctx)) : 0;
      const dDur = effect.durationDelta ? applyRounding(evalValue(effect.durationDelta, ctx)) : 0;
      for (const u of effectTargets(effect.from, ctx)) {
        const s = u.statuses.find(
          (x) => x.kind === effect.kind && (effect.name === undefined || x.name === effect.name),
        );
        if (!s) continue;
        if (dMag) s.magnitude = (s.magnitude ?? 0) + dMag;
        if (dDur && s.duration !== null) {
          const nextDur = s.duration + dDur;
          if (nextDur <= 0) u.statuses = u.statuses.filter((x) => x !== s);
          else s.duration = nextDur;
        }
      }
      return;
    }
    case "addStack": {
      const amount = effect.amount ? applyRounding(evalValue(effect.amount, ctx)) : 1;
      const duration = effect.duration === undefined ? null : evalDuration(effect.duration, ctx);
      for (const u of effectTargets(effect.to, ctx))
        applyStatus(u, {
          kind: "stack",
          name: effect.name,
          magnitude: amount,
          duration,
          appliedBy: ctx.caster.id,
          appliedTurn: ctx.state.turn,
          sourceId: ctx.skillId,
          // Inherit the invisible execution context, exactly like buildStatus — an isHidden skill that lays
          // stacks (saya3 "Spider Mines") must place them Invisibly, not just its applyStatus effects.
          invisible: ctx.invisible || undefined,
        });
      return;
    }
    case "grantEnergy": {
      const amount = applyRounding(evalValue(effect.amount, ctx));
      const pool = ctx.state.teams[ctx.caster.team].energy;
      pool[effect.element] = (pool[effect.element] ?? 0) + amount;
      return;
    }
    case "modifyCooldown": {
      const delta = applyRounding(evalValue(effect.delta, ctx));
      for (const u of effect.of ? resolveSelector(effect.of, ctx) : [ctx.caster]) {
        for (const s of u.skills ?? []) {
          if (effect.skillId && s.id !== effect.skillId) continue;
          s.currentCd = Math.max(0, s.currentCd + delta);
        }
      }
      return;
    }
    case "summon": {
      const n = effect.count ? applyRounding(evalValue(effect.count, ctx)) : 1;
      const hp = effect.hp ? applyRounding(evalValue(effect.hp, ctx)) : null;
      for (let i = 0; i < n; i++) summonMinion(ctx, effect.template, hp);
      return;
    }
    case "defeat": {
      for (const u of effectTargets(effect.to, ctx, false)) { // never consume the understudy hero as a minion
        if (!u.alive) continue;
        u.hp = 0;
        u.alive = false;
        ctx.emit({ type: "unitDied", unit: u.id, killer: ctx.caster.id });
      }
      return;
    }
    case "revive": {
      const hp = applyRounding(evalValue(effect.hp, ctx));
      for (const u of effectTargets(effect.to, ctx, false)) { // a minion-revive never resurrects the understudy hero
        if (u.alive) continue;
        u.alive = true;
        u.hp = Math.max(1, Math.min(u.maxHp, hp));
      }
      return;
    }
    case "transform": {
      const tmpl = getMinionTemplate(effect.template);
      if (!tmpl) return;
      for (const u of effectTargets(effect.to, ctx, false)) { // never retemplate the understudy hero
        u.name = tmpl.name;
        if (tmpl.element) u.currentElement = tmpl.element;
        u.maxHp = tmpl.maxHp;
        u.hp = effect.keepHp ? Math.min(u.hp, tmpl.maxHp) : tmpl.maxHp;
        u.skills = (tmpl.skills ?? []).map((s) => ({ ...s, currentCd: 0 }));
        u.triggers = (tmpl.triggers ?? []).map((t) => ({ ...t, owner: u.id }));
      }
      return;
    }
    case "useSkill": {
      // The understudy hero can't be MADE to act as the minion (it lacks the minion's skills), so `by` does
      // not admit it — a Dennis-cast reference (e.g. Dennisyphus) no-ops rather than mis-resolving to the hero.
      const by = effect.by ? resolveSelector(effect.by, ctx, false)[0] : ctx.caster;
      const sk = (by?.skills ?? []).find((s) => s.id === effect.skillId);
      if (by && sk) {
        const targets = effect.on ? resolveSelector(effect.on, ctx) : ctx.targets;
        runAll(sk.effects, { ...ctx, caster: by, self: by, targets, it: null, skillId: sk.id }); // inline, shares the bus
      }
      return;
    }
    case "swapPositions": {
      const a = resolveSelector(effect.a, ctx)[0];
      const b = resolveSelector(effect.b, ctx)[0];
      if (a && b) {
        const tmp = a.slot;
        a.slot = b.slot;
        b.slot = tmp;
      }
      return;
    }
    case "shuffleTeam": {
      const teamId = effect.team === "enemies" ? otherTeam(ctx.caster.team) : ctx.caster.team;
      const heroes = teamUnits(ctx.state, teamId).filter((u) => u.alive && u.kind === "hero" && u.slot !== undefined);
      const slots = ctx.rng.shuffle(heroes.map((h) => h.slot as number));
      heroes.forEach((h, i) => { h.slot = slots[i]; });
      return;
    }
    case "if": {
      if (evalCondition(effect.cond, ctx)) runAll(effect.then, ctx);
      else if (effect.else) runAll(effect.else, ctx);
      return;
    }
    case "forEach": {
      for (const u of resolveSelector(effect.each, ctx)) {
        runAll(effect.do, { ...ctx, it: u, targets: [u] });
      }
      return;
    }
    case "seq":
      runAll(effect.steps, ctx);
      return;
    case "schedule": {
      const targets = (effect.to ? resolveSelector(effect.to, ctx) : ctx.targets).map((u) => u.id);
      ctx.state.scheduled.push({
        effect: effect.effect, caster: ctx.caster.id, targets,
        turns: effect.delayTurns, appliedTurn: ctx.state.turn, skillId: ctx.skillId,
        // Invisible from either the execution context (isHidden skill) OR this node (a hidden-target prep).
        invisible: effect.invisible || ctx.invisible || undefined,
      });
      return;
    }
    case "custom": {
      const fn = CUSTOM.get(effect.fn);
      if (!fn) throw new Error(`custom effect not registered: ${effect.fn}`);
      fn(ctx, effect.args ?? {});
      return;
    }
  }
}

/** Summon a minion from its registered template; respects the 6-minion cap. */
function summonMinion(ctx: Ctx, templateName: string, hpOverride: number | null): void {
  const team = ctx.state.teams[ctx.caster.team];
  const minionCount = team.units.filter((id) => ctx.state.units[id]?.kind === "minion").length;
  if (minionCount >= 6) return; // MINION_CAP
  const tmpl = getMinionTemplate(templateName);
  const maxHp = hpOverride ?? tmpl?.maxHp ?? 1;
  const element = tmpl?.element ?? ctx.caster.currentElement;
  const id = `${ctx.caster.id}:${templateName}:${ctx.state.minionSeq++}`;
  ctx.state.units[id] = {
    id, kind: "minion", name: tmpl?.name ?? templateName, team: ctx.caster.team,
    hp: maxHp, maxHp, shields: [],
    baseElement: element, currentElement: element,
    statuses: (tmpl?.statuses ?? []).map((s) => ({ ...s, appliedBy: ctx.caster.id, appliedTurn: ctx.state.turn, invisible: ctx.invisible || s.invisible || undefined })),
    alive: true, summoner: ctx.caster.id,
    skills: (tmpl?.skills ?? []).map((s) => ({ ...s, currentCd: 0 })),
    triggers: (tmpl?.triggers ?? []).map((t) => ({ ...t, owner: id })),
  };
  team.units.push(id);
  ctx.emit({ type: "minionSummoned", unit: id, template: templateName, summoner: ctx.caster.id });
}

function runAll(effects: Effect[], ctx: Ctx): void {
  for (const e of effects) exec(e, ctx);
}

/** Run an effect list against an existing context (shares its bus/rng/depth). For custom handlers. */
export function runInContext(effects: Effect[], ctx: Ctx): void {
  runAll(effects, ctx);
}

// --------------------------------------------------------------------------- //
//  Event bus — reactive triggers
// --------------------------------------------------------------------------- //
export interface Bus {
  emit(event: GameEvent): void;
}

/** All units' reactive triggers matching an event type, in deterministic order. */
function collectTriggers(state: MatchState, type: GameEvent["type"]): { owner: Unit; trig: TriggeredEffect }[] {
  const out: { owner: Unit; trig: TriggeredEffect }[] = [];
  // Deterministic order: team A then B, in each team's unit-list order.
  const ordered = [...state.teams.A.units, ...state.teams.B.units];
  for (const id of ordered) {
    const owner = state.units[id];
    if (!owner) continue;
    for (const trig of owner.triggers ?? []) {
      if (trig.on === type && (trig.kind ?? "react") === "react") out.push({ owner, trig });
    }
  }
  return out;
}

/** The unit that caused an event (dealer / caster), if any. */
function eventActor(state: MatchState, event: GameEvent): Unit | null {
  const id = "source" in event ? event.source : "caster" in event ? event.caster : null;
  return id ? state.units[id] ?? null : null;
}

/** Stealth: a stealthed actor does not set off its enemies' triggers. */
function stealthSuppressed(state: MatchState, event: GameEvent, owner: Unit): boolean {
  const actor = eventActor(state, event);
  return !!actor && actor.team !== owner.team && actor.statuses.some((s) => s.kind === "stealth");
}

/** Build an event bus over a state + rng, with a shared re-entrancy depth guard. */
export function createBus(state: MatchState, rng: Rng): Bus {
  let depth = 0;
  const bus: Bus = {
    emit(event: GameEvent) {
      if (depth >= MAX_TRIGGER_DEPTH) {
        state.log.push(`trigger depth cap hit at ${event.type}`);
        return;
      }
      depth++;
      try {
        for (const { owner, trig } of collectTriggers(state, event.type)) {
          // A reactive trigger needs its owner alive — except a unit reacting to its own death.
          const ownDeath = event.type === "unitDied" && event.unit === owner.id;
          if (!owner.alive && !ownDeath) continue;
          if (stealthSuppressed(state, event, owner)) continue;
          const tctx: Ctx = {
            state, rng, caster: owner, self: owner, targets: [], it: null, vars: {},
            skillId: trig.sourceSkillId ?? ownerPassiveId(owner), event, emit: bus.emit,
          };
          if (trig.when && !evalCondition(trig.when, tctx)) continue;
          runAll(trig.effect, tctx);
          if (trig.once) owner.triggers = (owner.triggers ?? []).filter((t) => t !== trig); // consume a one-shot watch
        }
      } finally {
        depth--;
      }
    },
  };
  return bus;
}

/** Evaluate a standalone condition against a caster (for skill `requires` gates). */
export function evalSkillCondition(state: MatchState, caster: Unit, cond: Condition): boolean {
  const rng = Rng.fromState(state.rngState);
  const bus = createBus(state, rng);
  const ctx: Ctx = { state, rng, caster, self: caster, targets: [], it: null, vars: {}, emit: bus.emit };
  const result = evalCondition(cond, ctx);
  state.rngState = rng.state;
  return result;
}

/**
 * Evaluate a condition WITHOUT persisting the rng — a read-only gate for cost/cooldown previews
 * (effectiveCost is called from the read-only canUse as well as from performAction, so it must not
 * advance rng as a side effect). A cost gate that depends on rng would be a design smell anyway.
 */
export function evalConditionReadOnly(state: MatchState, caster: Unit, cond: Condition): boolean {
  const rng = Rng.fromState(state.rngState);
  const bus = createBus(state, rng);
  const ctx: Ctx = { state, rng, caster, self: caster, targets: [], it: null, vars: {}, emit: bus.emit };
  return evalCondition(cond, ctx); // rng intentionally not written back
}

/** Evaluate a Value WITHOUT persisting the rng — a read-only cost preview (see evalConditionReadOnly).
 *  Lets a per-cast cost mod scale live with a stack count (e.g. "1 less per Call Tides stack"). */
export function evalValueReadOnly(state: MatchState, caster: Unit, value: Value): number {
  const rng = Rng.fromState(state.rngState);
  const bus = createBus(state, rng);
  const ctx: Ctx = { state, rng, caster, self: caster, targets: [], it: null, vars: {}, emit: bus.emit };
  return evalValue(value, ctx); // rng intentionally not written back
}

/** Emit a standalone event (scheduler turn/round hooks, DoT deaths). Saves rng state. */
export function emit(state: MatchState, event: GameEvent): void {
  const rng = Rng.fromState(state.rngState);
  createBus(state, rng).emit(event);
  state.rngState = rng.state;
}

// --------------------------------------------------------------------------- //
//  Interrupt flow — counters & reflects (fire when a skill is DECLARED)
// --------------------------------------------------------------------------- //
export interface DeclarationResult {
  /** True if a Counter negated the skill (its effects must not run). */
  cancelled: boolean;
  /** The targets the skill should resolve against (redirected by any Reflect). */
  finalTargets: Unit[];
  countererId?: string;
}

/** First applicable "replace" trigger for a declared skill (The Whimsy Engine), in unit order. */
function findReplace(state: MatchState, rng: Rng, bus: Bus, event: GameEvent): { owner: Unit; trig: TriggeredEffect } | null {
  const ordered = [...state.teams.A.units, ...state.teams.B.units];
  for (const id of ordered) {
    const owner = state.units[id];
    if (!owner || !owner.alive) continue;
    for (const trig of owner.triggers ?? []) {
      if (trig.on !== "skillDeclared" || trig.kind !== "replace") continue;
      const tctx: Ctx = { state, rng, caster: owner, self: owner, targets: [], it: null, vars: {}, event, emit: bus.emit };
      if (trig.when && !evalCondition(trig.when, tctx)) continue;
      return { owner, trig };
    }
  }
  return null;
}

/** First applicable counter/reflect trigger for a declared skill, in unit order. */
function findInterrupt(state: MatchState, rng: Rng, bus: Bus, event: GameEvent): { owner: Unit; trig: TriggeredEffect } | null {
  const ordered = [...state.teams.A.units, ...state.teams.B.units];
  for (const id of ordered) {
    const owner = state.units[id];
    if (!owner || !owner.alive) continue;
    for (const trig of owner.triggers ?? []) {
      if (trig.on !== "skillDeclared") continue;
      const kind = trig.kind ?? "react";
      if (kind !== "counter" && kind !== "reflect") continue;
      const tctx: Ctx = { state, rng, caster: owner, self: owner, targets: [], it: null, vars: {}, event, emit: bus.emit };
      if (trig.when && !evalCondition(trig.when, tctx)) continue;
      return { owner, trig };
    }
  }
  return null;
}

/**
 * Resolve the declare phase of a skill: run any counter/reflect that intercepts it.
 * A Counter cancels the skill (and runs its own effect). A Reflect redirects the
 * target and re-checks, up to MAX_TRIGGER_DEPTH bounces (reflect-vs-reflect terminates).
 */
export function resolveDeclaration(state: MatchState, caster: Unit, skill: SkillInstance, targets: Unit[]): DeclarationResult {
  const rng = Rng.fromState(state.rngState);
  const bus = createBus(state, rng);
  let current = targets;
  try {
    // A "replace" trigger (The Whimsy Engine) substitutes the declared skill entirely. Checked BEFORE
    // Uncounterable, because a replacement is not a counter/reflect and applies even to uncounterable skills.
    {
      const event: GameEvent = { type: "skillDeclared", caster: caster.id, skillId: skill.id, tags: skill.tags, targets: current.map((t) => t.id), hidden: skillIsInvisible(caster, skill) };
      const rep = findReplace(state, rng, bus, event);
      if (rep) {
        const tctx: Ctx = { state, rng, caster: rep.owner, self: rep.owner, targets: [], it: null, vars: {}, skillId: rep.trig.sourceSkillId ?? ownerPassiveId(rep.owner), event, emit: bus.emit };
        runAll(rep.trig.effect, tctx);
        if (rep.trig.once) rep.owner.triggers = (rep.owner.triggers ?? []).filter((t) => t !== rep.trig);
        return { cancelled: true, finalTargets: current };
      }
    }
    // Uncounterable: the skill cannot be countered/reflected (tag, a caster status, or a
    // per-skill conditional gate that holds right now — e.g. gommar3 while Frost-Covered).
    const condUncounterable =
      skill.uncounterableIf &&
      evalCondition(skill.uncounterableIf, { state, rng, caster, self: caster, targets: [], it: null, vars: {}, emit: bus.emit });
    if (skill.tags.includes("Uncounterable") || caster.statuses.some((s) => s.kind === "uncounterable") || condUncounterable) {
      return { cancelled: false, finalTargets: current };
    }
    for (let bounce = 0; bounce < MAX_TRIGGER_DEPTH; bounce++) {
      const event: GameEvent = { type: "skillDeclared", caster: caster.id, skillId: skill.id, tags: skill.tags, targets: current.map((t) => t.id), hidden: skillIsInvisible(caster, skill) };
      const hit = findInterrupt(state, rng, bus, event);
      if (!hit) return { cancelled: false, finalTargets: current };
      const { owner, trig } = hit;
      const tctx: Ctx = { state, rng, caster: owner, self: owner, targets: [], it: null, vars: {}, skillId: trig.sourceSkillId ?? ownerPassiveId(owner), event, emit: bus.emit };
      runAll(trig.effect, tctx);
      if (trig.once) owner.triggers = (owner.triggers ?? []).filter((t) => t !== trig);
      if ((trig.kind ?? "react") === "counter") {
        bus.emit({ type: "counterFired", counterer: owner.id, caster: caster.id, skillId: skill.id });
        return { cancelled: true, finalTargets: current, countererId: owner.id };
      }
      const from = current[0]?.id;
      const dest = trig.redirectToId ? state.units[trig.redirectToId]
        : trig.redirectTo ? resolveSelector(trig.redirectTo, tctx)[0] : owner;
      if (dest && from) bus.emit({ type: "skillRedirected", caster: caster.id, skillId: skill.id, from, to: dest.id });
      current = dest ? [dest] : [];
    }
    state.log.push("reflect bounce cap hit");
    return { cancelled: false, finalTargets: current };
  } finally {
    state.rngState = rng.state;
  }
}

/** Run a skill's effect tree against the state (mutates it), seeding + saving rng. */
export function runEffects(
  state: MatchState,
  effects: Effect[],
  opts: { caster: Unit; self?: Unit; targets?: Unit[]; skillId?: string; targeting?: string; invisible?: boolean; disguiseAs?: string },
): string[] {
  const rng = Rng.fromState(state.rngState);
  const bus = createBus(state, rng);
  const affected = new Set<string>();
  const ctx: Ctx = {
    state, rng,
    caster: opts.caster,
    self: opts.self ?? opts.caster,
    targets: opts.targets ?? [],
    it: null,
    vars: {},
    skillId: opts.skillId,
    targeting: opts.targeting,
    invisible: opts.invisible,
    disguiseAs: opts.disguiseAs,
    affected,
    emit: bus.emit,
  };
  runAll(effects, ctx);
  state.rngState = rng.state;
  return [...affected]; // the units this skill touched (for "affected N targets" reads); statement-callers ignore it
}
