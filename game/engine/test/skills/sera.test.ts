/**
 * Behavior tests for Sera — asserted against the frozen skill PROSE (the oracle).
 * Sera builds "Eyes of Vengeance" stacks on enemies who attack her team and spends them
 * for bonus damage / essence / cooldown reduction.
 *
 * Team layout: a1 = sera, a2 = syl, a3 = gommar; enemies b1 = xyris, b2 = laria, b3 = riverdaughter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, shieldTotal, stackMag, emit, performAction, endTurn, startTurn } from "../skillHarness.ts";
import { status } from "../helpers.ts";

const A = ["sera", "syl", "gommar"];
const B = ["xyris", "laria", "riverdaughter"];
const essence = (u: { statuses: { kind: string }[] }): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
/** Give team A plenty of Sera's Specific (vengeance) energy so a Specific cost never blocks a cast. */
const fund = (s: ReturnType<typeof battle>) => { s.teams.A.energy.vengeance = 99; };
/** Put an Eyes of Vengeance stack of the given magnitude on a unit. */
const addEyes = (u: { statuses: unknown[] }, mag = 1) => (u.statuses as any[]).push(status("stack", { name: "Eyes of Vengeance", magnitude: mag }));

// --------------------------------------------------------------------------- //
//  sera0 — Eyes of Vengeance (passive)
//  "Enemy Heroes who use non-Invisible Harmful skills on Sera or her allies gain a stack
//   of Eyes of Vengeance."
// --------------------------------------------------------------------------- //
test("sera0 — an enemy who uses a Harmful skill on Sera gains a stack of Eyes of Vengeance", () => {
  const s = battle(A, B);
  endTurn(s); startTurn(s); // team B's turn
  performAction(s, { unit: "b1", skillId: "xyris1", targets: ["a1"] }); // Harmful, on Sera
  assert.equal(stackMag(unit(s, "b1"), "Eyes of Vengeance"), 1, "attacker gains 1 stack");
});

test("sera0 — a Harmful skill on one of Sera's ALLIES also marks the attacker", () => {
  const s = battle(A, B);
  endTurn(s); startTurn(s);
  performAction(s, { unit: "b1", skillId: "xyris1", targets: ["a2"] }); // on an ally of Sera
  assert.equal(stackMag(unit(s, "b1"), "Eyes of Vengeance"), 1, "attacking an ally still marks the attacker");
});

test("sera0 — a non-Harmful (Strategic) skill does NOT mark the attacker (no Scan active)", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  emit(s, { type: "skillUsed", caster: "b1", skillId: "probe-strategic", targets: ["a1"], tags: ["Strategic"], affected: [] });
  assert.equal(stackMag(b1, "Eyes of Vengeance"), 0, "a Strategic skill grants no stack by default");
});

// --------------------------------------------------------------------------- //
//  sera1 — Synthetic Skyblade  (cost g1, cd0)
//  "Deals 15 damage to target enemy. If they are marked by Eyes of Vengeance, this skill
//   will consume 1 stack to deal 10 additional damage and grant Sera Elemental Essence."
// --------------------------------------------------------------------------- //
test("sera1 — costs 1 Generic, no cooldown", () => {
  const s = battle(A, B);
  const sk = skillOf(unit(s, "a1"), "sera1");
  assert.equal(sk.cost.generic, 1);
  assert.equal(sk.cooldown, 0);
});

test("sera1 — base: deals 15 to the target, no Essence when the target is unmarked", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  const before = b1.hp;
  performAction(s, { unit: "a1", skillId: "sera1", targets: ["b1"] });
  assert.equal(before - b1.hp, 15, "15 damage");
  assert.equal(essence(unit(s, "a1")), 0, "no Essence granted against an unmarked target");
});

test("sera1 — marked: consumes 1 stack for +10 damage (25 total) and grants Sera Essence", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  addEyes(b1, 1);
  const before = b1.hp;
  performAction(s, { unit: "a1", skillId: "sera1", targets: ["b1"] });
  assert.equal(before - b1.hp, 25, "15 + 10 additional damage");
  assert.equal(stackMag(b1, "Eyes of Vengeance"), 0, "1 stack consumed");
  assert.equal(essence(unit(s, "a1")), 1, "Sera gains Elemental Essence");
});

// --------------------------------------------------------------------------- //
//  sera2 — Energized Wingstorm  (cost s1, cd4)
//  "Deals 15 Piercing damage to the enemy team. If any enemies are marked by Eyes of
//   Vengeance, this skill will consume 1 stack from each to reduce this skill's cooldown by
//   1 turn for each marked consumed."
// --------------------------------------------------------------------------- //
test("sera2 — costs 1 Specific, base cooldown 4", () => {
  const s = battle(A, B); fund(s);
  const sk = skillOf(unit(s, "a1"), "sera2");
  assert.equal(sk.cost.specific, 1);
  assert.equal(sk.cooldown, 4);
});

test("sera2 — deals 15 Piercing to the whole enemy team and consumes 1 Eyes stack from each marked", () => {
  const s = battle(A, B); fund(s);
  addEyes(unit(s, "b1"), 1);
  addEyes(unit(s, "b2"), 1);
  const hp = [unit(s, "b1").hp, unit(s, "b2").hp, unit(s, "b3").hp];
  performAction(s, { unit: "a1", skillId: "sera2" });
  assert.equal(hp[0] - unit(s, "b1").hp, 15, "b1 takes 15 Piercing");
  assert.equal(hp[1] - unit(s, "b2").hp, 15, "b2 takes 15 Piercing");
  assert.equal(hp[2] - unit(s, "b3").hp, 15, "b3 takes 15 Piercing");
  assert.equal(stackMag(unit(s, "b1"), "Eyes of Vengeance"), 0, "b1's stack consumed");
  assert.equal(stackMag(unit(s, "b2"), "Eyes of Vengeance"), 0, "b2's stack consumed");
});

test("sera2 — cooldown is reduced by 1 for each marked enemy consumed", () => {
  const s = battle(A, B); fund(s);
  addEyes(unit(s, "b1"), 1);
  addEyes(unit(s, "b2"), 1);
  performAction(s, { unit: "a1", skillId: "sera2" });
  // Base cd 4, two marked consumed -> effective cooldown 2.
  assert.equal(skillOf(unit(s, "a1"), "sera2").currentCd, 2, "4 - 2 marked consumed = 2");
});

// --------------------------------------------------------------------------- //
//  sera3 — Heavenly Parry  (cost g1/s1, cd2)
//  "For 1 turn, if target enemy uses a new Harmful skill, they will take 25 Piercing damage
//   and gain an additional stack of Eyes of Vengeance. This effect is invisible. If the
//   target was already marked, Sera gains Elemental Essence."
// --------------------------------------------------------------------------- //
test("sera3 — costs 1 Generic + 1 Specific, cooldown 2", () => {
  const s = battle(A, B); fund(s);
  const sk = skillOf(unit(s, "a1"), "sera3");
  assert.equal(sk.cost.generic, 1);
  assert.equal(sk.cost.specific, 1);
  assert.equal(sk.cooldown, 2);
});

test("sera3 — installs the parry mark; only grants Sera Essence when the target was already marked", () => {
  // Unmarked target: no immediate Essence.
  const s1 = battle(A, B); fund(s1);
  performAction(s1, { unit: "a1", skillId: "sera3", targets: ["b1"] });
  assert.ok(hasStatus(unit(s1, "b1"), "mark"), "the parry mark is installed on the target");
  assert.equal(essence(unit(s1, "a1")), 0, "no Essence when the target was not already marked");
  // Already-marked target: Sera gains Essence immediately on cast.
  const s2 = battle(A, B); fund(s2);
  addEyes(unit(s2, "b1"), 1);
  performAction(s2, { unit: "a1", skillId: "sera3", targets: ["b1"] });
  assert.equal(essence(unit(s2, "a1")), 1, "Sera gains Essence when the target was already marked");
});

test("sera3 — when the marked enemy uses a Harmful skill: 25 Piercing + an additional Eyes stack, then the parry is spent", () => {
  const s = battle(A, B); fund(s);
  const b1 = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "sera3", targets: ["b1"] });
  endTurn(s); startTurn(s); // team B
  const before = b1.hp;
  // b1 attacks its OWN ally (b2) so the passive does not also fire — isolating the parry's stack.
  performAction(s, { unit: "b1", skillId: "xyris1", targets: ["b2"] });
  assert.equal(before - b1.hp, 25, "the punished enemy takes 25 Piercing");
  assert.equal(stackMag(b1, "Eyes of Vengeance"), 1, "and gains an additional Eyes of Vengeance stack");
  assert.ok(!hasStatus(b1, "mark"), "the parry mark is consumed");
});

// --------------------------------------------------------------------------- //
//  sera4 — Scan of the All-Knowing  (cost 0, cd3)
//  "Eyes of Vengeance will trigger from Strategic skills as well for 1 turn."
// --------------------------------------------------------------------------- //
test("sera4 — costs nothing, cooldown 3, applies a 1-turn self mark", () => {
  const s = battle(A, B);
  const sk = skillOf(unit(s, "a1"), "sera4");
  assert.equal(sk.cost.generic, 0);
  assert.equal(sk.cost.specific, 0);
  assert.equal(sk.cooldown, 3);
  performAction(s, { unit: "a1", skillId: "sera4", targets: ["b1"] });
  const m = unit(s, "a1").statuses.find((x) => x.kind === "mark" && x.name === "Scan of the All-Knowing");
  assert.ok(m, "the Scan mark is applied to Sera");
  assert.equal(m!.duration, 1, "for 1 turn");
});

test("sera4 — while Scan is active, an enemy Strategic skill on Sera's team ALSO grants an Eyes stack", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  // Baseline: without Scan, a Strategic skill grants nothing (see sera0 negative), so cast Scan first.
  performAction(s, { unit: "a1", skillId: "sera4", targets: ["b1"] });
  emit(s, { type: "skillUsed", caster: "b1", skillId: "probe-strategic", targets: ["a1"], tags: ["Strategic"], affected: [] });
  assert.equal(stackMag(b1, "Eyes of Vengeance"), 1, "Strategic now triggers Eyes of Vengeance");
});

// --------------------------------------------------------------------------- //
//  sera5 — Proactivity Protocol  (cost s1, cd4)
//  "Sera receives 20 True Damage and 20 Shield. Target ally is healed for 20 HP."
// --------------------------------------------------------------------------- //
test("sera5 — costs 1 Specific, cooldown 4 (frozen)", () => {
  const s = battle(A, B); fund(s);
  const sk = skillOf(unit(s, "a1"), "sera5");
  assert.equal(sk.cost.specific, 1);
  assert.equal(sk.cooldown, 4);
});

test("sera5 — Sera takes 20 True damage (bypassing her Shield), gains 20 Shield, heals the target ally 20", () => {
  const s = battle(A, B); fund(s);
  const se = unit(s, "a1"), a2 = unit(s, "a2");
  se.hp = 100;
  a2.hp = a2.maxHp - 30;
  performAction(s, { unit: "a1", skillId: "sera5", targets: ["a2"] });
  assert.equal(se.hp, 80, "Sera loses 20 to True damage");
  assert.equal(shieldTotal(se), 20, "Sera gains 20 Shield");
  assert.equal(a2.hp, a2.maxHp - 10, "the target ally is healed 20 (from -30 to -10)");
});

// --------------------------------------------------------------------------- //
//  sera6 — Divinity Engine  (ultimate, cost s3, cd6)
//  "For her next 2 turns, Sera ignores non-damage effects. During this time, Synthetic
//   Skyblade will consume an additional stack of Eyes of Vengeance if possible, and grants
//   Sera Shield equal to the damage it deals."
// --------------------------------------------------------------------------- //
test("sera6 — costs 3 Specific, cooldown 6", () => {
  const s = battle(A, B); fund(s);
  const sk = skillOf(unit(s, "a1"), "sera6");
  assert.equal(sk.cost.specific, 3);
  assert.equal(sk.cooldown, 6);
});

test("sera6 — grants 'ignore non-damage effects' for her next 2 turns", () => {
  const s = battle(A, B); fund(s);
  performAction(s, { unit: "a1", skillId: "sera6" });
  const ndi = unit(s, "a1").statuses.find((x) => x.kind === "non_damage_ignore");
  assert.ok(ndi, "Sera ignores non-damage effects");
  assert.equal(ndi!.duration, 2, "for her next 2 turns");
});

test("sera6 — while active, Synthetic Skyblade consumes an EXTRA Eyes stack and Shields Sera for the damage dealt", () => {
  const s = battle(A, B); fund(s);
  const se = unit(s, "a1"), b1 = unit(s, "b1");
  addEyes(b1, 2); // two stacks available
  performAction(s, { unit: "a1", skillId: "sera6" });
  const before = b1.hp;
  performAction(s, { unit: "a1", skillId: "sera1", targets: ["b1"] });
  assert.equal(before - b1.hp, 25, "Skyblade deals its 25 (15 + marked 10)");
  assert.equal(stackMag(b1, "Eyes of Vengeance"), 0, "consumes 2 stacks total: the base one plus the Divinity extra");
  assert.equal(shieldTotal(se), 25, "Sera gains Shield equal to the 25 damage dealt");
});
