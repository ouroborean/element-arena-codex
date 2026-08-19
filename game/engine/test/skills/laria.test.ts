/**
 * Behavior tests for Laria, Nightcloaked — asserted against the FROZEN skill prose (the oracle),
 * never against the implementation. A clean assertion failure here is a reported engine bug.
 *
 * Oracle (game/content/frozen/skills.json):
 *  laria0 Deepening Shadows (passive): At the end of each of her turns, Laria gains a stack of Deepening
 *    Shadows. This effect will only trigger if Laria has fewer than 3 stacks.
 *  laria1 Nightwrap: Deals 10 damage to target enemy or heals target ally 10 HP, increased by 5 for each
 *    stack of Deepening Shadows on them. If the target has Elemental Essence, Laria gains Elemental Essence.
 *    Places one stack of Deepening Shadows on the target. (cost 1 generic, cd 1)
 *  laria2 Soothing Night: Gives all allies 1 stack of Deepening Shadows and heals them for 5 HP. If they
 *    already had 4 stacks, they are healed for 10 HP instead. Lasts up to 4 turns. (Channel, cd 2)
 *  laria3 Suffocating Night: Gives all enemies 1 stack of Deepening Shadows and deals 5 damage to them.
 *    If they already had 4 stacks, this skill deals True damage. Lasts up to 4 turns. (Channel, cd 2)
 *  laria4 Vanish: Laria gains 15 Damage Reduction for 3 turns, or until she uses a new skill. (self, cd 4)
 *  laria5 Nightfall: All characters become invulnerable for 1 turn and take 5 damage or healing for each
 *    Deepening Shadows stack they have. (cd 4)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, stackMag, canUse,
  performAction, startTurn, endTurn,
} from "../skillHarness.ts";

const A = ["laria", "maggie", "ando"];
const B = ["ando", "xyris", "syl"];
const DS = "Deepening Shadows";

/** Advance from Laria's turn through the enemy turn back to Laria's next turn. */
function fullRound(s: ReturnType<typeof battle>) {
  endTurn(s); // A ends (Laria's team)
  startTurn(s); // B starts
  endTurn(s); // B ends
  startTurn(s); // A starts again
}

/** Give a unit an exact magnitude of Deepening Shadows without going through a skill. */
function setDS(u: ReturnType<typeof unit>, mag: number) {
  u.statuses.push({ kind: "stack", name: DS, magnitude: mag, duration: null, appliedBy: "seed", appliedTurn: 0 });
}

// --------------------------------------------------------------------------- //
//  laria0 — Deepening Shadows (passive)
// --------------------------------------------------------------------------- //
test("laria0 Deepening Shadows — Laria gains a stack at the end of each of her turns", () => {
  const s = battle(A, B);
  assert.equal(stackMag(unit(s, "a1"), DS), 0, "starts with no stacks");
  endTurn(s); // end of Laria's turn
  assert.equal(stackMag(unit(s, "a1"), DS), 1, "one stack after her first turn ends");
  startTurn(s); endTurn(s); // enemy turn passes
  startTurn(s); endTurn(s); // Laria's second turn ends
  assert.equal(stackMag(unit(s, "a1"), DS), 2, "two stacks after her second turn");
});

test("laria0 Deepening Shadows — only triggers while Laria has fewer than 3 stacks (caps at 3)", () => {
  const s = battle(A, B);
  for (let i = 0; i < 6; i++) { endTurn(s); startTurn(s); endTurn(s); startTurn(s); }
  assert.equal(stackMag(unit(s, "a1"), DS), 3, "self-generation never exceeds 3");
});

// --------------------------------------------------------------------------- //
//  laria1 — Nightwrap
// --------------------------------------------------------------------------- //
test("laria1 Nightwrap — deals 10 to an enemy and places a Deepening Shadows stack on them", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "laria1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 damage to the enemy target");
  assert.equal(stackMag(unit(s, "b1"), DS), 1, "one Deepening Shadows stack placed on the target");
  assert.equal(skillOf(unit(s, "a1"), "laria1").currentCd, 1, "cooldown 1");
});

test("laria1 Nightwrap — enemy damage is increased by 5 per Deepening Shadows stack on the target", () => {
  const s = battle(A, B);
  setDS(unit(s, "b1"), 2); // 2 stacks -> 10 + 5*2 = 20
  performAction(s, { unit: "a1", skillId: "laria1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "10 + 5*2 = 20 damage");
  assert.equal(stackMag(unit(s, "b1"), DS), 3, "target's stack raised by one (2 -> 3)");
});

test("laria1 Nightwrap — heals a target ally 10 HP, increased by 5 per Deepening Shadows stack", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 40;
  performAction(s, { unit: "a1", skillId: "laria1", targets: ["a2"] });
  assert.equal(unit(s, "a2").hp, 50, "base heal of 10 on an ally");

  const s2 = battle(A, B);
  unit(s2, "a2").hp = 40;
  setDS(unit(s2, "a2"), 3); // 10 + 5*3 = 25
  performAction(s2, { unit: "a1", skillId: "laria1", targets: ["a2"] });
  assert.equal(unit(s2, "a2").hp, 65, "10 + 5*3 = 25 heal");
  assert.equal(stackMag(unit(s2, "a2"), DS), 4, "ally also gains a Deepening Shadows stack (3 -> 4)");
});

test("laria1 Nightwrap — if the target has Elemental Essence, Laria gains Elemental Essence", () => {
  const s = battle(A, B);
  unit(s, "b1").statuses.push({ kind: "elemental_essence", duration: null, appliedBy: "seed", appliedTurn: 0 });
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), false, "Laria has no essence beforehand");
  performAction(s, { unit: "a1", skillId: "laria1", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), true, "Laria gains Elemental Essence from the essence-bearing target");
});

test("laria1 Nightwrap — no essence gained when the target lacks Elemental Essence", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "laria1", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), false, "base case: no essence transfer");
});

// --------------------------------------------------------------------------- //
//  laria2 — Soothing Night (Channel)
// --------------------------------------------------------------------------- //
test("laria2 Soothing Night — gives every ally a stack and heals them 5 HP", () => {
  const s = battle(A, B);
  for (const id of ["a1", "a2", "a3"]) unit(s, id).hp = 50;
  performAction(s, { unit: "a1", skillId: "laria2" });
  for (const id of ["a1", "a2", "a3"]) {
    assert.equal(unit(s, id).hp, 55, `${id} healed 5`);
    assert.equal(stackMag(unit(s, id), DS), 1, `${id} gained a Deepening Shadows stack`);
  }
  assert.equal(skillOf(unit(s, "a1"), "laria2").currentCd, 2, "cooldown 2");
});

test("laria2 Soothing Night — an ally who already had 4 stacks is healed 10 instead of 5", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 50;
  setDS(unit(s, "a2"), 4);
  performAction(s, { unit: "a1", skillId: "laria2" });
  assert.equal(unit(s, "a2").hp, 60, "healed 10 because they already had 4 stacks");
});

test("laria2 Soothing Night — Channel repeats the effect on Laria's following turn (lasts up to 4 turns)", () => {
  const s = battle(A, B);
  for (const id of ["a1", "a2", "a3"]) unit(s, id).hp = 30;
  performAction(s, { unit: "a1", skillId: "laria2" });
  assert.equal(stackMag(unit(s, "a2"), DS), 1, "one stack after the first channel turn");
  fullRound(s);
  assert.equal(stackMag(unit(s, "a2"), DS), 2, "channel fires again next turn: second stack");
  assert.equal(unit(s, "a2").hp, 40, "healed another 5 on the repeat");
});

// --------------------------------------------------------------------------- //
//  laria3 — Suffocating Night (Channel)
// --------------------------------------------------------------------------- //
test("laria3 Suffocating Night — gives every enemy a stack and deals 5 damage", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "laria3" });
  for (const id of ["b1", "b2", "b3"]) {
    assert.equal(unit(s, id).hp, 95, `${id} took 5 damage`);
    assert.equal(stackMag(unit(s, id), DS), 1, `${id} gained a Deepening Shadows stack`);
  }
  assert.equal(skillOf(unit(s, "a1"), "laria3").currentCd, 2, "cooldown 2");
});

test("laria3 Suffocating Night — deals True damage to an enemy who already had 4 stacks", () => {
  const s = battle(A, B);
  // Give the enemy heavy damage reduction: normal 5 would be reduced, but True damage ignores it.
  unit(s, "b1").statuses.push({ kind: "damage_reduction", magnitude: 100, duration: null, appliedBy: "seed", appliedTurn: 0 });
  setDS(unit(s, "b1"), 4);
  const before = unit(s, "b1").hp;
  performAction(s, { unit: "a1", skillId: "laria3" });
  assert.equal(unit(s, "b1").hp, before - 5, "True damage ignores the target's damage reduction for the full 5");
});

test("laria3 Suffocating Night — Channel repeats on Laria's following turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "laria3" });
  assert.equal(unit(s, "b1").hp, 95, "5 on first channel turn");
  fullRound(s);
  assert.equal(unit(s, "b1").hp, 90, "another 5 when the channel repeats");
  assert.equal(stackMag(unit(s, "b1"), DS), 2, "second stack from the repeat");
});

// --------------------------------------------------------------------------- //
//  laria4 — Vanish
// --------------------------------------------------------------------------- //
test("laria4 Vanish — Laria gains 15 Damage Reduction for 3 turns", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "laria4" });
  assert.equal(skillOf(unit(s, "a1"), "laria4").currentCd, 4, "cooldown 4");
  const dr = unit(s, "a1").statuses.find((x) => x.kind === "damage_reduction" && x.name === "Vanish");
  assert.ok(dr, "Vanish applies a Damage Reduction status to Laria");
  assert.equal(dr!.magnitude, 15, "15 Damage Reduction");
  assert.equal(dr!.duration, 3, "for 3 turns");
});

test("laria4 Vanish — the Damage Reduction ends when Laria uses a new skill", () => {
  const s = battle(A, B);
  // Seed the Vanish DR directly, then use a *different* new skill; the 'or until she uses a new skill' clause removes it.
  unit(s, "a1").statuses.push({ kind: "damage_reduction", name: "Vanish", magnitude: 15, duration: 3, appliedBy: "a1", appliedTurn: 0 });
  assert.equal(hasStatus(unit(s, "a1"), "damage_reduction", "Vanish"), true, "DR present before the new skill");
  performAction(s, { unit: "a1", skillId: "laria1", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "damage_reduction", "Vanish"), false, "using a new skill removes the Vanish DR");
});

// --------------------------------------------------------------------------- //
//  laria5 — Nightfall
// --------------------------------------------------------------------------- //
test("laria5 Nightfall — every character becomes invulnerable for 1 turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "laria5" });
  for (const id of ["a1", "a2", "a3", "b1", "b2", "b3"]) {
    assert.equal(hasStatus(unit(s, id), "invulnerable"), true, `${id} is invulnerable`);
  }
  assert.equal(skillOf(unit(s, "a1"), "laria5").currentCd, 4, "cooldown 4");
});

test("laria5 Nightfall — enemies take 5 and allies heal 5 per Deepening Shadows stack they have", () => {
  const s = battle(A, B);
  setDS(unit(s, "b1"), 3); // enemy: 5*3 = 15 damage
  setDS(unit(s, "a1"), 2); // Laria (ally): 5*2 = 10 heal
  unit(s, "a1").hp = 50;
  const b1Before = unit(s, "b1").hp;
  performAction(s, { unit: "a1", skillId: "laria5" });
  assert.equal(unit(s, "b1").hp, b1Before - 15, "enemy takes 5 * 3 stacks = 15 damage");
  assert.equal(unit(s, "a1").hp, 60, "ally heals 5 * 2 stacks = 10");
  // Stacks are not consumed by Nightfall.
  assert.equal(stackMag(unit(s, "b1"), DS), 3, "enemy stacks unchanged");
  assert.equal(stackMag(unit(s, "a1"), DS), 2, "ally stacks unchanged");
});

test("laria5 Nightfall — a character with no stacks takes/heals nothing", () => {
  const s = battle(A, B);
  const before = unit(s, "b2").hp;
  performAction(s, { unit: "a1", skillId: "laria5" });
  assert.equal(unit(s, "b2").hp, before, "0 stacks -> 0 damage");
});
