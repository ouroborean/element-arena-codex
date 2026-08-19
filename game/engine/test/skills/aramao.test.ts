/**
 * Behavior tests for Aramao against the frozen skill prose (the oracle). Assertions target the
 * described behavior, never the implementation. A clean assertion failure here is a reported bug.
 *
 * Formation: team A = a1/a2/a3 (slots 0/1/2), team B = b1/b2/b3. "Directly across" pairs the same
 * slot across teams (a1 <-> b1). Aramao is placed at a1 (slot 0) unless a branch needs otherwise.
 *
 * Oracle (game/content/frozen/skills.json):
 *  aramao0 Dune Stalker (passive): "Aramao deals 5 more damage to the enemy Hero directly across
 *    from him, and he gains Elemental Essence whenever he damages them."
 *  aramao1 Desert Knife: "Deals 10 Piercing damage to target enemy. If used on an enemy Hero that
 *    isn't directly across from Aramao, he will swap positions with the ally that is. Using this
 *    skill does not break Veiled."
 *  aramao2 Sand Quake: "Deals 10 Piercing damage to all enemies and extends the duration of all
 *    Veiled effects by 2 turns. Using this skill does not break Veiled."
 *  aramao3 Mirage Trap: "Aramao targets an enemy Hero for 1 turn. If they are directly across from
 *    Aramao, he will counter the first non-Strategic skill they use. If they are not, he will
 *    counter the first Strategic skill they use."
 *  aramao4 Desert Veil: "Targets an allied Hero or Aramao. If targeting Aramao, applies Veiled to
 *    Aramao and a random allied Hero for 2 turns. If targeting an ally, applies Veiled to them and
 *    Aramao for 2 turns and swaps their positions."
 *  aramao5 Heart of the Desert: "If there is only one Hero adjacent to Aramao, heal that Hero and
 *    Aramao for 15 HP. If there are two Heroes adjacent to Aramao, heal them both for 15 HP. This
 *    effect Bypasses."
 *  aramao6 Trial of the Sands: "For 3 turns, all allied Heroes are Veiled at the end of each turn.
 *    During this time, Aramao will use Desert Knife on any enemy that uses a Harmful skill on him.
 *    After being used, Aramao's team randomly swaps places once."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, canUse, performAction, endTurn } from "../skillHarness.ts";
import type { Unit } from "../../src/types.ts";

const A = ["aramao", "gommar", "gommar"];
const B = ["gommar", "gommar", "gommar"];

// Aramao's element is "nomad", which the shared flushEnergy pool omits — top it up so a nomad-specific
// cost never blocks a behavior test (a setup detail, not a change to any asserted behavior).
const arena = (a = A, b = B) => {
  const s = battle(a, b);
  s.teams.A.energy.nomad = 99;
  s.teams.B.energy.nomad = 99;
  return s;
};

const dr = (u: Unit, mag: number) =>
  u.statuses.push({ kind: "damage_reduction", magnitude: mag, duration: null, appliedBy: "x", appliedTurn: 0 });
const veil = (u: Unit, duration: number) =>
  u.statuses.push({ kind: "veiled", duration, appliedBy: "x", appliedTurn: 0 });
const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const statusOf = (u: Unit, kind: string, name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const isVeiled = (u: Unit) => hasStatus(u, "veiled");

// --------------------------------------------------------------------------- //
//  aramao0 — Dune Stalker (passive)
// --------------------------------------------------------------------------- //
test("Dune Stalker — deals 5 more to the across enemy only, and grants Aramao Essence when he hits them", () => {
  const s = arena(); // Aramao a1 (slot 0) -> across is b1
  const aramao = unit(s, "a1");
  const before = essenceCount(aramao);
  // Sand Quake hits all enemies for 10 Piercing; the across enemy (b1) additionally takes the passive +5.
  performAction(s, { unit: "a1", skillId: "aramao2" });
  assert.equal(unit(s, "b1").hp, 85, "across enemy takes 10 + 5 = 15");
  assert.equal(unit(s, "b2").hp, 90, "a non-across enemy takes only 10 (no +5)");
  assert.equal(unit(s, "b3").hp, 90, "a non-across enemy takes only 10 (no +5)");
  assert.ok(essenceCount(aramao) > before, "Aramao gains Elemental Essence when he damages the across enemy");
});

// --------------------------------------------------------------------------- //
//  aramao1 — Desert Knife
// --------------------------------------------------------------------------- //
test("Desert Knife — 10 Piercing to the across target (ignores DR); no swap when target is across", () => {
  const s = arena();
  const aramao = unit(s, "a1");
  dr(unit(s, "b1"), 5); // Damage Reduction the Piercing hit must ignore
  performAction(s, { unit: "a1", skillId: "aramao1", targets: ["b1"] });
  // 10 Piercing ignores DR, plus the +5 across passive -> 15 (a non-piercing 10 would be reduced to 5 -> total 10).
  assert.equal(unit(s, "b1").hp, 85, "10 Piercing (ignoring 5 DR) + 5 across passive");
  assert.equal(aramao.slot, 0, "no position swap when the target is directly across");
});

test("Desert Knife — hitting a non-across enemy swaps Aramao with the ally across from that enemy", () => {
  const s = arena(); // Aramao a1 slot0; b2 is slot1 (not across from Aramao)
  performAction(s, { unit: "a1", skillId: "aramao1", targets: ["b2"] });
  assert.equal(unit(s, "b2").hp, 90, "10 Piercing to the target; no +5 since it was not across");
  assert.equal(unit(s, "a1").slot, 1, "Aramao moves into the target's slot (now across from b2)");
  assert.equal(unit(s, "a2").slot, 0, "the ally who was across from the target swaps out");
});

// --------------------------------------------------------------------------- //
//  aramao2 — Sand Quake
// --------------------------------------------------------------------------- //
test("Sand Quake — 10 Piercing to all enemies and extends every Veiled effect by 2 turns", () => {
  const s = arena();
  veil(unit(s, "a2"), 2); // an allied Veil
  veil(unit(s, "b2"), 3); // an enemy Veil
  performAction(s, { unit: "a1", skillId: "aramao2" });
  assert.equal(unit(s, "b1").hp, 85, "across enemy: 10 + 5");
  assert.equal(unit(s, "b2").hp, 90, "10 Piercing to all enemies");
  assert.equal(unit(s, "b3").hp, 90, "10 Piercing to all enemies");
  assert.equal(statusOf(unit(s, "a2"), "veiled")!.duration, 4, "allied Veil extended by 2 (2 -> 4)");
  assert.equal(statusOf(unit(s, "b2"), "veiled")!.duration, 5, "enemy Veil extended by 2 (3 -> 5)");
  assert.equal(skillOf(unit(s, "a1"), "aramao2").currentCd, 2, "cooldown 2");
});

// --------------------------------------------------------------------------- //
//  aramao3 — Mirage Trap
// --------------------------------------------------------------------------- //
test("Mirage Trap — across target: arms the trap and counters their first non-Strategic skill", () => {
  const s = arena(); // b1 across from Aramao
  performAction(s, { unit: "a1", skillId: "aramao3", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Mirage Trap: non-Strategic"), true, "armed vs non-Strategic");
  // b1 uses a non-Strategic (Harmful) skill on Aramao -> countered, so Aramao takes no damage.
  // (gommar1 is a plain counterable Harmful skill; gommar3 is Uncounterable while Frost-Covered.)
  const res = performAction(s, { unit: "b1", skillId: "gommar1", targets: ["a1"] });
  assert.equal(res.countered, true, "the first non-Strategic skill is countered");
  assert.equal(unit(s, "a1").hp, 100, "the countered skill deals no damage");
});

test("Mirage Trap — across target does NOT counter a Strategic skill", () => {
  const s = arena();
  performAction(s, { unit: "a1", skillId: "aramao3", targets: ["b1"] });
  const res = performAction(s, { unit: "b1", skillId: "gommar4" }); // gommar4 is Strategic
  assert.notEqual(res.countered, true, "a Strategic skill is not countered by the non-Strategic trap");
});

test("Mirage Trap — non-across target: arms vs Strategic and counters their first Strategic skill", () => {
  const s = arena(); // b2 is NOT across from Aramao (slot 1 vs slot 0)
  performAction(s, { unit: "a1", skillId: "aramao3", targets: ["b2"] });
  assert.equal(hasStatus(unit(s, "b2"), "mark", "Mirage Trap: Strategic"), true, "armed vs Strategic");
  const res = performAction(s, { unit: "b2", skillId: "gommar4" }); // Strategic
  assert.equal(res.countered, true, "the first Strategic skill is countered");
});

// --------------------------------------------------------------------------- //
//  aramao4 — Desert Veil
// --------------------------------------------------------------------------- //
test("Desert Veil — targeting Aramao: Veils Aramao and one random allied Hero for 2 turns", () => {
  const s = arena();
  const aramao = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "aramao4", targets: ["a1"] });
  assert.equal(isVeiled(aramao), true, "Aramao is Veiled");
  assert.equal(statusOf(aramao, "veiled")!.duration, 2, "for 2 turns");
  const otherVeiled = ["a2", "a3"].filter((id) => isVeiled(unit(s, id)));
  assert.equal(otherVeiled.length, 1, "exactly one other allied Hero is Veiled");
});

test("Desert Veil — targeting an ally: Veils the ally and Aramao for 2 turns and swaps their positions", () => {
  const s = arena();
  const aSlot = unit(s, "a1").slot, allySlot = unit(s, "a2").slot;
  performAction(s, { unit: "a1", skillId: "aramao4", targets: ["a2"] });
  assert.equal(isVeiled(unit(s, "a2")), true, "the ally is Veiled");
  assert.equal(isVeiled(unit(s, "a1")), true, "Aramao is Veiled");
  assert.equal(statusOf(unit(s, "a2"), "veiled")!.duration, 2, "for 2 turns");
  assert.equal(unit(s, "a1").slot, allySlot, "Aramao and the ally swap positions");
  assert.equal(unit(s, "a2").slot, aSlot, "Aramao and the ally swap positions");
});

// --------------------------------------------------------------------------- //
//  aramao5 — Heart of the Desert
// --------------------------------------------------------------------------- //
test("Heart of the Desert — one adjacent Hero: heals that Hero AND Aramao for 15; Bypasses", () => {
  const s = arena(); // Aramao a1 slot0 -> only a2 (slot1) is adjacent
  unit(s, "a1").hp = 50;
  unit(s, "a2").hp = 50;
  unit(s, "a3").hp = 50;
  performAction(s, { unit: "a1", skillId: "aramao5" });
  assert.equal(unit(s, "a2").hp, 65, "the one adjacent Hero is healed 15");
  assert.equal(unit(s, "a1").hp, 65, "Aramao is also healed 15");
  assert.equal(unit(s, "a3").hp, 50, "a non-adjacent Hero is not healed");
  assert.equal(skillOf(unit(s, "a1"), "aramao5").tags.includes("Bypassing"), true, "the heal Bypasses");
});

test("Heart of the Desert — two adjacent Heroes: heals both allies for 15, not Aramao", () => {
  const s = arena(["gommar", "aramao", "gommar"]); // Aramao a2 (slot1) -> a1 and a3 both adjacent
  unit(s, "a1").hp = 50;
  unit(s, "a2").hp = 50;
  unit(s, "a3").hp = 50;
  performAction(s, { unit: "a2", skillId: "aramao5" });
  assert.equal(unit(s, "a1").hp, 65, "one adjacent Hero healed 15");
  assert.equal(unit(s, "a3").hp, 65, "the other adjacent Hero healed 15");
  assert.equal(unit(s, "a2").hp, 50, "Aramao is NOT healed when two Heroes are adjacent");
});

// --------------------------------------------------------------------------- //
//  aramao6 — Trial of the Sands
// --------------------------------------------------------------------------- //
test("Trial of the Sands — installs the 3-turn window and randomly swaps Aramao's team once", () => {
  const s = arena();
  performAction(s, { unit: "a1", skillId: "aramao6" });
  const mark = statusOf(unit(s, "a1"), "mark", "Trial of the Sands");
  assert.ok(mark, "the 3-turn Trial window is installed on Aramao");
  assert.equal(mark!.duration, 3, "for 3 turns");
  const slots = ["a1", "a2", "a3"].map((id) => unit(s, id).slot).sort();
  assert.deepEqual(slots, [0, 1, 2], "the team still occupies a valid permutation of slots after the swap");
  assert.equal(skillOf(unit(s, "a1"), "aramao6").currentCd, 4, "cooldown 4");
});

test("Trial of the Sands — all allied Heroes are Veiled at the end of each turn", () => {
  const s = arena();
  performAction(s, { unit: "a1", skillId: "aramao6" });
  endTurn(s); // end of the turn -> the re-veil trigger fires while the Trial window is up
  assert.equal(isVeiled(unit(s, "a1")), true, "Aramao is Veiled at turn end");
  assert.equal(isVeiled(unit(s, "a2")), true, "an allied Hero is Veiled at turn end");
  assert.equal(isVeiled(unit(s, "a3")), true, "an allied Hero is Veiled at turn end");
});

test("Trial of the Sands — Aramao uses Desert Knife on an enemy that uses a Harmful skill on him", () => {
  const s = arena();
  performAction(s, { unit: "a1", skillId: "aramao6" });
  const b1Before = unit(s, "b1").hp;
  // b1 uses a Harmful skill on Aramao (a1) -> Aramao retaliates with Desert Knife.
  // (The exact retaliation damage varies: the attacker's own Harmful skill debuffs Aramao's outgoing
  // damage first, so we assert only that the retaliation landed.)
  performAction(s, { unit: "b1", skillId: "gommar1", targets: ["a1"] });
  assert.ok(unit(s, "b1").hp < b1Before, "the attacker is struck by Aramao's Desert Knife retaliation");
});
