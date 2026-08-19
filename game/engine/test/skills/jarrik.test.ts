/**
 * Behavior tests for Jarrik Cinderblade, asserted against the frozen skill prose (the oracle):
 *
 *   jarrik0 Cinders          — "When Jarrik damages an enemy marked by this skill, he deals 10
 *                               additional Affliction damage and gains Elemental Essence."
 *   jarrik1 Blade of Ashes    — "Deals 10 damage to target enemy and permanently marks them with Cinders."
 *   jarrik2 Cinderswell       — "Deals 15 damage to all enemies. If any target is marked by Cinders,
 *                               all enemies are Shattered for 2 turns."
 *   jarrik3 Call Cinders      — "Deals 5 Affliction damage to all enemies marked by Cinders. Those marks
 *                               are then removed, creating a Cinderling minion for each mark removed."
 *   jarrik4 Wall of Sparks    — "Grants Jarrik 15 Shield for 1 turn for each active Cinders mark or
 *                               Cinderling minion."
 *   jarrik5 Blade of Dancing Lights — "Withdraws all active Cinders marks and consumes any active
 *                               Cinderling minions. For a number of turns equal to the total consumed,
 *                               Blade of Ashes targets all enemies and Jarrik will automatically create a
 *                               Cinderling minion whenever he triggers his Cinders."
 *
 * Jarrik sits at a1; b1/b2/b3 are the enemies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, shieldTotal, performAction, startTurn, endTurn } from "../skillHarness.ts";

const A: [string, string, string] = ["jarrik", "syl", "gommar"];
const B: [string, string, string] = ["riverdaughter", "laria", "xyris"];

const essence = (u: ReturnType<typeof unit>) => u.statuses.filter((x) => x.kind === "elemental_essence").length;
const cinderlings = (s: ReturnType<typeof battle>) =>
  Object.values(s.units).filter((u) => u.kind === "minion" && u.name === "Cinderling" && u.alive !== false).length;

// --------------------------------------------------------------------------- //
//  jarrik0 — Cinders (passive)
// --------------------------------------------------------------------------- //

test("Cinders — damaging an UNMARKED enemy does not proc (damage lands before the mark)", () => {
  const s = battle(A, B);
  const j = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  // First Blade of Ashes: 10 base damage only; the Cinders mark is applied AFTER the hit, so no rider.
  assert.equal(unit(s, "b1").hp, 90, "unmarked target takes only the 10 base damage");
  assert.equal(essence(j), 0, "no Elemental Essence, since the target was unmarked when struck");
});

test("Cinders — damaging a MARKED enemy deals +10 Affliction and grants Elemental Essence", () => {
  const s = battle(A, B);
  const j = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // 100 -> 90, now marked
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // 90 -> 80 (base) -> 70 (+10 Affliction rider)
  assert.equal(unit(s, "b1").hp, 70, "10 base + 10 Cinders Affliction on the already-marked enemy");
  assert.equal(essence(j), 1, "Jarrik gains Elemental Essence from the proc");
});

test("Cinders — procs exactly once per Jarrik hit (re-entrancy guard)", () => {
  const s = battle(A, B);
  const j = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  // A single hit yields a single Essence charge — the rider's own Affliction must not recursively re-proc.
  assert.equal(essence(j), 1, "one Essence per hit, not a runaway chain");
});

test("Cinders — a minion's damage does NOT proc Jarrik's passive", () => {
  const s = battle(A, B);
  const j = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] });
  performAction(s, { unit: "a1", skillId: "jarrik3" }); // removes both marks, makes 2 Cinderlings
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // re-mark b1
  const essBefore = essence(j);
  const hpBefore = unit(s, "b1").hp;
  const minion = Object.values(s.units).find((u) => u.kind === "minion" && u.name === "Cinderling")!;
  performAction(s, { unit: minion.id, skillId: "cinder1" }); // Cinder Splash: 10 Affliction to enemy team
  assert.equal(unit(s, "b1").hp, hpBefore - 10, "marked b1 takes only the minion's 10, no Jarrik rider");
  assert.equal(essence(j), essBefore, "Jarrik gains no Essence — the minion, not Jarrik, dealt the damage");
});

// --------------------------------------------------------------------------- //
//  jarrik1 — Blade of Ashes
// --------------------------------------------------------------------------- //

test("Blade of Ashes — 10 damage to the target and a permanent Cinders mark", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 damage");
  assert.ok(hasStatus(unit(s, "b1"), "mark", "Cinders"), "target is marked with Cinders");
  const mark = unit(s, "b1").statuses.find((x) => x.kind === "mark" && x.name === "Cinders")!;
  assert.equal(mark.duration, null, "the mark is permanent (no expiry)");
  // Single-target: only the chosen enemy is marked / damaged.
  assert.equal(unit(s, "b2").hp, 100, "a non-target enemy is untouched");
  assert.ok(!hasStatus(unit(s, "b2"), "mark", "Cinders"), "a non-target enemy is not marked");
});

// --------------------------------------------------------------------------- //
//  jarrik2 — Cinderswell
// --------------------------------------------------------------------------- //

test("Cinderswell — 15 to all enemies; a marked enemy Shatters ALL enemies for 2 turns", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // mark b1 (b1: 90)
  performAction(s, { unit: "a1", skillId: "jarrik2" });
  // b1 was marked: 15 base + 10 Cinders rider = 25 -> 90 - 25 = 65.
  assert.equal(unit(s, "b1").hp, 65, "marked enemy takes 15 + the 10 Cinders rider");
  assert.equal(unit(s, "b2").hp, 85, "unmarked enemy takes the flat 15");
  assert.equal(unit(s, "b3").hp, 85, "unmarked enemy takes the flat 15");
  for (const id of ["b1", "b2", "b3"]) {
    assert.ok(hasStatus(unit(s, id), "shatter"), `${id} is Shattered because a target was marked`);
    const sh = unit(s, id).statuses.find((x) => x.kind === "shatter")!;
    assert.equal(sh.duration, 2, `${id} Shatter lasts 2 turns`);
  }
  assert.equal(skillOf(unit(s, "a1"), "jarrik2").currentCd, 2, "Cinderswell goes on a 2-turn cooldown");
});

test("Cinderswell — no marked enemy means no Shatter", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik2" });
  assert.equal(unit(s, "b1").hp, 85, "flat 15 damage");
  for (const id of ["b1", "b2", "b3"]) {
    assert.ok(!hasStatus(unit(s, id), "shatter"), `${id} is NOT Shattered — nothing was marked`);
  }
});

// --------------------------------------------------------------------------- //
//  jarrik3 — Call Cinders
// --------------------------------------------------------------------------- //

test("Call Cinders — 5 Affliction to marked enemies, removes marks, spawns a Cinderling per mark", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // b1: 90, marked
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] }); // b2: 90, marked
  // b3 stays unmarked.
  performAction(s, { unit: "a1", skillId: "jarrik3" });
  // 5 Affliction + 10 Cinders rider (still marked at damage time) = 15 to each marked enemy.
  assert.equal(unit(s, "b1").hp, 75, "marked b1 takes 5 + the 10 Cinders rider");
  assert.equal(unit(s, "b2").hp, 75, "marked b2 takes 5 + the 10 Cinders rider");
  assert.equal(unit(s, "b3").hp, 100, "unmarked b3 is untouched by Call Cinders");
  assert.ok(!hasStatus(unit(s, "b1"), "mark", "Cinders"), "b1's mark is removed");
  assert.ok(!hasStatus(unit(s, "b2"), "mark", "Cinders"), "b2's mark is removed");
  assert.equal(cinderlings(s), 2, "one Cinderling per removed mark");
  assert.equal(skillOf(unit(s, "a1"), "jarrik3").currentCd, 2, "Call Cinders goes on a 2-turn cooldown");
});

test("Call Cinders — no marks means no damage and no Cinderlings", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik3" });
  assert.equal(unit(s, "b1").hp, 100, "no marked enemies, no damage");
  assert.equal(cinderlings(s), 0, "no marks removed, no Cinderlings created");
});

// --------------------------------------------------------------------------- //
//  jarrik4 — Wall of Sparks
// --------------------------------------------------------------------------- //

test("Wall of Sparks — 15 Shield (for 1 turn) per active Cinders mark or Cinderling", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] });
  performAction(s, { unit: "a1", skillId: "jarrik4" });
  assert.equal(shieldTotal(unit(s, "a1")), 30, "2 marks * 15 = 30 Shield");
  const shield = unit(s, "a1").shields[0]!;
  assert.equal(shield.duration, 1, "the Shield lasts 1 turn");
});

test("Wall of Sparks — marks AND Cinderlings both count", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] });
  performAction(s, { unit: "a1", skillId: "jarrik3" }); // 2 Cinderlings, 0 marks
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b3"] }); // 1 mark
  performAction(s, { unit: "a1", skillId: "jarrik4" });
  assert.equal(shieldTotal(unit(s, "a1")), 45, "(1 mark + 2 Cinderlings) * 15 = 45");
});

test("Wall of Sparks — zero marks and zero Cinderlings grants no Shield", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik4" });
  assert.equal(shieldTotal(unit(s, "a1")), 0, "nothing active -> 0 Shield");
});

// --------------------------------------------------------------------------- //
//  jarrik5 — Blade of Dancing Lights
// --------------------------------------------------------------------------- //

test("Blade of Dancing Lights — withdraws marks, consumes Cinderlings, arms for total turns", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b3"] });
  performAction(s, { unit: "a1", skillId: "jarrik3" }); // 3 marks -> 3 Cinderlings, marks gone
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // re-mark b1
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] }); // re-mark b2
  // Now: 2 active marks (b1, b2) + 3 Cinderlings = 5 total consumed.
  performAction(s, { unit: "a1", skillId: "jarrik5" });
  const j = unit(s, "a1");
  assert.ok(hasStatus(j, "mark", "Dancing Lights"), "Jarrik gains the Dancing Lights mark");
  const dl = j.statuses.find((x) => x.kind === "mark" && x.name === "Dancing Lights")!;
  assert.equal(dl.duration, 5, "duration equals total consumed (2 marks + 3 Cinderlings)");
  assert.ok(!hasStatus(unit(s, "b1"), "mark", "Cinders"), "all Cinders marks are withdrawn");
  assert.ok(!hasStatus(unit(s, "b2"), "mark", "Cinders"), "all Cinders marks are withdrawn");
  assert.equal(cinderlings(s), 0, "all Cinderlings are consumed");
  assert.equal(skillOf(j, "jarrik5").currentCd, 4, "Blade of Dancing Lights goes on a 4-turn cooldown");
});

test("Blade of Dancing Lights — while active, Blade of Ashes hits ALL enemies", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b3"] });
  performAction(s, { unit: "a1", skillId: "jarrik5" }); // marks withdrawn, Dancing Lights armed (dur 3)
  // Each enemy is at 90 from the setup Blades; the AOE Blade takes every one of them to 80.
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // now an AOE Blade
  assert.equal(unit(s, "b1").hp, 80, "b1 hit by the AOE Blade");
  assert.equal(unit(s, "b2").hp, 80, "b2 hit by the AOE Blade");
  assert.equal(unit(s, "b3").hp, 80, "b3 hit by the AOE Blade");
  for (const id of ["b1", "b2", "b3"]) {
    assert.ok(hasStatus(unit(s, id), "mark", "Cinders"), `${id} is (re)marked by the AOE Blade`);
  }
});

test("Blade of Dancing Lights — while active, each Cinders proc auto-summons a Cinderling", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b2"] });
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b3"] });
  performAction(s, { unit: "a1", skillId: "jarrik5" }); // Dancing Lights armed, Cinderlings=0, marks gone
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // AOE marks all (no proc: unmarked at hit)
  assert.equal(cinderlings(s), 0, "no proc yet — enemies were unmarked when first struck");
  performAction(s, { unit: "a1", skillId: "jarrik1", targets: ["b1"] }); // AOE again: all 3 now marked -> 3 procs
  assert.equal(cinderlings(s), 3, "each Cinders proc under Dancing Lights auto-creates a Cinderling");
});
