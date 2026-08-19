/**
 * Behavior tests for Gaia Worldsoul, asserted against the frozen skill prose (game/content/frozen/skills.json).
 * The oracle is the description text; we assert concrete numbers from it, never the implementation.
 *
 * Gaia at a1; fillers riverdaughter/laria; enemies xyris/gommar/hector.
 * Her passive summons two Seedlings: a1:Seedling:0 and a1:Seedling:1. A Seedling's "Channel Earth"
 * skill (seedling1) feeds Gaia a permanent "Channel Earth" stack + Elemental Essence — this is the
 * "each time Channel Earth has been used this battle" counter that Worldfist and Rampart scale off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, stackMag, shieldTotal, canUse, performAction, startTurn, endTurn,
} from "../skillHarness.ts";

const A = ["gaia", "riverdaughter", "laria"];
const B = ["xyris", "gommar", "hector"];

const seedlingCount = (s: ReturnType<typeof battle>) =>
  Object.values(s.units).filter((u) => u.alive && u.name === "Seedling" && u.team === "A").length;

// ---------------------------------------------------------------------------
// gaia0 — Yggdrasil's Bounty (passive): "At the start of the game, Gaia creates two Seedling minions."
// ---------------------------------------------------------------------------
test("gaia0 Yggdrasil's Bounty — two Seedlings exist at battle start", () => {
  const s = battle(A, B);
  assert.equal(seedlingCount(s), 2, "exactly two Seedlings summoned at round start");
  // They are Gaia's (owned by a1) Seedling-template minions.
  const seeds = Object.keys(s.units).filter((k) => k.startsWith("a1:Seedling"));
  assert.equal(seeds.length, 2);
  for (const id of seeds) {
    assert.equal(unit(s, id).name, "Seedling");
    assert.equal(unit(s, id).kind, "minion");
  }
});

// ---------------------------------------------------------------------------
// gaia1 — Sprout Seedling: "Creates a Seedling minion. Maximum 3."
// ---------------------------------------------------------------------------
test("gaia1 Sprout Seedling — creates a Seedling, capped at 3 total", () => {
  const s = battle(A, B);
  assert.equal(seedlingCount(s), 2, "starts with the two passive Seedlings");
  performAction(s, { unit: "a1", skillId: "gaia1" });
  assert.equal(seedlingCount(s), 3, "sprouting a third Seedling brings the total to 3");
  // "Maximum 3": a further cast must not create a 4th.
  performAction(s, { unit: "a1", skillId: "gaia1" });
  assert.equal(seedlingCount(s), 3, "capped at 3 — no 4th Seedling is created");
});

// ---------------------------------------------------------------------------
// gaia2 — Worldfist: "Deals 10 damage to one enemy, increased by 5 for each time Channel Earth
//         has been used this battle."
// ---------------------------------------------------------------------------
test("gaia2 Worldfist — base 10 damage with no Channel Earth used", () => {
  const s = battle(A, B);
  const before = unit(s, "b1").hp;
  performAction(s, { unit: "a1", skillId: "gaia2", targets: ["b1"] });
  assert.equal(before - unit(s, "b1").hp, 10, "base damage is 10 when Channel Earth count is 0");
});

test("gaia2 Worldfist — +5 damage per Channel Earth used this battle", () => {
  const s = battle(A, B);
  const g = unit(s, "a1");
  // One Seedling channels Earth -> Gaia gains one "Channel Earth" stack.
  performAction(s, { unit: "a1:Seedling:0", skillId: "seedling1" });
  assert.equal(stackMag(g, "Channel Earth"), 1, "one Channel Earth used");
  let before = unit(s, "b1").hp;
  performAction(s, { unit: "a1", skillId: "gaia2", targets: ["b1"] });
  assert.equal(before - unit(s, "b1").hp, 15, "10 + 5*1 = 15 after one Channel Earth");

  // A second Channel Earth -> 10 + 5*2 = 20.
  performAction(s, { unit: "a1:Seedling:1", skillId: "seedling1" });
  assert.equal(stackMag(g, "Channel Earth"), 2, "two Channel Earths used");
  before = unit(s, "b2").hp;
  performAction(s, { unit: "a1", skillId: "gaia2", targets: ["b2"] });
  assert.equal(before - unit(s, "b2").hp, 20, "10 + 5*2 = 20 after two Channel Earths");
});

// ---------------------------------------------------------------------------
// gaia3 — Channel Vitality: "Gaia heals target ally for 10 HP. For the rest of the turn, if any of
//         Gaia's minions act, that ally will be healed for 10 HP." Cooldown 1.
// ---------------------------------------------------------------------------
test("gaia3 Channel Vitality — heals target ally 10 immediately", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 50;
  performAction(s, { unit: "a1", skillId: "gaia3", targets: ["a2"] });
  assert.equal(unit(s, "a2").hp, 60, "target ally healed 10 on cast");
});

test("gaia3 Channel Vitality — a minion acting heals the marked ally another 10", () => {
  const s = battle(A, B);
  unit(s, "a2").hp = 50;
  performAction(s, { unit: "a1", skillId: "gaia3", targets: ["a2"] });
  assert.equal(unit(s, "a2").hp, 60, "initial heal");
  // A Gaia minion acts this turn -> the marked ally is healed for 10 more.
  performAction(s, { unit: "a1:Seedling:0", skillId: "seedling1" });
  assert.equal(unit(s, "a2").hp, 70, "marked ally healed +10 when a minion acts");
});

test("gaia3 Channel Vitality — cooldown is 1", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gaia3", targets: ["a1"] });
  assert.equal(skillOf(unit(s, "a1"), "gaia3").currentCd, 1, "cooldown 1 after use");
  assert.equal(canUse(s, unit(s, "a1"), skillOf(unit(s, "a1"), "gaia3")), false, "on cooldown, not usable");
});

// ---------------------------------------------------------------------------
// gaia4 — Rampart: "Gaia gains 20 permanent Shield, increased by 5 for each time Channel Earth
//         has been used this battle." Cooldown 2.
// ---------------------------------------------------------------------------
test("gaia4 Rampart — grants 20 Shield with no Channel Earth used", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gaia4" });
  assert.equal(shieldTotal(unit(s, "a1")), 20, "base 20 Shield");
  assert.equal(skillOf(unit(s, "a1"), "gaia4").currentCd, 2, "cooldown 2");
});

test("gaia4 Rampart — +5 Shield per Channel Earth used, and it is permanent", () => {
  const s = battle(A, B);
  const g = unit(s, "a1");
  performAction(s, { unit: "a1:Seedling:0", skillId: "seedling1" }); // one Channel Earth
  performAction(s, { unit: "a1:Seedling:1", skillId: "seedling1" }); // two Channel Earths
  assert.equal(stackMag(g, "Channel Earth"), 2);
  performAction(s, { unit: "a1", skillId: "gaia4" });
  assert.equal(shieldTotal(g), 30, "20 + 5*2 = 30 Shield");
  // "Permanent" — the shield persists across a full round of turn-ends.
  endTurn(s); startTurn(s); endTurn(s); startTurn(s);
  assert.equal(shieldTotal(g), 30, "Shield is permanent — survives turn cycling");
});

// ---------------------------------------------------------------------------
// gaia5 — Worldmarch: "All active Seedling minions become Worldsprout minions permanently." CD 6.
// ---------------------------------------------------------------------------
test("gaia5 Worldmarch — transforms every active Seedling into a Worldsprout", () => {
  const s = battle(A, B);
  assert.equal(seedlingCount(s), 2, "two Seedlings present");
  performAction(s, { unit: "a1", skillId: "gaia5" });
  const minions = Object.keys(s.units).filter((k) => k.startsWith("a1:Seedling"));
  for (const id of minions) {
    assert.equal(unit(s, id).name, "Worldsprout", "each Seedling became a Worldsprout");
    assert.equal(unit(s, id).maxHp, 40, "Worldsprout has 40 max HP");
  }
  assert.equal(seedlingCount(s), 0, "no Seedling-template minions remain");
  assert.equal(skillOf(unit(s, "a1"), "gaia5").currentCd, 6, "cooldown 6");
});
