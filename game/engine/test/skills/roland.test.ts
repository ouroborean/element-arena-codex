/**
 * Behavior tests for Geolord Roland's base kit, asserted against the frozen skill prose
 * (game/content/frozen/skills.json). Each numbered skill's distinct clauses — damage
 * amounts + type, statuses, conditional branches, cooldowns, targeting — are checked.
 *
 * Inert bystanders are chosen so no filler/enemy passive perturbs the numbers:
 *   allies  riverdaughter/scratch — their triggers gate on their own actions/marks
 *   enemies ando/zevkir/keeper    — likewise; none react to being damaged or status-marked
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, shieldTotal, stackMag,
  performAction, canUse, endTurn, emit,
} from "../skillHarness.ts";
import { status } from "../helpers.ts";
import type { Unit } from "../../src/types.ts";

const A = ["roland", "riverdaughter", "scratch"];
const B = ["ando", "zevkir", "keeper"];

/** Flat magnitude of a unit's Damage Reduction. */
const drMag = (u: Unit): number =>
  u.statuses.filter((s) => s.kind === "damage_reduction").reduce((a, s) => a + (s.magnitude ?? 0), 0);
/** Total HP the enemy team has lost from 100-each. */
const enemyHpLost = (s: any): number =>
  ["b1", "b2", "b3"].reduce((a, id) => a + (100 - unit(s, id).hp), 0);
const boulders = (s: any): Unit[] =>
  s.teams.A.units.map((id: string) => s.units[id]).filter((u: Unit) => u.kind === "minion" && u.name === "Boulder");

// --------------------------------------------------------------------------- //
//  roland0 — Living Stone (passive)
//  "At the end of each of his turns, Roland gives 10 Shield to a random ally.
//   If this Shield is broken, Roland gains Elemental Essence."
// --------------------------------------------------------------------------- //
test("Living Stone — end of Roland's turn grants 10 Shield to one ally (and marks them)", () => {
  const s = battle(A, B);
  // Fresh round: no turn has ended yet, so no Living Stone shield is out.
  assert.equal(["a1", "a2", "a3"].reduce((a, id) => a + shieldTotal(unit(s, id)), 0), 0);

  endTurn(s); // ends Roland's (team A) turn → Living Stone fires

  const total = ["a1", "a2", "a3"].reduce((a, id) => a + shieldTotal(unit(s, id)), 0);
  assert.equal(total, 10, "exactly 10 Shield handed out");
  const marked = ["a1", "a2", "a3"].map((id) => unit(s, id)).filter((u) => hasStatus(u, "mark", "Living Stone"));
  assert.equal(marked.length, 1, "the shielded ally is tagged with the Living Stone mark");
  assert.equal(shieldTotal(marked[0]!), 10, "and it is the one holding the 10 Shield");
});

test("Living Stone — breaking that Shield grants Roland Elemental Essence", () => {
  const s = battle(A, B);
  endTurn(s); // grant the shield + mark
  const marked = ["a1", "a2", "a3"].map((id) => unit(s, id)).find((u) => hasStatus(u, "mark", "Living Stone"))!;
  assert.ok(marked, "an ally is marked by Living Stone");
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), false, "Roland has no Essence yet");

  // Break the Living Stone shield → the shieldBroken event drives the passive.
  emit(s, { type: "shieldBroken", unit: marked.id, source: "b1" });

  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), true, "Roland gains Elemental Essence");
  assert.equal(hasStatus(marked, "mark", "Living Stone"), false, "the consumed mark is cleared");
});

// --------------------------------------------------------------------------- //
//  roland1 — Strength From The Earth
//  "…dealing 15 damage to them, increased by 10 if he is affected by Living Stone.
//   If the target is a Boulder, it will launch at a random enemy, dealing its
//   remaining health in damage before being destroyed. If there is a character
//   Marked by Earth Pillar, the launched Boulder will prioritize targeting that
//   character."
// --------------------------------------------------------------------------- //
test("Strength From The Earth — 15 damage to an enemy at base", () => {
  const s = battle(A, B);
  const r = performAction(s, { unit: "a1", skillId: "roland1", targets: ["b1"] });
  assert.equal(r.ok, true);
  assert.equal(unit(s, "b1").hp, 85, "15 damage");
});

test("Strength From The Earth — 25 damage while Roland is affected by Living Stone", () => {
  const s = battle(A, B);
  unit(s, "a1").statuses.push(status("mark", { name: "Living Stone" }));
  performAction(s, { unit: "a1", skillId: "roland1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 75, "15 + 10 = 25 damage while Living-Stone-marked");
});

test("Strength From The Earth — launches a Boulder for its remaining HP, prioritizing Earth Pillar", () => {
  const s = battle(A, B);
  // An Earth-Pillar-marked enemy exists → the launched Boulder must prioritize it.
  unit(s, "b2").statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  performAction(s, { unit: "a1", skillId: "roland3" }); // Form Stone → a 50-HP Boulder
  const b = boulders(s)[0]!;
  assert.equal(b.hp, 50, "fresh Boulder at 50 HP");

  performAction(s, { unit: "a1", skillId: "roland1", targets: [b.id] });
  // Boulder took the base 15 first (50→35), then launched its 35 remaining HP at the marked enemy.
  assert.equal(unit(s, "b2").hp, 65, "the Earth-Pillar-marked enemy took the 35 launch");
  assert.equal(unit(s, "b1").hp, 100, "unmarked enemies were not the launch target");
  assert.equal(unit(s, "b3").hp, 100);
  assert.equal(boulders(s).length, 0, "the Boulder is destroyed after launching");
});

// --------------------------------------------------------------------------- //
//  roland2 — Earth Pillar
//  "Deals 20 damage to target enemy and marks them with an Earth Pillar for
//   Roland's next two turns. If this ability strikes a stunned target, they are
//   Shattered for 2 turns." (cooldown 1)
// --------------------------------------------------------------------------- //
test("Earth Pillar — 20 damage, applies the Earth Pillar mark, goes on 1 cooldown", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "roland2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "20 damage");
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Earth Pillar"), true, "marked with Earth Pillar");
  assert.equal(skillOf(unit(s, "a1"), "roland2").currentCd, 1, "cooldown 1");
  assert.equal(canUse(s, unit(s, "a1"), skillOf(unit(s, "a1"), "roland2")), false, "unusable while on cooldown");
});

test("Earth Pillar — striking a stunned target Shatters them", () => {
  const s = battle(A, B);
  unit(s, "b2").statuses.push(status("stun", { duration: 1 }));
  performAction(s, { unit: "a1", skillId: "roland2", targets: ["b2"] });
  assert.equal(hasStatus(unit(s, "b2"), "shatter"), true, "a struck stunned target is Shattered");
});

test("Earth Pillar — a non-stunned target is NOT Shattered", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "roland2", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "b1"), "shatter"), false, "no Shatter without a prior stun");
});

// --------------------------------------------------------------------------- //
//  roland3 — Form Stone  "Creates a Boulder minion." (cooldown 1)
// --------------------------------------------------------------------------- //
test("Form Stone — creates a 50-HP Boulder minion, cooldown 1", () => {
  const s = battle(A, B);
  assert.equal(boulders(s).length, 0);
  performAction(s, { unit: "a1", skillId: "roland3" });
  const bs = boulders(s);
  assert.equal(bs.length, 1, "one Boulder created");
  assert.equal(bs[0]!.hp, 50, "Boulder has 50 HP");
  assert.equal(skillOf(unit(s, "a1"), "roland3").currentCd, 1, "cooldown 1");
});

// --------------------------------------------------------------------------- //
//  roland4 — Stoneform
//  "Roland gains 15 points of Damage Reduction for 1 turn. Any targets affected
//   by Living Stone are also affected." (cooldown 3)
// --------------------------------------------------------------------------- //
test("Stoneform — Roland gains 15 Damage Reduction, cooldown 3", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "roland4" });
  assert.equal(drMag(unit(s, "a1")), 15, "15 Damage Reduction on Roland");
  assert.equal(skillOf(unit(s, "a1"), "roland4").currentCd, 3, "cooldown 3");
});

test("Stoneform — allies affected by Living Stone also gain the 15 Damage Reduction", () => {
  const s = battle(A, B);
  unit(s, "a2").statuses.push(status("mark", { name: "Living Stone" }));
  performAction(s, { unit: "a1", skillId: "roland4" });
  assert.equal(drMag(unit(s, "a2")), 15, "the Living-Stone ally shares the DR");
  assert.equal(drMag(unit(s, "a1")), 15, "Roland still gets his own DR");
  assert.equal(drMag(unit(s, "a3")), 0, "an unaffected ally gets nothing");
});

// --------------------------------------------------------------------------- //
//  roland5 — Fissure
//  "All targets other than Roland take 20 damage and have their Harmful skills
//   stunned for 1 turn. This skill starts each round with 2 turns of cooldown
//   remaining." (cooldown 4)
// --------------------------------------------------------------------------- //
test("Fissure — starts each round on 2 cooldown", () => {
  const s = battle(A, B);
  assert.equal(skillOf(unit(s, "a1"), "roland5").currentCd, 2, "2 turns of cooldown at round start");
  assert.equal(canUse(s, unit(s, "a1"), skillOf(unit(s, "a1"), "roland5")), false, "not usable yet");
});

test("Fissure — 20 damage + Harmful-scoped stun to everyone but Roland", () => {
  const s = battle(A, B);
  skillOf(unit(s, "a1"), "roland5").currentCd = 0; // clear the starting cooldown to fire it
  performAction(s, { unit: "a1", skillId: "roland5" });

  assert.equal(unit(s, "a1").hp, 100, "Roland is exempt from his own Fissure");
  for (const id of ["a2", "a3", "b1", "b2", "b3"]) {
    assert.equal(unit(s, id).hp, 80, `${id} takes 20 damage`);
    const stun = unit(s, id).statuses.find((x) => x.kind === "stun");
    assert.ok(stun, `${id} is stunned`);
    assert.equal(stun!.scope?.tag, "Harmful", `${id}'s stun is scoped to Harmful skills`);
    assert.equal(stun!.scope?.mode, "only");
  }
  assert.equal(unit(s, "a1").statuses.some((x) => x.kind === "stun"), false, "Roland is not stunned");
});
