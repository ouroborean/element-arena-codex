/**
 * Behavior tests for Ayana, Voice of Light — asserted against the FROZEN skill prose
 * (game/content/frozen/skills.json), never the implementation. Base kit ayana0..ayana5.
 *
 * A=[ayana, titania, xyris]  B=[laria, gommar, maggie]  — fillers/enemies chosen for inert
 * passives (no incoming-damage mods, no summons, no round-start DR) so damage numbers are clean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, performAction, endTurn, startTurn, emit } from "../skillHarness.ts";
import type { Unit } from "../../src/types.ts";

const A = ["ayana", "titania", "xyris"];
const B = ["laria", "gommar", "maggie"];

/** Summed magnitude of a (kind[,name]) status on a unit. */
const statusMag = (u: Unit, kind: string, name?: string): number =>
  u.statuses.filter((s) => s.kind === kind && (name === undefined || s.name === name)).reduce((a, s) => a + (s.magnitude ?? 0), 0);
/** The first matching status (for reading its duration). */
const findStatus = (u: Unit, kind: string, name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));

// --------------------------------------------------------------------------- //
// ayana0 — Revered Daughter (passive):
// "Ayana gains 5 points of permanent damage reduction for each of her living allies."
// --------------------------------------------------------------------------- //
test("Revered Daughter — 5 DR per living ally (2 allies = 10)", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  assert.equal(statusMag(ay, "damage_reduction"), 10, "5 x 2 living hero allies");
});

test("Revered Daughter — DR recomputes down when an ally dies", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  assert.equal(statusMag(ay, "damage_reduction"), 10);
  // Kill one ally and announce the death: DR must fall to 5 (one living ally left).
  const xy = unit(s, "a3");
  xy.hp = 0;
  xy.alive = false;
  emit(s, { type: "unitDied", unit: "a3", killer: "b1" });
  assert.equal(statusMag(ay, "damage_reduction"), 5, "5 x 1 remaining living ally");
});

// --------------------------------------------------------------------------- //
// ayana1 — Voice of Light: "Deals 15 damage to one enemy. If that enemy deals new
// damage this turn, Ayana gains Elemental Essence."  cost generic 1, cd 0.
// --------------------------------------------------------------------------- //
test("Voice of Light — 15 damage + Voice of Light mark, no essence unless the target deals damage", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  const b1 = unit(s, "b1");
  const before = b1.hp;
  const r = performAction(s, { unit: "a1", skillId: "ayana1", targets: ["b1"] });
  assert.equal(r.ok, true);
  assert.equal(before - b1.hp, 15, "deals 15 damage");
  assert.equal(hasStatus(b1, "mark", "Voice of Light"), true, "marks the target with Voice of Light");
  assert.equal(hasStatus(ay, "elemental_essence"), false, "no essence yet — target has not dealt damage");
  assert.equal(skillOf(ay, "ayana1").currentCd, 0, "cooldown 0 — reusable");
});

test("Voice of Light — Ayana gains Essence when the marked enemy deals new damage", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "ayana1", targets: ["b1"] });
  assert.equal(hasStatus(ay, "elemental_essence"), false);
  // The marked enemy deals new damage -> the Voice of Light trigger grants Essence and clears the mark.
  emit(s, { type: "damageDealt", source: "b1", target: "a2", amount: 5, dtype: "normal", isNew: true });
  assert.equal(hasStatus(ay, "elemental_essence"), true, "Essence granted");
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Voice of Light"), false, "mark consumed by the trigger");
});

// --------------------------------------------------------------------------- //
// ayana2 — Chorus: "For Ayana's next 2 turns, Voice of Light and Prayer will affect all
// valid targets."  cost specific 1, cd 2.
// --------------------------------------------------------------------------- //
test("Chorus — applies the Chorus mark (2 turns), cost/cooldown as frozen", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  const r = performAction(s, { unit: "a1", skillId: "ayana2" });
  assert.equal(r.ok, true);
  assert.equal(hasStatus(ay, "mark", "Chorus"), true);
  assert.equal(findStatus(ay, "mark", "Chorus")!.duration, 2, "lasts Ayana's next 2 turns");
  assert.equal(skillOf(ay, "ayana2").currentCd, 2, "cooldown 2");
});

test("Chorus — Voice of Light then hits ALL enemies", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "ayana2" });
  const enemies = ["b1", "b2", "b3"].map((id) => unit(s, id));
  const before = enemies.map((u) => u.hp);
  performAction(s, { unit: "a1", skillId: "ayana1", targets: ["b1"] });
  enemies.forEach((u, i) => assert.equal(before[i] - u.hp, 15, `enemy ${u.id} takes 15 under Chorus`));
});

test("Chorus — Prayer then heals ALL allied heroes", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "ayana2" });
  const allies = ["a1", "a2", "a3"].map((id) => unit(s, id));
  for (const u of allies) u.hp = 80;
  performAction(s, { unit: "a1", skillId: "ayana3", targets: ["a2"] });
  for (const u of allies) assert.equal(u.hp, 90, `${u.id} healed 10 under Chorus`);
});

// --------------------------------------------------------------------------- //
// ayana3 — Prayer: "Ayana heals target ally for 10 HP. If they receive new damage next
// turn, Ayana gains Elemental Essence."  cost generic 1, cd 0.
// --------------------------------------------------------------------------- //
test("Prayer — heals 10 + Prayer mark, no essence unless the ally is then damaged", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  const a2 = unit(s, "a2");
  a2.hp = 80;
  const r = performAction(s, { unit: "a1", skillId: "ayana3", targets: ["a2"] });
  assert.equal(r.ok, true);
  assert.equal(a2.hp, 90, "heals 10 HP");
  assert.equal(hasStatus(a2, "mark", "Prayer"), true, "marks the healed ally with Prayer");
  assert.equal(hasStatus(ay, "elemental_essence"), false, "no essence yet");
  assert.equal(skillOf(ay, "ayana3").currentCd, 0, "cooldown 0");
});

test("Prayer — Ayana gains Essence when the prayed-for ally takes new damage", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  unit(s, "a2").hp = 80;
  performAction(s, { unit: "a1", skillId: "ayana3", targets: ["a2"] });
  assert.equal(hasStatus(ay, "elemental_essence"), false);
  emit(s, { type: "damageDealt", source: "b1", target: "a2", amount: 5, dtype: "normal", isNew: true });
  assert.equal(hasStatus(ay, "elemental_essence"), true, "Essence granted when the healed ally is hurt");
  assert.equal(hasStatus(unit(s, "a2"), "mark", "Prayer"), false, "mark consumed");
});

// --------------------------------------------------------------------------- //
// ayana4 — Cloister: "The Damage Reduction from Revered Daughter is doubled for 1 turn."
// cost 0, cd 1.
// --------------------------------------------------------------------------- //
test("Cloister — doubles Revered Daughter DR for 1 turn", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  assert.equal(statusMag(ay, "damage_reduction"), 10, "base DR");
  const r = performAction(s, { unit: "a1", skillId: "ayana4" });
  assert.equal(r.ok, true);
  assert.equal(statusMag(ay, "damage_reduction"), 20, "DR doubled");
  assert.equal(hasStatus(ay, "mark", "Cloister"), true);
  assert.equal(findStatus(ay, "mark", "Cloister")!.duration, 1, "for 1 turn");
  assert.equal(skillOf(ay, "ayana4").currentCd, 1, "cooldown 1");
});

// --------------------------------------------------------------------------- //
// ayana5 — Voice of Glory: "Voice of Light and Prayer permanently last 1 additional turn.
// This effect stacks."  cost generic 1 / specific 2, cd 1.
// --------------------------------------------------------------------------- //
test("Voice of Glory — stacks Voice of Glory and extends Voice of Light's mark by 1 turn per stack", () => {
  const s = battle(A, B);
  const ay = unit(s, "a1");
  // Baseline: Voice of Light's mark lasts 1 turn with no Voice of Glory stacks.
  performAction(s, { unit: "a1", skillId: "ayana1", targets: ["b1"] });
  assert.equal(findStatus(unit(s, "b1"), "mark", "Voice of Light")!.duration, 1, "base mark duration 1");

  const s2 = battle(A, B);
  const ay2 = unit(s2, "a1");
  const r = performAction(s2, { unit: "a1", skillId: "ayana5" });
  assert.equal(r.ok, true);
  assert.equal(stackMag(ay2, "Voice of Glory"), 1, "one stack of Voice of Glory");
  assert.equal(skillOf(ay2, "ayana5").currentCd, 1, "cooldown 1");
  performAction(s2, { unit: "a1", skillId: "ayana1", targets: ["b1"] });
  assert.equal(findStatus(unit(s2, "b1"), "mark", "Voice of Light")!.duration, 2, "mark now lasts 1 additional turn");
});
