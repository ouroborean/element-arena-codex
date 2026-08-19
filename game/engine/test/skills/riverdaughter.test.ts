/**
 * Behavior tests for The River Daughter, asserted against the frozen skill prose (the oracle):
 *
 *   riverdaughter0 Healing Tears — "Whenever River Daughter counters or stuns an enemy, she heals her
 *                                   team for 5 HP every turn for 3 turns. Whenever this occurs, she gains
 *                                   Elemental Essence."
 *   riverdaughter1 Ripple        — "Deals 10 damage to the enemy team. The following turn, Undertow will
 *                                   stun its target for 1 turn."
 *   riverdaughter2 Undertow      — "Target enemy receives 20 damage."
 *   riverdaughter3 River Clone   — "Counters the first harmful skill used by target enemy. This effect is
 *                                   invisible."
 *   riverdaughter4 Soothe        — "Heals an ally for 10 health each turn for 2 turns. After the heal, if the
 *                                   target is a Hero and has full HP or less than 60 HP, River Daughter gains
 *                                   Elemental Essence."
 *   riverdaughter5 Dive          — "River Daughter becomes invulnerable for 1 turn. The following turn, Ripple
 *                                   will last two turns, Undertow will target all enemies, and River Clone's
 *                                   cost is changed to [65]."
 *
 * River Daughter sits at a1; b1/b2/b3 are the enemies. b1 is Jarrik, whose Blade of Ashes (jarrik1) is the
 * Harmful skill the River Clone counter test negates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, performAction, canUse, startTurn, endTurn } from "../skillHarness.ts";

const A: [string, string, string] = ["riverdaughter", "gommar", "xyris"];
const B: [string, string, string] = ["jarrik", "laria", "saya"];

const essence = (u: ReturnType<typeof unit>) => u.statuses.filter((x) => x.kind === "elemental_essence").length;
const regenNamed = (u: ReturnType<typeof unit>, name: string) =>
  u.statuses.find((x) => x.kind === "regen" && x.name === name);

// --------------------------------------------------------------------------- //
//  riverdaughter1 — Ripple
// --------------------------------------------------------------------------- //

test("Ripple — 10 damage to the whole enemy team, and arms Undertow's stun", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter1" });
  assert.equal(unit(s, "b1").hp, 90, "10 to b1");
  assert.equal(unit(s, "b2").hp, 90, "10 to b2");
  assert.equal(unit(s, "b3").hp, 90, "10 to b3");
  assert.ok(hasStatus(unit(s, "a1"), "mark", "Undertow Stun"), "Ripple sets the mark that lets Undertow stun");
  assert.equal(skillOf(unit(s, "a1"), "riverdaughter1").currentCd, 1, "Ripple goes on a 1-turn cooldown");
});

// --------------------------------------------------------------------------- //
//  riverdaughter2 — Undertow
// --------------------------------------------------------------------------- //

test("Undertow — 20 damage to a single target, no stun on its own", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "20 damage to the target");
  assert.equal(unit(s, "b2").hp, 100, "only the chosen enemy is hit");
  assert.ok(!hasStatus(unit(s, "b1"), "stun"), "no stun without a preceding Ripple");
  assert.equal(essence(unit(s, "a1")), 0, "no stun -> Healing Tears does not fire");
  assert.equal(skillOf(unit(s, "a1"), "riverdaughter2").currentCd, 1, "Undertow goes on a 1-turn cooldown");
});

test("Ripple -> Undertow — the follow-up Undertow both damages and stuns its target", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter1" }); // enemy team -> 90; arms Undertow
  performAction(s, { unit: "a1", skillId: "riverdaughter2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 70, "Ripple's 10 then Undertow's 20");
  assert.ok(hasStatus(unit(s, "b1"), "stun"), "the armed Undertow stuns its target");
  const stun = unit(s, "b1").statuses.find((x) => x.kind === "stun")!;
  assert.equal(stun.duration, 1, "the stun lasts 1 turn");
  assert.ok(!hasStatus(unit(s, "a1"), "mark", "Undertow Stun"), "the stun-arming mark is consumed");
});

// --------------------------------------------------------------------------- //
//  riverdaughter0 — Healing Tears (passive), stun branch
// --------------------------------------------------------------------------- //

test("Healing Tears — stunning an enemy heals the team 5/turn for 3 turns and grants Essence", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 50; // a wounded ally to watch the regen land on
  performAction(s, { unit: "a1", skillId: "riverdaughter1" });
  performAction(s, { unit: "a1", skillId: "riverdaughter2", targets: ["b1"] }); // stun -> passive fires
  const r = unit(s, "a1");
  assert.equal(essence(r), 1, "River Daughter gains Elemental Essence when she stuns");
  const teamRegen = regenNamed(unit(s, "a2"), "Healing Tears");
  assert.ok(teamRegen, "the wounded ally receives the Healing Tears regen");
  assert.equal(teamRegen!.magnitude, 5, "regen heals 5");
  assert.equal(teamRegen!.duration, 3, "regen lasts 3 turns");
  assert.ok(regenNamed(r, "Healing Tears"), "River Daughter heals herself too (her whole team)");
  // 5 HP each of River Daughter's next 3 turn-ends: 50 -> 65.
  endTurn(s); // A end (birth — no tick)
  endTurn(s); // B
  endTurn(s); // A end — +5 -> 55
  assert.equal(unit(s, "a2").hp, 55);
  endTurn(s); // B
  endTurn(s); // A end — +5 -> 60
  endTurn(s); // B
  endTurn(s); // A end — +5 -> 65, then expires
  assert.equal(unit(s, "a2").hp, 65, "5/turn x3 = 15 healed");
  assert.ok(!regenNamed(unit(s, "a2"), "Healing Tears"), "Healing Tears expires after 3 ticks");
});

// --------------------------------------------------------------------------- //
//  riverdaughter3 — River Clone (and Healing Tears counter branch)
// --------------------------------------------------------------------------- //

test("River Clone — counters the marked enemy's first Harmful skill; passive rewards the counter", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter3", targets: ["b1"] }); // invisibly mark b1
  assert.ok(hasStatus(unit(s, "b1"), "mark", "River Clone"), "b1 carries the (invisible) River Clone mark");
  assert.equal(skillOf(unit(s, "a1"), "riverdaughter3").currentCd, 1, "River Clone goes on a 1-turn cooldown");
  // b1's first Harmful skill is negated.
  const first = performAction(s, { unit: "b1", skillId: "jarrik1", targets: ["a1"] });
  assert.equal(first.countered, true, "the first Harmful skill from the marked enemy is countered");
  assert.equal(unit(s, "a1").hp, 100, "the countered skill deals no damage to River Daughter");
  assert.ok(!hasStatus(unit(s, "b1"), "mark", "River Clone"), "the mark is consumed by the counter");
  // Healing Tears (counter branch): Essence + team regen.
  assert.equal(essence(unit(s, "a1")), 1, "countering grants River Daughter Elemental Essence");
  assert.ok(regenNamed(unit(s, "a1"), "Healing Tears"), "countering starts the Healing Tears team regen");
  // Only the FIRST Harmful skill: a second one now lands.
  const second = performAction(s, { unit: "b1", skillId: "jarrik1", targets: ["a1"] });
  assert.notEqual(second.countered, true, "the second Harmful skill is no longer countered");
  assert.equal(unit(s, "a1").hp, 90, "the second Blade of Ashes deals its 10 damage");
});

// --------------------------------------------------------------------------- //
//  riverdaughter4 — Soothe
// --------------------------------------------------------------------------- //

test("Soothe — heals an ally 10/turn for 2 turns", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 50;
  performAction(s, { unit: "a1", skillId: "riverdaughter4", targets: ["a2"] });
  const regen = regenNamed(unit(s, "a2"), "Soothe");
  assert.ok(regen, "the ally carries the Soothe regen");
  assert.equal(regen!.magnitude, 10, "heals 10");
  assert.equal(regen!.duration, 2, "for 2 turns");
  assert.equal(skillOf(unit(s, "a1"), "riverdaughter4").currentCd, 1, "Soothe goes on a 1-turn cooldown");
  // 10 HP on each of River Daughter's next 2 turn-ends: 50 -> 70.
  endTurn(s); // A end (birth)
  endTurn(s); // B
  endTurn(s); // A end — +10 -> 60
  assert.equal(unit(s, "a2").hp, 60);
  endTurn(s); // B
  endTurn(s); // A end — +10 -> 70, expires
  assert.equal(unit(s, "a2").hp, 70, "10/turn x2 = 20 healed");
});

test("Soothe — Essence when the Hero target is at full HP", () => {
  const s = battle(A, B); // a2 starts the round at full HP
  performAction(s, { unit: "a1", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(essence(unit(s, "a1")), 1, "full-HP Hero target -> River Daughter gains Essence");
});

test("Soothe — Essence when the Hero target is below 60 HP", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 50;
  performAction(s, { unit: "a1", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(essence(unit(s, "a1")), 1, "sub-60 Hero target -> River Daughter gains Essence");
});

test("Soothe — no Essence when the Hero target is neither full nor below 60", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 70; // not full, not < 60
  performAction(s, { unit: "a1", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(essence(unit(s, "a1")), 0, "70 HP falls in the dead zone -> no Essence");
});

// --------------------------------------------------------------------------- //
//  riverdaughter5 — Dive
// --------------------------------------------------------------------------- //

test("Dive — River Daughter becomes Invulnerable for 1 turn and arms next turn's empowerments", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter5" });
  const r = unit(s, "a1");
  const inv = r.statuses.find((x) => x.kind === "invulnerable")!;
  assert.ok(inv, "River Daughter is Invulnerable");
  assert.equal(inv.duration, 1, "Invulnerable lasts 1 turn");
  assert.ok(hasStatus(r, "mark", "Dive Ripple"), "Ripple empowerment armed");
  assert.ok(hasStatus(r, "mark", "Dive Undertow"), "Undertow empowerment armed");
  assert.ok(hasStatus(r, "mark", "Dive River Clone"), "River Clone empowerment armed");
  assert.equal(skillOf(r, "riverdaughter5").currentCd, 3, "Dive goes on a 3-turn cooldown");
});

test("Dive — Undertow then targets all enemies", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter5" });
  performAction(s, { unit: "a1", skillId: "riverdaughter2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "20 to b1");
  assert.equal(unit(s, "b2").hp, 80, "Dive makes Undertow hit b2 too");
  assert.equal(unit(s, "b3").hp, 80, "Dive makes Undertow hit b3 too");
});

test("Dive — Ripple lasts two turns (a second 10 lands the following turn)", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter5" });
  performAction(s, { unit: "a1", skillId: "riverdaughter1" });
  assert.equal(unit(s, "b1").hp, 90, "first Ripple hit: 10");
  endTurn(s); // A end (birth for the scheduled second hit)
  endTurn(s); // B
  endTurn(s); // A end — the second Ripple hit fires
  assert.equal(unit(s, "b1").hp, 80, "Ripple's second wave lands the following turn for another 10");
  assert.equal(unit(s, "b2").hp, 80, "the second wave hits the whole team");
});

test("Dive — River Clone's cost is re-denominated to 1 generic [65]", () => {
  // Baseline: without Dive, River Clone needs 1 water; a generic-only pool cannot pay.
  const base = battle(A, B);
  base.teams.A.energy = { generic: 5 };
  assert.equal(canUse(base, unit(base, "a1"), skillOf(unit(base, "a1"), "riverdaughter3")), false,
    "normally River Clone needs its [2] water and is unusable on generic alone");
  // Under Dive, its cost becomes [65] (1 generic), so a generic-only pool CAN pay.
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "riverdaughter5" }); // Dive (paid from the flush pool)
  s.teams.A.energy = { generic: 5 };
  assert.equal(canUse(s, unit(s, "a1"), skillOf(unit(s, "a1"), "riverdaughter3")), true,
    "under Dive, River Clone is payable with generic energy alone");
});
