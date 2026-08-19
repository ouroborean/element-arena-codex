/**
 * Behavior tests for Dennis the Apprentice — asserted against the FROZEN skill prose
 * (game/content/frozen/skills.json), never the implementation.
 *
 * Dennis's element is "serum", which the shared flushEnergy() pool does not stock, so each
 * battle here tops up serum energy (addElement) before casting serum-specific skills.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, canUse, performAction, startTurn, endTurn } from "../skillHarness.ts";
import type { MatchState, Unit } from "../../src/types.ts";

/** Top up the element(s) a hero pays specific costs in (flushEnergy() only stocks the base ten). */
function addElement(s: MatchState, ...els: string[]): void {
  for (const t of ["A", "B"] as const) for (const el of els) s.teams[t].energy[el] = 99;
}
const dr = (u: Unit): number =>
  u.statuses.filter((x) => x.kind === "damage_reduction").reduce((a, x) => a + (x.magnitude ?? 0), 0);
const essenceCount = (u: Unit): number => u.statuses.filter((x) => x.kind === "elemental_essence").length;
const regenMag = (u: Unit): number =>
  u.statuses.filter((x) => x.kind === "regen").reduce((a, x) => a + (x.magnitude ?? 0), 0);
const tauntRef = (u: Unit): string | undefined => u.statuses.find((x) => x.kind === "taunt")?.unitRef;

// Dennis at a1; enemies maggie/taryn/riverdaughter are NOT stealthed (a stealthed attacker would, per the
// glossary, correctly suppress Dennis's reactive passive — see note below).
const D = (): MatchState => battle(["dennis", "syl", "gommar"], ["maggie", "taryn", "riverdaughter"]);

// --------------------------------------------------------------------------- //
//  dennis0 — Pain Tolerance (passive)
//  "If Dennis is damaged, he will gain Elemental Essence and 5 Damage Reduction until the end of his
//   next turn. This effect stacks, but does not refresh. Dennis can only gain Elemental Essence from
//   this effect once per turn."
// --------------------------------------------------------------------------- //
test("Pain Tolerance — being damaged grants Elemental Essence and 5 Damage Reduction", () => {
  const s = D();
  const d = unit(s, "a1");
  const before = d.hp;
  // maggie (b1) hits Dennis for 15 normal.
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a1"] });
  assert.equal(d.hp, before - 15, "took the hit at full value (no DR yet on the first hit)");
  assert.equal(stackMag(d, "Pain Tolerance"), 1, "one Pain Tolerance stack from being damaged");
  assert.ok(hasStatus(d, "elemental_essence"), "gains Elemental Essence when damaged");
  assert.equal(dr(d), 5, "gains 5 Damage Reduction");
});

test("Pain Tolerance — stacks (DR accumulates 5 per hit, reduces later damage); Essence only once per turn", () => {
  const s = D();
  const d = unit(s, "a1");
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a1"] }); // 15 normal, first hit full
  assert.equal(d.hp, 85, "first hit: 15 damage");
  assert.equal(dr(d), 5, "DR is 5 after one stack");
  performAction(s, { unit: "b2", skillId: "taryn1", targets: ["a1"] }); // 15 normal, reduced by DR 5 -> 10
  assert.equal(d.hp, 75, "second hit reduced by the 5 DR from the first: 15 - 5 = 10");
  assert.equal(stackMag(d, "Pain Tolerance"), 2, "stacks accumulate to 2");
  assert.equal(dr(d), 10, "DR accumulates to 5 per stack = 10");
  assert.equal(essenceCount(d), 1, "Elemental Essence granted only once per turn despite two hits");
});

// --------------------------------------------------------------------------- //
//  dennis1 — Big Green Fist
//  "Deals 10 damage to target enemy, increased by 5 for each stack of Pain Tolerance currently on Dennis."
// --------------------------------------------------------------------------- //
test("Big Green Fist — 10 base damage, +5 per Pain Tolerance stack", () => {
  const s = D();
  const d = unit(s, "a1");
  assert.ok(canUse(s, d, skillOf(d, "dennis1")), "usable at fresh round (cost 1 generic)");
  const b3 = unit(s, "b3");
  const before = b3.hp;
  performAction(s, { unit: "a1", skillId: "dennis1", targets: ["b3"] });
  assert.equal(before - b3.hp, 10, "base damage is 10 with no Pain Tolerance stacks");

  // Inject 3 Pain Tolerance stacks directly and confirm the +5/stack scaling (10 + 5*3 = 25).
  const s2 = D();
  const d2 = unit(s2, "a1");
  d2.statuses.push({ kind: "stack", name: "Pain Tolerance", magnitude: 3, duration: 1, appliedBy: "a1", appliedTurn: 0 });
  const e = unit(s2, "b3");
  const b4 = e.hp;
  performAction(s2, { unit: "a1", skillId: "dennis1", targets: ["b3"] });
  assert.equal(b4 - e.hp, 25, "10 + 5*3 stacks = 25 damage");
});

// --------------------------------------------------------------------------- //
//  dennis2 — HS-112 Fury Serum
//  "For 4 turns any unit Dennis damages and any unit that damages him is Taunted for 1 turn.
//   This effect can not stack on enemies or Dennis."
// --------------------------------------------------------------------------- //
test("HS-112 Fury Serum — applies the 4-turn Fury window; cooldown 3", () => {
  const s = D();
  addElement(s, "serum");
  const d = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "dennis2" });
  const mark = d.statuses.find((x) => x.kind === "mark" && x.name === "HS-112 Fury Serum");
  assert.ok(mark, "Fury mark applied to Dennis");
  assert.equal(mark!.duration, 4, "for 4 turns");
  assert.equal(skillOf(d, "dennis2").currentCd, 3, "cooldown 3");
});

test("HS-112 Fury Serum — Taunts any unit Dennis damages and any unit that damages him", () => {
  const s = D();
  addElement(s, "serum");
  performAction(s, { unit: "a1", skillId: "dennis2" });
  // Unit Dennis damages: hit b1 (do this while Dennis is un-Bannered so his hit lands).
  performAction(s, { unit: "a1", skillId: "dennis1", targets: ["b1"] });
  assert.ok(hasStatus(unit(s, "b1"), "taunt"), "a unit Dennis damaged is Taunted");
  assert.equal(tauntRef(unit(s, "b1")), "a1", "Taunted onto Dennis");
  // Unit that damages Dennis: b2 hits him.
  performAction(s, { unit: "b2", skillId: "taryn1", targets: ["a1"] });
  assert.ok(hasStatus(unit(s, "b2"), "taunt"), "a unit that damaged Dennis is Taunted");
  assert.equal(tauntRef(unit(s, "b2")), "a1", "Taunted onto Dennis");
});

test("HS-112 Fury Serum — the Taunt does not stack on a repeatedly-damaged enemy", () => {
  const s = D();
  addElement(s, "serum");
  performAction(s, { unit: "a1", skillId: "dennis2" });
  performAction(s, { unit: "a1", skillId: "dennis1", targets: ["b1"] });
  // Damage b1 again (inject a stack so a fresh Big Green Fist still lands after the first).
  const d = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "dennis1", targets: ["b1"] });
  const taunts = unit(s, "b1").statuses.filter((x) => x.kind === "taunt");
  assert.equal(taunts.length, 1, "Taunt refreshes rather than stacking (can not stack on enemies)");
});

// --------------------------------------------------------------------------- //
//  dennis3 — HS-46 Ascendant Serum
//  "Dennis takes 5 Affliction damage, ignores non-damage effects for 1 turn, and Big Green Fist deals
//   10 more damage until the end of his next turn."
// --------------------------------------------------------------------------- //
test("HS-46 Ascendant Serum — cost gate, 5 Affliction self-damage, non-damage immunity, +10 to Big Green Fist", () => {
  const s = D();
  const d = unit(s, "a1");
  // Cost gate: dennis3 costs 1 specific serum, absent from the base pool → not usable until serum is stocked.
  assert.equal(canUse(s, d, skillOf(d, "dennis3")), false, "unusable without serum energy (1 specific)");
  addElement(s, "serum");
  assert.equal(canUse(s, d, skillOf(d, "dennis3")), true, "usable once serum energy is available");

  const before = d.hp;
  performAction(s, { unit: "a1", skillId: "dennis3" });
  assert.equal(d.hp, before - 5, "takes 5 Affliction damage (ignores DR/shield)");
  assert.ok(hasStatus(d, "non_damage_ignore"), "ignores non-damage effects");
  assert.ok(hasStatus(d, "mark", "HS-46 Ascendant Serum"), "Ascendant mark armed for Big Green Fist");

  // The self-damage also triggered Pain Tolerance (Dennis was damaged) → 1 stack.
  assert.equal(stackMag(d, "Pain Tolerance"), 1, "self-damage triggers Pain Tolerance for 1 stack");
  const b3 = unit(s, "b3");
  const bh = b3.hp;
  performAction(s, { unit: "a1", skillId: "dennis1", targets: ["b3"] });
  // 10 base + 5 (one Pain Tolerance stack) + 10 (Ascendant) = 25.
  assert.equal(bh - b3.hp, 25, "Big Green Fist deals 10 more (10 + 5*1 stack + 10 = 25)");
});

// --------------------------------------------------------------------------- //
//  dennis4 — Shared Agony
//  "Dennis deals 5 damage to all enemy units, and all enemy units deal 5 Piercing damage to him."
// --------------------------------------------------------------------------- //
test("Shared Agony — 5 damage to every enemy, 5 Piercing back per enemy; cooldown 1", () => {
  const s = D();
  addElement(s, "serum");
  const d = unit(s, "a1");
  const dh = d.hp;
  const before = ["b1", "b2", "b3"].map((id) => unit(s, id).hp);
  performAction(s, { unit: "a1", skillId: "dennis4" });
  for (const [i, id] of ["b1", "b2", "b3"].entries()) {
    assert.equal(before[i] - unit(s, id).hp, 5, `enemy ${id} takes 5 damage`);
  }
  // Three enemies each deal 5 Piercing to Dennis. Piercing ignores DR, so all three land for 5 = 15.
  assert.equal(dh - d.hp, 15, "all three enemies deal 5 Piercing each (15 total) to Dennis");
  assert.equal(stackMag(d, "Pain Tolerance"), 3, "each Piercing hit triggers Pain Tolerance (3 stacks)");
  assert.equal(skillOf(d, "dennis4").currentCd, 1, "cooldown 1");
});

// --------------------------------------------------------------------------- //
//  dennis5 — HS-88 Reconstitution Serum
//  "Dennis heals 5 HP each turn (stacks)."
// --------------------------------------------------------------------------- //
test("HS-88 Reconstitution Serum — installs a 5 HP/turn regen; stacks; cooldown 1", () => {
  const s = D();
  const d = unit(s, "a1");
  d.hp = 50;
  performAction(s, { unit: "a1", skillId: "dennis5", targets: ["a1"] });
  assert.equal(regenMag(d), 5, "regen magnitude 5 after one cast");
  assert.equal(stackMag(d, "HS-88 Reconstitution Serum"), 1, "one stack after one cast");
  assert.equal(skillOf(d, "dennis5").currentCd, 1, "cooldown 1");

  // "(stacks)": a second cast grows the per-turn heal to 10.
  skillOf(d, "dennis5").currentCd = 0; // isolate the stacking clause from the cooldown
  performAction(s, { unit: "a1", skillId: "dennis5", targets: ["a1"] });
  assert.equal(stackMag(d, "HS-88 Reconstitution Serum"), 2, "stacks accumulate to 2");
  assert.equal(regenMag(d), 10, "per-turn heal grows to 5*2 = 10");
});

test("HS-88 Reconstitution Serum — actually heals 5 HP each turn", () => {
  const s = D();
  const d = unit(s, "a1");
  d.hp = 50;
  performAction(s, { unit: "a1", skillId: "dennis5", targets: ["a1"] });
  // Advance a full round-trip so Dennis's team ends a turn after the regen's birth turn.
  endTurn(s); // A ends (birth turn, no tick)
  startTurn(s); // B
  endTurn(s); // B ends
  startTurn(s); // A
  endTurn(s); // A ends -> regen should tick +5
  assert.equal(d.hp, 55, "Dennis heals 5 HP on his team's turn");
});

// --------------------------------------------------------------------------- //
//  dennis6 — End of Shift
//  "Dennis takes 25 Affliction damage, then uses HS-112 Fury Serum, HS-46 Ascendant Serum, and
//   HS-88 Reconstitution Serum on himself."
// --------------------------------------------------------------------------- //
test("End of Shift — 25 Affliction self-damage then casts the three serums on himself; cooldown 3", () => {
  const s = D();
  addElement(s, "serum");
  const d = unit(s, "a1");
  const before = d.hp; // 100
  performAction(s, { unit: "a1", skillId: "dennis6" });
  // 25 (End of Shift) + 5 (HS-46 self-damage) = 30 lost; HS-88 installs regen (no instant heal). 100 - 30 = 70.
  assert.equal(d.hp, before - 30, "takes 25 Affliction, plus the 5 from the inlined HS-46");
  assert.ok(hasStatus(d, "mark", "HS-112 Fury Serum"), "HS-112 Fury Serum was cast (Fury mark)");
  assert.ok(hasStatus(d, "mark", "HS-46 Ascendant Serum"), "HS-46 Ascendant Serum was cast (Ascendant mark)");
  assert.ok(hasStatus(d, "non_damage_ignore"), "HS-46 also granted non-damage immunity");
  assert.equal(regenMag(d), 5, "HS-88 Reconstitution Serum installed the 5 HP/turn regen");
  // Two affliction hits (25, then 5) each triggered Pain Tolerance → 2 stacks.
  assert.equal(stackMag(d, "Pain Tolerance"), 2, "the two self-damage events each granted a Pain Tolerance stack");
  assert.equal(skillOf(d, "dennis6").currentCd, 3, "cooldown 3");
});
