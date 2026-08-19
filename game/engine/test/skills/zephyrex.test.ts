/**
 * Behavior tests for Zephyrex the Windblade against the frozen skill prose (the oracle). Assertions
 * target the described behavior, never the implementation. A clean assertion failure here is a
 * reported bug (kept asserting the correct prose behavior, never weakened to pass).
 *
 * Oracle (game/content/frozen/skills.json):
 *  zephyrex0 Biting Wind (passive): "Any time an enemy unit becomes invulnerable, Zephyrex deals 15
 *    piercing damage to them first."
 *  zephyrex1 Arcadian Duet: "Target enemy becomes Invulnerable and Isolated until the end of their
 *    next turn."
 *  zephyrex2 Elegant Sweep: "On the following turn, Zephyrex deals 25 piercing damage to all enemy
 *    Heroes. This skill is Channeled (Being stunned or using a new skill will cancel it)."
 *  zephyrex3 Sonic Thrust: "Deals 20 Piercing damage to target enemy and stuns their non-Strategic
 *    skills for 1 turn. This skill Bypasses Invulnerability and can only be used if Wind Step is on
 *    cooldown."
 *  zephyrex4 Wind Step: "Zephyrex gains 15 damage reduction for 1 turn. This effect is Invisible. If
 *    Zephyrex receives a new skill during this time, he gains Elemental Essence."
 *  zephyrex5 Perfect Execution: "Zephyrex deals 15 Piercing damage to target enemy and gives himself
 *    Perfection until the end of his next turn. If Perfection expires, this skill will be disabled for
 *    the remainder of the round. Each time this skill is used, it permanently deals 15 more damage."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, canUse, performAction, startTurn, endTurn } from "../skillHarness.ts";
import type { Unit, MatchState } from "../../src/types.ts";

const statusOf = (u: Unit, kind: string, name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const enemyHeroHps = (s: MatchState) => ["b1", "b2", "b3"].map((id) => unit(s, id).hp);

// --------------------------------------------------------------------------- //
//  zephyrex0 — Biting Wind (passive)
// --------------------------------------------------------------------------- //
test("Biting Wind — when an enemy becomes Invulnerable, Zephyrex deals 15 piercing to them first", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  // Arcadian Duet makes b1 Invulnerable, which must trigger Biting Wind's 15 piercing.
  performAction(s, { unit: "a1", skillId: "zephyrex1", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "b1"), "invulnerable"), true, "the enemy did become Invulnerable");
  assert.equal(unit(s, "b1").hp, 85, "Biting Wind dealt 15 piercing as the enemy turned Invulnerable");
});

// --------------------------------------------------------------------------- //
//  zephyrex1 — Arcadian Duet
// --------------------------------------------------------------------------- //
test("Arcadian Duet — target becomes Invulnerable and Isolated until end of their next turn (cost 1 generic, cd 0)", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex1", targets: ["b1"] });
  const b1 = unit(s, "b1");
  assert.equal(hasStatus(b1, "invulnerable"), true, "target becomes Invulnerable");
  assert.equal(hasStatus(b1, "isolated"), true, "target becomes Isolated");
  assert.equal(statusOf(b1, "invulnerable")!.duration, 1, "Invulnerable until end of their next turn (1)");
  assert.equal(statusOf(b1, "isolated")!.duration, 1, "Isolated until end of their next turn (1)");
  assert.equal(skillOf(unit(s, "a1"), "zephyrex1").currentCd, 0, "no cooldown");
});

// --------------------------------------------------------------------------- //
//  zephyrex2 — Elegant Sweep
// --------------------------------------------------------------------------- //
test("Elegant Sweep — deals no damage on cast; it is Channeled (payload lands the following turn)", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex2" });
  assert.equal(hasStatus(unit(s, "a1"), "channeling"), true, "the skill is Channeled");
  assert.deepEqual(enemyHeroHps(s), [100, 100, 100], "damage is deferred to the following turn, not dealt on cast");
});

test("Elegant Sweep — on the following turn deals 25 piercing to all enemy Heroes", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex2" });
  const afterCast = enemyHeroHps(s);
  endTurn(s); startTurn(s); // hand to B and back...
  endTurn(s); startTurn(s); // ...to Zephyrex's next turn, when the channel resolves
  const afterNext = enemyHeroHps(s);
  for (let i = 0; i < 3; i++) {
    assert.equal(afterCast[i]! - afterNext[i]!, 25, "each enemy Hero takes 25 on the following turn");
  }
});

test("Elegant Sweep — using a new skill cancels the channel (no further payload)", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex2" });
  performAction(s, { unit: "a1", skillId: "zephyrex4" }); // Wind Step: a new skill
  assert.equal(hasStatus(unit(s, "a1"), "channeling"), false, "using a new skill cancels the channel");
  const before = enemyHeroHps(s);
  endTurn(s); startTurn(s);
  endTurn(s); startTurn(s);
  assert.deepEqual(enemyHeroHps(s), before, "a cancelled channel deals no further damage");
});

// --------------------------------------------------------------------------- //
//  zephyrex3 — Sonic Thrust
// --------------------------------------------------------------------------- //
test("Sonic Thrust — can only be used while Wind Step is on cooldown", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  const z = unit(s, "a1");
  // Fresh round: Wind Step (zephyrex4) is OFF cooldown, so Sonic Thrust must NOT be usable.
  assert.equal(canUse(s, z, skillOf(z, "zephyrex3")), false, "not usable while Wind Step is available");
  performAction(s, { unit: "a1", skillId: "zephyrex4" }); // put Wind Step on cooldown
  assert.equal(canUse(s, z, skillOf(z, "zephyrex3")), true, "usable once Wind Step is on cooldown");
});

test("Sonic Thrust — 20 Piercing that Bypasses Invulnerability, and stuns non-Strategic skills for 1 turn", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  const b1 = unit(s, "b1");
  // Sonic Thrust is gated on Wind Step being on cooldown; put it there so we can isolate the strike.
  skillOf(unit(s, "a1"), "zephyrex4").currentCd = 2;
  // Invulnerability must NOT stop it (Bypassing). Apply the status directly (no event) to isolate the bypass.
  b1.statuses.push({ kind: "invulnerable", duration: 2, appliedBy: "b1", appliedTurn: 0 });
  performAction(s, { unit: "a1", skillId: "zephyrex3", targets: ["b1"] });
  assert.equal(b1.hp, 80, "20 Piercing lands through Invulnerability");
  const stun = statusOf(b1, "stun");
  assert.ok(stun, "target is stunned");
  assert.equal(stun!.duration, 1, "stun lasts 1 turn");
  assert.deepEqual(stun!.scope, { tag: "Strategic", mode: "except" }, "stun applies to non-Strategic skills");
  assert.equal(canUse(s, b1, skillOf(b1, "gommar1")), false, "a non-Strategic skill is stunned");
});

// --------------------------------------------------------------------------- //
//  zephyrex4 — Wind Step
// --------------------------------------------------------------------------- //
test("Wind Step — grants 15 damage reduction for 1 turn (cooldown 2)", () => {
  const s = battle(["zephyrex", "sera", "syl"], ["sera", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex4" });
  const dr = statusOf(unit(s, "a1"), "damage_reduction");
  assert.ok(dr, "gains damage reduction");
  assert.equal(dr!.magnitude, 15, "15 damage reduction");
  assert.equal(dr!.duration, 1, "for 1 turn");
  assert.equal(skillOf(unit(s, "a1"), "zephyrex4").currentCd, 2, "cooldown 2");
  // Functional: a 15-damage hit is fully absorbed by the 15 DR, while an un-protected ally takes it.
  performAction(s, { unit: "b1", skillId: "sera1", targets: ["a2"] }); // control: no DR
  performAction(s, { unit: "b2", skillId: "ando1", targets: ["a1"] }); // Zephyrex: 15 DR
  assert.equal(unit(s, "a2").hp, 85, "un-protected ally takes the full 15");
  assert.equal(unit(s, "a1").hp, 100, "Zephyrex's 15 DR reduces the 15-damage hit to 0");
});

// --------------------------------------------------------------------------- //
//  zephyrex5 — Perfect Execution
// --------------------------------------------------------------------------- //
test("Perfect Execution — deals 15 Piercing and grants Perfection until end of Zephyrex's next turn", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex5", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "15 Piercing damage on the first use");
  const perf = statusOf(unit(s, "a1"), "mark", "Perfection");
  assert.ok(perf, "Zephyrex gains Perfection");
  assert.equal(perf!.duration, 1, "Perfection lasts until the end of his next turn (1)");
});

test("Perfect Execution — each use permanently deals 15 more damage", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "zephyrex5", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "first use: 15");
  performAction(s, { unit: "a1", skillId: "zephyrex5", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 55, "second use: 30 (15 more than the first)");
});

test("Perfect Execution — if Perfection expires, the skill is disabled for the rest of the round", () => {
  const s = battle(["zephyrex", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  const z = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "zephyrex5", targets: ["b1"] });
  assert.equal(canUse(s, z, skillOf(z, "zephyrex5")), true, "still usable while Perfection is up");
  // Let Perfection lapse without re-using it (advance to a later Zephyrex turn-end).
  endTurn(s); endTurn(s); endTurn(s);
  assert.equal(hasStatus(z, "mark", "Perfection"), false, "Perfection has expired");
  assert.equal(canUse(s, z, skillOf(z, "zephyrex5")), false, "Perfect Execution is disabled for the round");
});
