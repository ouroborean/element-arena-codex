import { test } from "node:test";
import assert from "node:assert/strict";
import "../content/fusion_effects.ts"; // register the implemented fusion handlers
import { emit, runEffects } from "../src/effects/interpret.ts";
import { performAction, tickTriggersForTeam, startRound, effectiveCost, endTurn, legalTargets, grantIncome, tickDots } from "../src/scheduler.ts";
import { Rng } from "../src/rng.ts";
import { stackCount, rawStackCount, applyStatus } from "../src/status.ts";
import { applyDamage, outgoingDtypeOverride } from "../src/damage.ts";
import { registerMinion } from "../src/minions.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { TriggeredEffect } from "../src/events.ts";
import type { Effect } from "../src/effects/ast.ts";

// Cluster 1 — combat-event reactions. Each mechanic is driven by emitting the event its trigger
// keys on, then asserting the handler read the event/ledger correctly.

function withTrigger(id: string, team: "A" | "B", trig: Omit<TriggeredEffect, "owner">, over = {}) {
  const u = makeUnit({ id, team, ...over });
  u.triggers = [{ ...trig, owner: id }];
  return u;
}
const custom = (fn: string, args: Record<string, unknown> = {}): Effect => ({ op: "custom", fn, args });

test("storeDamageDealt banks the damage amount into a stack", () => {
  const rd = withTrigger("rd", "A", { on: "damageDealt", source: "Blood", effect: [custom("storeDamageDealt", { name: "Blood in the Water", to: "self" })] });
  const state = makeState([rd], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "damageDealt", source: "rd", target: "e", amount: 12, dtype: "normal" });
  emit(state, { type: "damageDealt", source: "rd", target: "e", amount: 8, dtype: "normal" });
  assert.equal(stackCount(rd, "Blood in the Water"), 20, "banked 12 + 8");
});

test("storeHealing banks a heal amount into a tally", () => {
  const rd = withTrigger("rd", "A", { on: "healReceived", source: "Mirror", effect: [custom("storeHealing", { name: "Reflection of Kindness", to: "self" })] });
  const state = makeState([rd], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "healReceived", unit: "e", source: null, amount: 30 });
  assert.equal(stackCount(rd, "Reflection of Kindness"), 30);
});

test("gainRitualPower accrues hp lost, capped at max", () => {
  const j = withTrigger("j", "A", { on: "damageDealt", source: "Ritual", effect: [custom("gainRitualPower", { stack: "Ritual Power", max: 120 })] });
  const state = makeState([j], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "damageDealt", source: "e", target: "j", amount: 100, dtype: "normal" });
  emit(state, { type: "damageDealt", source: "e", target: "j", amount: 100, dtype: "normal" });
  assert.equal(stackCount(j, "Ritual Power"), 120, "200 accrued but capped at 120");
});

test("repeatDamageDealt re-deals the same amount to the target, without re-triggering", () => {
  const laria = withTrigger("laria", "A", {
    on: "damageDealt", source: "Vanish",
    when: { and: [{ sameUnit: ["eventSource", "self"] }, { has: "damage_reduction", name: "Vanish", of: "self" }] },
    effect: [custom("repeatDamageDealt", { to: "eventTarget" })],
  });
  laria.statuses.push(status("damage_reduction", { name: "Vanish", magnitude: 0 }));
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([laria], [foe]);
  emit(state, { type: "damageDealt", source: "laria", target: "e", amount: 20, dtype: "normal" });
  assert.equal(foe.hp, 80, "repeated 20 once (no infinite loop)");
});

test("healAlliesWhenCurseOfThornsDeals heals allies only for the Curse of Thorns source", () => {
  const maggie = withTrigger("m", "A", { on: "damageDealt", source: "Blood", when: { sameUnit: ["eventSource", "self"] }, effect: [custom("healAlliesWhenCurseOfThornsDeals", { healAmount: 5 })] });
  const ally = makeUnit({ id: "al", team: "A", hp: 50 });
  const state = makeState([maggie, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "damageDealt", source: "m", target: "e", amount: 7, dtype: "affliction", sourceId: "Something Else" });
  assert.equal(ally.hp, 50, "non-Curse damage does not heal");
  emit(state, { type: "damageDealt", source: "m", target: "e", amount: 7, dtype: "affliction", sourceId: "Curse of Thorns" });
  assert.equal(ally.hp, 55, "Curse of Thorns damage heals allies 5");
});

test("healLockUnitsDamagedByCurseOfThorns heal-locks the hit unit on Curse damage", () => {
  const maggie = withTrigger("m", "A", { on: "damageDealt", source: "Curse", when: { sameUnit: ["eventSource", "self"] }, effect: [custom("healLockUnitsDamagedByCurseOfThorns", { durationTurns: 1 })] });
  const foe = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [foe]);
  emit(state, { type: "damageDealt", source: "m", target: "e", amount: 5, dtype: "affliction", sourceId: "Curse of Thorns" });
  assert.ok(foe.statuses.some((s) => s.kind === "heal_lock"), "hit unit is heal-locked");
});

test("addCurseStackIfMaggieDidNotAct adds a stack only when Maggie did not act this turn", () => {
  const maggie = withTrigger("m", "A", { on: "turnEnd", source: "Zealot", effect: [custom("addCurseStackIfMaggieDidNotAct", { name: "Curse of Thorns", amount: 1 })] });
  const foe = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [foe]);

  state.actedThisTurn = ["m"]; // Maggie acted
  emit(state, { type: "turnEnd", team: "A" });
  assert.equal(stackCount(foe, "Curse of Thorns"), 0, "acted → no spread");

  state.actedThisTurn = []; // Maggie idled
  emit(state, { type: "turnEnd", team: "A" });
  assert.equal(stackCount(foe, "Curse of Thorns"), 1, "idled → +1 Curse stack on the enemy");
});

// Cluster 2 — watch windows (dynamic triggers). The active installs a temporary trigger; we emit the
// event it watches, then check it fires, respects `once`, and expires after its turns.

const install = (fn: string, args: Record<string, unknown>, caster: any, targets: any[], state: any) =>
  runEffects(state, [{ op: "custom", fn, args } as Effect], { caster, self: caster, targets });

test("searchAndRescueWatch heals + shields an ally who is stunned during the window", () => {
  const syl = makeUnit({ id: "syl", team: "A" });
  const ally = makeUnit({ id: "al", team: "A", hp: 50 });
  const state = makeState([syl, ally], [makeUnit({ id: "e", team: "B" })]);
  install("searchAndRescueWatch", { turns: 4, healAmount: 20, invulnDuration: 1 }, syl, [], state);
  // an ally becomes stunned → the watch fires
  ally.statuses.push(status("stun", { duration: 1 }));
  emit(state, { type: "statusApplied", unit: "al", source: "e", kind: "stun" });
  assert.equal(ally.hp, 70, "healed 20");
  assert.ok(ally.statuses.some((s) => s.kind === "invulnerable"), "shielded with invuln");
});

test("consecrationRetaliation retaliates for 2 turns, then the window expires", () => {
  const taryn = makeUnit({ id: "t", team: "A" });
  const ally = makeUnit({ id: "al", team: "A", hp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([taryn, ally], [enemy]);
  install("consecrationRetaliation", { turns: 2, damage: 10 }, taryn, [], state);

  emit(state, { type: "damageDealt", source: "e", target: "al", amount: 15, dtype: "normal" });
  assert.equal(enemy.hp, 90, "attacker took 10 retaliation");

  state.turn = 2; tickTriggersForTeam(state, "A"); // window: 2 → 1
  state.turn = 3; tickTriggersForTeam(state, "A"); // window: 1 → 0, removed
  emit(state, { type: "damageDealt", source: "e", target: "al", amount: 15, dtype: "normal" });
  assert.equal(enemy.hp, 90, "no retaliation after the window closed");
});

test("icySmileWatch is a one-shot: only the first hit on the target stuns it", () => {
  const titania = makeUnit({ id: "ti", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const dealer = makeUnit({ id: "d", team: "A" });
  const state = makeState([titania, dealer], [foe]);
  install("icySmileWatch", { turns: 1, target: "target", stunDuration: 1 }, titania, [foe], state);

  emit(state, { type: "damageDealt", source: "d", target: "e", amount: 10, dtype: "normal" });
  assert.equal(foe.statuses.filter((s) => s.kind === "stun").length, 1, "first hit stuns");
  foe.statuses = foe.statuses.filter((s) => s.kind !== "stun");
  emit(state, { type: "damageDealt", source: "d", target: "e", amount: 10, dtype: "normal" });
  assert.equal(foe.statuses.filter((s) => s.kind === "stun").length, 0, "once consumed — second hit does nothing");
});

test("notTodayReflect redirects a harmful skill aimed at the warded ally onto Taryn", () => {
  const taryn = makeUnit({ id: "t", team: "A", hp: 100 });
  const ally = makeUnit({ id: "al", team: "A", hp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", skills: [skill("atk", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful"] })] });
  const state = makeState([taryn, ally], [enemy]);
  state.teams.B.energy = { generic: 9 };
  install("notTodayReflect", { target: "target", turns: 1 }, taryn, [ally], state);

  performAction(state, { unit: "e", skillId: "atk", targets: ["al"] });
  assert.equal(ally.hp, 100, "ally unharmed — the skill was reflected");
  assert.equal(taryn.hp, 80, "Taryn took the reflected hit");
});

test("handOfMichaelWatch counters the target's harmful skill and adds bonus damage", () => {
  const taryn = makeUnit({ id: "t", team: "A", hp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, skills: [skill("atk", [{ op: "damage", amount: 30, to: "target" }], { tags: ["Harmful"] })] });
  const state = makeState([taryn], [enemy]);
  state.teams.B.energy = { generic: 9 };
  install("handOfMichaelWatch", { target: "target", turns: 1, counterBonus: 15 }, taryn, [enemy], state);

  const r = performAction(state, { unit: "e", skillId: "atk", targets: ["t"] });
  assert.equal(r.countered, true, "the target's harmful skill was countered");
  assert.equal(taryn.hp, 100, "the countered skill dealt no damage");
  assert.equal(enemy.hp, 85, "Hand of Michael dealt 15 back");
});

// Cluster 3 — self-skill mutation. The hazards are clone-safety (never corrupt the shared HeroDef)
// and idempotency (roundStart rewrites fire every round but apply once).
import { loadHero, type HeroDef } from "../content/hero.ts";
const zdef = (): HeroDef => ({
  id: "z", name: "Z", element: "wind", maxHp: 100, passive: { name: "p", description: "" }, triggers: [],
  skills: [skill("s2", [{ op: "damage", amount: 25, dtype: "piercing", to: "target" }], { cost: { generic: 1, specific: 0 } })],
});
const amt = (h: any) => (h.skills.find((s: any) => s.id === "s2").effects[0] as { amount: number }).amount;
const runOn = (hero: any, fn: string, args: Record<string, unknown>) => {
  const state = makeState([hero], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "custom", fn, args } as Effect], { caster: hero, self: hero, targets: [] });
};

test("self-skill mutation is clone-safe: patching one hero leaves the HeroDef and a teammate pristine", () => {
  const def = zdef();
  const u1 = loadHero(def, "A", "u1");
  const u2 = loadHero(def, "A", "u2");
  runOn(u1, "bumpSkillDamage", { skillId: "s2", delta: 5 });
  assert.equal(amt(u1), 30, "u1 patched");
  assert.equal(amt(u2), 25, "u2 untouched");
  assert.equal((def.skills[0]!.effects[0] as { amount: number }).amount, 25, "HeroDef pristine");
});

test("bumpSkillDamage compounds per trigger; dragonsHungerRewrite applies once (idempotent)", () => {
  const bump = loadHero(zdef(), "A", "b");
  runOn(bump, "bumpSkillDamage", { skillId: "s2", delta: 5 });
  runOn(bump, "bumpSkillDamage", { skillId: "s2", delta: 5 });
  assert.equal(amt(bump), 35, "two trigger fires → +10");

  const dragon = loadHero(zdef(), "A", "d");
  runOn(dragon, "dragonsHungerRewrite", { skillId: "s2", damageBonus: 5, healBonus: 5 });
  runOn(dragon, "dragonsHungerRewrite", { skillId: "s2", damageBonus: 5, healBonus: 5 });
  // dragonsHungerRewrite retargets Feed the Fire to all Fan-affected enemies by REPLACING its Fan-gated `if`
  // node; s2 here has no such `if`, so damage is untouched. It still sets targeting to all-enemies, idempotently
  // (once guard). The real Fan-filtered damage is covered in suite_pyrrha_fusions.
  assert.equal(amt(dragon), 25, "s2 has no Fan-gate to replace, so its damage is unchanged");
  assert.equal(dragon.skills!.find((s) => s.id === "s2")!.targeting, "all-enemies", "targeting rewritten, once");
});

test("setSkillDamageType / targeting rewrites / cost escalation edit the skill instance", () => {
  const t = loadHero(zdef(), "A", "t");
  runOn(t, "setSkillDamageType", { skillId: "s2", dtype: "affliction" });
  assert.equal((t.skills!.find((s) => s.id === "s2")!.effects[0] as { dtype: string }).dtype, "affliction");

  const g = loadHero(zdef(), "A", "g");
  runOn(g, "enterDreamscapeAffectsAll", { skillId: "s2" });
  assert.equal(g.skills!.find((s) => s.id === "s2")!.targeting, "all");

  const c = loadHero(zdef(), "A", "c");
  runOn(c, "escalateSkillCost", { skillId: "s2", generic: 1 });
  runOn(c, "escalateSkillCost", { skillId: "s2", generic: 1 });
  assert.equal(c.skills!.find((s) => s.id === "s2")!.cost.generic, 3, "1 base + 2 uses");
});

test("festeringBurnsRewrite makes the named dot permanent (once)", () => {
  const def: HeroDef = { id: "p", name: "P", element: "fire", maxHp: 100, passive: { name: "p", description: "" }, triggers: [],
    skills: [skill("s1", [{ op: "applyStatus", to: "target", status: { kind: "dot", name: "Fan the Flames", magnitude: 5, dtype: "affliction", duration: 3 } }], {})] };
  const p = loadHero(def, "A", "p");
  const state = makeState([p], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "custom", fn: "festeringBurnsRewrite", args: { skillId: "s1", dotName: "Fan the Flames" } } as Effect], { caster: p, self: p, targets: [] });
  const dot = (p.skills!.find((s) => s.id === "s1")!.effects[0] as { status: { duration: number | null } }).status;
  assert.equal(dot.duration, null, "the Fan the Flames dot is now permanent");
});

// Regression tests for the adversarial-review findings on clusters 2 & 3.

test("(review) a self-mutating skill keeps its cooldown — mutableSkill preserves object identity", () => {
  const def: HeroDef = { id: "m", name: "M", element: "fire", maxHp: 100, passive: { name: "p", description: "" }, triggers: [],
    skills: [skill("s", [{ op: "damage", amount: 5, to: "target" }, { op: "custom", fn: "escalateSkillCost", args: { skillId: "s", generic: 1 } }], { cost: { generic: 1, specific: 0 }, cooldown: 2, tags: ["Harmful"] })] };
  const hero = loadHero(def, "A", "m");
  const state = makeState([hero], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 9 };
  performAction(state, { unit: "m", skillId: "s", targets: ["e"] });
  const live = hero.skills!.find((s) => s.id === "s")!;
  assert.equal(live.currentCd, 2, "cooldown set on the LIVE instance despite the self-mutation");
  assert.equal(live.cost.generic, 2, "cost escalated on the same live instance");
});

test("(review) consecration retaliation does not re-trigger the dealer's own on-damage passive", () => {
  const taryn = makeUnit({ id: "t", team: "A" });
  taryn.triggers = [{ on: "damageDealt", owner: "t", source: "Guardian", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Guardian Suppressed", duration: 1 } }] }];
  const ally = makeUnit({ id: "al", team: "A", hp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([taryn, ally], [enemy]);
  runEffects(state, [{ op: "custom", fn: "consecrationRetaliation", args: { turns: 2, damage: 10 } } as Effect], { caster: taryn, self: taryn, targets: [] });
  emit(state, { type: "damageDealt", source: "e", target: "al", amount: 15, dtype: "normal" });
  assert.equal(enemy.hp, 90, "retaliation still deals 10");
  assert.ok(!taryn.statuses.some((s) => s.kind === "mark" && s.name === "Guardian Suppressed"), "the retaliation did not trip Taryn's own damageDealt passive (no emit)");
});

test("(review) dynamic watch triggers are cleared at round start; static triggers persist", () => {
  const u = makeUnit({ id: "u", team: "A" });
  u.triggers = [{ on: "turnStart", owner: "u", source: "Static", effect: [] }];
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "custom", fn: "consecrationRetaliation", args: { turns: 2, damage: 10 } } as Effect], { caster: u, self: u, targets: [] });
  assert.equal(u.triggers!.length, 2, "a dynamic watch was installed");
  startRound(state);
  assert.equal(u.triggers!.length, 1, "the dynamic watch was cleared at round start");
  assert.equal(u.triggers![0]!.source, "Static", "the static trigger persists");
});

// Cluster 4 — HP manipulation. Verified against exact prose.

test("swapHp / swapCurrentHp swap two units current HP only (max HP untouched)", () => {
  const x = makeUnit({ id: "x", team: "A", hp: 30, maxHp: 100 });
  const t = makeUnit({ id: "t", team: "B", hp: 70, maxHp: 80 });
  const state = makeState([x], [t]);
  runEffects(state, [{ op: "custom", fn: "swapHp", args: { a: "caster", b: "target" } } as Effect], { caster: x, self: x, targets: [t] });
  assert.equal(x.hp, 70); assert.equal(t.hp, 30);
  assert.equal(x.maxHp, 100, "max HP unchanged"); assert.equal(t.maxHp, 80);
});

test("setMaxHpToCurrent lowers max HP to current HP", () => {
  const t = makeUnit({ id: "t", team: "B", hp: 40, maxHp: 100 });
  const p = makeUnit({ id: "p", team: "A" });
  const state = makeState([p], [t]);
  runEffects(state, [{ op: "custom", fn: "setMaxHpToCurrent", args: { of: "target" } } as Effect], { caster: p, self: p, targets: [t] });
  assert.equal(t.maxHp, 40); assert.equal(t.hp, 40);
});

test("healWithOverhealToMaxHp heals; only the portion past max raises Max HP", () => {
  const s1 = { ...makeUnit({ id: "s1", team: "A", hp: 90, maxHp: 100 }), kind: "minion" as const };
  const s2 = { ...makeUnit({ id: "s2", team: "A", hp: 50, maxHp: 100 }), kind: "minion" as const };
  const rd = makeUnit({ id: "rd", team: "A" });
  const state = makeState([rd, s1, s2], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "custom", fn: "healWithOverhealToMaxHp", args: { amount: 15, to: { faction: "allies", kind: "minion" } } } as Effect], { caster: rd, self: rd, targets: [] });
  assert.equal(s1.hp, 105); assert.equal(s1.maxHp, 105, "5 past max -> max raised to 105");
  assert.equal(s2.hp, 65); assert.equal(s2.maxHp, 100, "no overheal -> max unchanged");
});

// Cluster 5 — resource & charge systems. Verified against exact prose.

test("reduceLeylineCostOnEssence lowers the syl5 specific cost by 1 per essence gain (floored)", () => {
  const syl = makeUnit({ id: "syl", team: "A", skills: [skill("syl5", [], { cost: { generic: 0, specific: 4 } })] });
  const state = makeState([syl], [makeUnit({ id: "e", team: "B" })]);
  const run = () => runEffects(state, [{ op: "custom", fn: "reduceLeylineCostOnEssence", args: { skillId: "syl5", amount: 1, min: 0 } } as Effect], { caster: syl, self: syl, targets: [] });
  run(); assert.equal(effectiveCost(syl, syl.skills![0]!).specific, 3, "one essence -> 4-1");
  run(); assert.equal(effectiveCost(syl, syl.skills![0]!).specific, 2, "two -> 4-2");
});

test("suppressLeylineCostDecay stops the per-turn decay while its mark is up", () => {
  const syl = makeUnit({ id: "syl", team: "A", skills: [skill("syl5", [], { cost: { generic: 0, specific: 4 } })] });
  const state = makeState([syl], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "custom", fn: "suppressLeylineCostDecay", args: { skillId: "syl5", turns: 4 } } as Effect], { caster: syl, self: syl, targets: [] });
  runEffects(state, [{ op: "custom", fn: "decaySkillCost", args: { skillId: "syl5", amount: 1, min: 0 } } as Effect], { caster: syl, self: syl, targets: [] });
  assert.equal(effectiveCost(syl, syl.skills![0]!).specific, 4, "decay suppressed -> cost unchanged");
});

test("scorchedFleshCostAura raises only Strategic skill costs of Cinders-marked enemies", () => {
  const jarrik = makeUnit({ id: "j", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B", statuses: [status("mark", { name: "Cinders" })],
    skills: [skill("strat", [], { cost: { generic: 1, specific: 0 }, tags: ["Strategic"] }), skill("atk", [], { cost: { generic: 1, specific: 0 }, tags: ["Harmful"] })] });
  const clean = makeUnit({ id: "e2", team: "B", skills: [skill("strat2", [], { cost: { generic: 1, specific: 0 }, tags: ["Strategic"] })] });
  const state = makeState([jarrik], [enemy, clean]);
  runEffects(state, [{ op: "custom", fn: "scorchedFleshCostAura", args: { mark: "Cinders", tag: "Strategic", amount: 1 } } as Effect], { caster: jarrik, self: jarrik, targets: [] });
  assert.equal(effectiveCost(enemy, enemy.skills![0]!).generic, 2, "Strategic +1");
  assert.equal(effectiveCost(enemy, enemy.skills![1]!).generic, 1, "Harmful unaffected");
  assert.equal(effectiveCost(clean, clean.skills![0]!).generic, 1, "un-Cinders enemy unaffected");
});

test("magneticFieldCharge: same-polarity re-use punishes; Strategic clears charge", () => {
  const saya = makeUnit({ id: "s", team: "A" });
  saya.triggers = [{ on: "skillUsed", owner: "s", source: "Magnet", when: { isFaction: "eventSource", faction: "enemy" }, effect: [{ op: "custom", fn: "magneticFieldCharge", args: { posMark: "Positive Charge", negMark: "Negative Charge", damage: 15, stunTurns: 1 } }] }];
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([saya], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.ok(enemy.statuses.some((s) => s.kind === "mark" && s.name === "Negative Charge"), "first Harmful -> Negative charge");
  assert.equal(enemy.hp, 100, "no punish on the first");
  emit(state, { type: "skillUsed", caster: "e", skillId: "y", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 85, "Harmful while Negative -> 15 damage");
  assert.ok(enemy.statuses.some((s) => s.kind === "stun"), "and stunned");
  emit(state, { type: "skillUsed", caster: "e", skillId: "z", targets: [], tags: ["Strategic"] });
  assert.ok(!enemy.statuses.some((s) => s.kind === "mark" && s.name === "Negative Charge"), "Strategic clears charge");
});

test("magneticFieldCharge: alternating polarity flips the charge and does not punish", () => {
  const saya = makeUnit({ id: "s", team: "A" });
  saya.triggers = [{ on: "skillUsed", owner: "s", source: "Magnet", when: { isFaction: "eventSource", faction: "enemy" }, effect: [{ op: "custom", fn: "magneticFieldCharge", args: { posMark: "Positive Charge", negMark: "Negative Charge", damage: 15, stunTurns: 1 } }] }];
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([saya], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "1", targets: [], tags: ["Harmful"] }); // -> Negative
  emit(state, { type: "skillUsed", caster: "e", skillId: "2", targets: [], tags: ["Helpful"] }); // flips to Positive, no punish
  assert.equal(enemy.hp, 100, "flipping polarity does not punish");
  assert.ok(enemy.statuses.some((s) => s.kind === "mark" && s.name === "Positive Charge"), "now Positive");
  assert.ok(!enemy.statuses.some((s) => s.kind === "mark" && s.name === "Negative Charge"), "Negative cleared (single polarity)");
});

test("coldAndAloneAccrue stacks on Invulnerable/Isolated enemies each enemy turn-end, stuns at 3", () => {
  const zeph = makeUnit({ id: "z", team: "A" });
  zeph.triggers = [{ on: "turnEnd", owner: "z", source: "Cold", effect: [{ op: "custom", fn: "coldAndAloneAccrue", args: { stack: "Cold and Alone", threshold: 3, stunDuration: 1 } }] }];
  const enemy = makeUnit({ id: "e", team: "B", statuses: [status("invulnerable", { duration: null })] });
  const state = makeState([zeph], [enemy]);
  emit(state, { type: "turnEnd", team: "A" }); // not the enemies' turn — no accrue
  assert.equal(stackCount(enemy, "Cold and Alone"), 0);
  emit(state, { type: "turnEnd", team: "B" });
  emit(state, { type: "turnEnd", team: "B" });
  assert.equal(stackCount(enemy, "Cold and Alone"), 2);
  emit(state, { type: "turnEnd", team: "B" });
  assert.ok(enemy.statuses.some((s) => s.kind === "stun"), "3 stacks -> stunned");
  assert.equal(stackCount(enemy, "Cold and Alone"), 0, "and the stacks reset");
});

test("capacitorUpgradeOnExpel deals perStack x stacks bonus on Expel Energy, then consumes the stacks", () => {
  const ando = makeUnit({ id: "a", team: "A", statuses: [status("stack", { name: "Capacitor Upgrade", magnitude: 3 })] });
  ando.triggers = [{ on: "skillUsed", owner: "a", source: "Cap", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "custom", fn: "capacitorUpgradeOnExpel", args: { skillId: "ando3", stackName: "Capacitor Upgrade", perStack: 5 } }] }];
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([ando], [foe]);
  emit(state, { type: "skillUsed", caster: "a", skillId: "ando1", targets: ["e"], tags: ["Harmful"] });
  assert.equal(foe.hp, 100, "a non-Expel skill does nothing");
  emit(state, { type: "skillUsed", caster: "a", skillId: "ando3", targets: ["e"], tags: ["Harmful"] });
  assert.equal(foe.hp, 85, "Expel Energy -> 5 x 3 bonus");
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 0, "stacks consumed");
});

// Cluster 6 — minion & summon variants. Verified against exact prose.

test("distributeShieldOnDeathRoundedTo5 splits Keeper's shield among allies, rounded up to 5", () => {
  const keeper = withTrigger("k", "A", { on: "unitDied", source: "Myth", effect: [custom("distributeShieldOnDeathRoundedTo5", { of: "self", to: { faction: "allies", kind: "hero", alive: true } })] });
  keeper.shields.push({ amount: 75, duration: null, appliedBy: "k", appliedTurn: 0 });
  const a1 = makeUnit({ id: "a1", team: "A" }); const a2 = makeUnit({ id: "a2", team: "A" });
  const state = makeState([keeper, a1, a2], [makeUnit({ id: "e", team: "B" })]);
  keeper.alive = false; keeper.hp = 0;
  emit(state, { type: "unitDied", unit: "k", killer: "e" });
  assert.equal(a1.shields.reduce((s, x) => s + x.amount, 0), 40, "ceil(75/2/5)*5 = 40");
  assert.equal(a2.shields.reduce((s, x) => s + x.amount, 0), 40);
});

test("minionsIgnoreCountersAndStuns tags only the named minion templates", () => {
  const xyris = makeUnit({ id: "x", team: "A" });
  const sim = { ...makeUnit({ id: "sim", team: "A", name: "Simulacrum" }), kind: "minion" as const, summoner: "x" };
  const other = { ...makeUnit({ id: "oth", team: "A", name: "Seedling" }), kind: "minion" as const, summoner: "x" };
  const state = makeState([xyris, sim, other], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [custom("minionsIgnoreCountersAndStuns", { templates: ["Simulacrum", "Dream Reflection"] })], { caster: xyris, self: xyris, targets: [] });
  assert.ok(sim.statuses.some((s) => s.kind === "uncounterable") && sim.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity"), "Simulacrum immune");
  assert.ok(!other.statuses.some((s) => s.kind === "uncounterable"), "other minion untouched");
});

test("createScavengerPile spawns on any death, but a Pile does not spawn another Pile", () => {
  const syl = withTrigger("syl", "A", { on: "unitDied", source: "Scav", effect: [custom("createScavengerPile", { template: "sylnomadminion", skipTemplates: ["sylnomadminion"] })] });
  const state = makeState([syl], [makeUnit({ id: "e", team: "B" })]);
  const minionCount = () => Object.values(state.units).filter((u) => u.kind === "minion").length;
  emit(state, { type: "unitDied", unit: "e", killer: "syl" });
  assert.equal(minionCount(), 1, "an enemy death made a pile");
  const pileId = Object.values(state.units).find((u) => u.kind === "minion")!.id;
  emit(state, { type: "unitDied", unit: pileId, killer: "e" });
  assert.equal(minionCount(), 1, "a pile's death makes no new pile");
});

test("eagleKillScavenger heals the Eagle 25 and cheapens Leyline only when the Eagle kills a Pile", () => {
  const syl = withTrigger("syl", "A", { on: "unitDied", source: "Scav", effect: [custom("eagleKillScavenger", { pileTemplate: "sylnomadminion", healAmount: 25, leylineSkillId: "syl5", costReduction: 1 })] });
  syl.skills = [skill("syl5", [], { cost: { generic: 0, specific: 4 } })];
  const eagle = { ...makeUnit({ id: "eg", team: "A", name: "Hatchling Eagle", hp: 50 }), kind: "minion" as const, summoner: "syl" };
  const pile = { ...makeUnit({ id: "p", team: "A", name: "sylnomadminion" }), kind: "minion" as const, summoner: "syl" };
  const state = makeState([syl, eagle, pile], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "unitDied", unit: "p", killer: "eg" });
  assert.equal(eagle.hp, 75, "Eagle healed 25");
  assert.equal(effectiveCost(syl, syl.skills![0]!).specific, 3, "Leyline specific cost -1");
});

test("pickTheBonesDamage deals 15, doubles vs a Pile, and grants team Essence on a kill", () => {
  const syl = makeUnit({ id: "syl", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const pile = { ...makeUnit({ id: "p", team: "B", name: "sylnomadminion", hp: 100 }), kind: "minion" as const };
  const state = makeState([syl], [foe, pile]);
  const run = (t: any) => runEffects(state, [custom("pickTheBonesDamage", { target: "target", base: 15, pileTemplate: "sylnomadminion", doubleVsPile: true })], { caster: syl, self: syl, targets: [t] });
  run(foe); assert.equal(foe.hp, 85, "15 to a normal enemy");
  run(pile); assert.equal(pile.hp, 70, "30 to a Pile (doubled)");
  const weak = makeUnit({ id: "w", team: "B", hp: 10 }); state.units.w = weak; state.teams.B.units.push("w");
  run(weak);
  assert.ok(!weak.alive, "killed"); assert.ok(syl.statuses.some((s) => s.kind === "elemental_essence"), "team gained Essence on the kill");
});

// Cluster 7 — damage multipliers. Verified against exact prose.

test("incomingDamageMultiplier halves NEW skill damage but not DoT ticks", () => {
  const gommar = makeUnit({ id: "g", team: "A", hp: 100 });
  const foe = makeUnit({ id: "e", team: "B" });
  const state = makeState([gommar], [foe]);
  runEffects(state, [custom("incomingDamageMultiplier", { of: "self", factor: 0.5, newOnly: true })], { caster: gommar, self: gommar, targets: [] });
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: foe, self: foe, targets: [gommar] });
  assert.equal(gommar.hp, 90, "new skill damage halved 20 -> 10");
  applyDamage(gommar, { amount: 20, type: "normal", isNew: false });
  assert.equal(gommar.hp, 70, "a DoT tick (not new) is not halved");
});

test("ritualDoubleAllDamage doubles incoming damage on every unit", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [foe]);
  runEffects(state, [custom("ritualDoubleAllDamage")], { caster: p, self: p, targets: [] });
  runEffects(state, [{ op: "damage", amount: 15, to: "target" } as Effect], { caster: p, self: p, targets: [foe] });
  assert.equal(foe.hp, 70, "15 doubled to 30");
});

test("tripleDamageThisTurn triples the target's OUTGOING damage", () => {
  const titania = makeUnit({ id: "t", team: "A" });
  const courtesan = makeUnit({ id: "c", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([titania, courtesan], [foe]);
  runEffects(state, [custom("tripleDamageThisTurn", { turns: 1, target: "target" })], { caster: titania, self: titania, targets: [courtesan] });
  runEffects(state, [{ op: "damage", amount: 10, to: "target" } as Effect], { caster: courtesan, self: courtesan, targets: [foe] });
  assert.equal(foe.hp, 70, "10 tripled to 30");
});

// Cluster 8 — damage-type override & conditional bypass. Verified against exact prose.

test("damageBecomesPiercing forces the dealers damage to Piercing (so it ignores DR)", () => {
  const taryn = makeUnit({ id: "t", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const state = makeState([taryn], [foe]);
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: taryn, self: taryn, targets: [foe] });
  assert.equal(foe.hp, 90, "baseline: 20 - 10 DR = 10");
  runEffects(state, [custom("damageBecomesPiercing", { to: "self", duration: 1 })], { caster: taryn, self: taryn, targets: [] });
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: taryn, self: taryn, targets: [foe] });
  assert.equal(foe.hp, 70, "Piercing ignores the 10 DR -> full 20");
});

test("bypassVsIsolated ignores DR+Shield only against Isolated targets", () => {
  const syl = makeUnit({ id: "syl", team: "A" });
  const iso = makeUnit({ id: "i", team: "B", hp: 100, statuses: [status("isolated", { duration: null })] });
  iso.shields.push({ amount: 50, duration: null, appliedBy: "i", appliedTurn: 0 });
  const norm = makeUnit({ id: "n", team: "B", hp: 100 });
  norm.shields.push({ amount: 50, duration: null, appliedBy: "n", appliedTurn: 0 });
  const state = makeState([syl], [iso, norm]);
  runEffects(state, [custom("bypassVsIsolated", { units: ["self"] })], { caster: syl, self: syl, targets: [] });
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: syl, self: syl, targets: [iso] });
  assert.equal(iso.hp, 80, "Isolated: shield bypassed, full 20 to HP");
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: syl, self: syl, targets: [norm] });
  assert.equal(norm.hp, 100, "non-Isolated: the 50 shield absorbs the 20");
});

test("bypassVsDreamscapeAffected makes Xyris bypass Shield vs the marked target", () => {
  const xyris = makeUnit({ id: "x", team: "A" });
  const marked = makeUnit({ id: "m", team: "B", hp: 100, statuses: [status("mark", { name: "Enter the Dreamscape" })] });
  marked.shields.push({ amount: 50, duration: null, appliedBy: "m", appliedTurn: 0 });
  const state = makeState([xyris], [marked]);
  runEffects(state, [custom("bypassVsDreamscapeAffected", { markName: "Enter the Dreamscape" })], { caster: xyris, self: xyris, targets: [] });
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: xyris, self: xyris, targets: [marked] });
  assert.equal(marked.hp, 80, "marked target: shield bypassed");
});

// Cluster 9 — heal-to-damage conversion & inverted HP. Verified against exact prose.

test("healReceivedBecomesAffliction turns the target's incoming healing into damage", () => {
  const titania = makeUnit({ id: "t", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 50 });
  const state = makeState([titania], [foe]);
  runEffects(state, [custom("healReceivedBecomesAffliction", { target: "target", turns: 3 })], { caster: titania, self: titania, targets: [foe] });
  runEffects(state, [{ op: "heal", amount: 20, to: "target" } as Effect], { caster: titania, self: titania, targets: [foe] });
  assert.equal(foe.hp, 30, "healing 20 instead dealt 20 damage");
});

test("Xyris curse: damage heals, healing damages, survives at 0, dies at 100", () => {
  const xyris = makeUnit({ id: "x", team: "A", hp: 100, maxHp: 100 });
  const foe = makeUnit({ id: "e", team: "B" });
  const state = makeState([xyris], [foe]);
  runEffects(state, [custom("curseStartAtOneHp", { to: "self", hp: 1 })], { caster: xyris, self: xyris, targets: [] });
  assert.equal(xyris.hp, 1, "starts at 1 HP");

  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: foe, self: foe, targets: [xyris] });
  assert.equal(xyris.hp, 21, "damage healed him toward 100");

  runEffects(state, [{ op: "heal", amount: 10, to: "target" } as Effect], { caster: xyris, self: xyris, targets: [xyris] });
  assert.equal(xyris.hp, 11, "healing damaged him");

  runEffects(state, [{ op: "heal", amount: 50, to: "target" } as Effect], { caster: xyris, self: xyris, targets: [xyris] });
  assert.equal(xyris.hp, 0);
  assert.ok(xyris.alive, "does NOT die at 0 HP");

  xyris.hp = 90;
  runEffects(state, [{ op: "damage", amount: 20, to: "target" } as Effect], { caster: foe, self: foe, targets: [xyris] });
  assert.equal(xyris.hp, 100);
  assert.ok(!xyris.alive, "dies when he reaches 100 HP");
});

// Cluster 10 — skill-use triggers, cleanses & simple status ops. Verified against exact prose.

test("invulnOnSkill / onStalwartShield / skylanceTauntAndShield / ominousRumble fire only on their skill", () => {
  const syl = withTrigger("s", "A", { on: "skillUsed", source: "Ninja", effect: [custom("invulnOnSkill", { skillId: "syl3", invulnDuration: 1 })] });
  const st = makeState([syl], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "skillUsed", caster: "s", skillId: "syl1", targets: [], tags: [] });
  assert.ok(!syl.statuses.some((x) => x.kind === "invulnerable"), "other skill: nothing");
  emit(st, { type: "skillUsed", caster: "s", skillId: "syl3", targets: [], tags: [] });
  assert.ok(syl.statuses.some((x) => x.kind === "invulnerable"), "To the Skies! -> invuln");

  const taryn = withTrigger("t", "A", { on: "skillUsed", source: "Angel", effect: [custom("onStalwartShield", { skillId: "taryn4", invulnDuration: 1 })] });
  const ally = makeUnit({ id: "al", team: "A" });
  const st2 = makeState([taryn, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(st2, { type: "skillUsed", caster: "t", skillId: "taryn4", targets: ["al"], tags: [] });
  assert.ok(taryn.statuses.some((x) => x.kind === "invulnerable") && ally.statuses.some((x) => x.kind === "invulnerable"), "Taryn + targeted ally invuln");
  assert.ok(taryn.statuses.some((x) => x.kind === "elemental_essence"), "Taryn gains Essence");

  const sy2 = withTrigger("sy", "A", { on: "skillUsed", source: "AngelSyl", effect: [custom("skylanceTauntAndShield", { skillId: "syl2", shieldAmount: 10, shieldDuration: 1 })] });
  const foe = makeUnit({ id: "e", team: "B" });
  const st3 = makeState([sy2], [foe]);
  emit(st3, { type: "skillUsed", caster: "sy", skillId: "syl2", targets: ["e"], tags: [] });
  assert.ok(foe.statuses.some((x) => x.kind === "taunt" && x.unitRef === "sy"), "target taunted onto Syl");
  assert.equal(sy2.shields.reduce((s, x) => s + x.amount, 0), 10, "Syl gains 10 shield");

  const zeph = withTrigger("z", "A", { on: "skillUsed", source: "Storm", effect: [custom("ominousRumbleOnWindStep", { triggerSkillId: "zephyrex4", mark: "Ominous Rumble" })] });
  const en = makeUnit({ id: "e", team: "B" });
  const st4 = makeState([zeph], [en]);
  emit(st4, { type: "skillUsed", caster: "z", skillId: "zephyrex4", targets: [], tags: [] });
  assert.ok(en.statuses.some((x) => x.kind === "mark" && x.name === "Ominous Rumble"), "enemies marked");
});

test("paralyzeCooldowns applies paralysis to the targets", () => {
  const xyris = makeUnit({ id: "x", team: "A" });
  const e1 = makeUnit({ id: "e1", team: "B" }); const e2 = makeUnit({ id: "e2", team: "B" });
  const st = makeState([xyris], [e1, e2]);
  runEffects(st, [custom("paralyzeCooldowns", { to: { faction: "enemies" }, duration: 1 })], { caster: xyris, self: xyris, targets: [] });
  assert.ok(e1.statuses.some((s) => s.kind === "paralysis") && e2.statuses.some((s) => s.kind === "paralysis"));
});

test("setStatusDuration overrides a named mark's duration when it is applied (no re-emit loop)", () => {
  const ando = withTrigger("a", "A", { on: "statusApplied", source: "Current", effect: [custom("setStatusDuration", { kind: "mark", name: "Electroblade", to: "eventUnit", duration: 3 })] });
  const foe = makeUnit({ id: "e", team: "B", statuses: [status("mark", { name: "Electroblade", duration: 1 })] });
  const st = makeState([ando], [foe]);
  emit(st, { type: "statusApplied", unit: "e", source: "a", kind: "mark", name: "Electroblade" });
  assert.equal(foe.statuses.find((s) => s.name === "Electroblade")!.duration, 3);
});

test("grantTieredShieldByAlliesActed scales 20/30/45 by allied heroes who acted", () => {
  const run = (acted: string[]) => {
    const k = makeUnit({ id: "k", team: "A" });
    const st = makeState([k, makeUnit({ id: "a1", team: "A" }), makeUnit({ id: "a2", team: "A" })], [makeUnit({ id: "e", team: "B" })]);
    st.actedThisTurn = acted;
    runEffects(st, [custom("grantTieredShieldByAlliesActed", { amounts: [20, 30, 45], to: "self" })], { caster: k, self: k, targets: [] });
    return k.shields.reduce((s, x) => s + x.amount, 0);
  };
  assert.equal(run([]), 20); assert.equal(run(["a1"]), 30); assert.equal(run(["a1", "a2"]), 45);
});

test("essenceHeal heals 10 on essence gain and heal-locks Saya from other healing", () => {
  const saya = withTrigger("s", "A", { on: "statusApplied", source: "Plasma", effect: [custom("essenceHeal", { statusKind: "elemental_essence", amount: 10 })] }, { hp: 50 });
  const st = makeState([saya], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "statusApplied", unit: "s", source: "s", kind: "elemental_essence" });
  assert.equal(saya.hp, 60, "healed 10");
  assert.ok(saya.statuses.some((s) => s.kind === "heal_lock"), "cannot be healed otherwise");
});

test("escalatingHeal heals 5 now and schedules 10 then 15", () => {
  const rd = withTrigger("rd", "A", { on: "skillUsed", source: "Glacier", effect: [custom("escalatingHeal", { to: "eventTarget", schedule: [{ delayTurns: 0, amount: 5 }, { delayTurns: 1, amount: 10 }, { delayTurns: 2, amount: 15 }] })] });
  const ally = makeUnit({ id: "al", team: "A", hp: 50 });
  const st = makeState([rd, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "skillUsed", caster: "rd", skillId: "soothe", targets: ["al"], tags: [] });
  assert.equal(ally.hp, 55, "immediate 5");
  assert.equal(st.scheduled.length, 2, "10 and 15 scheduled");
});

test("cleanseBeneficial / removeOneHarmful / cleanseEnemyEffects respect harmful vs beneficial vs provenance", () => {
  const enemy = makeUnit({ id: "e", team: "B", statuses: [status("invulnerable", { duration: 2 }), status("stun", { duration: 1 })] });
  const st = makeState([makeUnit({ id: "t", team: "A" })], [enemy]);
  runEffects(st, [custom("cleanseBeneficial", { from: "target", count: 1 })], { caster: st.units.t!, self: st.units.t!, targets: [enemy] });
  assert.ok(!enemy.statuses.some((s) => s.kind === "invulnerable"), "beneficial invuln removed");
  assert.ok(enemy.statuses.some((s) => s.kind === "stun"), "harmful stun kept");

  const ally = makeUnit({ id: "al", team: "A", statuses: [status("stun", { duration: 1 }), status("damage_reduction", { magnitude: 5 })] });
  const h = makeUnit({ id: "h", team: "A" });
  const st2 = makeState([h, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st2, [custom("removeOneHarmful", { from: "target" })], { caster: h, self: h, targets: [ally] });
  assert.ok(!ally.statuses.some((s) => s.kind === "stun"), "harmful removed");
  assert.ok(ally.statuses.some((s) => s.kind === "damage_reduction"), "beneficial kept");

  const ally2 = makeUnit({ id: "al2", team: "A" });
  ally2.statuses = [status("stun", { duration: 1, appliedBy: "foe" }), status("damage_reduction", { magnitude: 5, appliedBy: "al2" })];
  const st3 = makeState([makeUnit({ id: "h", team: "A" }), ally2], [makeUnit({ id: "foe", team: "B" })]);
  runEffects(st3, [custom("cleanseEnemyEffects", { to: "target" })], { caster: st3.units.h!, self: st3.units.h!, targets: [ally2] });
  assert.ok(!ally2.statuses.some((s) => s.kind === "stun"), "enemy-applied removed");
  assert.ok(ally2.statuses.some((s) => s.kind === "damage_reduction"), "self-applied kept");
});

// Cluster 11 — ledger punishes, chance procs, execute, links & targeting. Verified against exact prose.

test("risingGeyserLink replicates damage among Rising-Geyser-marked units, without looping", () => {
  const ando = makeUnit({ id: "a", team: "A" });
  const m1 = makeUnit({ id: "m1", team: "B", hp: 100, statuses: [status("mark", { name: "Rising Geyser" })] });
  const m2 = makeUnit({ id: "m2", team: "B", hp: 100, statuses: [status("mark", { name: "Rising Geyser" })] });
  const st = makeState([ando], [m1, m2]);
  runEffects(st, [custom("risingGeyserLink", { mark: "Rising Geyser" })], { caster: ando, self: ando, targets: [] });
  emit(st, { type: "damageDealt", source: "a", target: "m1", amount: 20, dtype: "normal", isNew: true });
  assert.equal(m2.hp, 80, "m2 replicated the 20 (new damage)");
  assert.equal(m1.hp, 100, "the hit unit is not self-replicated");
  emit(st, { type: "damageDealt", source: "a", target: "m1", amount: 8, dtype: "affliction" }); // a DoT tick (not new)
  assert.equal(m2.hp, 80, "DoT ticks are NOT replicated");
});

test("doubleGodOfThunder deals an extra hit equal to Ando's outgoing damage mod", () => {
  const ando = makeUnit({ id: "a", team: "A", statuses: [status("outgoing_damage_mod", { magnitude: 10 })] });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const st = makeState([ando], [e1]);
  runEffects(st, [custom("doubleGodOfThunder", { to: { faction: "enemies" } })], { caster: ando, self: ando, targets: [] });
  assert.equal(e1.hp, 90, "extra 10 piercing");
});

test("belphegorsBladeIdlePunish hits idle Jarrik + idle Cinders-enemies at turn-end", () => {
  const jarrik = withTrigger("j", "A", { on: "turnEnd", source: "Devil", effect: [custom("belphegorsBladeIdlePunish", { amount: 15, dtype: "affliction", mark: "Cinders" })] });
  const ci = makeUnit({ id: "ci", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const ca = makeUnit({ id: "ca", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const st = makeState([jarrik], [ci, ca]);
  st.actedThisTurn = ["ca"];
  emit(st, { type: "turnEnd", team: "B" });
  assert.equal(ci.hp, 85, "idle Cinders-enemy took 15");
  assert.equal(ca.hp, 100, "acted one spared");
  st.actedThisTurn = [];
  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(jarrik.hp, 85, "idle Jarrik took 15 on his turn-end");
});

test("constantFluxCoilTick deals base +/- a step-variance per coil to a random enemy", () => {
  const saya = makeUnit({ id: "s", team: "A", statuses: [status("stack", { name: "Saya Coil", magnitude: 2 })] });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const st = makeState([saya], [e1]);
  runEffects(st, [custom("constantFluxCoilTick", { base: 10, enhancedBase: 20, coilStack: "Saya Coil", enhancedStack: "Enhanced Saya Coil", varianceMin: -10, varianceMax: 10, step: 5, to: { pick: "random", from: { faction: "enemies" }, count: 1 } })], { caster: saya, self: saya, targets: [] });
  const dealt = 100 - e1.hp;
  assert.ok(dealt >= 0 && dealt <= 40 && dealt % 5 === 0, `2 coils -> [0,40] multiple of 5, got ${dealt}`);
});

test("thornPrickExecute kills a minion dropped below the threshold by Thorn Prick", () => {
  const titania = withTrigger("t", "A", { on: "damageDealt", source: "Assassin", when: { and: [{ sameUnit: ["eventSource", "self"] }, { isKind: "eventTarget", kind: "minion" }] }, effect: [custom("thornPrickExecute", { threshold: 20, skillId: "titania1", dotName: "Thorn Prick" })] });
  const weak = { ...makeUnit({ id: "w", team: "B", hp: 15 }), kind: "minion" as const };
  const st = makeState([titania], [weak]);
  emit(st, { type: "damageDealt", source: "t", target: "w", amount: 5, dtype: "affliction", sourceId: "titania1" });
  assert.ok(!weak.alive, "hp 15 < 20 -> executed");
});

test("fivePlaguesProc inflicts a random effect on Titania's affliction damage (guaranteed at 10 stacks)", () => {
  const titania = withTrigger("t", "A", { on: "damageDealt", source: "Blight", when: { sameUnit: ["eventSource", "self"] }, effect: [custom("fivePlaguesProc", { chancePerStack: 0.1, stackName: "Five Plagues", duration: 1, effects: ["shatter", "isolated", "costIncrease", "stunNonStrategic", "stunStrategic"] })] }, { statuses: [status("stack", { name: "Five Plagues", magnitude: 10 })] });
  const foe = makeUnit({ id: "e", team: "B" });
  const st = makeState([titania], [foe]);
  emit(st, { type: "damageDealt", source: "t", target: "e", amount: 5, dtype: "affliction" });
  assert.ok(foe.statuses.some((s) => ["shatter", "isolated", "cost_mod", "stun"].includes(s.kind)), "an effect inflicted (0.1 x 10 = 1.0)");
});

test("untargetableByBlindedSkills excludes the holder from a Blinded caster's random targeting", () => {
  const zeph = makeUnit({ id: "z", team: "B", hp: 100 });
  const other = makeUnit({ id: "o", team: "B", hp: 100 });
  const blind = makeUnit({ id: "c", team: "A", statuses: [status("blind", { duration: 1 })], skills: [skill("atk", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful"] })] });
  const st = makeState([blind], [zeph, other]);
  runEffects(st, [custom("untargetableByBlindedSkills", { to: "self" })], { caster: zeph, self: zeph, targets: [] });
  st.teams.A.energy = { generic: 5 };
  performAction(st, { unit: "c", skillId: "atk", targets: ["z"] });
  assert.equal(zeph.hp, 100, "the Blinded skill never lands on Zephyrex");
  assert.equal(other.hp, 80, "it hits the other enemy instead");
});

// Cluster 12 — shields, watch-afflict, clone & stack mechanics. Verified against exact prose.

test("prismaticShielding shields all allied heroes + gives Affliction immunity on Plasma Shield", () => {
  const saya = withTrigger("s", "A", { on: "skillUsed", source: "Aurora", effect: [custom("prismaticShielding", { skillId: "saya4", to: { faction: "allies", kind: "hero" }, shield: 40, afflictionIgnoreTurns: 2 })] });
  const ally = makeUnit({ id: "al", team: "A" });
  const st = makeState([saya, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "skillUsed", caster: "s", skillId: "saya4", targets: [], tags: [] });
  // The OTHER allied heroes get the fusion shield; Saya herself is excluded (base Plasma Shield covers her).
  assert.equal(ally.shields.reduce((s, x) => s + x.amount, 0), 40);
  assert.ok(ally.statuses.some((s) => s.kind === "damage_ignore" && s.dtype === "affliction"));
  assert.equal(saya.shields.reduce((s, x) => s + x.amount, 0), 0, "Saya not double-shielded by the fusion");
});

test("purifyingShieldHeal heals 5 per enemy-applied effect when Taryn's shield breaks", () => {
  const taryn = withTrigger("t", "A", { on: "shieldBroken", source: "Antidote", effect: [custom("purifyingShieldHeal", { perEnemyEffect: 5, markName: "Stalwart Shield" })] }, { hp: 50 });
  taryn.statuses = [status("stun", { duration: 1, appliedBy: "foe" }), status("silence", { duration: 1, appliedBy: "foe" })];
  const st = makeState([taryn], [makeUnit({ id: "foe", team: "B" })]);
  emit(st, { type: "shieldBroken", unit: "t", source: "foe" });
  assert.equal(taryn.hp, 60, "2 enemy effects -> heal 10");
});

test("afflictOnHelpfulUse isolates the target and afflicts it 20 when it uses a Helpful skill", () => {
  const titania = makeUnit({ id: "t", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const st = makeState([titania], [foe]);
  runEffects(st, [custom("afflictOnHelpfulUse", { target: "target", affliction: 20 })], { caster: titania, self: titania, targets: [foe] });
  assert.ok(foe.statuses.some((s) => s.kind === "isolated"), "permanently Isolated");
  emit(st, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(foe.hp, 100, "Harmful skill: no affliction");
  emit(st, { type: "skillUsed", caster: "e", skillId: "y", targets: [], tags: ["Helpful"] });
  assert.equal(foe.hp, 80, "Helpful skill -> 20 Affliction");
});

test("cloneBasicSkillsOntoSimulacrum makes a 30-HP Simulacrum with the target's Basic skills, re-elemented", () => {
  const xyris = makeUnit({ id: "x", team: "A", currentElement: "shadow" });
  const src = makeUnit({ id: "e", team: "B" });
  src.skills = [skill("b1", [], { klass: "basic" }), skill("b2", [], { klass: "basic" }), skill("u1", [], { klass: "ultimate" })];
  const st = makeState([xyris], [src]);
  runEffects(st, [custom("cloneBasicSkillsOntoSimulacrum", { copyFrom: "target", minionTemplate: "Simulacrum", onlyBasics: true })], { caster: xyris, self: xyris, targets: [src] });
  const sim = Object.values(st.units).find((u) => u.kind === "minion" && u.name === "Simulacrum")!;
  assert.ok(sim && sim.maxHp === 30, "30 HP Simulacrum");
  assert.deepEqual((sim.skills ?? []).map((s) => s.id).sort(), ["b1", "b2"], "only the target's Basic skills");
  assert.equal(sim.currentElement, "shadow", "specific costs match Xyris's element");
});

test("freezingBrineOnRiptide adds Call-Tides-many stacks and stuns + consumes at 5", () => {
  const zev = withTrigger("z", "A", { on: "skillUsed", source: "Glacier", when: { sameUnit: ["eventSource", "self"] }, effect: [custom("freezingBrineOnRiptide", { skillId: "zevkir2", stackName: "Freezing Brine", threshold: 5, stunTurns: 1 })] }, { statuses: [status("stack", { name: "Call Tides", magnitude: 3 })] });
  const foe = makeUnit({ id: "e", team: "B" });
  const st = makeState([zev], [foe]);
  emit(st, { type: "skillUsed", caster: "z", skillId: "zevkir2", targets: ["e"], tags: ["Harmful"] });
  assert.equal(stackCount(foe, "Freezing Brine"), 3);
  emit(st, { type: "skillUsed", caster: "z", skillId: "zevkir2", targets: ["e"], tags: ["Harmful"] });
  assert.ok(foe.statuses.some((s) => s.kind === "stun"), "reached 5 -> stunned");
  assert.equal(stackCount(foe, "Freezing Brine"), 0, "and consumed");
});

test("shieldPerTurnForDuration consumes Call Tides and grants 10 shield now + scheduled per remaining turn", () => {
  const zev = makeUnit({ id: "z", team: "A", statuses: [status("stack", { name: "Call Tides", magnitude: 2 })] });
  const ally = makeUnit({ id: "al", team: "A" });
  const st = makeState([zev, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("shieldPerTurnForDuration", { amount: 10, to: { faction: "allies", includeSelf: true } })], { caster: zev, self: zev, targets: [] });
  assert.equal(stackCount(zev, "Call Tides"), 0, "consumed");
  assert.equal(zev.shields.reduce((s, x) => s + x.amount, 0), 10, "turn 0 shield now");
  assert.equal(st.scheduled.length, 1, "1 more turn scheduled");
});

// Cluster 13 — empower windows, retaliation & stack-spend. Verified against exact prose.

test("lightningCrashSkylanceEmpower: each Skylance hits 2 random enemies for 5 + grants Essence", () => {
  const syl = makeUnit({ id: "s", team: "A" });
  const es = [1, 2, 3].map((i) => makeUnit({ id: "e" + i, team: "B", hp: 100 }));
  const st = makeState([syl], es);
  runEffects(st, [custom("lightningCrashSkylanceEmpower", { turns: 3, skillId: "syl2", bonusDamage: 5, dtype: "piercing", extraTargets: 2, grantEssence: true })], { caster: syl, self: syl, targets: [] });
  emit(st, { type: "skillUsed", caster: "s", skillId: "syl1", targets: [], tags: [] });
  assert.equal(es.reduce((s, x) => s + (100 - x.hp), 0), 0, "non-Skylance: nothing");
  emit(st, { type: "skillUsed", caster: "s", skillId: "syl2", targets: [], tags: [] });
  assert.equal(es.reduce((s, x) => s + (100 - x.hp), 0), 10, "2 random enemies took 5 each");
  assert.ok(syl.statuses.some((x) => x.kind === "elemental_essence"), "Syl gained Essence");
});

test("forcedHarmonyBonus: Inspiring Thrust deals a double hit to Forced-Harmony-marked targets", () => {
  const taryn = withTrigger("t", "A", { on: "skillUsed", source: "Judgment", when: { sameUnit: ["eventSource", "self"] }, effect: [custom("forcedHarmonyBonus", { skillId: "taryn3", markName: "Forced Harmony", bonusDamage: 20 })] });
  const marked = makeUnit({ id: "m", team: "B", hp: 100, statuses: [status("mark", { name: "Forced Harmony" })] });
  const plain = makeUnit({ id: "p", team: "B", hp: 100 });
  const st = makeState([taryn], [marked, plain]);
  emit(st, { type: "skillUsed", caster: "t", skillId: "taryn3", targets: ["m", "p"], tags: ["Harmful"] });
  assert.equal(marked.hp, 80, "marked took the extra 20");
  assert.equal(plain.hp, 100, "unmarked untouched");
  assert.ok(!marked.statuses.some((s) => s.kind === "mark" && s.name === "Forced Harmony"), "mark consumed");
});

test("restrainRetaliate: damaging Taryn during Restrain extends the attacker's stun by 1", () => {
  const taryn = makeUnit({ id: "t", team: "A", hp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", statuses: [status("stun", { duration: 1 })] });
  const st = makeState([taryn], [enemy]);
  runEffects(st, [custom("restrainRetaliate", { turns: 1, extendBy: 1, markName: "Restrain" })], { caster: taryn, self: taryn, targets: [] });
  emit(st, { type: "damageDealt", source: "e", target: "t", amount: 10, dtype: "normal", isNew: true });
  assert.equal(enemy.statuses.find((s) => s.kind === "stun")!.duration, 2, "new damage: stun extended 1 -> 2");
  // an un-Restrained enemy is NOT stunned by retaliation
  const plain = makeUnit({ id: "p", team: "B" });
  st.units.p = plain; st.teams.B.units.push("p");
  emit(st, { type: "damageDealt", source: "p", target: "t", amount: 10, dtype: "normal", isNew: true });
  assert.ok(!plain.statuses.some((s) => s.kind === "stun"), "an un-Restrained attacker is not freshly stunned");
});

test("spendStack consumes each 50 banked healing for Essence + 15 Affliction to all enemies", () => {
  const rd = makeUnit({ id: "rd", team: "A", statuses: [status("stack", { name: "Reflection of Kindness", magnitude: 120 })] });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const st = makeState([rd], [foe]);
  runEffects(st, [custom("spendStack", { name: "Reflection of Kindness", amount: 50, of: "self" })], { caster: rd, self: rd, targets: [] });
  assert.equal(stackCount(rd, "Reflection of Kindness"), 20, "120 -> 2 x 50 spent, 20 left");
  assert.equal(foe.hp, 70, "two procs of 15 Affliction");
  assert.ok(rd.statuses.some((s) => s.kind === "elemental_essence"), "Essence gained");
});

// ── Cluster 14 — Hector's serums, summon-swap & channeled skill-mods ─────────────────────────────── //

// A minimal Hector whose three serum skills each apply their named mark, so applySerum can re-run them.
function hectorWithSerums(id = "h", team: "A" | "B" = "A", over = {}) {
  const serumSkill = (sid: string, name: string) =>
    skill(sid, [{ op: "applyStatus", to: "target", status: { kind: "mark", name, duration: 3 } }]);
  return makeUnit({
    id, team, name: "Hector",
    skills: [serumSkill("hector1", "Burning Blood Serum"), serumSkill("hector2", "Stoneseal Serum"), serumSkill("hector3", "Mindfog Serum")],
    ...over,
  });
}
const SERUM_NAMES = ["Burning Blood Serum", "Stoneseal Serum", "Mindfog Serum"];

test("applyRandomSerum applies one serum Dennis lacks on energyFromEssence", () => {
  const h = hectorWithSerums();
  h.triggers = [{ on: "energyFromEssence", owner: "h", when: { sameUnit: ["eventUnit", "self"] }, source: "Borrowed Time",
    effect: [custom("applyRandomSerum", { to: { faction: "allies", kind: "minion", template: "Dennis the Apprentice" }, excludeExisting: true })] }];
  const dennis = makeUnit({ id: "d", team: "A", kind: "minion", name: "Dennis the Apprentice", summoner: "h" });
  const state = makeState([h, dennis], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "energyFromEssence", unit: "h", element: "fire" });
  const got = SERUM_NAMES.filter((n) => dennis.statuses.some((s) => s.name === n));
  assert.equal(got.length, 1, "exactly one random serum applied to Dennis");
});

test("applyRandomSerum excludeExisting picks the one serum Dennis is missing", () => {
  const h = hectorWithSerums();
  h.triggers = [{ on: "energyFromEssence", owner: "h", when: { sameUnit: ["eventUnit", "self"] }, source: "Borrowed Time",
    effect: [custom("applyRandomSerum", { to: { faction: "allies", kind: "minion", template: "Dennis the Apprentice" }, excludeExisting: true })] }];
  const dennis = makeUnit({ id: "d", team: "A", kind: "minion", name: "Dennis the Apprentice", summoner: "h",
    statuses: [status("mark", { name: "Burning Blood Serum" }), status("mark", { name: "Stoneseal Serum" })] });
  const state = makeState([h, dennis], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "energyFromEssence", unit: "h", element: "fire" });
  assert.ok(dennis.statuses.some((s) => s.name === "Mindfog Serum"), "only the missing serum (Mindfog) could be applied");
});

test("mirrorUsedSerumToSelf applies the serum Hector just used to himself too", () => {
  const h = hectorWithSerums();
  h.triggers = [{ on: "skillUsed", owner: "h", when: { sameUnit: ["eventSource", "self"] }, source: "Serum", effect: [custom("mirrorUsedSerumToSelf", { to: "self" })] }];
  const state = makeState([h], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "skillUsed", caster: "h", skillId: "hector2", targets: ["e"] });
  assert.ok(h.statuses.some((s) => s.name === "Stoneseal Serum"), "Stoneseal mirrored onto Hector");
  emit(state, { type: "skillUsed", caster: "h", skillId: "hector5", targets: [] });
  assert.equal(h.statuses.filter((s) => SERUM_NAMES.includes(s.name!)).length, 1, "a non-serum skill mirrors nothing");
});

test("avatarSerum pulses 5 x serum-count Affliction to all enemies each turn + grants non_damage_ignore", () => {
  const h = hectorWithSerums("h", "A", { statuses: [status("mark", { name: "Burning Blood Serum" }), status("mark", { name: "Mindfog Serum" })] });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([h], [e1, e2]);
  runEffects(state, [custom("avatarSerum", { damagePerSerum: 5, dtype: "affliction", turns: 3 })], { caster: h, self: h, targets: [] });
  assert.ok(h.statuses.some((s) => s.kind === "non_damage_ignore"), "ignores non-damage effects");
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(e1.hp, 90, "2 serums x 5 = 10 to each enemy");
  assert.equal(e2.hp, 90);
});

test("winterExileSummon re-badges Titania's Summer Courtesans as Winter Loyalists", () => {
  const t = makeUnit({ id: "t", team: "A", name: "Titania" });
  t.triggers = [{ on: "skillUsed", owner: "t", when: { sameUnit: ["eventSource", "self"] }, source: "Winter Exile",
    effect: [custom("winterExileSummon", { skillId: "titania5", fromTemplate: "Summer Courtesan", toTemplate: "Winter Loyalist" })] }];
  const courtesan = makeUnit({ id: "c", team: "A", kind: "minion", name: "Summer Courtesan", summoner: "t" });
  const state = makeState([t, courtesan], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "skillUsed", caster: "t", skillId: "titania5", targets: [] });
  assert.equal(courtesan.name, "Winter Loyalist", "Summer Courtesan renamed");
});

test("mistyMireBubblePrison deals 15 Piercing bypass to a random enemy per turn for Bubble Prison's duration", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir", statuses: [status("stack", { name: "Call Tides", magnitude: 1 })] });
  z.triggers = [{ on: "skillUsed", owner: "z", when: { sameUnit: ["eventSource", "self"] }, source: "Misty Mire",
    effect: [custom("mistyMireBubblePrison", { skillId: "zevkir3", perTurnDamage: 15, dtype: "piercing" })] }];
  const foe = makeUnit({ id: "e", team: "B", hp: 100, shield: 50 });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([z], [foe, foe2]);
  emit(state, { type: "skillUsed", caster: "z", skillId: "zevkir3", targets: ["e"] });
  assert.ok(foe.statuses.some((s) => s.kind === "dot" && s.name === "Bubble Prison"), "imprison reaches all enemies");
  assert.ok(foe2.statuses.some((s) => s.kind === "dot" && s.name === "Bubble Prison"), "including the non-targeted enemy");
  emit(state, { type: "turnStart", team: "A" });
  const hits = (100 - foe.hp) + (100 - foe2.hp);
  assert.equal(hits, 15, "exactly one 15 Piercing bypass strike to a random enemy");
  if (foe.hp < 100) assert.equal(foe.shields[0]?.amount, 50, "shield untouched (bypass)");
});

// ── Cluster 15 — delayed strikes, per-turn strikes & heal→damage redirects ───────────────────────── //

test("cleaveTheVeil deals 45 piercing at resolve when no harmful skill was received", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zephyrex" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([z], [foe]);
  runEffects(state, [custom("cleaveTheVeil", { delayTurns: 1, amount: 45, dtype: "piercing", target: "target", cancelOnHarmfulSkillReceived: true })], { caster: z, self: z, targets: [foe] });
  assert.ok(foe.statuses.some((s) => s.name === "Cleave Target"), "target marked");
  assert.ok(z.statuses.some((s) => s.name === "Cleave Charging"), "Zephyrex charging");
  runEffects(state, [custom("cleaveResolve", { amount: 45, dtype: "piercing" })], { caster: z, self: z, targets: [] });
  assert.equal(foe.hp, 55, "45 piercing landed");
});

test("cleaveTheVeil is cancelled if Zephyrex receives a new harmful skill", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zephyrex" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([z], [foe]);
  runEffects(state, [custom("cleaveTheVeil", { delayTurns: 1, amount: 45, dtype: "piercing", target: "target", cancelOnHarmfulSkillReceived: true })], { caster: z, self: z, targets: [foe] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["z"], tags: ["Harmful"] });
  assert.ok(!z.statuses.some((s) => s.name === "Cleave Charging"), "charge cancelled by harmful skill");
  runEffects(state, [custom("cleaveResolve", { amount: 45, dtype: "piercing" })], { caster: z, self: z, targets: [] });
  assert.equal(foe.hp, 100, "no damage after cancel");
});

test("lightningRod gains a stack on energyFromEssence and strikes 5-per-stack each turn", () => {
  const saya = makeUnit({ id: "s", team: "A", name: "Saya", statuses: [status("stack", { name: "Lightning Rod", magnitude: 1 })] });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([saya], [foe]);
  runEffects(state, [custom("lightningRod", { perStack: 5, stackName: "Lightning Rod" })], { caster: saya, self: saya, targets: [] });
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(foe.hp, 95, "1 stack -> 5 damage");
  emit(state, { type: "energyFromEssence", unit: "s", element: "fire" });
  assert.equal(stackCount(saya, "Lightning Rod"), 2, "essence gained a Lightning Rod stack");
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(foe.hp, 85, "2 stacks -> 10 damage");
});

test("doubleLaughingPowder doubles the dot's magnitude only on the dot's own application", () => {
  const t = makeUnit({ id: "t", team: "A", name: "Titania" });
  t.triggers = [{ on: "statusApplied", owner: "t", when: { sameUnit: ["eventSource", "self"] }, source: "Laughing Serum",
    effect: [custom("doubleLaughingPowder", { name: "Laughing Powder", to: "eventUnit", magnitude: 10 })] }];
  const foe = makeUnit({ id: "e", team: "B", statuses: [status("dot", { name: "Laughing Powder", magnitude: 5, dtype: "affliction" })] });
  const state = makeState([t], [foe]);
  emit(state, { type: "statusApplied", unit: "e", source: "t", kind: "mark", name: "Something Else" });
  assert.equal(foe.statuses.find((s) => s.kind === "dot")!.magnitude, 5, "unrelated status does not double the dot");
  emit(state, { type: "statusApplied", unit: "e", source: "t", kind: "dot", name: "Laughing Powder" });
  assert.equal(foe.statuses.find((s) => s.kind === "dot")!.magnitude, 10, "the dot's own application doubles 5 -> 10");
});

test("overhealAsAffliction deals River Daughter's overheal to a random enemy as Affliction", () => {
  const rd = makeUnit({ id: "rd", team: "A", name: "River Daughter" });
  rd.triggers = [{ on: "healReceived", owner: "rd", when: { sameUnit: ["eventSource", "self"] }, source: "Font of Cruelty", effect: [custom("overhealAsAffliction", {})] }];
  const ally = makeUnit({ id: "al", team: "A" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([rd, ally], [foe]);
  emit(state, { type: "healReceived", unit: "al", source: "rd", amount: 5, overheal: 15 });
  assert.equal(foe.hp, 85, "15 overheal dealt as Affliction to the enemy");
  emit(state, { type: "healReceived", unit: "al", source: "rd", amount: 20, overheal: 0 });
  assert.equal(foe.hp, 85, "no overheal -> no damage");
});

// ── Cluster 16 — positional & targeting restrictions ─────────────────────────────────────────────── //

test("flutterInTheFog cycles Syl-invuln -> Eagle-invuln -> skip across her turn-ends", () => {
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  syl.triggers = [{ on: "turnEnd", owner: "syl", source: "Flutter in the Fog",
    effect: [custom("flutterInTheFog", { invulnDuration: 1, inactiveMark: "Flutter Inactive", eagle: { faction: "allies", kind: "minion" } })] }];
  const eagle = makeUnit({ id: "eag", team: "A", kind: "minion", name: "Hatchling Eagle", summoner: "syl" });
  const state = makeState([syl, eagle], [makeUnit({ id: "e", team: "B" })]);
  // turn-end 1: Syl invuln + Flutter Self
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(syl.statuses.some((s) => s.kind === "invulnerable"), "step1: Syl invulnerable");
  assert.ok(syl.statuses.some((s) => s.name === "Flutter Self"), "step1: Flutter Self marked");
  assert.ok(!eagle.statuses.some((s) => s.kind === "invulnerable"), "step1: eagle not invuln");
  // turn-end 2: Eagle invuln + Flutter Inactive, Flutter Self cleared
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(eagle.statuses.some((s) => s.kind === "invulnerable"), "step2: eagle invulnerable");
  assert.ok(syl.statuses.some((s) => s.name === "Flutter Inactive"), "step2: inactive marked");
  assert.ok(!syl.statuses.some((s) => s.name === "Flutter Self"), "step2: Flutter Self cleared");
  // turn-end 3: skip (Flutter Inactive consumed, nothing new)
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(!syl.statuses.some((s) => s.name === "Flutter Inactive"), "step3: inactive consumed");
  assert.ok(!syl.statuses.some((s) => s.name === "Flutter Self"), "step3: still no Flutter Self");
  // turn-end 4: cycle restarts (Flutter Self again)
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(syl.statuses.some((s) => s.name === "Flutter Self"), "step4: cycle restarts");
});

test("flutterInTheFog ignores the enemy team's turn-end", () => {
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  syl.triggers = [{ on: "turnEnd", owner: "syl", source: "Flutter in the Fog",
    effect: [custom("flutterInTheFog", { invulnDuration: 1, inactiveMark: "Flutter Inactive", eagle: { faction: "allies", kind: "minion" } })] }];
  const state = makeState([syl], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "turnEnd", team: "B" });
  assert.ok(!syl.statuses.some((s) => s.name === "Flutter Self"), "enemy turn-end does not trigger the cycle");
});

test("restrictTargetingToMaggieOrBramblelash confines the reanimated ally's targets", () => {
  const maggie = makeUnit({ id: "m", team: "A", name: "Maggie" });
  const ally = makeUnit({ id: "al", team: "A", name: "Ally" });
  const plain = makeUnit({ id: "p", team: "B", name: "Plain Foe" });
  const cursed = makeUnit({ id: "c", team: "B", name: "Cursed Foe", statuses: [status("mark", { name: "Bramblelash" })] });
  const state = makeState([maggie, ally], [plain, cursed]);
  runEffects(state, [custom("restrictTargetingToMaggieOrBramblelash", { durationTurns: 3, allowCaster: true, allowMark: "Bramblelash" })], { caster: maggie, self: maggie, targets: [ally] });
  assert.ok(ally.statuses.some((s) => s.kind === "immortal"), "ally becomes Immortal");
  assert.ok(ally.statuses.some((s) => s.name === "Reanimated"), "ally marked Reanimated");
  const rng = Rng.fromState(state.rngState);
  const harmful = skill("s", [], { targeting: "single", tags: ["Harmful"] });
  assert.deepEqual(legalTargets(state, ally, harmful, [plain], rng).map((u) => u.id), [], "cannot target a non-Bramblelash enemy");
  assert.deepEqual(legalTargets(state, ally, harmful, [cursed], rng).map((u) => u.id), ["c"], "can target a Bramblelash enemy");
  const helpful = skill("h", [], { targeting: "single", tags: ["Helpful"] });
  assert.deepEqual(legalTargets(state, ally, helpful, [maggie], rng).map((u) => u.id), ["m"], "can target Maggie (the applier)");
});

test("restrictTargetingToMaggieOrBramblelash kills the target when the duration ends", () => {
  const maggie = makeUnit({ id: "m", team: "A", name: "Maggie" });
  const ally = makeUnit({ id: "al", team: "A", name: "Ally" });
  const state = makeState([maggie, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [custom("restrictTargetingToMaggieOrBramblelash", { durationTurns: 3, allowCaster: true, allowMark: "Bramblelash" })], { caster: maggie, self: maggie, targets: [ally] });
  for (let i = 0; i < 8 && ally.alive; i++) endTurn(state);
  assert.equal(ally.alive, false, "the target dies at the end of the reanimation");
});

// ── Cluster 17 — derived stack-reads (stack_read_mod primitive) ──────────────────────────────────── //

test("stack_read_mod slots by name — two different-named read-mods coexist (no collision)", () => {
  const u = makeUnit({ id: "u", team: "A" });
  applyStatus(u, status("stack_read_mod", { name: "Call Tides", mode: "floorZero", magnitude: 2 }));
  applyStatus(u, status("stack_read_mod", { name: "Deepening Shadows", mode: "mult", magnitude: 3 }));
  assert.equal(u.statuses.filter((s) => s.kind === "stack_read_mod").length, 2, "both read-mods kept (slot by name)");
});

test("evencoinTripleShadows triples Deepening Shadows only for Evencoin holders", () => {
  const laria = makeUnit({ id: "l", team: "A", name: "Laria", statuses: [status("stack", { name: "Deepening Shadows", magnitude: 2 })] });
  const foe = makeUnit({ id: "e", team: "B", statuses: [status("stack", { name: "Deepening Shadows", magnitude: 2 }), status("stack", { name: "Evencoin", magnitude: 1 })] });
  const st = makeState([laria], [foe]);
  runEffects(st, [custom("evencoinTripleShadows", {})], { caster: laria, self: laria, targets: [] });
  assert.equal(stackCount(foe, "Deepening Shadows"), 6, "Evencoin holder reads triple (2 -> 6)");
  assert.equal(stackCount(laria, "Deepening Shadows"), 2, "no Evencoin -> unchanged");
  // presence/raw reads are unaffected by the mult
  assert.equal(rawStackCount(foe, "Deepening Shadows"), 2, "raw count is still the actual 2");
});

test("stinkingMarshZeroStackMod: floorZero read + affliction override gated on RAW 0", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir" });
  const st = makeState([z], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("stinkingMarshZeroStackMod", { treatAsStacks: 2, dtype: "affliction", stackName: "Call Tides" })], { caster: z, self: z, targets: [] });
  assert.equal(stackCount(z, "Call Tides"), 2, "raw 0 reads as 2 (treated as two)");
  assert.equal(outgoingDtypeOverride(z), "affliction", "damage becomes affliction while at 0 raw stacks");
  applyStatus(z, status("stack", { name: "Call Tides", magnitude: 1 }));
  assert.equal(stackCount(z, "Call Tides"), 1, "with a real stack, the floor does not apply");
  assert.equal(outgoingDtypeOverride(z), undefined, "override lifts once he holds a real stack");
});

test("afflictSelfIfRawStackZero: 10 Affliction on skill DECLARE at 0 raw stacks only (pre-resolution)", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir", hp: 100 });
  z.triggers = [{ on: "skillDeclared", owner: "z", when: { sameUnit: ["eventSource", "self"] }, source: "Stinking Marsh",
    effect: [custom("afflictSelfIfRawStackZero", { stackName: "Call Tides", amount: 10, dtype: "affliction" })] }];
  const st = makeState([z], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "skillDeclared", caster: "z", skillId: "zevkir1", tags: [], targets: [] });
  assert.equal(z.hp, 90, "took 10 Affliction at 0 stacks");
  applyStatus(z, status("stack", { name: "Call Tides", magnitude: 1 }));
  emit(st, { type: "skillDeclared", caster: "z", skillId: "zevkir1", tags: [], targets: [] });
  assert.equal(z.hp, 90, "no self-damage while holding a real stack");
});

test("Iced Shelf breaks only when a DECLARED TARGET bears the mark, not on any Helpful/Harmful skill", () => {
  const keeper = makeUnit({ id: "k", team: "A", name: "Keeper", statuses: [status("mark", { name: "Iced Shelf" }), status("stun", {})] });
  const foe = makeUnit({ id: "e", team: "B", statuses: [status("mark", { name: "Iced Shelf" }), status("stun", {})] });
  const bystander = makeUnit({ id: "b", team: "B" });
  const markSel = { filter: "eventTargets" as const, with: { kind: "mark" as const, name: "Iced Shelf" } };
  const allBearers = { filter: { faction: "all" as const }, with: { kind: "mark" as const, name: "Iced Shelf" } };
  keeper.triggers = [{ on: "skillDeclared", owner: "k", source: "Iced Shelf",
    when: { and: [{ or: [{ eventHasTag: "Helpful" }, { eventHasTag: "Harmful" }] },
                  { cmp: ">", left: { ref: "count", of: markSel }, right: 0 }] },
    effect: [{ op: "removeStatus", kind: "stun", from: allBearers },
             { op: "removeStatus", kind: "mark", name: "Iced Shelf", from: allBearers }] }];
  const st = makeState([keeper], [foe, bystander]);
  // Harmful skill targeting the UNMARKED bystander -> shelf must hold (old bug: broke on any Helpful/Harmful)
  emit(st, { type: "skillDeclared", caster: "b", skillId: "x", tags: ["Harmful"], targets: ["b"] });
  assert.ok(keeper.statuses.some((s) => s.kind === "stun"), "shelf holds when the skill targets a non-bearer");
  // Harmful skill targeting the marked foe -> shelf breaks for BOTH bearers
  emit(st, { type: "skillDeclared", caster: "b", skillId: "x", tags: ["Harmful"], targets: ["e"] });
  assert.ok(!keeper.statuses.some((s) => s.kind === "stun") && !foe.statuses.some((s) => s.kind === "stun"), "shelf breaks for both when a bearer is targeted");
});

test("skillDeclared react dispatch: the 0-stack penalty reads Call Tides PRE-resolution (a consuming skill does not self-trigger it)", () => {
  // A skill whose own effects remove Call Tides. Cast while holding 2 stacks: the penalty must NOT fire
  // (he declared with 2), proving skillDeclared fires before the skill mutates the count. On skillUsed
  // (the old wiring) it would have read the post-consumption 0 and wrongly self-damaged.
  const consume = skill("consume", [{ op: "removeStatus", kind: "stack", name: "Call Tides", from: "self" }], { targeting: "none", tags: [], cost: { generic: 0, specific: 0 } });
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir", hp: 100, skills: [consume], statuses: [status("stack", { name: "Call Tides", magnitude: 2 })] });
  z.triggers = [{ on: "skillDeclared", owner: "z", when: { sameUnit: ["eventSource", "self"] }, source: "Stinking Marsh",
    effect: [custom("afflictSelfIfRawStackZero", { stackName: "Call Tides", amount: 10, dtype: "affliction" })] }];
  const st = makeState([z], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  performAction(st, { unit: "z", skillId: "consume", targets: [] });
  assert.equal(z.hp, 100, "no penalty: declared with 2 Call Tides, even though the skill then consumed them");
  assert.equal(rawStackCount(z, "Call Tides"), 0, "the skill did consume the stacks");
  // and it DOES fire when actually declaring at 0
  performAction(st, { unit: "z", skillId: "consume", targets: [] });
  assert.equal(z.hp, 90, "penalty fires when declared at 0 raw Call Tides");
});

test("stinkingMarsh forces DoT ticks to Affliction while at 0 Call Tides (tickDots override)", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100, shield: 50, statuses: [status("dot", { name: "Bubble Prison", magnitude: 15, dtype: "normal", duration: 2, appliedBy: "z", appliedTurn: 0 })] });
  const st = makeState([z], [foe]);
  runEffects(st, [custom("stinkingMarshZeroStackMod", { treatAsStacks: 2, dtype: "affliction", stackName: "Call Tides" })], { caster: z, self: z, targets: [] });
  tickDots(st, "A");
  assert.equal(foe.hp, 85, "normal-typed DoT ticked as Affliction, bypassing the 50 shield");
  assert.equal(foe.shields[0]?.amount, 50, "shield untouched (affliction)");
});

test("callTidesFromMissingHp adds 1 stack per 15 missing HP", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir", hp: 70, maxHp: 100, statuses: [status("stack", { name: "Call Tides", magnitude: 1 })] });
  const st = makeState([z], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("callTidesFromMissingHp", { perMissingHp: 15, stackName: "Call Tides" })], { caster: z, self: z, targets: [] });
  assert.equal(stackCount(z, "Call Tides"), 3, "1 real + floor(30/15)=2 = 3");
  z.hp = 100;
  assert.equal(stackCount(z, "Call Tides"), 1, "full HP -> no bonus");
});

// ── Cluster 18 — eagle/minion skill mods, granted skills & channel-instant ───────────────────────── //

test("extendEagleSkillDurations bumps eagle skill status durations by 1, once", () => {
  const eagleSkill = skill("swoop", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }]);
  const eagle = makeUnit({ id: "eag", team: "A", kind: "minion", name: "Hatchling Eagle", summoner: "syl", skills: [eagleSkill] });
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  const st = makeState([syl, eagle], [makeUnit({ id: "e", team: "B" })]);
  const args = custom("extendEagleSkillDurations", { eagle: { faction: "allies", kind: "minion" }, durationDelta: 1 });
  runEffects(st, [args], { caster: syl, self: syl, targets: [] });
  const stun = eagle.skills![0]!.effects[0] as { status: { duration: number } };
  assert.equal(stun.status.duration, 3, "stun duration 2 -> 3");
  runEffects(st, [args], { caster: syl, self: syl, targets: [] });
  assert.equal(stun.status.duration, 3, "re-run does not compound (once-guard)");
});

test("skyDropEagleStageBonus scales damage + stun by the Eagle's evolution stage", () => {
  const foe = makeUnit({ id: "e", team: "B", hp: 100, statuses: [status("stun", { duration: 0 })] });
  const eagle = makeUnit({ id: "eag", team: "A", kind: "minion", name: "Adult Eagle", summoner: "syl" });
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  const st = makeState([syl, eagle], [foe]);
  runEffects(st, [custom("skyDropEagleStageBonus", { target: "target", perStageDamage: 10, perStageStun: 1 })], { caster: syl, self: syl, targets: [foe] });
  assert.equal(foe.hp, 90, "stage 1 -> +10 damage");
  assert.equal(foe.statuses.find((s) => s.kind === "stun")!.duration, 1, "stage 1 -> +1 stun turn");
});

test("skyDropEagleStageBonus is a no-op at stage 0 (Hatchling)", () => {
  const foe = makeUnit({ id: "e", team: "B", hp: 100, statuses: [status("stun", { duration: 0 })] });
  const eagle = makeUnit({ id: "eag", team: "A", kind: "minion", name: "Hatchling Eagle", summoner: "syl" });
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  const st = makeState([syl, eagle], [foe]);
  runEffects(st, [custom("skyDropEagleStageBonus", { perStageDamage: 10, perStageStun: 1 })], { caster: syl, self: syl, targets: [foe] });
  assert.equal(foe.hp, 100, "stage 0 -> no bonus damage");
});

test("grantSkillToTemplate grants Living Lash to a Boulder on summon", () => {
  const roland = makeUnit({ id: "r", team: "A", name: "Roland" });
  roland.triggers = [{ on: "minionSummoned", owner: "r", source: "Living Boulder",
    effect: [custom("grantSkillToTemplate", { template: "Boulder", skillId: "rolandlivingboulder1" })] }];
  const boulder = makeUnit({ id: "b", team: "A", kind: "minion", name: "Boulder", summoner: "r", skills: [] });
  const st = makeState([roland, boulder], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "minionSummoned", unit: "b", template: "Boulder", summoner: "r" });
  assert.ok((boulder.skills ?? []).some((s) => s.id === "rolandlivingboulder1"), "Boulder now has Living Lash");
  // idempotent: a second summon event does not duplicate
  emit(st, { type: "minionSummoned", unit: "b", template: "Boulder", summoner: "r" });
  assert.equal((boulder.skills ?? []).filter((s) => s.id === "rolandlivingboulder1").length, 1, "not duplicated");
});

test("instant_cast suppresses a Channel skill's sustain (skillCastsInstantlyWhileMarked)", () => {
  const chan = skill("es", [{ op: "damage", amount: 5, to: { faction: "enemies" } }], { targeting: "self", tags: ["Channel"], channelTurns: 1 });
  const z = makeUnit({ id: "z", team: "A", name: "Zephyrex", skills: [chan], statuses: [status("mark", { name: "Light of Raphael", duration: 3 })] });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const st = makeState([z], [foe]);
  runEffects(st, [custom("skillCastsInstantlyWhileMarked", { skillId: "es", mark: "Light of Raphael" })], { caster: z, self: z, targets: [] });
  assert.ok(z.statuses.some((s) => s.kind === "instant_cast" && s.skillId === "es"), "instant_cast applied for the mark's duration");
  performAction(st, { unit: "z", skillId: "es" });
  assert.ok(!z.statuses.some((s) => s.kind === "channeling"), "no channel installed — resolves on cast");
  assert.equal(foe.hp, 95, "the cast hit still landed once");
});

test("without instant_cast, a Channel skill installs a sustained channel", () => {
  const chan = skill("es", [{ op: "damage", amount: 5, to: { faction: "enemies" } }], { targeting: "self", tags: ["Channel"], channelTurns: 1 });
  const z = makeUnit({ id: "z", team: "A", name: "Zephyrex", skills: [chan] });
  const st = makeState([z], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  performAction(st, { unit: "z", skillId: "es" });
  assert.ok(z.statuses.some((s) => s.kind === "channeling" && s.name === "es"), "channel installed without instant_cast");
});

test("dreamscapeEndDamage banks damage taken while marked and pays it back as true damage", () => {
  const xyris = makeUnit({ id: "x", team: "A", name: "Xyris" });
  xyris.triggers = [
    { on: "skillUsed", owner: "x", when: { sameUnit: ["eventSource", "self"] }, source: "Before I Wake",
      effect: [custom("applyDreamscapeMark", { skillId: "xyris2", markName: "Enter the Dreamscape", duration: 2 })] },
    { on: "damageDealt", owner: "x", when: { has: "mark", name: "Enter the Dreamscape", of: "eventTarget" }, source: "Before I Wake",
      effect: [custom("storeDamageDealt", { to: "eventTarget", name: "Dreamscape Damage" })] },
    { on: "statusExpired", owner: "x", when: { isFaction: "eventUnit", faction: "enemy" }, source: "Before I Wake",
      effect: [custom("dreamscapeEndDamage", { markName: "Enter the Dreamscape", to: "eventUnit" })] },
  ];
  const foe = makeUnit({ id: "e", team: "B", hp: 100, shield: 50 });
  const st = makeState([xyris], [foe]);
  emit(st, { type: "skillUsed", caster: "x", skillId: "xyris2", targets: ["e"] });
  assert.ok(foe.statuses.some((s) => s.kind === "mark" && s.name === "Enter the Dreamscape"), "companion A marked the target");
  emit(st, { type: "damageDealt", source: "x", target: "e", amount: 20, dtype: "normal", isNew: true });
  emit(st, { type: "damageDealt", source: "x", target: "e", amount: 15, dtype: "normal", isNew: true });
  assert.equal(stackCount(foe, "Dreamscape Damage"), 35, "banked 20 + 15 while marked");
  foe.statuses = foe.statuses.filter((s) => s.name !== "Enter the Dreamscape"); // simulate the mark expiring
  emit(st, { type: "statusExpired", unit: "e", kind: "mark", name: "Enter the Dreamscape" });
  assert.equal(foe.hp, 65, "paid back 35 as true damage (ignored the 50 shield)");
  assert.equal(stackCount(foe, "Dreamscape Damage"), 0, "tally cleared");
});

// ── Cluster 19 — summon-execute & Fae Prince ─────────────────────────────────────────────────────── //

test("barrenRealmExecute deletes each summoned Summer Courtesan and strikes the lowest-HP enemy", () => {
  const t = makeUnit({ id: "t", team: "A", name: "Titania" });
  t.triggers = [{ on: "minionSummoned", owner: "t", source: "Barren Realm",
    effect: [custom("barrenRealmExecute", { perStack: 10 })] }];
  const c1 = makeUnit({ id: "c1", team: "A", kind: "minion", name: "Summer Courtesan", summoner: "t" });
  const c2 = makeUnit({ id: "c2", team: "A", kind: "minion", name: "Summer Courtesan", summoner: "t" });
  const hi = makeUnit({ id: "hi", team: "B", hp: 100 });
  const lo = makeUnit({ id: "lo", team: "B", hp: 80 });
  const st = makeState([t, c1, c2], [hi, lo]);
  st.teams.A.units.push("c1", "c2");
  emit(st, { type: "minionSummoned", unit: "c1", template: "Summer Courtesan", summoner: "t" });
  emit(st, { type: "minionSummoned", unit: "c2", template: "Summer Courtesan", summoner: "t" });
  assert.equal(st.units.c1, undefined, "courtesan c1 removed");
  assert.equal(st.units.c2, undefined, "courtesan c2 removed");
  assert.ok(!st.teams.A.units.includes("c1"), "team roster pruned");
  assert.equal(lo.hp, 60, "2 x 10 Affliction to the lowest-HP enemy (80 -> 60)");
  assert.equal(hi.hp, 100, "the higher-HP enemy untouched");
});

test("barrenRealmExecute ignores non-Courtesan summons and other summoners", () => {
  const t = makeUnit({ id: "t", team: "A", name: "Titania" });
  t.triggers = [{ on: "minionSummoned", owner: "t", source: "Barren Realm", effect: [custom("barrenRealmExecute", { perStack: 10 })] }];
  const other = makeUnit({ id: "o", team: "A", kind: "minion", name: "Boulder", summoner: "t" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const st = makeState([t, other], [foe]);
  emit(st, { type: "minionSummoned", unit: "o", template: "Boulder", summoner: "t" });
  assert.ok(st.units.o, "a non-Courtesan minion is left alone");
  assert.equal(foe.hp, 100, "no damage for a non-Courtesan summon");
});

test("Fae Prince: undamaged enemies accrue +10, consumed on Zephyrex's next hit; absorbed hits don't count as damage", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zephyrex" });
  z.triggers = [
    { on: "damageDealt", owner: "z", when: { sameUnit: ["eventTarget", "self"] }, source: "Fae Prince",
      effect: [custom("recordDamagedZephyrex", { mark: "Damaged Zephyrex" })] },
    { on: "turnEnd", owner: "z", source: "Fae Prince", effect: [custom("faePrinceAccrue", { amount: 10, mark: "Fae Prince" })] },
    { on: "damageDealt", owner: "z", when: { sameUnit: ["eventSource", "self"] }, source: "Fae Prince",
      effect: [custom("faePrinceConsume", { amount: 10, mark: "Fae Prince" })] },
  ];
  const attacker = makeUnit({ id: "atk", team: "B", kind: "hero", hp: 100 });
  const absorbed = makeUnit({ id: "abs", team: "B", kind: "hero", hp: 100 });
  const idle = makeUnit({ id: "idle", team: "B", kind: "hero", hp: 100 });
  const st = makeState([z], [attacker, absorbed, idle]);
  emit(st, { type: "damageDealt", source: "atk", target: "z", amount: 10, dtype: "normal", isNew: true }); // real hit
  emit(st, { type: "damageDealt", source: "abs", target: "z", amount: 0, dtype: "normal", isNew: true }); // fully absorbed
  emit(st, { type: "turnEnd", team: "B" });
  assert.equal(stackCount(attacker, "Fae Prince"), 0, "the real attacker accrues nothing");
  assert.equal(stackCount(absorbed, "Fae Prince"), 1, "a fully-absorbed hit does NOT count as dealing damage");
  assert.equal(stackCount(idle, "Fae Prince"), 1, "the idle enemy accrues +1");
  // consume on Zephyrex's next hit to the idle enemy (apply the base hit, then emit the event the consume reacts to)
  applyDamage(idle, { amount: 5, type: "piercing", isNew: true });
  emit(st, { type: "damageDealt", source: "z", target: "idle", amount: 5, dtype: "piercing", isNew: true });
  assert.equal(idle.hp, 85, "5 (the hit) + 10 (Fae Prince bonus) = 15 total");
  assert.equal(stackCount(idle, "Fae Prince"), 0, "bonus consumed");
});

// ── Adversarial-review fixes (clusters 17-19) ────────────────────────────────────────────────────── //

test("shieldPerTurnForDuration uses the floored Call Tides read (Stinking Marsh: 0 raw -> 2 turns)", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir" });
  const ally = makeUnit({ id: "al", team: "A", hp: 100 });
  const st = makeState([z, ally], [makeUnit({ id: "e", team: "B" })]);
  applyStatus(z, status("stack_read_mod", { name: "Call Tides", mode: "floorZero", magnitude: 2 }));
  runEffects(st, [custom("shieldPerTurnForDuration", { to: { faction: "allies", includeSelf: true }, amount: 10 })], { caster: z, self: z, targets: [] });
  assert.ok(ally.shields.some((s) => s.amount === 10), "turn-1 shield granted immediately (floored read = 2)");
  assert.equal(st.scheduled.length, 1, "turn-2 shield scheduled");
});

test("eventTeamIsSelf gates a turnEnd trigger to the owner's own team", () => {
  const z = makeUnit({ id: "z", team: "A", name: "Zevkir", hp: 100 });
  z.triggers = [{ on: "turnEnd", owner: "z", when: { eventTeamIsSelf: true }, source: "Rapid Mutation",
    effect: [{ op: "damage", amount: 5, dtype: "affliction", to: "self" }] }];
  const st = makeState([z], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "turnEnd", team: "B" });
  assert.equal(z.hp, 100, "enemy team's turn-end does not fire it");
  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(z.hp, 95, "his own team's turn-end deals 5 Affliction");
});

test("extendEagleSkillDurations only bumps the Eagle, not other allied minions", () => {
  const eagleSkill = skill("swoop", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }]);
  const otherSkill = skill("other", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }]);
  const eagle = makeUnit({ id: "eag", team: "A", kind: "minion", name: "Hatchling Eagle", summoner: "syl", skills: [eagleSkill] });
  const golem = makeUnit({ id: "g", team: "A", kind: "minion", name: "Boulder", summoner: "syl", skills: [otherSkill] });
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  const st = makeState([syl, eagle, golem], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("extendEagleSkillDurations", { eagle: { faction: "allies", kind: "minion" }, durationDelta: 1 })], { caster: syl, self: syl, targets: [] });
  assert.equal((eagle.skills![0]!.effects[0] as { status: { duration: number } }).status.duration, 3, "eagle skill bumped 2 -> 3");
  assert.equal((golem.skills![0]!.effects[0] as { status: { duration: number } }).status.duration, 2, "non-eagle minion untouched");
});

test("extendEagleSkillDurations floors a duration-0 status to 1 before bumping (gains a real turn)", () => {
  const eagleSkill = skill("swoop", [{ op: "applyStatus", to: "target", status: { kind: "shatter", duration: 0 } }]);
  const eagle = makeUnit({ id: "eag", team: "A", kind: "minion", name: "Adult Eagle", summoner: "syl", skills: [eagleSkill] });
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl" });
  const st = makeState([syl, eagle], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("extendEagleSkillDurations", { eagle: { faction: "allies", kind: "minion" }, durationDelta: 1 })], { caster: syl, self: syl, targets: [] });
  assert.equal((eagle.skills![0]!.effects[0] as { status: { duration: number } }).status.duration, 2, "0 -> max(0,1)+1 = 2");
});

// ── Final cluster — the 6 hard holdouts ──────────────────────────────────────────────────────────── //

test("lastSkillId is set on cast and reset each round", () => {
  const atk = skill("s1", [{ op: "damage", amount: 5, to: "target" }], { targeting: "single", tags: ["Harmful"] });
  const a = makeUnit({ id: "a", team: "A", skills: [atk] });
  const st = makeState([a], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  performAction(st, { unit: "a", skillId: "s1", targets: ["e"] });
  assert.equal(a.lastSkillId, "s1", "records the last skill used");
  startRound(st, "A");
  assert.equal(a.lastSkillId, undefined, "reset at round start");
});

test("cloneLastUsedSkillOntoMinion clones the target's last skill onto a Dream Reflection", () => {
  registerMinion({ name: "Dream Reflection", maxHp: 35, element: "shadow", skills: [skill("xyrisminion1", [])] });
  const enemySkill = skill("foeSkill", [{ op: "damage", amount: 30, to: "target" }], { targeting: "single", tags: ["Harmful"], element: "fire" });
  const foe = makeUnit({ id: "e", team: "B", skills: [enemySkill], lastSkillId: "foeSkill" });
  const xyris = makeUnit({ id: "x", team: "A", name: "Xyris", currentElement: "shadow" });
  const st = makeState([xyris], [foe]);
  runEffects(st, [custom("cloneLastUsedSkillOntoMinion", { copyFrom: "target", minionTemplate: "Dream Reflection", placeholderSkillId: "xyrisminion1", reelementSpecificCostTo: "casterCurrentElement" })], { caster: xyris, self: xyris, targets: [foe] });
  const minion = Object.values(st.units).find((u) => u.kind === "minion" && u.name === "Dream Reflection");
  assert.ok(minion, "a Dream Reflection was summoned");
  assert.ok((minion!.skills ?? []).some((s) => s.id === "foeSkill"), "the target's last skill was cloned on");
  assert.ok(!(minion!.skills ?? []).some((s) => s.id === "xyrisminion1"), "the placeholder was replaced");
  assert.equal(minion!.currentElement, "shadow", "re-elemented to Xyris's element");
});

test("cloneLastUsedSkillOntoMinion fails (no minion) if the target never used a skill", () => {
  const foe = makeUnit({ id: "e", team: "B", skills: [] }); // lastSkillId undefined
  const xyris = makeUnit({ id: "x", team: "A", name: "Xyris" });
  const st = makeState([xyris], [foe]);
  runEffects(st, [custom("cloneLastUsedSkillOntoMinion", { copyFrom: "target", minionTemplate: "Dream Reflection", placeholderSkillId: "xyrisminion1" })], { caster: xyris, self: xyris, targets: [foe] });
  assert.ok(!Object.values(st.units).some((u) => u.kind === "minion"), "no minion summoned when the target has no last skill");
});

test("hiveFormationRedirect: Barbed Wit's taunt is redirected to a random Hive Formation ally", () => {
  const titania = makeUnit({ id: "t", team: "A", name: "Titania" });
  const ally = makeUnit({ id: "al", team: "A", statuses: [status("mark", { name: "Hive Formation" })] });
  const foe = makeUnit({ id: "e", team: "B", statuses: [status("taunt", { unitRef: "t" })] });
  const st = makeState([titania, ally], [foe]);
  runEffects(st, [custom("hiveFormationRedirect", { turns: 4, skillId: "titania3", markName: "Hive Formation" })], { caster: titania, self: titania, targets: [] });
  emit(st, { type: "skillUsed", caster: "t", skillId: "titania3", targets: ["e"] });
  assert.equal(foe.statuses.find((s) => s.kind === "taunt")!.unitRef, "al", "taunt redirected from Titania to the Hive-Formation ally");
});

test("shieldPerExtraTarget grants 10 shield per extra enemy affected beyond the declared target", () => {
  const ando = makeUnit({ id: "a", team: "A", name: "Ando" });
  ando.triggers = [{ on: "skillUsed", owner: "a", when: { sameUnit: ["eventSource", "self"] }, source: "Magnet", effect: [custom("shieldPerExtraTarget", { perTarget: 10 })] }];
  const st = makeState([ando], [makeUnit({ id: "e1", team: "B" }), makeUnit({ id: "e2", team: "B" }), makeUnit({ id: "e3", team: "B" })]);
  // declared target e1; affected e1,e2,e3 -> 2 extra -> 20 shield
  emit(st, { type: "skillUsed", caster: "a", skillId: "ando1", targets: ["e1"], affected: ["e1", "e2", "e3"] });
  assert.equal(ando.shields.reduce((n, s) => n + s.amount, 0), 20, "2 extra targets -> 20 shield");
  // single-hit skill: affected == declared -> no shield
  const ando2u = makeUnit({ id: "b", team: "A", name: "Ando2" });
  ando2u.triggers = [{ on: "skillUsed", owner: "b", when: { sameUnit: ["eventSource", "self"] }, source: "Magnet", effect: [custom("shieldPerExtraTarget", { perTarget: 10 })] }];
  const st2 = makeState([ando2u], [makeUnit({ id: "e", team: "B" })]);
  emit(st2, { type: "skillUsed", caster: "b", skillId: "ando1", targets: ["e"], affected: ["e"] });
  assert.equal(ando2u.shields.length, 0, "no extra targets -> no shield");
});

test("whimsyEngine replaces a marked unit's declared skill (via the replace TriggerKind)", () => {
  const titania = makeUnit({ id: "t", team: "A", name: "Titania", hp: 100 });
  // The foe's only skill is a harmless self-mark; whichever skill the replacement picks, it is this one.
  const safe = skill("safe", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Ran A Skill", duration: 1 } }], { targeting: "self", tags: [], cost: { generic: 0, specific: 0 } });
  const foe = makeUnit({ id: "e", team: "B", hp: 100, skills: [safe], statuses: [status("mark", { name: "The Whimsy Engine", duration: 1 })] });
  const st = makeState([titania], [foe]);
  runEffects(st, [custom("whimsyEngine", { turns: 1 })], { caster: titania, self: titania, targets: [] });
  const res = performAction(st, { unit: "e", skillId: "safe", targets: [] });
  assert.ok(res.countered, "the declared skill was intercepted + replaced by the replace-kind trigger");
  assert.ok(foe.statuses.some((s) => s.name === "Ran A Skill"), "a substitute skill actually ran");
});

test("whimsyEngine does NOT replace an unmarked caster's skill", () => {
  const titania = makeUnit({ id: "t", team: "A", name: "Titania", hp: 100 });
  const hit = skill("hit", [{ op: "damage", amount: 20, to: { faction: "enemies" } }], { targeting: "single", tags: ["Harmful"], cost: { generic: 0, specific: 0 } });
  const foe = makeUnit({ id: "e", team: "B", hp: 100, skills: [hit] }); // no Whimsy mark
  const st = makeState([titania], [foe]);
  runEffects(st, [custom("whimsyEngine", { turns: 1 })], { caster: titania, self: titania, targets: [] });
  const res = performAction(st, { unit: "e", skillId: "hit", targets: ["t"] });
  assert.ok(!res.countered, "an unmarked caster's skill resolves normally");
  assert.equal(titania.hp, 80, "the real skill dealt its 20 damage");
});

test("ionCoilRules: Saya Coil applies 2 at a time and caps its requires at 2", () => {
  const coil = skill("saya2", [{ op: "if", cond: { has: "mark", name: "Enhanced", of: "self" }, then: [{ op: "addStack", name: "Enhanced Saya Coil", amount: 1, to: "self" }], else: [{ op: "addStack", name: "Saya Coil", amount: 1, to: "self" }] }],
    { requires: { cmp: "<", left: { ref: "stackCount", name: "Saya Coil", of: "self" }, right: 3 } });
  const saya = makeUnit({ id: "s", team: "A", name: "Saya", skills: [coil] });
  const st = makeState([saya], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("ionCoilRules", { coilStack: "Saya Coil", maxStack: 2, perCast: 2, cannotEnhance: true, panicIgnoresCoils: true })], { caster: saya, self: saya, targets: [] });
  const s2 = saya.skills![0]!;
  assert.equal((s2.effects[0] as { op: string; amount: number }).op, "addStack", "coil effect is now a flat addStack (no Enhanced branch)");
  assert.equal((s2.effects[0] as { amount: number }).amount, 2, "applied 2 at a time");
  assert.equal((s2.requires as { right: number }).right, 2, "cap lowered to 2");
});

test("mountainRescueTeam gives Feed a stunned-ally heal branch (observable; Swoop half is Eagle-gated)", () => {
  const feed = skill("syl1", [{ op: "heal", amount: 20, to: { faction: "allies", kind: "minion" } }], { targeting: "single", tags: ["Helpful"] });
  const syl = makeUnit({ id: "syl", team: "A", name: "Syl", skills: [feed] });
  const stunnedAlly = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100, statuses: [status("stun", { duration: 1 })] });
  const st = makeState([syl, stunnedAlly], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [custom("mountainRescueTeam", { feedSkillId: "syl1", swoopSkillId: "sylminion2", invulnDuration: 1 })], { caster: syl, self: syl, targets: [] });
  runEffects(st, syl.skills![0]!.effects, { caster: syl, self: syl, targets: [stunnedAlly] });
  assert.equal(stunnedAlly.hp, 70, "Feed healed the stunned ally 20 via the new branch");
});

test("ion Saya's re-declared coil trigger deals 10-per-coil at turn-end", () => {
  const saya = withTrigger("s", "A", { on: "turnEnd", source: "Miniature Ion Cannons",
    when: { cmp: ">", left: { ref: "stackCount", name: "Saya Coil", of: "self" }, right: 0 },
    effect: [{ op: "damage", amount: { op: "mul", args: [10, { ref: "stackCount", name: "Saya Coil", of: "self" }] }, to: { pick: "random", from: { faction: "enemies" }, count: 1 } }] });
  saya.statuses.push(status("stack", { name: "Saya Coil", magnitude: 2 }));
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const st = makeState([saya], [foe]);
  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(foe.hp, 80, "2 coils -> 20 damage at turn-end (coil mechanic not inert under ion)");
});
