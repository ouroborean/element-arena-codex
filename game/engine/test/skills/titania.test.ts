/**
 * Behavior tests for Titania, Laughing Princess, asserted against the frozen skill prose (the oracle):
 *
 *   titania0 Whimsy         — "Titania's skills do not trigger effects with their use or damage."
 *                             (Realized as a permanent Stealth aura — a stealthed actor's skills do not
 *                             fire enemy reactive triggers — re-applied at round start.)
 *   titania1 Thorn Prick    — "Deals 10 damage to one enemy and 5 affliction damage permanently."
 *   titania2 Laughing Powder— "Target enemy has their strategic skills stunned for 2 turns and takes 5
 *                             affliction damage per turn. Anyone who uses a new skill on that character is
 *                             afflicted by Laughing Powder for 2 turns."
 *   titania3 Barbed Wit     — "Titania taunts target enemy for 3 turns. This effect will end if they use a
 *                             new harmful skill on Titania."
 *   titania4 Prance         — "Titania gains Elemental Essence. For one turn, the first unit to use a new
 *                             skill on Titania gains Elemental Essence."
 *   titania5 Summer Clique  — "For each time Titania has gained or given Elemental Essence with Prance this
 *                             game, she creates a Summer Courtesan minion. Stacks will reset on use."
 *   (minion) titaniaminion1 Curry Favor — "Heals Titania for 15 HP."
 *   (minion) titaniaminion2 Diving Slash — "Deals 10 Piercing damage to target enemy."
 *
 * Titania sits at a1 (poison element, in the flush pool); a2/a3 are allies, b1/b2/b3 the enemies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, performAction, canUse, startTurn, endTurn } from "../skillHarness.ts";

const A: [string, string, string] = ["titania", "gommar", "gommar"];
const B: [string, string, string] = ["riverdaughter", "laria", "xyris"];

const T = (s: ReturnType<typeof battle>) => unit(s, "a1");
const essence = (u: ReturnType<typeof unit>) => u.statuses.some((x) => x.kind === "elemental_essence");
const dotNamed = (u: ReturnType<typeof unit>, name: string) =>
  u.statuses.find((x) => x.kind === "dot" && x.name === name);
const findByName = (s: ReturnType<typeof battle>, name: string) =>
  Object.values(s.units).filter((u) => u.name === name);

// --------------------------------------------------------------------------- //
//  titania0 — Whimsy (passive)
// --------------------------------------------------------------------------- //

test("Whimsy — Titania carries the permanent Stealth aura (skills don't trigger effects) from round start", () => {
  const s = battle(A, B);
  const stealth = T(s).statuses.filter((x) => x.kind === "stealth");
  assert.equal(stealth.length, 1, "exactly one Stealth aura");
  assert.equal(stealth[0]!.duration, null, "permanent (round-scoped) — duration null");
});

// --------------------------------------------------------------------------- //
//  titania1 — Thorn Prick
// --------------------------------------------------------------------------- //

test("Thorn Prick — deals 10 immediate damage to one enemy and applies a permanent 5 affliction DoT", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 immediate damage");
  const dot = dotNamed(unit(s, "b1"), "Thorn Prick");
  assert.ok(dot, "a Thorn Prick DoT is applied");
  assert.equal(dot!.magnitude, 5, "5 per tick");
  assert.equal(dot!.dtype, "affliction", "affliction damage");
  assert.equal(dot!.duration, null, "'permanently' -> duration null (round-scoped)");
});

test("Thorn Prick — the permanent 5 affliction damage ticks on Titania's following turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "after the immediate hit");
  // Advance one full round-robin back to Titania's (team A) next turn end, when her DoTs tick.
  endTurn(s); // A -> B
  startTurn(s);
  endTurn(s); // B -> A
  startTurn(s);
  endTurn(s); // A ticks Titania's DoTs
  assert.equal(unit(s, "b1").hp, 85, "one more 5 affliction tick from the permanent Thorn Prick DoT");
});

// --------------------------------------------------------------------------- //
//  titania2 — Laughing Powder
// --------------------------------------------------------------------------- //

test("Laughing Powder — stuns the target's Strategic skills for 2 turns and applies a 5 affliction DoT for 2 turns", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania2", targets: ["b1"] });
  const stun = unit(s, "b1").statuses.find((x) => x.kind === "stun");
  assert.ok(stun, "a stun is applied");
  assert.deepEqual(stun!.scope, { tag: "Strategic", mode: "only" }, "Strategic-only stun");
  assert.equal(stun!.duration, 2, "for 2 turns");
  const dot = dotNamed(unit(s, "b1"), "Laughing Powder");
  assert.ok(dot, "Laughing Powder DoT applied");
  assert.equal(dot!.magnitude, 5, "5 affliction per turn");
  assert.equal(dot!.dtype, "affliction", "affliction type");
  assert.equal(dot!.duration, 2, "for 2 turns");
});

test("Laughing Powder — only the target's Strategic skills are stunned, not its other skills", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania2", targets: ["b1"] });
  const b1 = unit(s, "b1");
  // For a Strategic-only stun (mode "only"), a skill is blocked iff it carries the Strategic tag.
  const stunBlocks = (tags: string[]) =>
    b1.statuses.some(
      (x) => x.kind === "stun" && x.scope?.mode === "only" && tags.includes(x.scope.tag),
    );
  const strategic = (b1.skills ?? []).find((k) => k.tags.includes("Strategic"));
  const nonStrategic = (b1.skills ?? []).find((k) => !k.tags.includes("Strategic"));
  assert.ok(strategic, "b1 has a Strategic skill to check");
  assert.ok(nonStrategic, "b1 has a non-Strategic skill to check");
  assert.equal(stunBlocks(strategic!.tags), true, "a Strategic skill is stunned");
  assert.equal(stunBlocks(nonStrategic!.tags), false, "a non-Strategic skill is not stunned");
});

test("Laughing Powder — anyone who uses a new skill on the powdered target is afflicted by Laughing Powder for 2 turns", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania2", targets: ["b1"] });
  endTurn(s); // hand over to team B
  startTurn(s);
  // b2 uses a new skill on the powdered b1 -> b2 catches Laughing Powder.
  performAction(s, { unit: "b2", skillId: "laria1", targets: ["b1"] });
  const spread = dotNamed(unit(s, "b2"), "Laughing Powder");
  assert.ok(spread, "the actor catches Laughing Powder");
  assert.equal(spread!.magnitude, 5, "5 per turn");
  assert.equal(spread!.duration, 2, "for 2 turns");
});

test("Laughing Powder — casting it does not powder Titania herself (caster excluded)", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania2", targets: ["b1"] });
  assert.equal(dotNamed(T(s), "Laughing Powder"), undefined, "Titania is not self-afflicted by her own cast");
});

test("Laughing Powder — goes on a 1-turn cooldown after use", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania2", targets: ["b1"] });
  assert.equal(skillOf(T(s), "titania2").currentCd, 1, "cooldown 1");
  assert.equal(canUse(s, T(s), skillOf(T(s), "titania2")), false, "unusable while on cooldown");
});

// --------------------------------------------------------------------------- //
//  titania3 — Barbed Wit
// --------------------------------------------------------------------------- //

test("Barbed Wit — taunts the target onto Titania for 3 turns, on a 3-turn cooldown", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania3", targets: ["b1"] });
  const taunt = unit(s, "b1").statuses.find((x) => x.kind === "taunt");
  assert.ok(taunt, "a taunt is applied");
  assert.equal(taunt!.unitRef, "a1", "taunt is forced onto Titania");
  assert.equal(taunt!.duration, 3, "for 3 turns");
  assert.equal(skillOf(T(s), "titania3").currentCd, 3, "cooldown 3");
});

test("Barbed Wit — the taunt ends when the taunted enemy uses a new harmful skill on Titania", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania3", targets: ["b1"] });
  assert.ok(hasStatus(unit(s, "b1"), "taunt"), "taunted");
  endTurn(s); // team B's turn
  startTurn(s);
  // Taunt forces b1's harmful single-target skill onto Titania; that resolves the early-end.
  performAction(s, { unit: "b1", skillId: "riverdaughter2", targets: ["a1"] });
  assert.equal(hasStatus(unit(s, "b1"), "taunt"), false, "taunt removed after b1 attacks Titania");
});

// --------------------------------------------------------------------------- //
//  titania4 — Prance
// --------------------------------------------------------------------------- //

test("Prance — Titania gains Elemental Essence, a Prance stack, and a 1-turn Prance Watch mark; cooldown 1", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania4" });
  assert.ok(essence(T(s)), "Titania gains Elemental Essence");
  assert.equal(stackMag(T(s), "Prance"), 1, "a Prance stack is banked (a gain)");
  const watch = T(s).statuses.find((x) => x.kind === "mark" && x.name === "Prance Watch");
  assert.ok(watch, "the Prance Watch mark is set");
  assert.equal(watch!.duration, 1, "for one turn");
  assert.equal(skillOf(T(s), "titania4").currentCd, 1, "cooldown 1");
});

test("Prance — the first unit to use a new skill on Titania gains Elemental Essence and banks another Prance stack, then the mark is consumed", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania4" });
  assert.equal(stackMag(T(s), "Prance"), 1, "one stack from the cast");
  // a2 uses a single-target skill on Titania -> that unit gains Essence; Titania banks the 'given' stack.
  performAction(s, { unit: "a2", skillId: "gommar1", targets: ["a1"] });
  assert.ok(essence(unit(s, "a2")), "the first actor gains Elemental Essence");
  assert.equal(stackMag(T(s), "Prance"), 2, "Titania banks a second (given) Prance stack");
  assert.equal(T(s).statuses.some((x) => x.kind === "mark" && x.name === "Prance Watch"), false, "Prance Watch consumed");
  // A second unit acting on Titania does NOT bank a further stack (only the first benefits).
  performAction(s, { unit: "a3", skillId: "gommar1", targets: ["a1"] });
  assert.equal(stackMag(T(s), "Prance"), 2, "no further stack from the second actor");
});

// --------------------------------------------------------------------------- //
//  titania5 — Summer Clique
// --------------------------------------------------------------------------- //

test("Summer Clique — creates one Summer Courtesan per banked Prance stack, then resets the stacks; cooldown 3", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania4" }); // +1 stack (gain)
  performAction(s, { unit: "a2", skillId: "gommar1", targets: ["a1"] }); // +1 stack (given)
  assert.equal(stackMag(T(s), "Prance"), 2, "two banked stacks");
  performAction(s, { unit: "a1", skillId: "titania5" });
  assert.equal(findByName(s, "Summer Courtesan").length, 2, "one Courtesan per stack");
  assert.equal(stackMag(T(s), "Prance"), 0, "stacks reset on use");
  assert.equal(skillOf(T(s), "titania5").currentCd, 3, "cooldown 3");
});

test("Summer Clique — with a single banked stack, creates exactly one Summer Courtesan", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania4" }); // 1 stack
  performAction(s, { unit: "a1", skillId: "titania5" });
  assert.equal(findByName(s, "Summer Courtesan").length, 1, "one Courtesan from one stack");
});

// --------------------------------------------------------------------------- //
//  Summer Courtesan minion skills
// --------------------------------------------------------------------------- //

test("Curry Favor — the Summer Courtesan heals Titania for 15 HP", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania4" });
  performAction(s, { unit: "a1", skillId: "titania5" }); // one Courtesan
  const court = findByName(s, "Summer Courtesan")[0]!;
  T(s).hp = 50;
  performAction(s, { unit: court.id, skillId: "titaniaminion1", targets: ["a1"] });
  assert.equal(T(s).hp, 65, "healed for 15 (50 -> 65)");
});

test("Diving Slash — the Summer Courtesan deals 10 Piercing damage to a target enemy", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "titania4" });
  performAction(s, { unit: "a1", skillId: "titania5" });
  const court = findByName(s, "Summer Courtesan")[0]!;
  performAction(s, { unit: court.id, skillId: "titaniaminion2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 piercing damage");
});
