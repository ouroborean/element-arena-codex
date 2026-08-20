import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDamage, totalShield } from "../src/damage.ts";
import { runEffects, emit } from "../src/effects/interpret.ts";
import { removeStatus } from "../src/status.ts";
import { applyPatch } from "../content/augment.ts";
import "../content/hero.ts"; // side-effect: registers the augment/custom handlers
import { makeState, makeUnit, status } from "./helpers.ts";

// Engine-fidelity PR1 — damage-pipeline debt retired:
//   keeper4 "Good Pacing"   → shield_absorb_cap (per-hit shield-absorb cap)
//   jarrik4 "Blackened Soul" → split_incoming    (single-target hits split across the holder + Cinders)

// --- keeper4 / shield_absorb_cap ---------------------------------------------- //

test("shield_absorb_cap: a single hit absorbs at most `cap` shield; the overflow falls to HP", () => {
  const u = makeUnit({ hp: 100, shield: 100, statuses: [status("shield_absorb_cap", { magnitude: 20 })] });
  const r = applyDamage(u, { amount: 50, type: "normal" });
  assert.equal(r.shieldAbsorbed, 20, "only 20 shield spent absorbing this hit");
  assert.equal(r.hpLost, 30, "the remaining 30 falls through to HP");
  assert.equal(totalShield(u), 80, "80 shield remains");
  assert.equal(r.shieldBroke, false, "shield not broken — 80 still stands");
  assert.equal(u.hp, 70);
});

test("shield_absorb_cap: a hit at or under the cap is fully absorbed", () => {
  const u = makeUnit({ hp: 100, shield: 100, statuses: [status("shield_absorb_cap", { magnitude: 20 })] });
  const r = applyDamage(u, { amount: 15, type: "normal" });
  assert.equal(r.shieldAbsorbed, 15);
  assert.equal(r.hpLost, 0);
});

test("keeper4 Good Pacing installs the cap + a durable roundStart re-apply", () => {
  const keeper = makeUnit({ id: "keeper", team: "A", shield: 100 });
  applyPatch(keeper, { op: "custom", fn: "capShieldAbsorbPerHit", args: { of: "self", max: 20 } });

  const cap = keeper.statuses.find((s) => s.kind === "shield_absorb_cap");
  assert.ok(cap && cap.magnitude === 20, "cap applied immediately for the drafted round");
  const trig = (keeper.triggers ?? []).find((t) => t.source === "Good Pacing" && t.on === "roundStart");
  assert.ok(trig, "durable roundStart trigger installed");
  assert.equal(trig!.duration, undefined, "trigger is static — survives startRound's dynamic-trigger wipe");

  // Prove it re-applies after a round wipe: drop the status, fire roundStart, it returns.
  removeStatus(keeper, "shield_absorb_cap");
  const state = makeState([keeper], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" });
  assert.ok(
    keeper.statuses.some((s) => s.kind === "shield_absorb_cap" && s.magnitude === 20),
    "roundStart re-applied the cap",
  );
});

// --- jarrik4 / split_incoming -------------------------------------------------- //

test("split_incoming: a single-target skill's hit splits evenly across Jarrik + his Cinders-marked enemies", () => {
  const jarrik = makeUnit({ id: "a1", team: "A", hp: 100, statuses: [status("split_incoming", { name: "Cinders" })] });
  const attacker = makeUnit({ id: "b1", team: "B", hp: 100 });
  const c2 = makeUnit({ id: "b2", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const c3 = makeUnit({ id: "b3", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const state = makeState([jarrik], [attacker, c2, c3]);

  // b1 lands a 30 single-target hit on Jarrik → split three ways (Jarrik + b2 + b3) → 10 each.
  runEffects(state, [{ op: "damage", amount: 30, to: "target" }], { caster: attacker, targets: [jarrik], targeting: "single" });
  assert.equal(jarrik.hp, 90, "Jarrik took his 1/3 share");
  assert.equal(c2.hp, 90, "Cinders-bearer b2 took a share");
  assert.equal(c3.hp, 90, "Cinders-bearer b3 took a share");
  assert.equal(attacker.hp, 100, "the attacker (no Cinders) is untouched");
});

test("split_incoming: redistributed shares are credited to Jarrik, not the attacker (no friendly-fire reactions)", () => {
  const jarrik = makeUnit({ id: "a1", team: "A", hp: 100, statuses: [status("split_incoming", { name: "Cinders" })] });
  // The attacker has a real on-deal-damage reaction (heal 5 whenever IT deals damage) — the exact shape of
  // Sanguine Spectre / Hunger for Battle. It must fire ONCE (its own hit on Jarrik), not again on the
  // redistributed share that lands on its own ally.
  const attacker = makeUnit({
    id: "b1", team: "B", hp: 50, maxHp: 100,
    triggers: [{ on: "damageDealt", owner: "b1", source: "Lifesteal", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "heal", to: "self", amount: 5 }] }],
  });
  const ally = makeUnit({ id: "b2", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const state = makeState([jarrik], [attacker, ally]);

  runEffects(state, [{ op: "damage", amount: 30, to: "target" }], { caster: attacker, targets: [jarrik], targeting: "single" });
  assert.equal(jarrik.hp, 85, "Jarrik took his 1/2 share (15)");
  assert.equal(ally.hp, 85, "the Cinders ally took the redistributed 1/2 share (15)");
  assert.equal(attacker.hp, 55, "the attacker's on-deal heal fired once (its hit on Jarrik), NOT on the friendly-fire share");
});

test("split_incoming: an all-enemies AOE that resolves to one enemy is NOT split (keys on declared targeting)", () => {
  const jarrik = makeUnit({ id: "a1", team: "A", hp: 100, statuses: [status("split_incoming", { name: "Cinders" })] });
  const attacker = makeUnit({ id: "b1", team: "B", hp: 100 });
  const cinder = makeUnit({ id: "b2", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const state = makeState([jarrik], [attacker, cinder]); // Jarrik is the sole enemy → AOE resolves to [jarrik]

  runEffects(state, [{ op: "damage", amount: 30, to: { faction: "enemies" } }], { caster: attacker, targets: [], targeting: "all-enemies" });
  assert.equal(jarrik.hp, 70, "Jarrik takes the full AOE hit — an AOE resolving to one enemy is not single-target");
  assert.equal(cinder.hp, 100, "Cinders-bearer untouched");
});

test("split_incoming: a forEach-decomposed AOE is NOT split (each hit is a single-defender op, but the skill is AOE)", () => {
  const jarrik = makeUnit({ id: "a1", team: "A", hp: 100, statuses: [status("split_incoming", { name: "Cinders" })] });
  const ally = makeUnit({ id: "a2", team: "A", hp: 100 });
  const attacker = makeUnit({ id: "b1", team: "B", hp: 100 });
  const cinder = makeUnit({ id: "b2", team: "B", hp: 100, statuses: [status("mark", { name: "Cinders" })] });
  const state = makeState([jarrik, ally], [attacker, cinder]);

  runEffects(
    state,
    [{ op: "forEach", each: { faction: "enemies" }, do: [{ op: "damage", amount: 30, to: "it" }] }],
    { caster: attacker, targets: [], targeting: "all-enemies" },
  );
  assert.equal(jarrik.hp, 70, "the forEach's per-enemy hit on Jarrik is not split — the skill is AOE");
  assert.equal(cinder.hp, 100, "Cinders-bearer untouched");
});

test("split_incoming with no Cinders bearers: full damage lands on Jarrik alone", () => {
  const jarrik = makeUnit({ id: "a1", team: "A", hp: 100, statuses: [status("split_incoming", { name: "Cinders" })] });
  const attacker = makeUnit({ id: "b1", team: "B", hp: 100 });
  const state = makeState([jarrik], [attacker]);
  runEffects(state, [{ op: "damage", amount: 30, to: "target" }], { caster: attacker, targets: [jarrik], targeting: "single" });
  assert.equal(jarrik.hp, 70, "amount / (1 + 0 co-bearers) = the full amount");
});

test("jarrik4 Blackened Soul installs split_incoming + a durable roundStart re-apply", () => {
  const jarrik = makeUnit({ id: "jarrik", team: "A" });
  applyPatch(jarrik, { op: "custom", fn: "splitIncomingSingleTargetDamageAcrossCinders", args: { of: "self" } });
  assert.ok(
    jarrik.statuses.some((s) => s.kind === "split_incoming" && s.name === "Cinders"),
    "split_incoming applied",
  );
  const trig = (jarrik.triggers ?? []).find((t) => t.source === "Blackened Soul" && t.on === "roundStart");
  assert.ok(trig && trig.duration === undefined, "durable static roundStart trigger installed");
});
