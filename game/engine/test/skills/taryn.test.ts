/**
 * Behavior tests for Taryn, Hand of Glory — asserted against the frozen skill prose
 * (game/content/frozen/skills.json), never the implementation.
 *
 * Oracle text:
 *   taryn0 Protector of the Song (passive): "When Taryn has an ability reflected to him, he
 *          gains 10 DR for 1 turn and Elemental Essence."
 *   taryn1 Banner of Harmony: "Deals 15 damage to target enemy. For 1 turns, any Harmful skill
 *          used by the target is reflected to Taryn."
 *   taryn2 Refrain: "Targets one enemy or ally. If used on an enemy, stuns their harmful skills
 *          for 1 turn. If used on an ally, they are healed for 15 health whenever they use a
 *          skill for 2 turns."
 *   taryn3 Inspiring Thrust: "Deals 20 damage to target enemy. This turn, any ally who uses a
 *          new harmful skill on the target will gain Elemental Essence."
 *   taryn4 Stalwart Shield: "May target Taryn or an ally. Grants Taryn 20 Shield, and if used on
 *          an ally, reflects all harmful skills from the target to himself. This skill's target
 *          is invisible."
 *   taryn5 Radiant Glory: "For 3 turns, using Stalwart Shield and Inspiring Thrust will also use
 *          Refrain on the target."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, shieldTotal, canUse,
  performAction,
} from "../skillHarness.ts";

const TEAM_B = ["riverdaughter", "laria", "xyris"];

// --------------------------------------------------------------------------- //
//  taryn0 — Protector of the Song (passive)
// --------------------------------------------------------------------------- //
test("taryn0 Protector of the Song — a reflected skill grants Taryn 10 DR (1 turn) + Essence", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const taryn = unit(s, "a1");
  // Banner-mark the enemy so its Harmful skill reflects back to Taryn.
  performAction(s, { unit: "a1", skillId: "taryn1", targets: ["b1"] });
  // The marked enemy attacks Taryn's ally; the skill is reflected onto Taryn.
  performAction(s, { unit: "b1", skillId: "riverdaughter2", targets: ["a2"] });

  const dr = taryn.statuses.find((x) => x.kind === "damage_reduction");
  assert.ok(dr, "Taryn gains Damage Reduction from the reflect");
  assert.equal(dr.magnitude, 10, "10 DR");
  assert.equal(dr.duration, 1, "for 1 turn");
  assert.equal(hasStatus(taryn, "elemental_essence"), true, "and Elemental Essence");
});

// --------------------------------------------------------------------------- //
//  taryn1 — Banner of Harmony
// --------------------------------------------------------------------------- //
test("taryn1 Banner of Harmony — deals 15 damage and goes on a 1-turn cooldown", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const taryn = unit(s, "a1");
  const enemy = unit(s, "b1");
  const hp0 = enemy.hp;
  performAction(s, { unit: "a1", skillId: "taryn1", targets: ["b1"] });
  assert.equal(hp0 - enemy.hp, 15, "15 damage to the target");
  assert.equal(skillOf(taryn, "taryn1").currentCd, 1, "1-turn cooldown");
});

test("taryn1 Banner of Harmony — the target's Harmful skill is reflected to Taryn", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const taryn = unit(s, "a1");
  const ally = unit(s, "a2");
  ally.hp = 100;
  taryn.hp = 100;
  performAction(s, { unit: "a1", skillId: "taryn1", targets: ["b1"] });
  const tarynHp = taryn.hp;
  // The marked enemy tries to hit the ally; reflection pulls the hit onto Taryn instead.
  performAction(s, { unit: "b1", skillId: "riverdaughter2", targets: ["a2"] });
  assert.equal(ally.hp, 100, "the intended ally target takes no damage");
  assert.ok(taryn.hp < tarynHp, "Taryn receives the reflected harmful skill instead");
});

// --------------------------------------------------------------------------- //
//  taryn2 — Refrain
// --------------------------------------------------------------------------- //
test("taryn2 Refrain — on an enemy: stuns their Harmful skills for 1 turn (Helpful still usable)", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const laria = unit(s, "b2"); // laria2 is a pure Helpful skill; laria3 is Harmful
  performAction(s, { unit: "a1", skillId: "taryn2", targets: ["b2"] });
  const stun = laria.statuses.find((x) => x.kind === "stun");
  assert.ok(stun, "the enemy is stunned");
  assert.equal(stun.scope?.tag, "Harmful", "the stun is scoped to Harmful skills");
  assert.equal(stun.scope?.mode, "only", "it stops only Harmful skills");
  assert.equal(canUse(s, laria, skillOf(laria, "laria3")), false, "a Harmful skill is blocked");
  assert.equal(canUse(s, laria, skillOf(laria, "laria2")), true, "a Helpful skill is still usable");
});

test("taryn2 Refrain — on an ally: heals them 15 whenever they use a skill (for 2 turns)", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const ally = unit(s, "a2"); // syl
  ally.hp = 50;
  performAction(s, { unit: "a1", skillId: "taryn2", targets: ["a2"] });
  assert.ok(ally.statuses.some((x) => x.kind === "mark" && x.name === "Refrain"), "ally gets the Refrain mark");
  // The ally uses a skill -> Refrain heals them 15.
  performAction(s, { unit: "a2", skillId: "syl2", targets: ["b1"] });
  assert.equal(ally.hp, 65, "healed 15 on using a skill");
});

// --------------------------------------------------------------------------- //
//  taryn3 — Inspiring Thrust
// --------------------------------------------------------------------------- //
test("taryn3 Inspiring Thrust — deals 20 damage to the target", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const enemy = unit(s, "b1");
  const hp0 = enemy.hp;
  performAction(s, { unit: "a1", skillId: "taryn3", targets: ["b1"] });
  assert.equal(hp0 - enemy.hp, 20, "20 damage");
  assert.equal(skillOf(unit(s, "a1"), "taryn3").currentCd, 0, "no cooldown");
});

test("taryn3 Inspiring Thrust — an ally hitting the marked target with a new Harmful skill gains Essence", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const ally = unit(s, "a2"); // syl
  performAction(s, { unit: "a1", skillId: "taryn3", targets: ["b1"] }); // marks b1 this turn
  performAction(s, { unit: "a2", skillId: "syl2", targets: ["b1"] });   // ally attacks the marked enemy
  assert.equal(hasStatus(ally, "elemental_essence"), true, "the assisting ally gains Elemental Essence");
});

test("taryn3 Inspiring Thrust — an ally attacking a DIFFERENT (unmarked) enemy gains no Essence", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const ally = unit(s, "a2");
  performAction(s, { unit: "a1", skillId: "taryn3", targets: ["b1"] }); // marks b1
  performAction(s, { unit: "a2", skillId: "syl2", targets: ["b2"] });   // hits an unmarked enemy
  assert.equal(hasStatus(ally, "elemental_essence"), false, "no Essence when the target is not the marked one");
});

// --------------------------------------------------------------------------- //
//  taryn4 — Stalwart Shield
// --------------------------------------------------------------------------- //
test("taryn4 Stalwart Shield — grants Taryn 20 Shield and goes on a 4-turn cooldown", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const taryn = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "taryn4", targets: ["a1"] });
  assert.equal(shieldTotal(taryn), 20, "Taryn gains 20 Shield");
  assert.equal(skillOf(taryn, "taryn4").currentCd, 4, "4-turn cooldown");
});

test("taryn4 Stalwart Shield — used on an ally, reflects the ally's incoming harmful skills to Taryn", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const taryn = unit(s, "a1");
  const ally = unit(s, "a2");
  ally.hp = 100;
  performAction(s, { unit: "a1", skillId: "taryn4", targets: ["a2"] });
  assert.equal(shieldTotal(taryn), 20, "Taryn still gains 20 Shield when shielding an ally");
  // An enemy hits the protected ally; the hit is reflected onto Taryn and absorbed by his Shield.
  performAction(s, { unit: "b1", skillId: "riverdaughter2", targets: ["a2"] });
  assert.equal(ally.hp, 100, "the protected ally takes no damage");
  assert.ok(shieldTotal(taryn) < 20, "the reflected hit lands on Taryn (absorbed by his Shield)");
});

// --------------------------------------------------------------------------- //
//  taryn5 — Radiant Glory
// --------------------------------------------------------------------------- //
test("taryn5 Radiant Glory — while active, Inspiring Thrust also casts Refrain on the target", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const taryn = unit(s, "a1");
  const enemy = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "taryn5" });
  assert.ok(taryn.statuses.some((x) => x.kind === "mark" && x.name === "Radiant Glory"), "Radiant Glory is active");
  const hp0 = enemy.hp;
  performAction(s, { unit: "a1", skillId: "taryn3", targets: ["b1"] });
  assert.equal(hp0 - enemy.hp, 20, "Inspiring Thrust still deals its 20 damage");
  // The piggy-backed Refrain (enemy branch) stuns the target's Harmful skills.
  assert.ok(enemy.statuses.some((x) => x.kind === "stun"), "Refrain is also used on the target (Harmful-scoped stun)");
});

test("taryn5 Radiant Glory — while active, Stalwart Shield also casts Refrain on the ally target", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const ally = unit(s, "a2");
  performAction(s, { unit: "a1", skillId: "taryn5" });
  performAction(s, { unit: "a1", skillId: "taryn4", targets: ["a2"] });
  assert.ok(ally.statuses.some((x) => x.kind === "mark" && x.name === "Refrain"),
    "the ally also receives Refrain's ally-branch mark");
});

test("taryn5 Radiant Glory — without it, Inspiring Thrust does NOT piggy-back Refrain", () => {
  const s = battle(["taryn", "syl", "gommar"], TEAM_B);
  const enemy = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "taryn3", targets: ["b1"] });
  assert.equal(enemy.statuses.some((x) => x.kind === "stun"), false, "no auto-Refrain stun without Radiant Glory");
});
