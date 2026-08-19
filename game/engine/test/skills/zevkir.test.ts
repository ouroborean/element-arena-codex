/**
 * Behavior tests for Tidecaller Zev'kir (zevkir0..zevkir5), asserted against the frozen skill prose in
 * game/content/frozen/skills.json. Assertions encode what the description PROMISES; a clean failure is a
 * reported engine bug, never something to weaken.
 *
 * Oracle (frozen descriptions):
 *  - zevkir0 Oceans Gather (passive): "When Zev'kir reaches 1 stack of Call Tides, he gains Elemental
 *      Essence. When he reaches 2 stacks, his harmful skills will stun their primary target for 1 turn.
 *      When he reaches 3 stacks, his skills affect all valid targets."
 *  - zevkir1 Call Tides: "Zev'kir begins Channeling, gaining a stack of Call Tides each turn. These stacks
 *      are consumed on him using a new non-Strategic skill." (Strategic, Channel; cost 1 generic; cd 2)
 *  - zevkir2 Riptide: "Zev'kir deals 5 damage to target enemy, increased by 10 damage per stack of Call
 *      Tides Zev'kir has." (Harmful, Instant; cost 1 water; cd 1)
 *  - zevkir3 Bubble Prison: "Zev'kir deals 15 damage to target enemy for 1 turn, increased by 1 turn per
 *      stack of Call Tides Zev'kir has. This skill will end if Zev'kir is stunned." (Harmful, Control; cost
 *      1 generic + 1 water; cd 1)
 *  - zevkir4 Repulse: "Zev'kir counters the first harmful skill received by target ally. If a skill is
 *      countered, Zev'kir will automatically begin channeling Call Tides. This effect is invisible."
 *      (Helpful, Instant, hidden; cost 1 generic; cd 3)
 *  - zevkir5 Tidal Wave: "Zev'kir deals 45 piercing damage to target enemy. This skill costs 1 less [water]
 *      per stack of Call Tides Zev'kir has." (Harmful, Instant; cost 5 water; cd 1)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  battle, unit, skillOf, hasStatus, stackMag, shieldTotal,
  performAction, canUse, effectiveCost, startTurn, endTurn, emit,
} from "../skillHarness.ts";
import type { MatchState, Unit } from "../../src/types.ts";

/** Give Zev'kir exactly n raw Call Tides stacks (single merged stack status), bypassing the passive trigger. */
function setTides(u: Unit, n: number): void {
  u.statuses = u.statuses.filter((s) => !(s.kind === "stack" && s.name === "Call Tides"));
  if (n > 0) u.statuses.push({ kind: "stack", name: "Call Tides", magnitude: n, duration: null, appliedBy: u.id, appliedTurn: 0 });
}

/** A damage-safe roster: Zev'kir at a1; enemies whose passives don't add DR/shield when merely struck. */
const A = ["zevkir", "gommar", "roland"];
const B = ["xyris", "laria", "taryn"];

/** Advance from the active A-turn back to A's next turn start (so channels/DoTs anchored to A tick once). */
function cycleToNextATurn(s: MatchState): void {
  endTurn(s);   // end A -> hand to B
  startTurn(s); // begin B
  endTurn(s);   // end B -> hand to A
  startTurn(s); // begin A (runs A channels)
}

// --------------------------------------------------------------------------- //
//  zevkir0 — Oceans Gather (passive)
// --------------------------------------------------------------------------- //

test("Oceans Gather clause 1: reaching 1 Call Tides stack grants Elemental Essence", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  assert.equal(hasStatus(z, "elemental_essence"), false, "starts with no Essence charge");
  performAction(s, { unit: "a1", skillId: "zevkir1" }); // Call Tides -> reach 1 stack
  assert.equal(stackMag(z, "Call Tides"), 1, "Call Tides at 1 after casting it");
  assert.equal(hasStatus(z, "elemental_essence"), true, "gains Elemental Essence on reaching 1 stack");
});

test("Oceans Gather clause 2: at 2 stacks a harmful skill stuns its primary target for 1 turn; at 1 it does not", () => {
  // Base (1 stack): no stun.
  let s = battle(A, B);
  setTides(unit(s, "a1"), 1);
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] });
  assert.equal(hasStatus(unit(s, "b1"), "stun"), false, "1 stack -> no stun");

  // Threshold (2 stacks): primary target stunned for 1 turn.
  s = battle(A, B);
  setTides(unit(s, "a1"), 2);
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] });
  const b1 = unit(s, "b1");
  assert.equal(hasStatus(b1, "stun"), true, "2 stacks -> primary target stunned");
  const stun = b1.statuses.find((x) => x.kind === "stun")!;
  assert.equal(stun.duration, 1, "stun lasts 1 turn");
});

test("Oceans Gather clause 3: at 3 stacks skills affect all valid targets; below 3 only the primary", () => {
  // Below threshold (2 stacks): Riptide hits only the primary.
  let s = battle(A, B);
  setTides(unit(s, "a1"), 2);
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 100 - 25, "primary hit (5 + 10*2)");
  assert.equal(unit(s, "b2").hp, 100, "non-primary untouched below 3 stacks");
  assert.equal(unit(s, "b3").hp, 100, "non-primary untouched below 3 stacks");

  // Threshold (3 stacks): Riptide hits every enemy for 5 + 10*3 = 35.
  s = battle(A, B);
  setTides(unit(s, "a1"), 3);
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 100 - 35, "all-enemies: primary");
  assert.equal(unit(s, "b2").hp, 100 - 35, "all-enemies: second");
  assert.equal(unit(s, "b3").hp, 100 - 35, "all-enemies: third");
});

// --------------------------------------------------------------------------- //
//  zevkir1 — Call Tides
// --------------------------------------------------------------------------- //

test("Call Tides: casting gains 1 stack, installs a channel, and (Strategic) does NOT consume stacks; cd 2, cost 1 generic", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  setTides(z, 2); // pre-existing stacks
  performAction(s, { unit: "a1", skillId: "zevkir1" });
  assert.equal(stackMag(z, "Call Tides"), 3, "Strategic skill: +1 gained, existing stacks NOT consumed");
  assert.equal(hasStatus(z, "channeling", "zevkir1"), true, "begins Channeling Call Tides");
  const k = skillOf(z, "zevkir1");
  assert.equal(k.cost.generic, 1, "cost is 1 generic");
  assert.equal(k.currentCd, 2, "cooldown is 2 after use");
  assert.equal(canUse(s, z, k), false, "on cooldown right after use");
});

test("Call Tides channels: gains another stack at Zev'kir's next turn", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "zevkir1" });
  assert.equal(stackMag(z, "Call Tides"), 1, "1 stack immediately on cast");
  cycleToNextATurn(s);
  assert.equal(stackMag(z, "Call Tides"), 2, "channel re-runs at A's next turn: +1 stack");
});

test("Call Tides stacks are consumed when Zev'kir uses a non-Strategic skill", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  setTides(z, 3);
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] }); // Riptide is non-Strategic
  assert.equal(stackMag(z, "Call Tides"), 0, "non-Strategic use consumes Call Tides");
});

// --------------------------------------------------------------------------- //
//  zevkir2 — Riptide
// --------------------------------------------------------------------------- //

test("Riptide: 5 damage + 10 per Call Tides stack; cost 1 water; cd 1", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  const k = skillOf(z, "zevkir2");
  assert.equal(k.cost.specific, 1, "costs 1 specific (water)");
  assert.equal(k.cost.generic, 0, "no generic cost");

  // 0 stacks -> 5 damage.
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 95, "0 stacks: 5 damage");
  assert.equal(skillOf(z, "zevkir2").currentCd, 1, "cooldown 1 after use");
});

test("Riptide scales +10 per stack (1 stack -> 15 damage)", () => {
  const s = battle(A, B);
  setTides(unit(s, "a1"), 1);
  performAction(s, { unit: "a1", skillId: "zevkir2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 100 - 15, "1 stack: 5 + 10 = 15 damage");
});

// --------------------------------------------------------------------------- //
//  zevkir3 — Bubble Prison
// --------------------------------------------------------------------------- //

test("Bubble Prison: 15 dmg/turn DoT for (1 + stacks) turns; cost 1 generic + 1 water; cd 1", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  const k = skillOf(z, "zevkir3");
  assert.equal(k.cost.generic, 1, "cost 1 generic");
  assert.equal(k.cost.specific, 1, "cost 1 water");

  // 0 stacks -> duration 1.
  performAction(s, { unit: "a1", skillId: "zevkir3", targets: ["b1"] });
  const dot = unit(s, "b1").statuses.find((x) => x.kind === "dot" && x.name === "Bubble Prison");
  assert.ok(dot, "Bubble Prison DoT applied to target");
  assert.equal(dot!.magnitude, 15, "15 damage per tick");
  assert.equal(dot!.duration, 1, "0 stacks -> lasts 1 turn");
  assert.equal(skillOf(z, "zevkir3").currentCd, 1, "cooldown 1");

  // The DoT deals 15 on its next tick (Zev'kir's team's turn-end, past the birth turn).
  cycleToNextATurn(s);
  endTurn(s); // A's turn-end at turn > birth turn: the DoT ticks here
  assert.equal(unit(s, "b1").hp, 85, "DoT dealt 15 damage over one tick");
});

test("Bubble Prison duration scales +1 turn per stack (2 stacks -> 3 turns)", () => {
  const s = battle(A, B);
  setTides(unit(s, "a1"), 2);
  performAction(s, { unit: "a1", skillId: "zevkir3", targets: ["b1"] });
  const dot = unit(s, "b1").statuses.find((x) => x.kind === "dot" && x.name === "Bubble Prison");
  assert.ok(dot, "DoT applied");
  assert.equal(dot!.duration, 3, "2 stacks -> 1 + 2 = 3 turns");
});

test("Bubble Prison ends if Zev'kir is stunned", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "zevkir3", targets: ["b1"] });
  assert.ok(unit(s, "b1").statuses.some((x) => x.kind === "dot" && x.name === "Bubble Prison"), "DoT present before stun");
  // Zev'kir becomes stunned -> the passive/trigger clears Bubble Prison from enemies.
  z.statuses.push({ kind: "stun", duration: 1, appliedBy: "b1", appliedTurn: s.turn });
  emit(s, { type: "statusApplied", unit: "a1", source: "b1", kind: "stun" });
  assert.equal(
    unit(s, "b1").statuses.some((x) => x.kind === "dot" && x.name === "Bubble Prison"),
    false,
    "Bubble Prison ends when Zev'kir is stunned",
  );
});

// --------------------------------------------------------------------------- //
//  zevkir4 — Repulse
// --------------------------------------------------------------------------- //

test("Repulse: marks target ally; cost 1 generic; cd 3", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  const k = skillOf(z, "zevkir4");
  assert.equal(k.cost.generic, 1, "cost 1 generic");
  performAction(s, { unit: "a1", skillId: "zevkir4", targets: ["a2"] });
  assert.equal(hasStatus(unit(s, "a2"), "mark", "Repulse"), true, "target ally receives the Repulse mark");
  assert.equal(skillOf(z, "zevkir4").currentCd, 3, "cooldown 3 after use");
});

test("Repulse at 3 stacks affects all allies (Oceans Gather clause 3)", () => {
  const s = battle(A, B);
  setTides(unit(s, "a1"), 3);
  performAction(s, { unit: "a1", skillId: "zevkir4", targets: ["a2"] });
  assert.equal(hasStatus(unit(s, "a1"), "mark", "Repulse"), true, "self marked");
  assert.equal(hasStatus(unit(s, "a2"), "mark", "Repulse"), true, "ally 2 marked");
  assert.equal(hasStatus(unit(s, "a3"), "mark", "Repulse"), true, "ally 3 marked");
});

test("Repulse counters the first harmful skill on the marked ally, consumes the mark, and Zev'kir begins channeling Call Tides", () => {
  const s = battle(["zevkir", "gommar", "roland"], ["pyrrha", "xyris", "taryn"]);
  const z = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "zevkir4", targets: ["a3"] }); // mark ally a3
  assert.equal(hasStatus(unit(s, "a3"), "mark", "Repulse"), true, "a3 marked");

  const a3HpBefore = unit(s, "a3").hp;
  // Enemy xyris (b2) uses a harmful single-target skill on the marked ally -> must be countered.
  // xyris1 deals 15 to an unmarked ally, so a countered cast must leave a3 at full HP.
  const r = performAction(s, { unit: "b2", skillId: "xyris1", targets: ["a3"] });
  assert.equal(r.ok, true, "the harmful action was declared");
  assert.equal(unit(s, "a3").hp, a3HpBefore, "the countered harmful skill dealt no damage");
  assert.equal(hasStatus(unit(s, "a3"), "mark", "Repulse"), false, "the Repulse mark was consumed");
  assert.equal(hasStatus(z, "channeling", "zevkir1"), true, "Zev'kir begins Channeling Call Tides after countering");
});

// --------------------------------------------------------------------------- //
//  zevkir5 — Tidal Wave
// --------------------------------------------------------------------------- //

test("Tidal Wave: 45 piercing damage to target (ignores Damage Reduction); base cost 5 water; cd 1", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  const b1 = unit(s, "b1");
  b1.statuses.push({ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "b1", appliedTurn: 0 });
  const k = skillOf(z, "zevkir5");
  assert.equal(k.cost.specific, 5, "base cost 5 water");
  performAction(s, { unit: "a1", skillId: "zevkir5", targets: ["b1"] });
  assert.equal(b1.hp, 55, "45 piercing lands in full through 10 DR (piercing ignores DR)");
  assert.equal(skillOf(z, "zevkir5").currentCd, 1, "cooldown 1");
});

test("Tidal Wave costs 1 less water per Call Tides stack", () => {
  const s = battle(A, B);
  const z = unit(s, "a1");
  setTides(z, 2);
  const cost = effectiveCost(z, skillOf(z, "zevkir5"));
  assert.equal(cost.specific, 3, "5 - 2 stacks = 3 water");
});
