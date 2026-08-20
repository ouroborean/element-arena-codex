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
import { registerAugmentCustom, mutableSkill } from "./augment.ts";
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

// jealousyBasicsToGeneric — titania5 "Jealousy": when an ALLY triggers Prance, the OTHER ally (not the
// trigger-er, not Titania) has their basic abilities' Specific costs changed to Generic the following turn.
// Applies a skillId-scoped cost_currency_remap (read by effectiveCost) to each of that ally's basic skills.
registerCustom("jealousyBasicsToGeneric", (ctx, a) => {
  const trigger = resolveSelector("eventSource", ctx)[0]; // the ally who triggered Prance
  const others = resolveSelector({ faction: "allies", kind: "hero", includeSelf: false }, ctx).filter((u) => u.id !== trigger?.id);
  const dur = (a.duration as number | null) ?? 1;
  for (const ally of others) {
    for (const sk of ally.skills ?? []) {
      if (sk.klass !== "basic") continue;
      applyStatus(ally, { kind: "cost_currency_remap", skillId: sk.id, duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    }
  }
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

// conditionalCostReduction — keeper3 "Plot Twist": a cost reduction gated by a Condition that is
// RE-EVALUATED at each cast. Carried as a per-cast costMod on the skill itself (skills persist across
// rounds, so it survives the per-round status wipe — unlike a cost_mod status). effectiveCost evaluates
// the `when` live at cast time.
registerAugmentCustom("conditionalCostReduction", (unit, a) => {
  const skill = (unit.skills ?? []).find((s) => s.id === (a.skillId as string));
  if (!skill) return;
  skill.costMods = [...(skill.costMods ?? []), { magnitude: -num(a.amount), when: a.when as Condition }];
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

// scaleCoilDamage — saya2 "Link Coils": Saya Coil deals an additional `perCoilBonus` damage for every active
// coil. A `coil_damage_bonus` status that Saya's coil-tick amount reads live (statusMag) and adds to each coil
// hit — so N coils each deal +perCoilBonus×N (quadratic, per the authored note). Round-scoped, so a static
// roundStart trigger re-applies it each battle (and once immediately for the drafted round).
registerAugmentCustom("scaleCoilDamage", (unit, a) => {
  const bonus = num(a.perCoilBonus);
  applyStatus(unit, { kind: "coil_damage_bonus", magnitude: bonus, duration: null, appliedBy: unit.id, appliedTurn: 0 });
  unit.triggers = [...(unit.triggers ?? []), {
    on: "roundStart", owner: unit.id, source: "Link Coils", origin: "augment",
    effect: [{ op: "applyStatus", to: "self", status: { kind: "coil_damage_bonus", magnitude: bonus, duration: null } }],
  }];
});

// relaxSerumTargeting — FAITHFUL no-op: the "only Dennis" restriction the augment relaxes was never
// encoded in this engine (the serums already target `single`), so there is nothing to lift.
registerAugmentCustom("relaxSerumTargeting", () => { /* nothing to relax */ });

// capShieldAbsorbPerHit — "Good Pacing": Keeper's Shield can only absorb up to `max` from a single hit
// (overflow falls through to HP). A `shield_absorb_cap` status the damage pipeline reads (damage.ts). The
// status is round-scoped, so a static roundStart trigger re-applies it each battle (and once immediately for
// the drafted round). (Shields aren't source-tagged, so the cap applies to all of Keeper's shield — see note.)
registerAugmentCustom("capShieldAbsorbPerHit", (unit, a) => {
  const max = num(a.max);
  applyStatus(unit, { kind: "shield_absorb_cap", magnitude: max, duration: null, appliedBy: unit.id, appliedTurn: 0 });
  unit.triggers = [...(unit.triggers ?? []), {
    on: "roundStart", owner: unit.id, source: "Good Pacing", origin: "augment",
    effect: [{ op: "applyStatus", to: "self", status: { kind: "shield_absorb_cap", magnitude: max, duration: null } }],
  }];
});

// channelCopies — galazax1 "Twin Storms": Galazax may Channel up to `maxCopies` separate copies of The Sky
// Darkens. Set channelCopies on the skill (each live copy then gets a distinct instanceId and re-runs
// independently; sibling copies survive a re-cast) and relax its base single-copy gate to "< maxCopies live
// copies". Rides on the skill (persists across rounds) — clone-safe via mutableSkill.
registerAugmentCustom("channelCopies", (unit, a) => {
  const skillId = a.skillId as string;
  const maxCopies = num(a.maxCopies, 2);
  const sk = mutableSkill(unit, skillId);
  if (!sk) return;
  sk.channelCopies = maxCopies;
  sk.requires = { cmp: "<", left: { ref: "statusCount", kind: "channeling", name: skillId, of: "self" }, right: maxCopies };
});

// splitIncomingSingleTargetDamageAcrossCinders — "Blackened Soul": Jarrik splits all single-target damage
// received between him and any active Cinders (marks on his enemies). A `split_incoming` status the damage op
// reads to divide a single-target hit evenly across Jarrik + the opposing-team bearers of the "Cinders" mark.
// Round-scoped, so a static roundStart trigger re-applies it each battle (and once immediately for the draft).
registerAugmentCustom("splitIncomingSingleTargetDamageAcrossCinders", (unit) => {
  applyStatus(unit, { kind: "split_incoming", name: "Cinders", duration: null, appliedBy: unit.id, appliedTurn: 0 });
  unit.triggers = [...(unit.triggers ?? []), {
    on: "roundStart", owner: unit.id, source: "Blackened Soul", origin: "augment",
    effect: [{ op: "applyStatus", to: "self", status: { kind: "split_incoming", name: "Cinders", duration: null } }],
  }];
});
