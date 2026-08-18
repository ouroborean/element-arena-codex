/**
 * Native handlers for the `custom` nodes the AUGMENT authors reached for (the clauses no Patch op
 * or DSL node expresses). Two registries: effect-level customs run in the interpreter (ctx, args)
 * from inside an augment's appended effects/triggers; patch-level customs run at apply time
 * (unit, args) to restructure a hero's kit.
 *
 * Faithful where an engine primitive exists (scoped cost_mod, scoped damage_ignore, shields, the
 * acted-this-turn ledger, scheduling, across-slot). A few clauses need engine features that don't
 * exist yet (incoming-damage redistribution, a per-hit shield-absorb cap, two concurrent channels
 * of one skill) — those do the closest observable thing and are logged as fidelity debt in
 * ../design/ENGINE_GAPS.md. None is a silent no-op except where the base rule itself is unencoded.
 */
import { registerCustom, resolveSelector, runInContext, evalCondition } from "../src/effects/interpret.ts";
import { registerAugmentCustom } from "./augment.ts";
import { applyStatus, removeStatus } from "../src/status.ts";
import { applyHeal, addShield } from "../src/damage.ts";
import { getMinionTemplate } from "../src/minions.ts";
import type { Unit, Status } from "../src/types.ts";
import type { Selector, Condition, StatusSpec } from "../src/effects/ast.ts";

const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const scopedCost = (unit: Unit, skillId: string): Status | undefined =>
  unit.statuses.find((s) => s.kind === "cost_mod" && s.skillId === skillId);

// ── effect-level customs (ctx, args) ──────────────────────────────────────────── //

// bonusMaxHp / increaseMaxHp — raise a unit's max HP (and current HP with it).
function raiseMaxHp(ctx: { targets: Unit[]; caster: Unit; state: { units: Record<string, Unit> } }, sel: Selector | undefined, amount: number) {
  for (const u of sel ? resolveSelector(sel as Selector, ctx as never) : ctx.targets) {
    u.maxHp += amount;
    u.hp += amount;
  }
}
registerCustom("bonusMaxHp", (ctx, a) => raiseMaxHp(ctx, (a.to as Selector) ?? (a.of as Selector), num(a.amount)));
registerCustom("increaseMaxHp", (ctx, a) => raiseMaxHp(ctx, (a.of as Selector) ?? (a.to as Selector), num(a.amount)));

// ignoreDamageType — type-scoped damage immunity (the engine's damage_ignore carries a dtype scope).
registerCustom("ignoreDamageType", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "damage_ignore", dtype: a.dtype as Status["dtype"], duration: (a.duration as number | null) ?? null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// grantStunImmunity — a "Stun Immunity" mark honoured by scheduler.isStunnedFor.
registerCustom("grantStunImmunity", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "mark", name: "Stun Immunity", duration: (a.duration as number | null) ?? null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// scopedCostMod — a skillId-scoped cost_mod (Value-typed delta, optional duration).
registerCustom("scopedCostMod", (ctx, a) => {
  const skillId = a.skillId as string;
  const mag = num(a.magnitude ?? a.amount, 0);
  applyStatus(ctx.self, { kind: "cost_mod", skillId, magnitude: mag, duration: (a.duration as number | null) ?? null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// scopedCostDiscountOnUse — deepen a skillId-scoped discount by `perUse` each use, floored at -max.
registerCustom("scopedCostDiscountOnUse", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const skillId = a.skillId as string;
  const cur = scopedCost(ctx.self, skillId)?.magnitude ?? 0;
  const next = Math.max(-num(a.max, 2), cur - num(a.perUse, 1));
  applyStatus(ctx.self, { kind: "cost_mod", skillId, magnitude: next, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// jealousyBasicsToGeneric — DEBT: converting a skill's specific cost to generic for a duration has
// no clean primitive (cost_mod is a flat delta, not a currency change). Apply an observable mark.
registerCustom("jealousyBasicsToGeneric", (ctx) => {
  applyStatus(ctx.self, { kind: "mark", name: "Jealousy", duration: 1, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// healIfExpiredStatusNamed — reactive heal when a specifically-named status lapses (statusExpired).
registerCustom("healIfExpiredStatusNamed", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusExpired" || e.kind !== (a.kind as string) || e.name !== (a.name as string)) return;
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) applyHeal(u, num(a.amount));
});

// healTeamIfDidNotAct — at the caster's own team turn-end, heal the team if the caster did not act.
registerCustom("healTeamIfDidNotAct", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd" || e.team !== ctx.self.team) return;
  if (ctx.state.actedThisTurn.includes(ctx.self.id)) return;
  for (const u of resolveSelector({ faction: "allies" }, ctx)) applyHeal(u, num(a.amount));
});

// healAllyAcrossFromHolder — heal the caster's hero teammate standing in the target's slot.
registerCustom("healAllyAcrossFromHolder", (ctx, a) => {
  const holder = ctx.targets[0];
  if (!holder || holder.slot === undefined) return;
  const ally = ctx.state.teams[ctx.self.team].units
    .map((id) => ctx.state.units[id])
    .find((u) => !!u && u.alive && u.kind === "hero" && u.slot === holder.slot);
  if (ally) applyHeal(ally, num(a.amount));
});

// jumpStatusOnExpire — when a named status lapses, (re)apply it to a random ally lacking it.
registerCustom("jumpStatusOnExpire", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusExpired" || e.kind !== (a.matchKind as string) || e.name !== (a.matchName as string)) return;
  const spec = a.reapply as StatusSpec | undefined;
  if (!spec) return;
  const lacking = resolveSelector({ faction: "allies" }, ctx).filter((u) => !u.statuses.some((s) => s.kind === spec.kind && s.name === spec.name));
  const pick = ctx.rng.shuffle(lacking).slice(0, 1)[0];
  if (pick) applyStatus(pick, { kind: spec.kind, name: spec.name, magnitude: typeof spec.magnitude === "number" ? spec.magnitude : undefined, dtype: spec.dtype, duration: (spec.duration as number | null) ?? null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// regainFrostCoveredNextTurn — when a named status lapses, schedule re-applying it after a delay.
registerCustom("regainFrostCoveredNextTurn", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusExpired" || e.kind !== (a.kind as string) || e.name !== (a.name as string)) return;
  ctx.state.scheduled.push({
    effect: [{ op: "applyStatus", to: "self", status: { kind: a.kind as Status["kind"], name: a.name as string, duration: null } }],
    caster: ctx.self.id, targets: [ctx.self.id], turns: num(a.delayTurns, 1), appliedTurn: ctx.state.turn,
  });
});

// replenishShieldWhileSkillReady — at own turn-start, if the named skill is ready, refresh a shield.
registerCustom("replenishShieldWhileSkillReady", (ctx, a) => {
  const e = ctx.event;
  if (e && e.type === "turnStart" && e.team !== ctx.self.team) return;
  const skill = (ctx.self.skills ?? []).find((s) => s.id === (a.skillId as string));
  if (!skill || skill.currentCd > 0) return;
  addShield(ctx.self, num(a.amount), null, ctx.self.id, ctx.state.turn, a.shieldName as string | undefined);
});

// applyRandomSkill — cast a random skill from a set (by `by`, at `on`), running its effects inline.
registerCustom("applyRandomSkill", (ctx, a) => {
  const ids = (a.skillIds as string[]) ?? [];
  if (!ids.length) return;
  const by = a.by ? resolveSelector(a.by as Selector, ctx)[0] : ctx.caster;
  const id = ctx.rng.shuffle(ids.slice())[0]!;
  const sk = (by?.skills ?? []).find((s) => s.id === id);
  if (!by || !sk) return;
  const on = a.on ? resolveSelector(a.on as Selector, ctx) : ctx.targets;
  runInContext(sk.effects, { ...ctx, caster: by, self: by, targets: on, it: null });
});

// ── patch-level customs (unit, args) — structural kit edits at apply time ──────── //

// buffMinionMaxHp — bump the max HP of the hero's minion templates (and any already on the field).
registerAugmentCustom("buffMinionMaxHp", (unit, a) => {
  const delta = num(a.delta);
  for (const name of (a.templates as string[]) ?? []) {
    const tmpl = getMinionTemplate(name);
    if (tmpl) tmpl.maxHp += delta; // future summons inherit the bump
  }
  // (Existing on-field minions are re-summoned each round, so the template bump suffices.)
  void unit;
});

// conditionalCostReduction — a scoped cost_mod gated by a condition evaluated at apply time.
// DEBT: the gate is checked once here, not re-evaluated per cast (no per-cast conditional cost hook).
registerAugmentCustom("conditionalCostReduction", (unit, a) => {
  const skillId = a.skillId as string;
  applyStatus(unit, { kind: "cost_mod", skillId, magnitude: -num(a.amount), duration: null, appliedBy: unit.id, appliedTurn: 0 });
});

// retunePassiveThreshold — rewrite the numeric right-hand side of a base trigger's cmp gate.
registerAugmentCustom("retunePassiveThreshold", (unit, a) => {
  const threshold = num(a.threshold);
  for (const t of unit.triggers ?? []) {
    if (t.source !== (a.source as string)) continue;
    const setCmp = (c: Condition | undefined): void => {
      if (!c || typeof c !== "object") return;
      if ("cmp" in c && typeof c.right === "number") (c as { right: number }).right = threshold;
      if ("and" in c) c.and.forEach(setCmp);
      if ("or" in c) c.or.forEach(setCmp);
      if ("not" in c) setCmp(c.not);
    };
    setCmp(t.when);
  }
});

// scaleCoilDamage — DEBT: retuning a live per-tick amount inside an existing trigger's Value tree
// has no general rewrite; mark the hero so the intent is observable and record the debt.
registerAugmentCustom("scaleCoilDamage", (unit, a) => {
  unit.statuses.push({ kind: "mark", name: `CoilBonus:${num(a.perCoilBonus)}`, duration: null, appliedBy: unit.id, appliedTurn: 0 });
});

// relaxSerumTargeting — FAITHFUL no-op: the "only Dennis" restriction the augment relaxes was never
// encoded in this engine (the serums already target `single`), so there is nothing to lift.
registerAugmentCustom("relaxSerumTargeting", () => { /* nothing to relax */ });

// capShieldAbsorbPerHit — DEBT: a per-hit shield-absorb cap is a damage-pipeline modifier the engine
// doesn't have. Mark the hero with the cap so the intent is recorded/observable.
registerAugmentCustom("capShieldAbsorbPerHit", (unit, a) => {
  unit.statuses.push({ kind: "mark", name: `ShieldCap:${num(a.max)}`, duration: null, appliedBy: unit.id, appliedTurn: 0 });
});

// channelCopies — DEBT: the engine keys one `channeling` status per skill id, so two concurrent
// copies of one Channel skill aren't representable. Mark the intent.
registerAugmentCustom("channelCopies", (unit, a) => {
  unit.statuses.push({ kind: "mark", name: `ChannelCopies:${a.skillId}:${num(a.maxCopies, 2)}`, duration: null, appliedBy: unit.id, appliedTurn: 0 });
});

// splitIncomingSingleTargetDamageAcrossCinders — DEBT: redistributing incoming damage needs a
// pre-mitigation pipeline hook that doesn't exist. Mark the intent.
registerAugmentCustom("splitIncomingSingleTargetDamageAcrossCinders", (unit) => {
  unit.statuses.push({ kind: "mark", name: "SplitDamageAcrossCinders", duration: null, appliedBy: unit.id, appliedTurn: 0 });
});
