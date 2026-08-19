/**
 * Behavior tests for Keeper of Fables, asserted against the frozen skill prose (the oracle):
 *
 *   keeper0 Tales to Tell     — "Keeper of Fables gains Elemental Essence whenever one of his allies does.
 *                               Whenever this occurs, he gains 10 Shield."  (Tales to Tell IS his Shield pool.)
 *   keeper1 Page-turner        — "attempts to consume 25 Shield from Tales to Tell. If he does, he deals 25
 *                               damage to target enemy."
 *   keeper2 Character Development — "attempts to consume 25 Shield ... If he does, he heals target ally for 30 HP."
 *   keeper3 Chronicle Deeds    — "If target enemy uses a new skill this turn, Tales to Tell will gain 35 Shield.
 *                               This effect is invisible."
 *   keeper4 Plot Armor         — "attempts to consume 20 Shield ... If he does, he makes target ally
 *                               invulnerable for 1 turn."
 *   keeper5 Hero's Return       — "attempts to consume 75 Shield ... If he does, target dead ally returns to
 *                               life at 50 HP."
 *
 * Keeper sits at a1; a2/a3 are allies, b1/b2/b3 the enemies. Tales to Tell starts empty, so tests that
 * need a Shield pool seed it directly onto Keeper's `shields`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, shieldTotal, performAction, emit, startTurn, endTurn } from "../skillHarness.ts";

const A: [string, string, string] = ["keeper", "syl", "gommar"];
const B: [string, string, string] = ["riverdaughter", "laria", "xyris"];

const essence = (u: ReturnType<typeof unit>) => u.statuses.filter((x) => x.kind === "elemental_essence").length;
/** Seed Tales to Tell (Keeper's real Shield pool) with a given amount. */
const givePool = (u: ReturnType<typeof unit>, n: number) =>
  u.shields.push({ amount: n, duration: null, appliedBy: "test", appliedTurn: 0 });
/** Emit the statusApplied event the interpreter fires when a unit gains a status. */
const giveEssence = (s: ReturnType<typeof battle>, id: string) => {
  unit(s, id).statuses.push({ kind: "elemental_essence", duration: null, appliedBy: "test", appliedTurn: 0 });
  emit(s, { type: "statusApplied", unit: id, source: id, kind: "elemental_essence" });
};

// --------------------------------------------------------------------------- //
//  keeper0 — Tales to Tell (passive)
// --------------------------------------------------------------------------- //

test("Tales to Tell — Keeper starts with an empty pool", () => {
  const s = battle(A, B);
  assert.equal(shieldTotal(unit(s, "a1")), 0, "no Shield until an ally gains Elemental Essence");
});

test("Tales to Tell — an ally gaining Elemental Essence gives Keeper Essence + 10 Shield", () => {
  const s = battle(A, B);
  giveEssence(s, "a2"); // ally gains Elemental Essence
  assert.equal(essence(unit(s, "a1")), 1, "Keeper gains Elemental Essence when an ally does");
  assert.equal(shieldTotal(unit(s, "a1")), 10, "Keeper gains 10 Shield on Tales to Tell");
});

test("Tales to Tell — stacks across multiple allies gaining Essence", () => {
  const s = battle(A, B);
  giveEssence(s, "a2");
  giveEssence(s, "a3");
  assert.equal(shieldTotal(unit(s, "a1")), 20, "10 Shield per ally Essence gain");
});

test("Tales to Tell — an ENEMY gaining Essence does not trigger it", () => {
  const s = battle(A, B);
  giveEssence(s, "b1"); // enemy, not an ally
  assert.equal(shieldTotal(unit(s, "a1")), 0, "only allies' Essence gains feed Tales to Tell");
});

// --------------------------------------------------------------------------- //
//  keeper1 — Page-turner
// --------------------------------------------------------------------------- //

test("Page-turner — consumes 25 Shield and deals 25 damage to the target enemy", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 40);
  performAction(s, { unit: "a1", skillId: "keeper1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 75, "25 damage to target enemy");
  assert.equal(shieldTotal(unit(s, "a1")), 15, "25 Shield consumed from Tales to Tell (40 -> 15)");
});

test("Page-turner — with too little Shield, nothing happens (the 'if he does' guard)", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 24); // one short of 25
  performAction(s, { unit: "a1", skillId: "keeper1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 100, "no damage — the consume failed");
  assert.equal(shieldTotal(unit(s, "a1")), 24, "no Shield spent");
});

// --------------------------------------------------------------------------- //
//  keeper2 — Character Development
// --------------------------------------------------------------------------- //

test("Character Development — consumes 25 Shield and heals the target ally for 30", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 40);
  unit(s, "a2").hp = 50;
  performAction(s, { unit: "a1", skillId: "keeper2", targets: ["a2"] });
  assert.equal(unit(s, "a2").hp, 80, "target ally healed 30 HP (50 -> 80)");
  assert.equal(shieldTotal(unit(s, "a1")), 15, "25 Shield consumed (40 -> 15)");
});

test("Character Development — no heal when the pool is too small", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 10);
  unit(s, "a2").hp = 50;
  performAction(s, { unit: "a1", skillId: "keeper2", targets: ["a2"] });
  assert.equal(unit(s, "a2").hp, 50, "no heal — the consume failed");
  assert.equal(shieldTotal(unit(s, "a1")), 10, "no Shield spent");
});

// --------------------------------------------------------------------------- //
//  keeper3 — Chronicle Deeds
// --------------------------------------------------------------------------- //

test("Chronicle Deeds — Tales to Tell gains 35 Shield if the marked enemy uses a skill", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "keeper3", targets: ["b1"] });
  assert.equal(shieldTotal(unit(s, "a1")), 0, "no Shield yet — only the watch is armed");
  // Hand the turn to B and let the marked enemy act.
  endTurn(s);
  startTurn(s);
  performAction(s, { unit: "b1", skillId: unit(s, "b1").skills[0]!.id, targets: ["a1"] });
  assert.equal(shieldTotal(unit(s, "a1")), 35, "Tales to Tell gains 35 Shield when the marked enemy uses a skill");
});

test("Chronicle Deeds — no Shield if a DIFFERENT (unmarked) enemy acts", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "keeper3", targets: ["b1"] }); // mark b1 only
  endTurn(s);
  startTurn(s);
  performAction(s, { unit: "b2", skillId: unit(s, "b2").skills[0]!.id, targets: ["a1"] }); // b2 is unmarked
  assert.equal(shieldTotal(unit(s, "a1")), 0, "an unmarked enemy acting grants nothing");
});

// --------------------------------------------------------------------------- //
//  keeper4 — Plot Armor
// --------------------------------------------------------------------------- //

test("Plot Armor — consumes 20 Shield and makes the target ally invulnerable for 1 turn", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 30);
  performAction(s, { unit: "a1", skillId: "keeper4", targets: ["a2"] });
  assert.ok(hasStatus(unit(s, "a2"), "invulnerable"), "target ally is invulnerable");
  const inv = unit(s, "a2").statuses.find((x) => x.kind === "invulnerable")!;
  assert.equal(inv.duration, 1, "invulnerability lasts 1 turn");
  assert.equal(shieldTotal(unit(s, "a1")), 10, "20 Shield consumed (30 -> 10)");
});

test("Plot Armor — no invulnerability when the pool is too small", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 19); // one short of 20
  performAction(s, { unit: "a1", skillId: "keeper4", targets: ["a2"] });
  assert.ok(!hasStatus(unit(s, "a2"), "invulnerable"), "no invulnerability — the consume failed");
  assert.equal(shieldTotal(unit(s, "a1")), 19, "no Shield spent");
});

// --------------------------------------------------------------------------- //
//  keeper5 — Hero's Return
// --------------------------------------------------------------------------- //

test("Hero's Return — consumes 75 Shield and revives a dead ally at 50 HP", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 100);
  // Kill the ally.
  unit(s, "a2").hp = 0;
  unit(s, "a2").alive = false;
  performAction(s, { unit: "a1", skillId: "keeper5", targets: ["a2"] });
  assert.equal(unit(s, "a2").alive, true, "the dead ally returns to life");
  assert.equal(unit(s, "a2").hp, 50, "revived at 50 HP");
  assert.equal(shieldTotal(unit(s, "a1")), 25, "75 Shield consumed (100 -> 25)");
});

test("Hero's Return — with too little Shield, the dead ally stays dead", () => {
  const s = battle(A, B);
  givePool(unit(s, "a1"), 74); // one short of 75
  unit(s, "a2").hp = 0;
  unit(s, "a2").alive = false;
  performAction(s, { unit: "a1", skillId: "keeper5", targets: ["a2"] });
  assert.equal(unit(s, "a2").alive, false, "no revive — the consume failed");
  assert.equal(shieldTotal(unit(s, "a1")), 74, "no Shield spent");
});
