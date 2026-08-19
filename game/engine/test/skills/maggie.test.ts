/**
 * Behavior tests for Maggie Thorncursed — asserted against the FROZEN skill prose (the oracle),
 * never against the implementation. A clean assertion failure here is a reported engine bug.
 *
 * Oracle (game/content/frozen/skills.json):
 *  maggie0 Curse of Thorns (passive): When Maggie uses a skill, she takes 5 Affliction damage each turn
 *    for the rest of the game.
 *  maggie1 Bramblelash: Deals 15 damage to target enemy and marks them with Bramblelash. Until the end of
 *    Maggie's next turn, if that target receives new damage, she will gain Elemental Essence. (cost 1, cd 0)
 *  maggie2 Grasping Vines: Maggie prepares to cast Grasping Vines on target enemy. The following turn, they
 *    receive 15 damage. If the target uses a skill during this time, they are also stunned for 1 turn. The
 *    target of this skill is invisible. This effect will be cancelled if Maggie is stunned. (Control, cd 1)
 *  maggie3 Thornburst: Deals 30 damage to one enemy. If Maggie has 3 or more stacks of Curse of Thorns on
 *    her, this skill will target all enemies. (cd 1)
 *  maggie4 Cursed Resistance: Maggie gains 10 permanent shield for every stack of Curse of Thorns on her.
 *    (self, cd 2)
 *  maggie5 The Thornborn Witch: Maggie ignores damage from Curse of Thorns for 2 turns. During this time,
 *    she deals damage equal to her Curse of Thorns damage to all targetable enemies and allies each turn.
 *    (self, cd 3)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, stackMag, shieldTotal, canUse,
  performAction, startTurn, endTurn, emit,
} from "../skillHarness.ts";

const A = ["maggie", "laria", "ando"];
const B = ["ando", "xyris", "syl"];
const COT = "Curse of Thorns";

/** Advance from Maggie's turn through the enemy turn back to Maggie's next turn (and end it). */
function toNextMaggieTurnEnd(s: ReturnType<typeof battle>) {
  endTurn(s); // A ends (Maggie's team)
  startTurn(s); // B starts
  endTurn(s); // B ends
  startTurn(s); // A starts (Maggie's next turn)
  endTurn(s); // A ends -> scheduled/DoT effects anchored to Maggie's turn fire
}

/** Give Maggie an exact stack count of Curse of Thorns without going through a skill. */
function setCoT(u: ReturnType<typeof unit>, mag: number) {
  u.statuses.push({ kind: "stack", name: COT, magnitude: mag, duration: null, appliedBy: "a1", appliedTurn: 0 });
}

// --------------------------------------------------------------------------- //
//  maggie0 — Curse of Thorns (passive)
// --------------------------------------------------------------------------- //
test("maggie0 Curse of Thorns — using a skill accrues the curse (a Curse of Thorns stack)", () => {
  const s = battle(A, B);
  assert.equal(stackMag(unit(s, "a1"), COT), 0, "no curse before acting");
  performAction(s, { unit: "a1", skillId: "maggie1", targets: ["b1"] });
  assert.equal(stackMag(unit(s, "a1"), COT), 1, "a skill use accrues Curse of Thorns");
});

test("maggie0 Curse of Thorns — after using a skill, Maggie takes 5 Affliction damage each turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie1", targets: ["b1"] });
  assert.equal(unit(s, "a1").hp, 100, "the Bramblelash cast itself does not self-damage yet");
  // Advance to Maggie's next turn; the curse should tick for 5.
  toNextMaggieTurnEnd(s);
  assert.equal(unit(s, "a1").hp, 95, "Curse of Thorns deals 5 Affliction damage on her next turn");
});

// --------------------------------------------------------------------------- //
//  maggie1 — Bramblelash
// --------------------------------------------------------------------------- //
test("maggie1 Bramblelash — deals 15 damage and marks the target with Bramblelash", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "15 damage to the target");
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Bramblelash"), true, "target marked with Bramblelash");
  assert.equal(skillOf(unit(s, "a1"), "maggie1").currentCd, 0, "no cooldown");
});

test("maggie1 Bramblelash — Maggie gains Elemental Essence when the marked target receives new damage", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie1", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), false, "no essence just from the Bramblelash strike itself");
  // A separate, new source of damage hits the marked target.
  performAction(s, { unit: "a2", skillId: "laria1", targets: ["b1"] });
  assert.equal(
    hasStatus(unit(s, "a1"), "elemental_essence"), true,
    "new damage to the Bramblelash-marked target grants Maggie Elemental Essence",
  );
});

// --------------------------------------------------------------------------- //
//  maggie2 — Grasping Vines
// --------------------------------------------------------------------------- //
test("maggie2 Grasping Vines — no immediate damage; deals 15 the following turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 100, "no damage on the preparation turn");
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Grasping Vines"), true, "target marked while the cast is pending");
  assert.equal(skillOf(unit(s, "a1"), "maggie2").currentCd, 1, "cooldown 1");
  toNextMaggieTurnEnd(s);
  assert.equal(unit(s, "b1").hp, 85, "the following turn the target receives 15 damage");
});

test("maggie2 Grasping Vines — if the target uses a skill during this time, they are also stunned for 1 turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie2", targets: ["b1"] });
  endTurn(s); // Maggie's team ends
  startTurn(s); // enemy team's turn
  performAction(s, { unit: "b1", skillId: unit(s, "b1").skills[0].id, targets: ["a1"] });
  assert.equal(hasStatus(unit(s, "b1"), "stun"), true, "acting while Grasping Vines is pending stuns the target");
});

test("maggie2 Grasping Vines — the effect is cancelled if Maggie is stunned", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie2", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Grasping Vines"), true, "pending before Maggie is stunned");
  // Stun Maggie (same event shape the engine emits when a status is applied).
  unit(s, "a1").statuses.push({ kind: "stun", duration: 1, appliedBy: "b1", appliedTurn: 0 });
  emit(s, { type: "statusApplied", unit: "a1", source: "b1", kind: "stun" });
  assert.equal(
    hasStatus(unit(s, "b1"), "mark", "Grasping Vines"), false,
    "Maggie being stunned cancels the pending Grasping Vines (mark removed)",
  );
  toNextMaggieTurnEnd(s);
  assert.equal(unit(s, "b1").hp, 100, "cancelled cast deals no delayed damage");
});

// --------------------------------------------------------------------------- //
//  maggie3 — Thornburst
// --------------------------------------------------------------------------- //
test("maggie3 Thornburst — deals 30 to a single enemy when Maggie has fewer than 3 Curse of Thorns stacks", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "maggie3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 70, "30 damage to the chosen enemy");
  assert.equal(unit(s, "b2").hp, 100, "other enemies untouched");
  assert.equal(unit(s, "b3").hp, 100, "other enemies untouched");
  assert.equal(skillOf(unit(s, "a1"), "maggie3").currentCd, 1, "cooldown 1");
});

test("maggie3 Thornburst — hits ALL enemies for 30 when Maggie has 3 or more Curse of Thorns stacks", () => {
  const s = battle(A, B);
  setCoT(unit(s, "a1"), 3);
  performAction(s, { unit: "a1", skillId: "maggie3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 70, "b1 takes 30");
  assert.equal(unit(s, "b2").hp, 70, "b2 takes 30 (AOE branch)");
  assert.equal(unit(s, "b3").hp, 70, "b3 takes 30 (AOE branch)");
});

// --------------------------------------------------------------------------- //
//  maggie4 — Cursed Resistance
// --------------------------------------------------------------------------- //
test("maggie4 Cursed Resistance — grants 10 shield per Curse of Thorns stack on Maggie", () => {
  const s = battle(A, B);
  setCoT(unit(s, "a1"), 2); // 2 stacks -> 20 shield
  performAction(s, { unit: "a1", skillId: "maggie4" });
  assert.equal(shieldTotal(unit(s, "a1")), 20, "10 * 2 stacks = 20 shield");
  assert.equal(skillOf(unit(s, "a1"), "maggie4").currentCd, 2, "cooldown 2");
});

test("maggie4 Cursed Resistance — the shield is permanent (does not expire over turns)", () => {
  const s = battle(A, B);
  setCoT(unit(s, "a1"), 3); // 30 shield
  performAction(s, { unit: "a1", skillId: "maggie4" });
  assert.equal(shieldTotal(unit(s, "a1")), 30, "30 shield granted");
  endTurn(s); startTurn(s); endTurn(s); startTurn(s);
  assert.equal(shieldTotal(unit(s, "a1")), 30, "shield persists across turns (permanent)");
});

// --------------------------------------------------------------------------- //
//  maggie5 — The Thornborn Witch
// --------------------------------------------------------------------------- //
test("maggie5 The Thornborn Witch — Maggie ignores her Curse of Thorns damage for 2 turns", () => {
  const s = battle(A, B);
  setCoT(unit(s, "a1"), 2);
  performAction(s, { unit: "a1", skillId: "maggie5" });
  assert.equal(hasStatus(unit(s, "a1"), "damage_ignore"), true, "gains a Curse-of-Thorns damage_ignore");
  assert.equal(skillOf(unit(s, "a1"), "maggie5").currentCd, 3, "cooldown 3");
});

test("maggie5 The Thornborn Witch — deals damage equal to her Curse of Thorns damage to all other targetable units", () => {
  const s = battle(A, B);
  setCoT(unit(s, "a1"), 2); // curse damage = 5 * 2 = 10 (measured before the passive's own +1 stack)
  const enemiesBefore = ["b1", "b2", "b3"].map((id) => unit(s, id).hp);
  const alliesBefore = ["a2", "a3"].map((id) => unit(s, id).hp);
  performAction(s, { unit: "a1", skillId: "maggie5" });
  for (const [i, id] of ["b1", "b2", "b3"].entries()) {
    assert.equal(unit(s, id).hp, enemiesBefore[i] - 10, `${id} (enemy) takes 10 = her Curse of Thorns damage`);
  }
  for (const [i, id] of ["a2", "a3"].entries()) {
    assert.equal(unit(s, id).hp, alliesBefore[i] - 10, `${id} (ally) also takes 10 — hits enemies AND allies`);
  }
});

test("maggie5 The Thornborn Witch — the damage pulse repeats on Maggie's following turn (2 turns total)", () => {
  const s = battle(A, B);
  setCoT(unit(s, "a1"), 2);
  performAction(s, { unit: "a1", skillId: "maggie5" });
  const afterFirst = unit(s, "b1").hp;
  assert.equal(afterFirst, 90, "first pulse dealt 10");
  toNextMaggieTurnEnd(s);
  assert.ok(unit(s, "b1").hp < afterFirst, "a second pulse lands on her following turn");
});
