/**
 * Behavior tests for Ando-91 against the frozen skill prose (the oracle). Assertions target the
 * described behavior, never the implementation. A clean assertion failure here is a reported bug.
 *
 * Oracle (game/content/frozen/skills.json):
 *  ando0 Stored Charge (passive): "Ando's skills Charge him, granting him Elemental Essence and
 *    augmenting his skills for 1 turn. Using a skill while Charged will Supercharge him, granting
 *    him Elemental Essence and further augmenting his skills for 1 turn."
 *  ando1 Electroblade: "Deals 15 damage to target enemy and marks them with Electroblade. While
 *    Charged, this skill also strikes any target affected by Electroblade. While Supercharged, this
 *    skill targets all enemies and deals 10 additional damage to targets marked by Electroblade."
 *  ando2 Flash Step: "Shatters target enemy until the end of Ando's next turn. While Charged, this
 *    skill lasts an additional turn. While Supercharged, this skill affects all targets marked by
 *    Electroblade."
 *  ando3 Expel Energy: "Deals 10 damage to target enemy and removes Ando's charge state. If Ando
 *    was Charged, this skill deals 10 additional damage. If Ando was Supercharged, it deals 20
 *    additional damage and becomes Piercing. This skill cannot be stunned and does not advance
 *    Ando's Charge state."
 *  ando4 Focus Power: "Ando advances to the next Charge state. Afterwards, if he is Charged, he
 *    strikes all enemies marked by Electroblade for 5 Piercing damage. If he is Supercharged, he
 *    marks a random enemy with Electroblade."
 *  ando5 Overclock: "For the next 3 turns, after using a Supercharged skill, Ando will become
 *    Charged and gain Elemental Essence. This skill can only be used while Supercharged, and extends
 *    the duration of his current Supercharge by 1 turn."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, shieldTotal, canUse, performAction } from "../skillHarness.ts";
import type { Unit } from "../../src/types.ts";

const A = ["ando", "gommar", "gommar"];
const B = ["gommar", "gommar", "gommar"];

const mark = (u: Unit, name: string, duration: number | null = 1) =>
  u.statuses.push({ kind: "mark", name, duration, appliedBy: u.id, appliedTurn: 0 });
const dr = (u: Unit, mag: number) =>
  u.statuses.push({ kind: "damage_reduction", magnitude: mag, duration: null, appliedBy: "x", appliedTurn: 0 });
const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const statusOf = (u: Unit, kind: string, name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const isCharged = (u: Unit) => hasStatus(u, "mark", "Charged");
const isSuper = (u: Unit) => hasStatus(u, "mark", "Supercharged");
const hasEblade = (u: Unit) => hasStatus(u, "mark", "Electroblade");

// --------------------------------------------------------------------------- //
//  ando0 — Stored Charge (passive)
// --------------------------------------------------------------------------- //
test("Stored Charge — a skill from neutral Charges Ando and grants Elemental Essence", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  assert.equal(isCharged(ando), false, "starts uncharged");
  assert.equal(isSuper(ando), false, "starts un-supercharged");
  const before = essenceCount(ando);
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] });
  assert.equal(isCharged(ando), true, "using a skill Charges him");
  assert.equal(isSuper(ando), false, "one step only: not yet Supercharged");
  assert.equal(essenceCount(ando), before + 1, "grants one Elemental Essence");
});

test("Stored Charge — a skill while Charged Supercharges Ando and grants more Essence", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Charged", 1);
  const before = essenceCount(ando);
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] });
  assert.equal(isSuper(ando), true, "using a skill while Charged Supercharges him");
  assert.equal(isCharged(ando), false, "Charged consumed by the advance");
  assert.equal(essenceCount(ando), before + 1, "grants another Elemental Essence");
});

test("Stored Charge — a skill while Supercharged does not advance further and grants no Essence", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Supercharged", 1);
  const before = essenceCount(ando);
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] });
  assert.equal(isSuper(ando), true, "stays Supercharged (no further step)");
  assert.equal(essenceCount(ando), before, "no additional Essence once already Supercharged");
});

// --------------------------------------------------------------------------- //
//  ando1 — Electroblade
// --------------------------------------------------------------------------- //
test("Electroblade — base: 15 damage to target and marks it with Electroblade", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "15 damage");
  assert.equal(hasEblade(unit(s, "b1")), true, "marks the target with Electroblade");
  assert.equal(hasEblade(unit(s, "b2")), false, "only the target is marked");
});

test("Electroblade — Charged: also strikes every Electroblade-marked enemy for 15", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Charged", 1);
  mark(unit(s, "b2"), "Electroblade", null); // a pre-existing mark
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "primary target marked then struck for 15");
  assert.equal(unit(s, "b2").hp, 85, "the other Electroblade-marked enemy is also struck for 15");
  assert.equal(unit(s, "b3").hp, 100, "an unmarked enemy is untouched");
});

test("Electroblade — Supercharged: hits all enemies for 15, +10 to those already marked, then marks all", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Supercharged", 1);
  mark(unit(s, "b1"), "Electroblade", null); // marked before this cast
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 75, "already-marked enemy takes 15 + 10 = 25");
  assert.equal(unit(s, "b2").hp, 85, "unmarked enemy takes 15");
  assert.equal(unit(s, "b3").hp, 85, "unmarked enemy takes 15");
  assert.equal(hasEblade(unit(s, "b2")), true, "all enemies are marked afterward");
  assert.equal(hasEblade(unit(s, "b3")), true, "all enemies are marked afterward");
});

// --------------------------------------------------------------------------- //
//  ando2 — Flash Step
// --------------------------------------------------------------------------- //
test("Flash Step — base: Shatters the target until end of Ando's next turn (1 turn), cooldown 2", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "ando2", targets: ["b1"] });
  const b1 = unit(s, "b1");
  assert.equal(hasStatus(b1, "shatter"), true, "target is Shattered");
  assert.equal(statusOf(b1, "shatter")!.duration, 1, "lasts until end of Ando's next turn");
  assert.equal(skillOf(unit(s, "a1"), "ando2").currentCd, 2, "cooldown 2");
});

test("Flash Step — Charged: Shatter lasts an additional turn (2)", () => {
  const s = battle(A, B);
  mark(unit(s, "a1"), "Charged", 1);
  performAction(s, { unit: "a1", skillId: "ando2", targets: ["b1"] });
  assert.equal(statusOf(unit(s, "b1"), "shatter")!.duration, 2, "one extra turn of Shatter");
});

test("Flash Step — Supercharged: Shatters all Electroblade-marked enemies", () => {
  const s = battle(A, B);
  mark(unit(s, "a1"), "Supercharged", 1);
  mark(unit(s, "b1"), "Electroblade", null);
  mark(unit(s, "b2"), "Electroblade", null);
  performAction(s, { unit: "a1", skillId: "ando2", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "b1"), "shatter"), true, "marked enemy Shattered");
  assert.equal(hasStatus(unit(s, "b2"), "shatter"), true, "marked enemy Shattered");
  assert.equal(hasStatus(unit(s, "b3"), "shatter"), false, "unmarked enemy not Shattered");
});

// --------------------------------------------------------------------------- //
//  ando3 — Expel Energy
// --------------------------------------------------------------------------- //
test("Expel Energy — base (neutral): 10 damage, and does not advance Ando's Charge state", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "ando3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 damage");
  assert.equal(isCharged(ando), false, "does not advance Ando's Charge state");
  assert.equal(isSuper(ando), false, "does not advance Ando's Charge state");
  assert.equal(skillOf(ando, "ando3").currentCd, 1, "cooldown 1");
});

test("Expel Energy — Charged: 10 additional damage (20), and removes the charge state", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Charged", 1);
  performAction(s, { unit: "a1", skillId: "ando3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "10 + 10 additional = 20 damage");
  assert.equal(isCharged(ando), false, "removes Ando's charge state");
  assert.equal(isSuper(ando), false, "did not advance to Supercharged");
});

test("Expel Energy — Supercharged: 20 additional damage (30) and becomes Piercing (ignores DR)", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Supercharged", 1);
  dr(unit(s, "b1"), 10); // Damage Reduction that Piercing must ignore
  performAction(s, { unit: "a1", skillId: "ando3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 70, "30 Piercing damage ignores the 10 DR (non-piercing would deal 20)");
  assert.equal(isSuper(ando), false, "removes Ando's charge state");
});

// --------------------------------------------------------------------------- //
//  ando4 — Focus Power
// --------------------------------------------------------------------------- //
test("Focus Power — from neutral: advances to Charged, then strikes Electroblade-marked enemies for 5 Piercing", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(unit(s, "b1"), "Electroblade", null);
  const before = essenceCount(ando);
  performAction(s, { unit: "a1", skillId: "ando4" });
  assert.equal(isCharged(ando), true, "advances to the next Charge state (Charged)");
  assert.equal(unit(s, "b1").hp, 95, "5 Piercing damage to the marked enemy");
  assert.equal(unit(s, "b2").hp, 100, "unmarked enemy untouched");
  assert.equal(essenceCount(ando), before + 1, "advancing charge grants Elemental Essence");
});

test("Focus Power — from Charged: advances to Supercharged, then marks a random enemy with Electroblade", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Charged", 1);
  performAction(s, { unit: "a1", skillId: "ando4" });
  assert.equal(isSuper(ando), true, "advances to Supercharged");
  const marked = ["b1", "b2", "b3"].filter((id) => hasEblade(unit(s, id)));
  assert.equal(marked.length, 1, "marks exactly one random enemy with Electroblade");
});

// --------------------------------------------------------------------------- //
//  ando5 — Overclock
// --------------------------------------------------------------------------- //
test("Overclock — can only be used while Supercharged", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  assert.equal(canUse(s, ando, skillOf(ando, "ando5")), false, "not usable while un-supercharged");
  mark(ando, "Supercharged", 1);
  assert.equal(canUse(s, ando, skillOf(ando, "ando5")), true, "usable while Supercharged");
});

test("Overclock — extends the current Supercharge by 1 turn, cooldown 4", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Supercharged", 1);
  performAction(s, { unit: "a1", skillId: "ando5" });
  assert.equal(statusOf(ando, "mark", "Supercharged")!.duration, 2, "Supercharge duration extended by 1 (1 -> 2)");
  assert.equal(skillOf(ando, "ando5").currentCd, 4, "cooldown 4");
});

test("Overclock — for 3 turns, after a Supercharged skill Ando becomes Charged and gains Essence", () => {
  const s = battle(A, B);
  const ando = unit(s, "a1");
  mark(ando, "Supercharged", 1);
  performAction(s, { unit: "a1", skillId: "ando5" }); // opens the Overclock window; stays Supercharged
  assert.equal(isSuper(ando), true, "Overclock itself keeps Ando Supercharged");
  const before = essenceCount(ando);
  performAction(s, { unit: "a1", skillId: "ando1", targets: ["b1"] }); // a Supercharged skill
  assert.equal(isCharged(ando), true, "after a Supercharged skill Ando becomes Charged");
  assert.equal(isSuper(ando), false, "no longer Supercharged");
  assert.equal(essenceCount(ando), before + 1, "gains Elemental Essence");
});
