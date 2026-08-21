import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers fusion custom handlers
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — Zephyrex "Biting Wind" reactive aura + its fusion variants, on statusApplied.
//
// Frozen (skills.json):
//   Biting Wind (zephyrex0):        "Any time an enemy unit becomes invulnerable, Zephyrex deals 15
//                                    piercing damage to them first."
//   Fell Wind (ghost, zephyrexghost0):     "Biting Wind now causes health loss, which does not count
//                                    as any form of damage."
//   Winds of Summer (mechanic, zephyrexmechanic0): "Biting Wind and Elegant Sweep now deal Affliction
//                                    damage."
//   Vacuum Blade (ninja, zephyrexninja0):  "Any time Biting Wind or Wind Step triggers, Elegant Sweep
//                                    permanently deals 5 more damage."
//
// The recipient (`eventUnit`) is CORRECT: a statusApplied event carries the status RECIPIENT in
// `event.unit`, and the frozen text targets "them" = the enemy who just became invulnerable, i.e. the
// recipient, never the status's source. `eventTarget` does not resolve for statusApplied (no `target`
// field), which is the systemic bug the eventUnit fix repaired.
//
// SECOND latent bug found while locking these in: every one of these four `when` gates read
// `eventHasTag: "invulnerable"`. `eventHasTag` inspects `event.tags` — present only on
// skillDeclared/skillUsed (skill CLASS tags), NEVER on statusApplied. So the `and` gate was always
// false and the aura silently never fired even after the eventUnit fix. Fixed at the authored source
// (roster.authored.json + fusions.authored.json, regenerated) to the correct primitive
// `eventStatusKind: "invulnerable"`, which matches statusApplied's `event.kind`. These tests lock in
// that the aura now fires on an enemy becoming invulnerable and stays silent otherwise.

const hp = (state: { units: Record<string, { hp: number }> }, id: string) => state.units[id]!.hp;
const sweepDamage = (u: { skills?: { id: string; effects: unknown[] }[] }) => {
  const sweep = (u.skills ?? []).find((s) => s.id === "zephyrex2")!;
  const dmg = (sweep.effects as { op: string; amount?: number }[]).find((e) => e.op === "damage")!;
  return dmg.amount;
};

test("Biting Wind (base): enemy becoming invulnerable takes 15 piercing; ally / non-invuln status do not", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const ally = makeUnit({ id: "a2", team: "A", hp: 100, maxHp: 100 }); // an ALLY of Zephyrex
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph, ally], [foe, foe2]);

  // Positive: an enemy becomes invulnerable -> Zephyrex deals 15 piercing to that enemy (the recipient).
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "enemy gaining invulnerable takes 15 piercing (Biting Wind)");

  // Control A (faction gate): an ALLY becoming invulnerable must NOT trigger Biting Wind.
  emit(state, { type: "statusApplied", unit: "a2", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "a2"), 100, "an ally becoming invulnerable does not trigger Biting Wind");

  // Control B (status-kind gate): a NON-invulnerable status on an enemy must NOT trigger it.
  emit(state, { type: "statusApplied", unit: "e2", source: "zx", kind: "stun" });
  assert.equal(hp(state, "e2"), 100, "a non-invulnerable status on an enemy does not trigger Biting Wind");
});

test("Fell Wind (ghost): Biting Wind now causes health loss on the newly-invulnerable enemy", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyFusion(zeph, fusionForm("zephyrex", "ghost")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);

  // Positive: enemy becomes invulnerable -> 15 health loss to that enemy (op is healthLoss, not damage).
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "Fell Wind: enemy gaining invulnerable loses 15 health");

  // Control: a non-invulnerable status must NOT fire it (no further health loss).
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "poison" });
  assert.equal(hp(state, "e1"), 85, "Fell Wind does not fire on a non-invulnerable status");
});

test("Winds of Summer (mechanic): Biting Wind deals 15 to the newly-invulnerable enemy (Affliction)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyFusion(zeph, fusionForm("zephyrex", "mechanic")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);

  // Positive: enemy becomes invulnerable -> 15 affliction to that enemy.
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "Winds of Summer: enemy gaining invulnerable takes 15 (affliction)");

  // Control: a non-invulnerable status must NOT fire it.
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "burn" });
  assert.equal(hp(state, "e1"), 85, "Winds of Summer does not fire on a non-invulnerable status");
});

test("Vacuum Blade (ninja): Biting Wind fires AND permanently raises Elegant Sweep by 5", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyFusion(zeph, fusionForm("zephyrex", "ninja")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe, foe2]);

  assert.equal(sweepDamage(state.units["zx"]!), 25, "Elegant Sweep starts at 25 piercing");

  // Positive: enemy becomes invulnerable -> 15 piercing to that enemy AND Elegant Sweep +5 (permanent).
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "Vacuum Blade: enemy gaining invulnerable takes 15 piercing (Biting Wind)");
  assert.equal(sweepDamage(state.units["zx"]!), 30, "each Biting Wind trigger permanently bumps Elegant Sweep by 5");

  // A second enemy becoming invulnerable compounds the Elegant Sweep bump again.
  emit(state, { type: "statusApplied", unit: "e2", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "e2"), 85, "second invulnerable enemy also takes 15 piercing");
  assert.equal(sweepDamage(state.units["zx"]!), 35, "Elegant Sweep bump compounds per Biting Wind trigger");

  // Control: a non-invulnerable status must NOT fire it — no damage, no further Elegant Sweep bump.
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "slow" });
  assert.equal(hp(state, "e1"), 85, "no extra damage on a non-invulnerable status");
  assert.equal(sweepDamage(state.units["zx"]!), 35, "Elegant Sweep does not bump on a non-invulnerable status");
});
