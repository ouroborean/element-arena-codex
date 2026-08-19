/**
 * Behavior tests for Syl, Scourge of the Skies — asserted against the frozen skill prose
 * (game/content/frozen/skills.json), never the implementation.
 *
 * Oracle text:
 *   syl0 Two as One (passive): "Syl begins the game with a Hatchling Eagle minion. Any time
 *        Syl and her Eagle act on the same turn, she gains Elemental Essence."
 *   syl1 Feed: "Syl heals her Eagle minion for 20 health. If her Eagle minion is at maximum
 *        life after the heal, she gains Elemental Essence."
 *   syl2 Skylance: "Deals 20 Piercing damage to one enemy."
 *   syl3 To the Skies!: "This turn, Talon Rake will stun its target for 1 turn, and Soar will
 *        last an additional turn and extend this effect. When empowered this way, Talon Rake
 *        has its cooldown increased by 1."
 *   syl4 Unbreakable Bond: "Equalizes the health between Syl and her Eagle minion"
 *   syl5 Leyline Nest: "Advances Syl's Eagle Minion to the next growth stage. This skill costs
 *        1 less [4] each turn, resetting on use."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, effectiveCost,
  performAction, startTurn, endTurn,
} from "../skillHarness.ts";
import type { MatchState, Unit } from "../../src/types.ts";

/** Syl's Eagle: the sole allied (team A) minion on the field. */
const eagleOf = (s: MatchState): Unit =>
  Object.values(s.units).find((u) => u.team === "A" && u.kind === "minion")!;

// --------------------------------------------------------------------------- //
//  syl0 — Two as One (passive)
// --------------------------------------------------------------------------- //
test("syl0 Two as One — Syl starts with a Hatchling Eagle minion", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const eagle = eagleOf(s);
  assert.ok(eagle, "an allied minion exists at round start");
  assert.equal(eagle.name, "Hatchling Eagle", "it is a Hatchling Eagle");
  assert.equal(eagle.maxHp, 60, "Hatchling Eagle has 60 max HP");
  assert.equal(eagle.team, "A", "on Syl's team");
  assert.ok(eagle.alive);
});

test("syl0 Two as One — Syl gains Elemental Essence when she AND her Eagle act the same turn", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const eagle = eagleOf(s);
  // Syl acts alone first: no same-turn pairing yet, so no Essence.
  performAction(s, { unit: "a1", skillId: "syl2", targets: ["b1"] });
  assert.equal(hasStatus(syl, "elemental_essence"), false, "Syl acting alone grants no Essence");
  // Now the Eagle also acts this same turn -> Two as One grants Syl Elemental Essence.
  performAction(s, { unit: eagle.id, skillId: "sylminion1", targets: ["b1"] });
  assert.equal(hasStatus(syl, "elemental_essence"), true, "Syl + Eagle same turn -> Essence");
});

// --------------------------------------------------------------------------- //
//  syl1 — Feed
// --------------------------------------------------------------------------- //
test("syl1 Feed — heals the Eagle 20, grants Essence only if the Eagle is at max after", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const eagle = eagleOf(s);
  eagle.hp = 40; // 40 + 20 = 60 = max
  performAction(s, { unit: "a1", skillId: "syl1", targets: [eagle.id] });
  assert.equal(eagle.hp, 60, "healed for 20 up to the Hatchling's 60 max");
  assert.equal(hasStatus(syl, "elemental_essence"), true, "at max after heal -> Essence");
  assert.equal(skillOf(syl, "syl1").currentCd, 1, "Feed goes on its 1-turn cooldown");
});

test("syl1 Feed — no Essence when the Eagle is below max after the heal", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const eagle = eagleOf(s);
  eagle.hp = 20; // 20 + 20 = 40 < 60 max
  performAction(s, { unit: "a1", skillId: "syl1", targets: [eagle.id] });
  assert.equal(eagle.hp, 40, "healed for 20");
  assert.equal(hasStatus(syl, "elemental_essence"), false, "below max after heal -> no Essence");
});

test("syl1 Feed — targets only the Eagle minion (not an ally hero)", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const eagle = eagleOf(s);
  eagle.hp = 30;
  const bad = performAction(s, { unit: "a1", skillId: "syl1", targets: ["a2"] });
  assert.equal(bad.ok, false, "Feed cannot target an ally hero");
  const good = performAction(s, { unit: "a1", skillId: "syl1", targets: [eagle.id] });
  assert.equal(good.ok, true, "Feed can target the Eagle minion");
});

// --------------------------------------------------------------------------- //
//  syl2 — Skylance
// --------------------------------------------------------------------------- //
test("syl2 Skylance — deals 20 Piercing to one enemy (bypasses Damage Reduction)", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const enemy = unit(s, "b1");
  const before = enemy.hp;
  performAction(s, { unit: "a1", skillId: "syl2", targets: ["b1"] });
  assert.equal(before - enemy.hp, 20, "20 damage dealt");
  assert.equal(skillOf(syl, "syl2").currentCd, 1, "Skylance goes on its 1-turn cooldown");

  // Piercing bypasses flat Damage Reduction: a DR'd enemy still takes the full 20.
  const s2 = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const drEnemy = unit(s2, "b1");
  drEnemy.statuses.push({ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "b1", appliedTurn: 0 });
  const hp0 = drEnemy.hp;
  performAction(s2, { unit: "a1", skillId: "syl2", targets: ["b1"] });
  assert.equal(hp0 - drEnemy.hp, 20, "Piercing ignores the 10 DR -> full 20");
});

// --------------------------------------------------------------------------- //
//  syl3 — To the Skies!
// --------------------------------------------------------------------------- //
test("syl3 To the Skies! — empowers Talon Rake: +1-turn stun and +1 cooldown this turn", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const eagle = eagleOf(s);
  const enemy = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "syl3" }); // self-targeted empowerment onto the Eagle
  assert.equal(skillOf(syl, "syl3").currentCd, 2, "To the Skies! goes on its 2-turn cooldown");

  const hp0 = enemy.hp;
  performAction(s, { unit: eagle.id, skillId: "sylminion1", targets: ["b1"] });
  assert.equal(hp0 - enemy.hp, 15, "Talon Rake still deals its 15 Piercing");
  assert.equal(hasStatus(enemy, "stun"), true, "empowered Talon Rake stuns the target");
  assert.equal(skillOf(eagle, "sylminion1").currentCd, 1, "empowered Talon Rake's cooldown is increased by 1");
});

test("syl3 To the Skies! — base Talon Rake (unempowered) does not stun and stays off cooldown", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const eagle = eagleOf(s);
  const enemy = unit(s, "b1");
  const hp0 = enemy.hp;
  performAction(s, { unit: eagle.id, skillId: "sylminion1", targets: ["b1"] });
  assert.equal(hp0 - enemy.hp, 15, "15 Piercing");
  assert.equal(hasStatus(enemy, "stun"), false, "no stun without To the Skies!");
  assert.equal(skillOf(eagle, "sylminion1").currentCd, 0, "Talon Rake stays at 0 cooldown");
});

test("syl3 To the Skies! — Soar lasts an additional turn (invulnerable 2) and extends the empowerment", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  // Evolve the Eagle Hatchling -> Adult -> Ancient so it has Soar (cooldown reset is test setup only).
  performAction(s, { unit: "a1", skillId: "syl5" });
  skillOf(syl, "syl5").currentCd = 0;
  performAction(s, { unit: "a1", skillId: "syl5" });
  const eagle = eagleOf(s);
  assert.equal(eagle.name, "Ancient Eagle", "Eagle reached its final stage");

  performAction(s, { unit: "a1", skillId: "syl3" }); // empower
  performAction(s, { unit: eagle.id, skillId: "sylminion3" }); // Soar
  const invSyl = syl.statuses.find((x) => x.kind === "invulnerable");
  const invEagle = eagle.statuses.find((x) => x.kind === "invulnerable");
  assert.equal(invSyl?.duration, 2, "empowered Soar makes Syl invulnerable for the extra turn (2)");
  assert.equal(invEagle?.duration, 2, "empowered Soar makes the Eagle invulnerable for 2 turns");
  assert.ok(eagle.statuses.some((x) => x.kind === "mark" && x.name === "To the Skies"),
    "Soar re-applies the To the Skies empowerment to extend it");
});

test("syl3 To the Skies! — base Soar (unempowered) is only 1 turn of invulnerability", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "syl5" });
  skillOf(syl, "syl5").currentCd = 0;
  performAction(s, { unit: "a1", skillId: "syl5" });
  const eagle = eagleOf(s);
  performAction(s, { unit: eagle.id, skillId: "sylminion3" }); // Soar, no empowerment
  const invEagle = eagle.statuses.find((x) => x.kind === "invulnerable");
  assert.equal(invEagle?.duration, 1, "base Soar is 1-turn invulnerability");
});

// --------------------------------------------------------------------------- //
//  syl4 — Unbreakable Bond
// --------------------------------------------------------------------------- //
test("syl4 Unbreakable Bond — equalizes HP between Syl and her Eagle (their average)", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const eagle = eagleOf(s);
  syl.hp = 50;
  eagle.hp = 30;
  performAction(s, { unit: "a1", skillId: "syl4" });
  assert.equal(syl.hp, 40, "Syl set to the average (50+30)/2 = 40");
  assert.equal(eagle.hp, 40, "Eagle set to the same average = 40");
  assert.equal(skillOf(syl, "syl4").currentCd, 1, "Unbreakable Bond goes on its 1-turn cooldown");
});

// --------------------------------------------------------------------------- //
//  syl5 — Leyline Nest
// --------------------------------------------------------------------------- //
test("syl5 Leyline Nest — advances the Eagle to its next growth stage", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const eagle = eagleOf(s);
  assert.equal(eagle.name, "Hatchling Eagle", "starts as a Hatchling");
  performAction(s, { unit: "a1", skillId: "syl5" });
  const after = eagleOf(s);
  assert.equal(after.name, "Adult Eagle", "advanced to the Adult stage");
  assert.equal(after.maxHp, 80, "Adult Eagle has 80 max HP");
});

test("syl5 Leyline Nest — specific cost decreases by 1 each turn and resets to 4 on use", () => {
  const s = battle(["syl", "taryn", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const syl = unit(s, "a1");
  const leyline = skillOf(syl, "syl5");
  assert.equal(effectiveCost(syl, leyline).specific, 4, "base specific cost is 4");
  startTurn(s); // one of Syl's turns -> cost drops by 1
  assert.equal(effectiveCost(syl, skillOf(syl, "syl5")).specific, 3, "1 less after a turn");
  startTurn(s); // another turn -> drops again
  assert.equal(effectiveCost(syl, skillOf(syl, "syl5")).specific, 2, "1 less each turn");
  performAction(s, { unit: "a1", skillId: "syl5" }); // using it resets the cost
  assert.equal(effectiveCost(syl, skillOf(syl, "syl5")).specific, 4, "resets to 4 on use");
});
