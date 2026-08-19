/**
 * Behavior tests for Gommar, Frostfang Chieftain — asserted against the frozen skill prose
 * (game/content/frozen/skills.json). Base kit: gommar0 (passive) + gommar1..gommar5.
 *
 * Oracle text:
 *  gommar0 Frost-Covered: "At the start of each round, Gommar gains Frost-Covered, enhancing his skills.
 *                          If Gommar damages an enemy with reduced damage, he gains Elemental Essence."
 *  gommar1 Iceblood Hammer: "Deals 20 damage to one enemy and lower their damage by 5 for 3 turns.
 *                            If Gommar is Frost-Covered, he then deals 10 damage to the enemy team."
 *  gommar2 Foot of the Mountain: "Deals 20 damage to the enemy team. If Gommar is Frost-Covered,
 *                                 enemies have their strategic skills stunned for 1 turn."
 *  gommar3 Breath of the North: "Deals 25 damage to one enemy and lowers their damage by 5 until the end
 *                                of Gommar's next turn. If Gommar is Frost-Covered, this skill cannot be
 *                                countered and deals Piercing damage."
 *  gommar4 Ice Body: "Makes Gommar invulnerable to non-strategic skills for 1 turn and regains
 *                     Frost-Covered. If he was already Frost-Covered, he gains Elemental Essence."
 *  gommar5 Absolute Zero: "All enemies and allies have their non-Strategic skills stunned for 1 turn.
 *                          If Gommar is not Frost-Covered, he is also stunned."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, shieldTotal, canUse, performAction, startTurn, endTurn } from "../skillHarness.ts";
import { status } from "../helpers.ts";

const FROST = (u: any) => hasStatus(u, "mark", "Frost-Covered");
const stripFrost = (u: any) => { u.statuses = u.statuses.filter((x: any) => !(x.kind === "mark" && x.name === "Frost-Covered")); };
const A = ["gommar", "pyrrha", "jarrik"];
const B = ["keeper", "saya", "laria"];
const stun = (u: any) => u.statuses.find((x: any) => x.kind === "stun");
const stuns = (u: any) => u.statuses.filter((x: any) => x.kind === "stun");
const odm = (u: any) => u.statuses.find((x: any) => x.kind === "outgoing_damage_mod");

// ---------------------------------------------------------------- passive

test("gommar0 — gains Frost-Covered at the start of the round", () => {
  const s = battle(A, B);
  assert.ok(FROST(unit(s, "a1")), "Gommar starts the round Frost-Covered");
});

test("gommar0 — damaging an enemy with reduced damage grants Elemental Essence", () => {
  const s = battle(A, B);
  const g = unit(s, "a1");
  // Enemy already carries reduced (negative outgoing) damage.
  unit(s, "b1").statuses.push(status("outgoing_damage_mod", { magnitude: -5, duration: 3 }));
  assert.equal(hasStatus(g, "elemental_essence"), false, "no essence before the hit");
  performAction(s, { unit: "a1", skillId: "gommar3", targets: ["b1"] });
  assert.ok(hasStatus(g, "elemental_essence"), "essence gained from hitting a reduced-damage enemy");
});

test("gommar0 — damaging an enemy WITHOUT reduced damage grants no Essence", () => {
  const s = battle(A, B);
  const g = unit(s, "a1");
  // b1 is fresh; gommar3 applies its own -5 AFTER dealing damage, so at damage-time it is not yet reduced.
  performAction(s, { unit: "a1", skillId: "gommar3", targets: ["b1"] });
  assert.equal(hasStatus(g, "elemental_essence"), false, "no essence when the target was not already reduced");
});

// ---------------------------------------------------------------- gommar1 Iceblood Hammer

test("gommar1 — 20 damage + lower target damage 5/3t, and Frost-Covered adds 10 to the enemy team", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gommar1", targets: ["b1"] });
  // Frost-Covered branch: target eats 20 + 10 AOE = 30; the other enemies eat 10 each.
  assert.equal(unit(s, "b1").hp, 70, "target takes 20 + 10 (Frost-Covered team hit)");
  assert.equal(unit(s, "b2").hp, 90, "other enemy takes the 10 team hit");
  assert.equal(unit(s, "b3").hp, 90, "other enemy takes the 10 team hit");
  const m = odm(unit(s, "b1"));
  assert.ok(m && m.magnitude === -5, "target's damage lowered by 5");
  assert.equal(m!.duration, 3, "for 3 turns");
});

test("gommar1 — without Frost-Covered there is no 10-damage team hit", () => {
  const s = battle(A, B);
  stripFrost(unit(s, "a1"));
  performAction(s, { unit: "a1", skillId: "gommar1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "only the 20 single-target hit");
  assert.equal(unit(s, "b2").hp, 100, "no team hit while not Frost-Covered");
  assert.equal(unit(s, "b3").hp, 100, "no team hit while not Frost-Covered");
});

test("gommar1 — consumes Frost-Covered and goes on a 1-turn cooldown", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gommar1", targets: ["b1"] });
  assert.equal(FROST(unit(s, "a1")), false, "Frost-Covered consumed by the cast");
  assert.equal(skillOf(unit(s, "a1"), "gommar1").currentCd, 1, "cooldown 1");
});

// ---------------------------------------------------------------- gommar2 Foot of the Mountain

test("gommar2 — 20 to the whole enemy team; Frost-Covered stuns enemy Strategic skills 1t", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gommar2" });
  for (const id of ["b1", "b2", "b3"]) assert.equal(unit(s, id).hp, 80, `${id} takes 20`);
  for (const id of ["b1", "b2", "b3"]) {
    const st = stun(unit(s, id));
    assert.ok(st, `${id} is stunned`);
    assert.equal(st!.scope?.tag, "Strategic", "stun keys on Strategic");
    assert.equal(st!.scope?.mode, "only", "stuns ONLY Strategic skills");
    assert.equal(st!.duration, 1, "for 1 turn");
  }
});

test("gommar2 — without Frost-Covered deals damage but applies no stun", () => {
  const s = battle(A, B);
  stripFrost(unit(s, "a1"));
  performAction(s, { unit: "a1", skillId: "gommar2" });
  assert.equal(unit(s, "b1").hp, 80, "still deals 20 team damage");
  assert.equal(stun(unit(s, "b1")), undefined, "no stun without Frost-Covered");
});

// ---------------------------------------------------------------- gommar3 Breath of the North

test("gommar3 — 25 damage + lower target damage 5 until end of Gommar's next turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gommar3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 75, "25 damage");
  const m = odm(unit(s, "b1"));
  assert.ok(m && m.magnitude === -5, "damage lowered by 5");
  assert.equal(m!.duration, 1, "until end of Gommar's next turn (duration 1)");
});

test("gommar3 — Frost-Covered makes the hit Piercing (ignores Damage Reduction)", () => {
  const s = battle(A, B);
  unit(s, "b1").statuses.push(status("damage_reduction", { magnitude: 10, duration: null }));
  performAction(s, { unit: "a1", skillId: "gommar3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 75, "Piercing bypasses the 10 DR: full 25 lands");
});

test("gommar3 — without Frost-Covered the hit is normal (reduced by Damage Reduction)", () => {
  const s = battle(A, B);
  stripFrost(unit(s, "a1"));
  unit(s, "b1").statuses.push(status("damage_reduction", { magnitude: 10, duration: null }));
  performAction(s, { unit: "a1", skillId: "gommar3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "normal damage is reduced by DR (25-10)");
});

// ---------------------------------------------------------------- gommar4 Ice Body

test("gommar4 — invulnerable 1t, regains Frost-Covered, cooldown 3", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gommar4" });
  const g = unit(s, "a1");
  const inv = g.statuses.find((x: any) => x.kind === "invulnerable");
  assert.ok(inv, "Gommar becomes invulnerable");
  assert.equal(inv!.duration, 1, "for 1 turn");
  assert.ok(FROST(g), "regains Frost-Covered");
  assert.equal(skillOf(g, "gommar4").currentCd, 3, "cooldown 3");
});

test("gommar4 — gains Essence when he was ALREADY Frost-Covered", () => {
  const s = battle(A, B); // fresh round: already Frost-Covered
  performAction(s, { unit: "a1", skillId: "gommar4" });
  assert.ok(hasStatus(unit(s, "a1"), "elemental_essence"), "already Frost-Covered -> Essence");
});

test("gommar4 — no Essence when he was NOT Frost-Covered, but still regains it", () => {
  const s = battle(A, B);
  stripFrost(unit(s, "a1"));
  performAction(s, { unit: "a1", skillId: "gommar4" });
  const g = unit(s, "a1");
  assert.equal(hasStatus(g, "elemental_essence"), false, "no Essence when he lacked Frost-Covered");
  assert.ok(FROST(g), "still regains Frost-Covered");
});

// ---------------------------------------------------------------- gommar5 Absolute Zero

test("gommar5 — stuns non-Strategic skills of ALL enemies and allies for 1 turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "gommar5" });
  for (const id of ["a1", "a2", "a3", "b1", "b2", "b3"]) {
    const st = stun(unit(s, id));
    assert.ok(st, `${id} has a stun`);
    assert.equal(st!.scope?.tag, "Strategic", "keyed on Strategic");
    assert.equal(st!.scope?.mode, "except", "stuns all-but-Strategic (non-Strategic) skills");
    assert.equal(st!.duration, 1, "1 turn");
  }
  assert.equal(skillOf(unit(s, "a1"), "gommar5").currentCd, 5, "cooldown 5");
});

test("gommar5 — while Frost-Covered only non-Strategic skills are stunned (Strategic stay usable)", () => {
  const s = battle(A, B); // Frost-Covered
  const g = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "gommar5" });
  // The scoped (except-Strategic) stun leaves his Strategic Ice Body usable.
  assert.ok(canUse(s, g, skillOf(g, "gommar4")), "Strategic skill still usable while Frost-Covered");
});

test("gommar5 — when NOT Frost-Covered Gommar is ALSO stunned (Strategic skills blocked too)", () => {
  const s = battle(A, B);
  stripFrost(unit(s, "a1"));
  const g = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "gommar5" });
  // "he is also stunned" => a full stun, so even his Strategic Ice Body is unusable.
  assert.equal(canUse(s, g, skillOf(g, "gommar4")), false, "not Frost-Covered => also fully stunned");
});
