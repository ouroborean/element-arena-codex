/**
 * Behavior tests for Saya, Genius Inventor's base kit, asserted against the frozen skill
 * prose (game/content/frozen/skills.json). Enhanced branches are exercised by planting the
 * "Enhanced" mark (what Stroke of Genius grants) and checking it is both used and consumed.
 *
 * Inert bystanders (allies riverdaughter/scratch, enemies ando/zevkir/keeper) keep the
 * numbers clean — their passives gate on their own actions/marks, not on Saya's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, shieldTotal, stackMag,
  performAction, canUse, endTurn, emit,
} from "../skillHarness.ts";
import { status } from "../helpers.ts";
import { applyDamage } from "../../src/damage.ts";
import type { MatchState, Unit } from "../../src/types.ts";

const A = ["saya", "riverdaughter", "scratch"];
const B = ["ando", "zevkir", "keeper"];

const enemyHpLost = (s: MatchState): number =>
  ["b1", "b2", "b3"].reduce((a, id) => a + (100 - unit(s, id).hp), 0);
const totalMines = (s: MatchState): number =>
  ["b1", "b2", "b3"].reduce((a, id) => a + stackMag(unit(s, id), "Spider Mine"), 0);
const costModMag = (u: Unit): number =>
  u.statuses.filter((x) => x.kind === "cost_mod").reduce((a, x) => a + (x.magnitude ?? 0), 0);

// --------------------------------------------------------------------------- //
//  saya0 — Well-Used Panic Button (passive)
//  "The first time Saya falls below 40 health due to damage, her next Stroke of
//   Genius will detonate all of her inventions, dealing 10 Piercing damage to a
//   random enemy and granting her 10 Shield for each device detonated."
// --------------------------------------------------------------------------- //
test("Well-Used Panic Button — arms when Saya first falls below 40 HP from damage", () => {
  const s = battle(A, B);
  const saya = unit(s, "a1");
  saya.hp = 30; // dropped below 40 by damage
  emit(s, { type: "damageDealt", source: "b1", target: "a1", amount: 20, dtype: "normal", isNew: true });
  assert.equal(hasStatus(saya, "mark", "Panic Armed"), true, "the next Stroke of Genius is armed");
});

test("Well-Used Panic Button — Stroke of Genius detonates every device: 10 Piercing + 10 Shield each", () => {
  const s = battle(A, B);
  const saya = unit(s, "a1");
  // Arm the passive the real way (below-40 damage), then stage inventions: 2 Saya Coils + 1 Spider Mine.
  saya.hp = 30;
  emit(s, { type: "damageDealt", source: "b1", target: "a1", amount: 20, dtype: "normal", isNew: true });
  assert.equal(hasStatus(saya, "mark", "Panic Armed"), true);
  saya.statuses.push(status("stack", { name: "Saya Coil", magnitude: 2 }));
  unit(s, "b1").statuses.push(status("stack", { name: "Spider Mine", magnitude: 1 }));

  performAction(s, { unit: "a1", skillId: "saya5" }); // Stroke of Genius

  // 3 devices (2 coils + 1 mine-bearing enemy) → 30 Shield + 30 Piercing to one random enemy.
  assert.equal(shieldTotal(saya), 30, "10 Shield per device = 30");
  assert.equal(enemyHpLost(s), 30, "10 Piercing per device = 30, aggregated on one enemy");
  assert.equal(stackMag(saya, "Saya Coil"), 0, "coils are consumed by the detonation");
  assert.equal(totalMines(s), 0, "spider mines are consumed by the detonation");
  assert.equal(hasStatus(saya, "mark", "Panic Armed"), false, "the arm is spent");
  assert.equal(hasStatus(saya, "mark", "Panic Spent"), true, "and marked spent");
});

test("Well-Used Panic Button — only the FIRST drop below 40 arms it", () => {
  const s = battle(A, B);
  const saya = unit(s, "a1");
  // First drop arms and is then spent by a Stroke of Genius (no devices → nothing detonated, but spent).
  saya.hp = 30;
  emit(s, { type: "damageDealt", source: "b1", target: "a1", amount: 20, dtype: "normal", isNew: true });
  performAction(s, { unit: "a1", skillId: "saya5" });
  assert.equal(hasStatus(saya, "mark", "Panic Spent"), true);

  // A second drop below 40 must NOT re-arm.
  saya.hp = 25;
  emit(s, { type: "damageDealt", source: "b1", target: "a1", amount: 10, dtype: "normal", isNew: true });
  assert.equal(hasStatus(saya, "mark", "Panic Armed"), false, "does not re-arm after the first time");
});

// --------------------------------------------------------------------------- //
//  saya1 — Universal Energy Conduit
//  "Gives a random ally Elemental Essence at the end of Saya's turns. While
//   Enhanced, lowers the cost of the targeted ally's skills by [65] for 1 turn."
// --------------------------------------------------------------------------- //
test("Universal Energy Conduit — a random ally gains Elemental Essence at Saya's turn-end", () => {
  const s = battle(A, B);
  assert.equal(["a1", "a2", "a3"].some((id) => hasStatus(unit(s, id), "elemental_essence")), false);
  performAction(s, { unit: "a1", skillId: "saya1" });
  endTurn(s); // end Saya's turn → the Conduit hands out Essence
  assert.equal(
    ["a1", "a2", "a3"].some((id) => hasStatus(unit(s, id), "elemental_essence")),
    true,
    "some ally received Elemental Essence",
  );
});

test("Universal Energy Conduit — while Enhanced, lowers an ally's skill costs by 1 for 1 turn", () => {
  const s = battle(A, B);
  const saya = unit(s, "a1");
  saya.statuses.push(status("mark", { name: "Enhanced" }));
  performAction(s, { unit: "a1", skillId: "saya1" });
  const discounted = ["a1", "a2", "a3"].map((id) => unit(s, id)).find((u) => costModMag(u) === -1);
  assert.ok(discounted, "an ally has a -1 cost reduction");
  const cm = discounted!.statuses.find((x) => x.kind === "cost_mod")!;
  assert.equal(cm.duration, 1, "for 1 turn");
  assert.equal(hasStatus(saya, "mark", "Enhanced"), false, "Enhanced is consumed");
});

// --------------------------------------------------------------------------- //
//  saya2 — Saya Coil
//  "Deals 10 damage to a random enemy at the end of every turn. While Enhanced,
//   this skill deals double damage. Saya can only have up to 3 Saya Coils active."
// --------------------------------------------------------------------------- //
test("Saya Coil — constructs a coil that deals 10 to a random enemy each turn-end", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "saya2" });
  assert.equal(stackMag(unit(s, "a1"), "Saya Coil"), 1, "one Saya Coil active");
  assert.equal(skillOf(unit(s, "a1"), "saya2").currentCd, 1, "cooldown 1");
  endTurn(s);
  assert.equal(enemyHpLost(s), 10, "the coil ticks 10 to one random enemy");
});

test("Saya Coil — while Enhanced, the coil ticks double (20)", () => {
  const s = battle(A, B);
  unit(s, "a1").statuses.push(status("mark", { name: "Enhanced" }));
  performAction(s, { unit: "a1", skillId: "saya2" });
  assert.equal(stackMag(unit(s, "a1"), "Enhanced Saya Coil"), 1, "an Enhanced coil is tracked");
  assert.equal(hasStatus(unit(s, "a1"), "mark", "Enhanced"), false, "Enhanced consumed");
  endTurn(s);
  assert.equal(enemyHpLost(s), 20, "the Enhanced coil ticks double");
});

test("Saya Coil — cannot exceed 3 active coils", () => {
  const s = battle(A, B);
  unit(s, "a1").statuses.push(status("stack", { name: "Saya Coil", magnitude: 3 }));
  assert.equal(canUse(s, unit(s, "a1"), skillOf(unit(s, "a1"), "saya2")), false, "blocked at 3 coils");

  const s2 = battle(A, B);
  unit(s2, "a1").statuses.push(status("stack", { name: "Saya Coil", magnitude: 2 }));
  assert.equal(canUse(s2, unit(s2, "a1"), skillOf(unit(s2, "a1"), "saya2")), true, "allowed below 3 coils");
});

// --------------------------------------------------------------------------- //
//  saya3 — Spider Mines
//  "Saya constructs two spider mines that then attach to random enemy Heroes. If
//   those enemies use a new skill, their spider mine detonates, dealing 15 damage.
//   While Enhanced, three Spider Mines are created instead."
// --------------------------------------------------------------------------- //
test("Spider Mines — constructs two mines on enemy heroes", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "saya3" });
  assert.equal(totalMines(s), 2, "two spider mines attached to enemies");
});

test("Spider Mines — three mines while Enhanced", () => {
  const s = battle(A, B);
  unit(s, "a1").statuses.push(status("mark", { name: "Enhanced" }));
  performAction(s, { unit: "a1", skillId: "saya3" });
  assert.equal(totalMines(s), 3, "three spider mines while Enhanced");
  assert.equal(hasStatus(unit(s, "a1"), "mark", "Enhanced"), false, "Enhanced consumed");
});

test("Spider Mines — a mine detonates for 15 when its bearer uses a new skill", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "saya3" });
  const bearerId = ["b1", "b2", "b3"].find((id) => stackMag(unit(s, id), "Spider Mine") > 0)!;
  assert.ok(bearerId, "a mine-bearing enemy exists");
  const before = unit(s, bearerId).hp;
  emit(s, { type: "skillUsed", caster: bearerId, skillId: "x", targets: [], tags: [] });
  assert.equal(unit(s, bearerId).hp, before - 15, "the bearer takes 15 from the detonation");
  assert.equal(stackMag(unit(s, bearerId), "Spider Mine"), 0, "the mine is consumed");
});

// --------------------------------------------------------------------------- //
//  saya4 — Plasma Shield
//  "Saya gains 40 shield and ignores affliction damage for 1 turn. This skill is
//   invisible. While Enhanced, damage to her Shield will grant her Elemental
//   Essence." (cooldown 3)
// --------------------------------------------------------------------------- //
test("Plasma Shield — 40 Shield and affliction immunity for 1 turn, cooldown 3", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "saya4" });
  const saya = unit(s, "a1");
  assert.equal(shieldTotal(saya), 40, "40 Shield");
  assert.equal(hasStatus(saya, "damage_ignore"), true, "an affliction-ignore is up");
  assert.equal(skillOf(saya, "saya4").currentCd, 3, "cooldown 3");
  // Affliction damage is ignored entirely.
  const r = applyDamage(saya, { amount: 20, type: "affliction", isNew: true });
  assert.equal(r.hpLost, 0, "affliction deals no HP loss");
  assert.equal(saya.hp, 100, "Saya's HP is untouched by affliction");
});

test("Plasma Shield — while Enhanced, Shield damage grants Elemental Essence", () => {
  const s = battle(A, B);
  const saya = unit(s, "a1");
  saya.statuses.push(status("mark", { name: "Enhanced" }));
  performAction(s, { unit: "a1", skillId: "saya4" });
  assert.equal(hasStatus(saya, "mark", "Plasma Charge"), true, "the Enhanced charge is set");
  assert.equal(hasStatus(saya, "mark", "Enhanced"), false, "Enhanced consumed");
  assert.equal(hasStatus(saya, "elemental_essence"), false, "no Essence before the shield is hit");
  emit(s, { type: "shieldDamaged", unit: "a1", source: "b1", amount: 5 });
  assert.equal(hasStatus(saya, "elemental_essence"), true, "Shield damage grants Elemental Essence");
});

// --------------------------------------------------------------------------- //
//  saya5 — Stroke of Genius
//  "Saya gains Elemental Essence and changes the costs of her other skills to 1
//   [3], Enhancing her next skill." (cooldown 1)
// --------------------------------------------------------------------------- //
test("Stroke of Genius — grants Essence, re-costs her other skills to 1 lightning, Enhances next", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "saya5" });
  const saya = unit(s, "a1");
  assert.equal(hasStatus(saya, "elemental_essence"), true, "Saya gains Elemental Essence");
  assert.equal(hasStatus(saya, "mark", "Enhanced"), true, "her next skill is Enhanced");
  for (const id of ["saya1", "saya2", "saya3", "saya4"]) {
    const c = skillOf(saya, id).cost;
    assert.equal(c.generic, 0, `${id} generic cost reset to 0`);
    assert.equal(c.specific, 1, `${id} costs 1 specific (lightning)`);
  }
  assert.equal(skillOf(saya, "saya5").cost.generic, 2, "Stroke of Genius itself keeps its 2 cost");
  assert.equal(skillOf(saya, "saya5").currentCd, 1, "cooldown 1");
});
