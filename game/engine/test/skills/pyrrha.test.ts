/**
 * Behavior tests for Pyrrha, the Mage in Ivory, asserted against the frozen skill prose (the oracle):
 *
 *   pyrrha0 Burning Up      — "When an enemy affected by Fan the Flames damages Pyrrha, she gains
 *                             Elemental Essence. When Pyrrha dies, she deals 10 Affliction damage to
 *                             all targetable enemies."
 *   pyrrha1 Fan the Flames  — "Deals 15 Affliction damage to target enemy, then 5 Affliction damage for
 *                             the next 3 turns. Using this skill on an affected enemy will refresh the duration."
 *   pyrrha2 Feed the Fire   — "Deals 10 Affliction damage to target enemy affected by Fan the Flames.
 *                             Pyrrha heals 10 HP and gains Elemental Essence."
 *   pyrrha3 Pyrokinesis     — "Deals 20 Affliction damage to target enemy. If the target is affected by
 *                             Fan the Flames, they take 5 more damage from it for the rest of its duration."
 *   pyrrha4 Flashbang       — "Stuns target enemy's non-Strategic skills for 1 turn. Pyrrha becomes
 *                             Invulnerable for 1 turn."
 *   pyrrha5 Wraith in White — "Pyrrha ignores non-damage effects for 2 turns. During this time, using
 *                             Pyrokinesis on an enemy will first use Fan the Flames."
 *
 * Pyrrha sits at a1; b1/b2/b3 are the enemies. b1 is Jarrik (has both a Harmful and a Strategic skill,
 * used by the Flashbang test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, shieldTotal, performAction, canUse, startTurn, endTurn } from "../skillHarness.ts";
import { runEffects } from "../../src/effects/interpret.ts";

const A: [string, string, string] = ["pyrrha", "gommar", "syl"];
const B: [string, string, string] = ["jarrik", "laria", "xyris"];

const essence = (u: ReturnType<typeof unit>) => u.statuses.filter((x) => x.kind === "elemental_essence").length;
const fanDot = (u: ReturnType<typeof unit>) => u.statuses.find((x) => x.kind === "dot" && x.name === "Fan the Flames");

// --------------------------------------------------------------------------- //
//  pyrrha1 — Fan the Flames
// --------------------------------------------------------------------------- //

test("Fan the Flames — 15 Affliction up front, then a 5/turn burn for 3 turns", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "15 Affliction damage immediately");
  const dot = fanDot(unit(s, "b1"));
  assert.ok(dot, "target carries the Fan the Flames burn");
  assert.equal(dot!.magnitude, 5, "burn ticks for 5");
  assert.equal(dot!.duration, 3, "burn lasts 3 turns");
  assert.equal(dot!.dtype, "affliction", "burn is Affliction");
  // The burn ticks 5 on each of Pyrrha's (team A) turn-ends, 3 times: 85 -> 70.
  endTurn(s); // A end (birth turn — no tick)
  assert.equal(unit(s, "b1").hp, 85);
  endTurn(s); // B end — not team A's dot
  assert.equal(unit(s, "b1").hp, 85);
  endTurn(s); // A end — tick 1
  assert.equal(unit(s, "b1").hp, 80);
  endTurn(s); // B
  endTurn(s); // A end — tick 2
  assert.equal(unit(s, "b1").hp, 75);
  endTurn(s); // B
  endTurn(s); // A end — tick 3, then expires
  assert.equal(unit(s, "b1").hp, 70, "15 + 3x5 = 30 total");
  assert.ok(!fanDot(unit(s, "b1")), "burn expired after exactly 3 ticks");
});

test("Fan the Flames — Affliction ignores Shield and Damage Reduction", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  b1.shields.push({ amount: 30, duration: null, appliedBy: "x", appliedTurn: 0 });
  b1.statuses.push({ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 });
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] });
  assert.equal(b1.hp, 85, "full 15 Affliction lands past Shield and DR");
  assert.equal(shieldTotal(b1), 30, "Shield is untouched by Affliction");
});

test("Fan the Flames — recasting on an affected enemy refreshes the burn's duration", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] }); // burn dur 3
  endTurn(s); // A end (no tick, birth)
  endTurn(s); // B
  endTurn(s); // A end — tick 1, duration 3 -> 2
  assert.equal(fanDot(unit(s, "b1"))!.duration, 2, "burn ticked down to 2");
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] }); // recast
  assert.equal(fanDot(unit(s, "b1"))!.duration, 3, "recasting refreshed the burn back to 3 turns");
});

// --------------------------------------------------------------------------- //
//  pyrrha2 — Feed the Fire
// --------------------------------------------------------------------------- //

test("Feed the Fire — 10 Affliction to a Fan-affected enemy, plus heal 10 and Essence", () => {
  const s = battle(A, B);
  const p = unit(s, "a1");
  p.hp = 90;
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] }); // Fan: b1 -> 85
  performAction(s, { unit: "a1", skillId: "pyrrha2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 75, "10 Affliction because the target is affected");
  assert.equal(p.hp, 100, "Pyrrha heals 10");
  assert.equal(essence(p), 1, "Pyrrha gains Elemental Essence");
  assert.equal(skillOf(p, "pyrrha2").currentCd, 2, "Feed the Fire goes on a 2-turn cooldown");
});

test("Feed the Fire — no damage on an unaffected enemy, but Pyrrha still heals and gains Essence", () => {
  const s = battle(A, B);
  const p = unit(s, "a1");
  p.hp = 90;
  performAction(s, { unit: "a1", skillId: "pyrrha2", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 100, "no burn on the target -> no damage");
  assert.equal(p.hp, 100, "heal is unconditional (10)");
  assert.equal(essence(p), 1, "Essence is unconditional");
});

// --------------------------------------------------------------------------- //
//  pyrrha3 — Pyrokinesis
// --------------------------------------------------------------------------- //

test("Pyrokinesis — 20 Affliction to an unaffected target, no burn added", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 80, "flat 20 Affliction");
  assert.ok(!fanDot(unit(s, "b1")), "Pyrokinesis alone applies no burn");
  assert.equal(skillOf(unit(s, "a1"), "pyrrha3").currentCd, 1, "Pyrokinesis goes on a 1-turn cooldown");
});

test("Pyrokinesis — on a Fan-affected target, 20 now and the burn deepens by 5", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] }); // Fan: 85, burn 5
  performAction(s, { unit: "a1", skillId: "pyrrha3", targets: ["b1"] }); // +20 -> 65
  assert.equal(unit(s, "b1").hp, 65, "20 Affliction on top of the Fan hit");
  assert.equal(fanDot(unit(s, "b1"))!.magnitude, 10, "burn amplified 5 -> 10 for the rest of its duration");
  // "5 more damage from it": the deepened burn ticks 10, not 5.
  endTurn(s); // A end (birth for the amplify)
  endTurn(s); // B
  endTurn(s); // A end — tick at the new magnitude
  assert.equal(unit(s, "b1").hp, 55, "the burn tick now deals 10");
});

// --------------------------------------------------------------------------- //
//  pyrrha4 — Flashbang
// --------------------------------------------------------------------------- //

test("Flashbang — stuns the target's non-Strategic skills for 1 turn; Pyrrha turns Invulnerable", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha4", targets: ["b1"] });
  const p = unit(s, "a1");
  assert.ok(hasStatus(p, "invulnerable"), "Pyrrha is Invulnerable");
  const inv = p.statuses.find((x) => x.kind === "invulnerable")!;
  assert.equal(inv.duration, 1, "Invulnerable lasts 1 turn");
  const stun = unit(s, "b1").statuses.find((x) => x.kind === "stun")!;
  assert.ok(stun, "target is stunned");
  assert.equal(stun.duration, 1, "stun lasts 1 turn");
  assert.deepEqual(stun.scope, { tag: "Strategic", mode: "except" }, "stun applies to every skill EXCEPT Strategic ones");
  assert.equal(skillOf(p, "pyrrha4").currentCd, 4, "Flashbang goes on a 4-turn cooldown");
  // Behavioral proof: b1's Harmful (non-Strategic) skill is blocked, its Strategic skill is not.
  assert.equal(performAction(s, { unit: "b1", skillId: "jarrik1", targets: ["a1"] }).reason, "stunned", "non-Strategic skill blocked");
  assert.notEqual(performAction(s, { unit: "b1", skillId: "jarrik3" }).reason, "stunned", "Strategic skill is not stunned");
});

test("Flashbang — Invulnerable actually blocks a fresh Harmful skill aimed at Pyrrha", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha4", targets: ["b1"] }); // b1 stunned, Pyrrha Invulnerable
  // b2 (unstunned) tries a single-target Harmful skill on Pyrrha; Invulnerable removes her as a legal target.
  const r = performAction(s, { unit: "b2", skillId: "laria1", targets: ["a1"] });
  assert.equal(r.reason, "no-legal-target", "an Invulnerable Pyrrha cannot be targeted by a new Harmful skill");
  assert.equal(unit(s, "a1").hp, 100, "Pyrrha takes no damage");
});

// --------------------------------------------------------------------------- //
//  pyrrha5 — Wraith in White
// --------------------------------------------------------------------------- //

test("Wraith in White — grants the 2-turn non-damage-ignore window", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha5" });
  const p = unit(s, "a1");
  const ndi = p.statuses.find((x) => x.kind === "non_damage_ignore")!;
  assert.ok(ndi, "Pyrrha gains the non-damage-ignore status");
  assert.equal(ndi.duration, 2, "it lasts 2 turns");
  assert.equal(skillOf(p, "pyrrha5").currentCd, 3, "Wraith in White goes on a 3-turn cooldown");
});

test("Wraith in White — while active, Pyrrha ignores an incoming non-damage effect (a stun)", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha5" });
  const p = unit(s, "a1");
  // An enemy applies a Harmful non-damage effect (stun) to Pyrrha; the prose says she ignores it.
  runEffects(s, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { caster: unit(s, "b1"), targets: [p] });
  assert.ok(!hasStatus(p, "stun"), "the stun is ignored while Wraith in White is active");
});

test("Wraith in White — during the window, Pyrokinesis leads with Fan the Flames", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha5" });
  performAction(s, { unit: "a1", skillId: "pyrrha3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 65, "Fan the Flames (15) is used first, then Pyrokinesis (20) = 35");
  assert.ok(fanDot(unit(s, "b1")), "the leading Fan the Flames applied its burn");
  assert.equal(fanDot(unit(s, "b1"))!.magnitude, 10, "Fan applied (5), then Pyrokinesis deepened it (+5) since it now reads as affected");
});

// --------------------------------------------------------------------------- //
//  pyrrha0 — Burning Up (passive)
// --------------------------------------------------------------------------- //

test("Burning Up — a Fan-affected enemy damaging Pyrrha grants her Elemental Essence", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "pyrrha1", targets: ["b1"] }); // Fan on b1
  const p = unit(s, "a1");
  runEffects(s, [{ op: "damage", amount: 10, to: "target" }], { caster: unit(s, "b1"), targets: [p] });
  assert.equal(essence(p), 1, "the affected attacker's hit grants Pyrrha Essence");
});

test("Burning Up — an UNaffected enemy damaging Pyrrha grants nothing", () => {
  const s = battle(A, B);
  const p = unit(s, "a1");
  runEffects(s, [{ op: "damage", amount: 10, to: "target" }], { caster: unit(s, "b2"), targets: [p] });
  assert.equal(essence(p), 0, "no Fan on the attacker -> no Essence");
});

test("Burning Up — on death, Pyrrha deals 10 Affliction to all targetable enemies", () => {
  const s = battle(A, B);
  const p = unit(s, "a1");
  runEffects(s, [{ op: "damage", amount: 100, to: "target" }], { caster: unit(s, "b1"), targets: [p] });
  assert.equal(p.alive, false, "Pyrrha is dead");
  assert.equal(unit(s, "b1").hp, 90, "10 Affliction to b1 on death");
  assert.equal(unit(s, "b2").hp, 90, "10 Affliction to b2 on death");
  assert.equal(unit(s, "b3").hp, 90, "10 Affliction to b3 on death");
});
