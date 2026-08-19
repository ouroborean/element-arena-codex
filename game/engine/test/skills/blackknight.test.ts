/**
 * Behavior tests for the Black Knight — asserted against the FROZEN skill prose
 * (game/content/frozen/skills.json), never the implementation. Base kit blackknight0..5.
 *
 * A=[blackknight, titania, xyris]  B=[laria, gommar, maggie] — inert fillers/enemies so
 * damage numbers are clean. "Enhanced" = acting alone = the private self-mark "Exile"; the
 * enhanced branches are exercised by placing that mark directly, and the passive that grants
 * it is tested on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, performAction, endTurn } from "../skillHarness.ts";
import type { Unit } from "../../src/types.ts";

const A = ["blackknight", "titania", "xyris"];
const B = ["laria", "gommar", "maggie"];

const statusMag = (u: Unit, kind: string, name?: string): number =>
  u.statuses.filter((s) => s.kind === kind && (name === undefined || s.name === name)).reduce((a, s) => a + (s.magnitude ?? 0), 0);
const findStatus = (u: Unit, kind: string, name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
/** Give a unit the private "Exile" enhanced mark (what "while enhanced" reads). */
const enhance = (u: Unit) => u.statuses.push({ kind: "mark", name: "Exile", duration: 1, appliedBy: u.id, appliedTurn: 0 });
/** Give a unit flat damage reduction (to reveal piercing bypass). */
const giveDR = (u: Unit, mag: number) => u.statuses.push({ kind: "damage_reduction", magnitude: mag, duration: null, appliedBy: "x", appliedTurn: 0 });

// --------------------------------------------------------------------------- //
// blackknight0 — Exile (passive): "When the Black Knight acts alone, his abilities are
// enhanced and he gains Elemental Essence."
// --------------------------------------------------------------------------- //
test("Exile — acting alone grants the enhanced mark + Elemental Essence at turn end", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  assert.equal(hasStatus(bk, "mark", "Exile"), false, "not enhanced before acting");
  performAction(s, { unit: "a1", skillId: "blackknight1", targets: ["b1"] });
  endTurn(s); // only the Black Knight acted this turn -> he acted alone
  assert.equal(hasStatus(bk, "mark", "Exile"), true, "enhanced after acting alone");
  assert.equal(hasStatus(bk, "elemental_essence"), true, "gains Elemental Essence");
});

test("Exile — NOT enhanced when an ally also acts", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "blackknight1", targets: ["b1"] });
  s.actedThisTurn.push("a2"); // an ally hero also took an action this turn
  endTurn(s);
  assert.equal(hasStatus(bk, "mark", "Exile"), false, "no enhancement — did not act alone");
});

// --------------------------------------------------------------------------- //
// blackknight1 — Oathbreaker Strike: "Deals 15 damage to 1 enemy. While enhanced, deals
// 10 more damage and becomes piercing."  cost generic 1, cd 0.
// --------------------------------------------------------------------------- //
test("Oathbreaker Strike — base deals 15 normal damage (reduced by DR)", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  const b1 = unit(s, "b1");
  giveDR(b1, 10); // normal damage is subject to DR
  const before = b1.hp;
  const r = performAction(s, { unit: "a1", skillId: "blackknight1", targets: ["b1"] });
  assert.equal(r.ok, true);
  assert.equal(before - b1.hp, 5, "15 normal minus 10 DR = 5");
  assert.equal(skillOf(bk, "blackknight1").currentCd, 0, "cooldown 0");
});

test("Oathbreaker Strike — enhanced deals 25 piercing (bypasses DR)", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  enhance(bk);
  const b1 = unit(s, "b1");
  giveDR(b1, 10);
  const before = b1.hp;
  performAction(s, { unit: "a1", skillId: "blackknight1", targets: ["b1"] });
  assert.equal(before - b1.hp, 25, "15 + 10 = 25, piercing ignores the 10 DR");
});

// --------------------------------------------------------------------------- //
// blackknight2 — Misery: "For 2 turns, the Black Knight deals 5 additional damage for each
// 30 health his team is missing, up to 20. While enhanced, lasts an additional turn."
// cost generic 1, cd 1.
// --------------------------------------------------------------------------- //
test("Misery — +5 damage per 30 team HP missing, for 2 turns", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  unit(s, "a1").hp = 40; // missing 60
  unit(s, "a2").hp = 100;
  unit(s, "a3").hp = 100; // team missing 60 -> floor(60/30)=2 -> +10
  const r = performAction(s, { unit: "a1", skillId: "blackknight2" });
  assert.equal(r.ok, true);
  assert.equal(statusMag(bk, "outgoing_damage_mod", "Misery"), 10, "+5 x 2 = 10");
  assert.equal(findStatus(bk, "outgoing_damage_mod", "Misery")!.duration, 2, "lasts 2 turns");
  assert.equal(skillOf(bk, "blackknight2").currentCd, 1, "cooldown 1");
});

test("Misery — bonus is capped at 20", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  unit(s, "a1").hp = 10; // missing 90
  unit(s, "a2").hp = 10; // missing 90
  unit(s, "a3").hp = 100; // team missing 180 -> floor/*=6 -> 30, capped to 20
  performAction(s, { unit: "a1", skillId: "blackknight2" });
  assert.equal(statusMag(bk, "outgoing_damage_mod", "Misery"), 20, "capped at 20");
});

test("Misery — while enhanced it lasts an additional turn (3)", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  enhance(bk);
  unit(s, "a1").hp = 70; // missing 30 -> +5
  performAction(s, { unit: "a1", skillId: "blackknight2" });
  assert.equal(statusMag(bk, "outgoing_damage_mod", "Misery"), 5, "+5 for 30 missing");
  assert.equal(findStatus(bk, "outgoing_damage_mod", "Misery")!.duration, 3, "enhanced -> 3 turns");
});

test("Misery — the bonus is actually added to the Black Knight's damage", () => {
  const s = battle(A, B);
  unit(s, "a1").hp = 40; // missing 60 -> +10
  performAction(s, { unit: "a1", skillId: "blackknight2" });
  const b1 = unit(s, "b1");
  const before = b1.hp;
  performAction(s, { unit: "a1", skillId: "blackknight1", targets: ["b1"] }); // 15 normal + 10 Misery
  assert.equal(before - b1.hp, 25, "Oathbreaker's 15 plus Misery's +10");
});

// --------------------------------------------------------------------------- //
// blackknight3 — Unholy Aura: "For 2 turns, all allies and enemies deal 5 less damage.
// While enhanced, this skill only targets enemies and affected enemies deal 10 less
// damage."  cost generic 1 / specific 1, cd 1.
// --------------------------------------------------------------------------- //
test("Unholy Aura — base: everyone (allies + enemies) deals 5 less for 2 turns", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  const r = performAction(s, { unit: "a1", skillId: "blackknight3" });
  assert.equal(r.ok, true);
  for (const id of ["a1", "a2", "a3", "b1", "b2", "b3"]) {
    assert.equal(statusMag(unit(s, id), "outgoing_damage_mod", "Unholy Aura"), -5, `${id} deals 5 less`);
  }
  assert.equal(findStatus(bk, "outgoing_damage_mod", "Unholy Aura")!.duration, 2, "for 2 turns");
  assert.equal(skillOf(bk, "blackknight3").currentCd, 1, "cooldown 1");
});

test("Unholy Aura — enhanced: only enemies are affected, at 10 less", () => {
  const s = battle(A, B);
  enhance(unit(s, "a1"));
  performAction(s, { unit: "a1", skillId: "blackknight3" });
  for (const id of ["b1", "b2", "b3"]) {
    assert.equal(statusMag(unit(s, id), "outgoing_damage_mod", "Unholy Aura"), -10, `${id} deals 10 less`);
  }
  for (const id of ["a1", "a2", "a3"]) {
    assert.equal(hasStatus(unit(s, id), "outgoing_damage_mod", "Unholy Aura"), false, `${id} (ally) unaffected while enhanced`);
  }
});

// --------------------------------------------------------------------------- //
// blackknight4 — Dead or Alive: "The Black Knight ignores all new Harmful skills for 1
// turn. While enhanced, this skill also redirects harmful skills from his allies to
// himself."  cost specific 1, cd 4.
// --------------------------------------------------------------------------- //
test("Dead or Alive — ignores all new Harmful for 1 turn (base, no redirect mark)", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  const r = performAction(s, { unit: "a1", skillId: "blackknight4" });
  assert.equal(r.ok, true);
  assert.equal(hasStatus(bk, "damage_ignore"), true, "ignores harmful damage");
  assert.equal(hasStatus(bk, "non_damage_ignore"), true, "ignores harmful non-damage");
  assert.equal(findStatus(bk, "damage_ignore")!.duration, 1, "for 1 turn");
  assert.equal(hasStatus(bk, "mark", "Dead or Alive"), false, "no redirect while not enhanced");
  assert.equal(skillOf(bk, "blackknight4").currentCd, 4, "cooldown 4");
});

test("Dead or Alive — ignored harmful damage deals nothing", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "blackknight4" });
  const before = bk.hp;
  // An enemy strikes the Black Knight with a harmful skill (laria1 = 10 damage); the ignore absorbs it.
  const r = performAction(s, { unit: "b1", skillId: "laria1", targets: ["a1"] });
  assert.equal(r.ok, true, "the enemy's harmful skill resolved (not blocked at targeting)");
  assert.equal(bk.hp, before, "no HP lost — the harmful skill is ignored");
});

test("Dead or Alive — enhanced also installs the redirect mark", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  enhance(bk);
  performAction(s, { unit: "a1", skillId: "blackknight4" });
  assert.equal(hasStatus(bk, "mark", "Dead or Alive"), true, "enhanced -> redirect enabled");
});

// --------------------------------------------------------------------------- //
// blackknight5 — The Nightmare Rides: "For 2 turns, the Black Knight is invulnerable.
// During this time, Oathbreaker Strike will target all enemies and is always enhanced."
// cost specific 2, cd 6.
// --------------------------------------------------------------------------- //
test("The Nightmare Rides — 2 turns invulnerable + the mark, cooldown 6", () => {
  const s = battle(A, B);
  const bk = unit(s, "a1");
  const r = performAction(s, { unit: "a1", skillId: "blackknight5" });
  assert.equal(r.ok, true);
  assert.equal(hasStatus(bk, "invulnerable"), true, "invulnerable");
  assert.equal(findStatus(bk, "invulnerable")!.duration, 2, "for 2 turns");
  assert.equal(hasStatus(bk, "mark", "The Nightmare Rides"), true);
  assert.equal(skillOf(bk, "blackknight5").currentCd, 6, "cooldown 6");
});

test("The Nightmare Rides — Oathbreaker Strike hits ALL enemies for 25 piercing", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "blackknight5" });
  const b2 = unit(s, "b2");
  giveDR(b2, 10); // piercing must ignore this
  const enemies = ["b1", "b2", "b3"].map((id) => unit(s, id));
  const before = enemies.map((u) => u.hp);
  performAction(s, { unit: "a1", skillId: "blackknight1", targets: ["b1"] });
  enemies.forEach((u, i) => assert.equal(before[i]! - u.hp, 25, `${u.id} takes 25 piercing (always enhanced, all enemies)`));
});
