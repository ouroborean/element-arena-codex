/**
 * Behavior tests for Xyris, King of Dreams, against the frozen skill prose (the oracle). Assertions
 * target the described behavior, never the implementation. A clean assertion failure here is a
 * reported bug (kept asserting the correct prose behavior, never weakened to pass).
 *
 * Oracle (game/content/frozen/skills.json):
 *  xyris0 Dream Body (passive): "Whenever this Hero is the sole target of a skill, he gains
 *    Elemental Essence."
 *  xyris1 Reveal Hidden Truth: "Xyris deals 15 damage to target enemy and Taunts them for 1 turn."
 *  xyris2 Enter the Dreamscape: "Xyris deals 20 damage to target enemy and stuns their helpful
 *    skills for 2 turns. While active, Xyris gains Elemental Essence each turn."
 *  xyris3 Twisted Nightmares: "Xyris deals 20 damage to target enemy. For 1 turn, their AOE skills
 *    become single-target."
 *  xyris4 Somnic Apparition: "Xyris counters the next Harmful skill used by target enemy for 1 turn.
 *    If countered this way, Xyris creates a Dream Reflection minion (HP:35) with a copy of the
 *    countered skill (its Specific costs change to Xyris' current Element.) This effect is invisible."
 *  xyris5 Echoes of Desire: "The next skill used by target ally will occur twice. Cannot target Xyris."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, canUse, performAction } from "../skillHarness.ts";
import type { Unit } from "../../src/types.ts";

const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const statusOf = (u: Unit, kind: string, name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const minions = (s: ReturnType<typeof battle>, team: string) =>
  Object.values(s.units).filter((u) => u.kind === "minion" && u.team === team);

// --------------------------------------------------------------------------- //
//  xyris0 — Dream Body (passive)
// --------------------------------------------------------------------------- //
test("Dream Body — being the sole target of a skill grants Xyris Elemental Essence", () => {
  const s = battle(["xyris", "gommar", "syl"], ["ando", "laria", "riverdaughter"]);
  const x = unit(s, "a1");
  assert.equal(essenceCount(x), 0, "Xyris (slot 0) starts with no Essence charge");
  // b1 casts a single-target skill on Xyris alone -> he is the sole target.
  performAction(s, { unit: "b1", skillId: "ando1", targets: ["a1"] });
  assert.equal(essenceCount(x), 1, "sole target of a skill -> gains one Elemental Essence");
});

test("Dream Body — NOT triggered when the skill hits multiple units (not a sole target)", () => {
  const s = battle(["xyris", "gommar", "syl"], ["ando", "laria", "riverdaughter"]);
  const x = unit(s, "a1");
  // b3 = River Daughter's Ripple hits the whole enemy team (a1, a2, a3) -> Xyris is not a SOLE target.
  performAction(s, { unit: "b3", skillId: "riverdaughter1" });
  assert.equal(essenceCount(x), 0, "an AOE that also hits allies is not a sole-target trigger");
});

// --------------------------------------------------------------------------- //
//  xyris1 — Reveal Hidden Truth
// --------------------------------------------------------------------------- //
test("Reveal Hidden Truth — 15 damage to target enemy and Taunts them for 1 turn (cooldown 1)", () => {
  const s = battle(["xyris", "gommar", "syl"], ["laria", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "xyris1", targets: ["b1"] });
  const b1 = unit(s, "b1");
  assert.equal(b1.hp, 85, "15 damage");
  const taunt = statusOf(b1, "taunt");
  assert.ok(taunt, "target is Taunted");
  assert.equal(taunt!.duration, 1, "Taunt lasts 1 turn");
  assert.equal(taunt!.unitRef, "a1", "Taunt forces the target onto Xyris");
  assert.equal(skillOf(unit(s, "a1"), "xyris1").currentCd, 1, "cooldown 1");
});

// --------------------------------------------------------------------------- //
//  xyris2 — Enter the Dreamscape
// --------------------------------------------------------------------------- //
test("Enter the Dreamscape — 20 damage, stuns the target's Helpful skills for 2 turns, Xyris gains Essence (cooldown 3)", () => {
  const s = battle(["xyris", "gommar", "syl"], ["laria", "ando", "riverdaughter"]);
  const x = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "xyris2", targets: ["b1"] });
  const b1 = unit(s, "b1");
  assert.equal(b1.hp, 80, "20 damage");
  const stun = statusOf(b1, "stun");
  assert.ok(stun, "target is stunned");
  assert.equal(stun!.duration, 2, "stun lasts 2 turns");
  assert.deepEqual(stun!.scope, { tag: "Helpful", mode: "only" }, "stun applies ONLY to Helpful skills");
  assert.equal(essenceCount(x), 1, "Xyris gains Elemental Essence while active");
  assert.equal(skillOf(x, "xyris2").currentCd, 3, "cooldown 3");
});

// --------------------------------------------------------------------------- //
//  xyris3 — Twisted Nightmares
// --------------------------------------------------------------------------- //
test("Twisted Nightmares — 20 damage to target enemy and marks it (cooldown 1)", () => {
  const s = battle(["xyris", "gommar", "syl"], ["riverdaughter", "ando", "laria"]);
  performAction(s, { unit: "a1", skillId: "xyris3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "20 damage");
  assert.equal(skillOf(unit(s, "a1"), "xyris3").currentCd, 1, "cooldown 1");
});

test("Twisted Nightmares — for 1 turn the target's AOE skills become single-target", () => {
  const s = battle(["xyris", "gommar", "syl"], ["riverdaughter", "ando", "laria"]);
  performAction(s, { unit: "a1", skillId: "xyris3", targets: ["b1"] });
  // b1 = River Daughter, whose Ripple normally hits the whole enemy team. Under Twisted
  // Nightmares it must strike only a single one of Xyris's allies.
  performAction(s, { unit: "b1", skillId: "riverdaughter1" });
  const damaged = ["a1", "a2", "a3"].filter((id) => unit(s, id).hp < 100);
  assert.equal(damaged.length, 1, "the marked enemy's AOE is reduced to a single target");
});

// --------------------------------------------------------------------------- //
//  xyris4 — Somnic Apparition
// --------------------------------------------------------------------------- //
test("Somnic Apparition — marks the target enemy (cooldown 2)", () => {
  const s = battle(["xyris", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "xyris4", targets: ["b1"] });
  assert.ok(statusOf(unit(s, "b1"), "mark", "Somnic Watch"), "the target enemy is watched for the counter");
  assert.equal(skillOf(unit(s, "a1"), "xyris4").currentCd, 2, "cooldown 2");
});

test("Somnic Apparition — counters the target's next Harmful skill and creates a 35-HP Dream Reflection", () => {
  const s = battle(["xyris", "gommar", "syl"], ["gommar", "ando", "riverdaughter"]);
  performAction(s, { unit: "a1", skillId: "xyris4", targets: ["b1"] });
  const reflections = () => minions(s, "A").filter((m) => m.name === "Dream Reflection");
  assert.equal(reflections().length, 0, "no Dream Reflection before the counter");
  const res = performAction(s, { unit: "b1", skillId: "gommar1", targets: ["a2"] });
  assert.equal(res.countered, true, "the watched enemy's Harmful skill is countered");
  assert.equal(unit(s, "a2").hp, 100, "the countered skill's effects do not land");
  const created = reflections();
  assert.equal(created.length, 1, "a Dream Reflection minion is created");
  assert.equal(created[0].hp, 35, "the Dream Reflection has 35 HP");
});

// --------------------------------------------------------------------------- //
//  xyris5 — Echoes of Desire
// --------------------------------------------------------------------------- //
test("Echoes of Desire — the target ally's next skill occurs twice (cooldown 3)", () => {
  const s = battle(["xyris", "ando", "syl"], ["laria", "gommar", "riverdaughter"]);
  const res = performAction(s, { unit: "a1", skillId: "xyris5", targets: ["a2"] });
  assert.equal(res.ok, true, "can target an ally");
  assert.ok(statusOf(unit(s, "a2"), "mark", "Echoes of Desire"), "the ally is marked");
  assert.equal(skillOf(unit(s, "a1"), "xyris5").currentCd, 3, "cooldown 3");
  // a2's Electroblade normally deals 15; occurring twice it deals 30.
  performAction(s, { unit: "a2", skillId: "ando1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 70, "the ally's next skill (15 dmg) occurs twice -> 30 total");
  assert.equal(hasStatus(unit(s, "a2"), "mark", "Echoes of Desire"), false, "the one-shot mark is consumed");
});

test("Echoes of Desire — cannot target Xyris himself", () => {
  const s = battle(["xyris", "ando", "syl"], ["laria", "gommar", "riverdaughter"]);
  const res = performAction(s, { unit: "a1", skillId: "xyris5", targets: ["a1"] });
  assert.equal(res.ok, false, "Echoes of Desire cannot be cast on Xyris");
});
