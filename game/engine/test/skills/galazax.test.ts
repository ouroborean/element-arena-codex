/**
 * Behavior tests for Galazax, the Coming Storm, asserted against the frozen skill prose
 * (game/content/frozen/skills.json). The oracle is the description text.
 *
 * Galazax at a1; fillers riverdaughter/laria; enemies xyris/gommar/hector.
 *
 * NOTE ON ENERGY: the harness flushes base-element energy but Galazax's element is "storm", so his
 * specific-cost skills (galazax4, galazax6) need storm energy — we top it up explicitly.
 * "The Storm Builds" stacks are stored as a single status whose magnitude is the count (stackMag).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, stackMag, canUse, performAction, startTurn, endTurn,
} from "../skillHarness.ts";
import type { MatchState, Unit } from "../../src/types.ts";

const A = ["galazax", "riverdaughter", "laria"];
const B = ["xyris", "gommar", "hector"];

/** Put a single "The Storm Builds" stack status of magnitude n on a unit (matches engine storage). */
function setStorm(u: Unit, n: number): void {
  u.statuses.push({ kind: "stack", name: "The Storm Builds", magnitude: n, duration: null, appliedBy: "x", appliedTurn: 0, sourceId: "galazax0" } as any);
}
/** Reduce team B to a single living enemy (b1) so a "random enemy" pick is deterministic. */
function isolateB1(s: MatchState): void {
  for (const id of Object.keys(s.units)) {
    if (id[0] === "b" && id !== "b1") { s.units[id]!.hp = 0; s.units[id]!.alive = false; }
  }
}

// ---------------------------------------------------------------------------
// galazax0 — The Storm Builds (passive): "Galazax's damaging skills apply a stack of The Storm Builds.
//            Galazax gains Elemental Essence if he uses a skill while Channeling."
// ---------------------------------------------------------------------------
test("galazax0 — a damaging skill applies a stack of The Storm Builds to each enemy hit", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "galazax1" }); // Sky Darkens: 5 to ALL enemies
  for (const id of ["b1", "b2", "b3"]) {
    assert.equal(stackMag(unit(s, id), "The Storm Builds"), 1, `${id} gained a Storm Builds stack from being damaged`);
  }
});

test("galazax0 — no Elemental Essence from a skill used while NOT channeling", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "galazax2", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), false, "not channeling -> no Elemental Essence");
});

test("galazax0 — Elemental Essence gained when a skill is used while Channeling", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "galazax1" }); // begin channeling The Sky Darkens
  assert.equal(hasStatus(unit(s, "a1"), "channeling", "galazax1"), true, "now channeling");
  // Use another skill while the channel is active -> Elemental Essence.
  performAction(s, { unit: "a1", skillId: "galazax3", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "elemental_essence"), true, "skill used while Channeling grants Elemental Essence");
});

// ---------------------------------------------------------------------------
// galazax1 — The Sky Darkens: "Galazax deals 5 Piercing damage to all enemies each turn.
//            Cannot be used while active." Channel; cooldown 1.
// ---------------------------------------------------------------------------
test("galazax1 The Sky Darkens — deals 5 to all enemies on cast", () => {
  const s = battle(A, B);
  const before = ["b1", "b2", "b3"].map((id) => unit(s, id).hp);
  performAction(s, { unit: "a1", skillId: "galazax1" });
  ["b1", "b2", "b3"].forEach((id, i) => {
    assert.equal(before[i]! - unit(s, id).hp, 5, `${id} took 5 damage`);
  });
});

test("galazax1 The Sky Darkens — re-deals 5 to all enemies each of Galazax's turns (Channel)", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "galazax1" });
  const afterCast = ["b1", "b2", "b3"].map((id) => unit(s, id).hp);
  endTurn(s); startTurn(s); // B's turn
  endTurn(s); startTurn(s); // Galazax's next turn -> channel re-ticks
  ["b1", "b2", "b3"].forEach((id, i) => {
    assert.equal(afterCast[i]! - unit(s, id).hp, 5, `${id} took another 5 from the channel tick`);
  });
});

test("galazax1 The Sky Darkens — cannot be used while already active", () => {
  const s = battle(A, B);
  const g = unit(s, "a1");
  assert.equal(canUse(s, g, skillOf(g, "galazax1")), true, "usable when not channeling");
  performAction(s, { unit: "a1", skillId: "galazax1" });
  assert.equal(canUse(s, g, skillOf(g, "galazax1")), false, "cannot be used while active");
});

// ---------------------------------------------------------------------------
// galazax2 — Lightning Strikes: "Galazax deals 10 damage to target enemy and 5 damage to a random enemy."
// ---------------------------------------------------------------------------
test("galazax2 Lightning Strikes — 10 to target and 5 to a random enemy (15 total)", () => {
  const s = battle(A, B);
  // Sum damage across all enemies to be robust to which enemy the random 5 lands on.
  const enemyIds = Object.keys(s.units).filter((k) => s.units[k]!.team === "B");
  const before = enemyIds.reduce((a, id) => a + unit(s, id).hp, 0);
  performAction(s, { unit: "a1", skillId: "galazax2", targets: ["b1"] });
  const after = enemyIds.reduce((a, id) => a + unit(s, id).hp, 0);
  assert.equal(before - after, 15, "10 (target) + 5 (random enemy) = 15 total damage");
  assert.equal(100 - unit(s, "b1").hp >= 10, true, "the explicit target took at least its 10 damage");
});

test("galazax2 Lightning Strikes — both hits can land on the sole enemy (10+5)", () => {
  const s = battle(A, B);
  isolateB1(s); // only b1 alive -> the random pick must be b1
  performAction(s, { unit: "a1", skillId: "galazax2", targets: ["b1"] });
  assert.equal(100 - unit(s, "b1").hp, 15, "10 + 5 both land on the only enemy");
});

// ---------------------------------------------------------------------------
// galazax3 — Pressure Rises: "Galazax moves all stacks of The Storm Builds from target enemy to himself.
//            If 2 or more stacks are removed, this deals 5 Piercing damage to the target.
//            If 4 or more stacks are removed, stun the target for 1 turn.
//            Using this skill does not interrupt Channeling."
// ---------------------------------------------------------------------------
test("galazax3 Pressure Rises — moves all stacks to Galazax (>=4: also 5 Piercing + stun)", () => {
  const s = battle(A, B);
  setStorm(unit(s, "b1"), 4);
  performAction(s, { unit: "a1", skillId: "galazax3", targets: ["b1"] });
  assert.equal(stackMag(unit(s, "b1"), "The Storm Builds"), 0, "all stacks removed from the target");
  assert.equal(stackMag(unit(s, "a1"), "The Storm Builds"), 4, "the 4 stacks moved to Galazax");
  assert.equal(unit(s, "b1").hp, 95, "4>=2 -> 5 Piercing damage to the target");
  assert.equal(hasStatus(unit(s, "b1"), "stun"), true, "4>=4 -> target stunned");
});

test("galazax3 Pressure Rises — exactly 2 stacks: 5 Piercing but no stun", () => {
  const s = battle(A, B);
  setStorm(unit(s, "b1"), 2);
  performAction(s, { unit: "a1", skillId: "galazax3", targets: ["b1"] });
  assert.equal(stackMag(unit(s, "a1"), "The Storm Builds"), 2, "2 stacks moved to Galazax");
  assert.equal(stackMag(unit(s, "b1"), "The Storm Builds"), 0, "target cleared");
  assert.equal(unit(s, "b1").hp, 95, "2>=2 -> 5 Piercing");
  assert.equal(hasStatus(unit(s, "b1"), "stun"), false, "2<4 -> no stun");
});

test("galazax3 Pressure Rises — a single stack: moved, but no damage and no stun", () => {
  const s = battle(A, B);
  setStorm(unit(s, "b1"), 1);
  performAction(s, { unit: "a1", skillId: "galazax3", targets: ["b1"] });
  assert.equal(stackMag(unit(s, "a1"), "The Storm Builds"), 1, "the single stack moved to Galazax");
  assert.equal(stackMag(unit(s, "b1"), "The Storm Builds"), 0, "target cleared");
  assert.equal(unit(s, "b1").hp, 100, "1<2 -> no Piercing damage");
  assert.equal(hasStatus(unit(s, "b1"), "stun"), false, "1<4 -> no stun");
});

test("galazax3 Pressure Rises — does not interrupt Channeling", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "galazax1" }); // channel The Sky Darkens
  setStorm(unit(s, "b1"), 3);
  performAction(s, { unit: "a1", skillId: "galazax3", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "a1"), "channeling", "galazax1"), true, "channel still active after Pressure Rises");
});

// ---------------------------------------------------------------------------
// galazax4 — The Heavens Speak: "Consumes all stacks of The Storm Builds on Galazax, dealing 10 damage
//            to target enemy, increased by 5 for each stack and applying that many stacks of
//            The Storm Builds to the target." Cooldown 2.
// ---------------------------------------------------------------------------
test("galazax4 The Heavens Speak — consumes N self-stacks: 10+5N damage, applies N stacks, cd 2", () => {
  const s = battle(A, B);
  s.teams.A.energy.storm = 99; // storm specific cost
  const g = unit(s, "a1");
  setStorm(g, 3); // N = 3
  performAction(s, { unit: "a1", skillId: "galazax4", targets: ["b1"] });
  assert.equal(100 - unit(s, "b1").hp, 25, "10 + 5*3 = 25 damage");
  assert.equal(stackMag(g, "The Storm Builds"), 0, "all of Galazax's stacks consumed");
  // N=3 explicitly applied to the target (plus 1 from the passive on the damage hit = 4).
  assert.equal(stackMag(unit(s, "b1"), "The Storm Builds"), 4, "3 applied by the skill + 1 from the passive");
  assert.equal(skillOf(g, "galazax4").currentCd, 2, "cooldown 2");
});

test("galazax4 The Heavens Speak — with no stacks: base 10 damage", () => {
  const s = battle(A, B);
  s.teams.A.energy.storm = 99;
  performAction(s, { unit: "a1", skillId: "galazax4", targets: ["b1"] });
  assert.equal(100 - unit(s, "b1").hp, 10, "10 + 5*0 = 10 base damage");
});

// ---------------------------------------------------------------------------
// galazax5 — Thunder Deafens: "Galazax becomes untargetable and ignores all damage for 1 turn.
//            Using this skill does not interrupt Channeling." Cooldown 3.
// ---------------------------------------------------------------------------
test("galazax5 Thunder Deafens — grants untargetable + damage-ignore, cd 3, keeps channel", () => {
  const s = battle(A, B);
  const g = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "galazax1" }); // channel first
  performAction(s, { unit: "a1", skillId: "galazax5" });
  assert.equal(hasStatus(g, "untargetable"), true, "becomes untargetable");
  assert.equal(hasStatus(g, "damage_ignore"), true, "ignores all damage");
  assert.equal(skillOf(g, "galazax5").currentCd, 3, "cooldown 3");
  assert.equal(hasStatus(g, "channeling", "galazax1"), true, "channel not interrupted");
});

// ---------------------------------------------------------------------------
// galazax6 — The Vortex Consumes: "Galazax deals 15 Piercing damage to all enemies each turn for 3 turns.
//            This skill applies an extra stack of The Storm Builds to all targets. To use this skill,
//            Galazax must consume 10 stacks of The Storm Builds from himself and must be Channeling
//            The Sky Darkens." Cooldown 4.
// ---------------------------------------------------------------------------
test("galazax6 The Vortex Consumes — usability gate: needs 10 stacks AND channeling The Sky Darkens", () => {
  const s = battle(A, B);
  s.teams.A.energy.storm = 99;
  const g = unit(s, "a1");
  // No stacks, not channeling -> unusable.
  assert.equal(canUse(s, g, skillOf(g, "galazax6")), false, "unusable without stacks or channel");
  // 10 stacks but not channeling -> still unusable.
  setStorm(g, 10);
  assert.equal(canUse(s, g, skillOf(g, "galazax6")), false, "10 stacks but not channeling -> unusable");
});

test("galazax6 The Vortex Consumes — with 10 stacks + Sky Darkens channel: usable, consumes 10", () => {
  const s = battle(A, B);
  s.teams.A.energy.storm = 99;
  const g = unit(s, "a1");
  setStorm(g, 12);
  performAction(s, { unit: "a1", skillId: "galazax1" }); // channel The Sky Darkens
  assert.equal(canUse(s, g, skillOf(g, "galazax6")), true, "10+ stacks while channeling -> usable");
  performAction(s, { unit: "a1", skillId: "galazax6" });
  assert.equal(stackMag(g, "The Storm Builds"), 2, "consumes exactly 10 of the 12 stacks");
  assert.equal(skillOf(g, "galazax6").currentCd, 4, "cooldown 4");
});

test("galazax6 The Vortex Consumes — first tick: 15 Piercing + an extra Storm Builds stack to all enemies", () => {
  const s = battle(A, B);
  s.teams.A.energy.storm = 99;
  const g = unit(s, "a1");
  setStorm(g, 12);
  performAction(s, { unit: "a1", skillId: "galazax1" }); // channel: 5 to all + 1 stack each
  const hpAfterChannel = ["b1", "b2", "b3"].map((id) => unit(s, id).hp);
  const stacksAfterChannel = ["b1", "b2", "b3"].map((id) => stackMag(unit(s, id), "The Storm Builds"));
  performAction(s, { unit: "a1", skillId: "galazax6" });
  ["b1", "b2", "b3"].forEach((id, i) => {
    assert.equal(hpAfterChannel[i]! - unit(s, id).hp, 15, `${id} took 15 Piercing from the first Vortex tick`);
    // +1 explicit "extra" stack, +1 from the passive on the damage = +2 over the pre-Vortex count.
    assert.equal(stackMag(unit(s, id), "The Storm Builds") - stacksAfterChannel[i]!, 2, `${id} gained the extra stack (+ passive)`);
  });
  // "for 3 turns": two further ticks are scheduled beyond this immediate one.
  assert.equal(s.scheduled.length, 2, "two more Vortex ticks are queued (3 total)");
});
