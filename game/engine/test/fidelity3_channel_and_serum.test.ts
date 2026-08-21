import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { performAction, runChannels } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — two fixes that required an engine hook rather than a content swap.
//
// (A) Static Maelstrom (zevkir:current) "Channeling Call Tides now changes Zev'kir's costs to Generic ...".
//     channeling is a status but the scheduler applied/removed it WITHOUT emitting, so the passive keyed on the
//     over-firing has(channeling)/not-has(channeling) proxy. The scheduler now emits statusApplied/statusExpired
//     {kind:"channeling", name:<skill id>} at channel start + every end, and the passive gates on
//     {eventStatusKind:"channeling"} — fires exactly once on start and once on end.
//
// (B) Lingering Spores (hector:spore) "Whenever a Serum effect ends ...". The trigger had NO gate (fired on every
//     status expiry anywhere). Now gated on {eventStatusNameIncludes:"Serum"} — a "...Serum"-named status expiring.

const remap = (u: { statuses: { kind: string; name?: string }[] }) =>
  u.statuses.some((s) => s.kind === "cost_currency_remap" && s.name === "Static Maelstrom");

test("Static Maelstrom: the cost remap is applied on a channeling statusApplied and removed on its statusExpired", () => {
  const zk = loadHero(heroById("zevkir"), "A", "zk");
  applyFusion(zk, fusionForm("zevkir", "current") as FusionForm);
  const state = makeState([zk], [makeUnit({ id: "e1", team: "B" })]);

  assert.equal(remap(zk), false, "no remap before Channeling begins");

  // Channel begins -> statusApplied {kind:channeling} -> the passive applies the Static Maelstrom remap once.
  emit(state, { type: "statusApplied", unit: "zk", source: "zk", kind: "channeling", name: "zevkir1" });
  assert.equal(remap(zk), true, "beginning to Channel Call Tides applies the Generic-cost remap");
  assert.ok(zk.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === 10), "and the +10 next-ability bonus");

  // OVER-FIRE CONTROL: an UNRELATED status expiring must NOT strip the remap (the old not-has(channeling) proxy did).
  emit(state, { type: "statusExpired", unit: "zk", kind: "mark", name: "Some Debuff" });
  assert.equal(remap(zk), true, "an unrelated status expiry must not end the Generic-cost conversion");

  // Channel ends -> statusExpired {kind:channeling} -> the remap is removed.
  emit(state, { type: "statusExpired", unit: "zk", kind: "channeling", name: "zevkir1" });
  assert.equal(remap(zk), false, "the Generic-cost conversion ends when Channeling ends");
});

test("Static Maelstrom: casting Call Tides (a real channel) emits the start event and applies the remap; an interrupt ends it", () => {
  const zk = loadHero(heroById("zevkir"), "A", "zk");
  applyFusion(zk, fusionForm("zevkir", "current") as FusionForm);
  const state = makeState([zk], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = { generic: 30, water: 30 };

  performAction(state, { unit: "zk", skillId: "zevkir1", targets: [] });
  assert.ok(zk.statuses.some((s) => s.kind === "channeling"), "Call Tides is now channeling");
  assert.equal(remap(zk), true, "the scheduler's channel-start emit drove the passive -> remap applied");

  // Interrupt the channel: a stunned channeler drops the channel in runChannels, which now emits statusExpired.
  zk.statuses.push({ kind: "stun", duration: 1, appliedBy: "e1", appliedTurn: 0 });
  runChannels(state, "A");
  assert.ok(!zk.statuses.some((s) => s.kind === "channeling"), "the channel was interrupted");
  assert.equal(remap(zk), false, "interrupting the channel ends the Generic-cost conversion");
});

test("Static Maelstrom: cancelling the channel by casting ANOTHER skill tears down the remap (no permanent stick)", () => {
  const zk = loadHero(heroById("zevkir"), "A", "zk");
  applyFusion(zk, fusionForm("zevkir", "current") as FusionForm);
  const state = makeState([zk], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = { generic: 60, water: 60 };

  performAction(state, { unit: "zk", skillId: "zevkir1", targets: [] }); // start Call Tides (indefinite channel)
  assert.equal(remap(zk), true, "channeling -> remap applied");

  // Using any other (non-doesNotInterrupt) skill cancels the channel. That cancel must END the Generic-cost
  // conversion — the bug was that the performAction interrupt path emitted no statusExpired, so the duration:null
  // remap stuck for the rest of the match.
  performAction(state, { unit: "zk", skillId: "zevkir2", targets: ["e1"] });
  assert.ok(!zk.statuses.some((s) => s.kind === "channeling"), "casting another skill cancelled the channel");
  assert.equal(remap(zk), false, "cancelling the channel by acting ends the Generic-cost conversion (not stuck)");
});

test("Lingering Spores: only a '...Serum'-named status expiry places a spore; an unrelated expiry does not", () => {
  const hector = loadHero(heroById("hector"), "A", "h");
  applyFusion(hector, fusionForm("hector", "spore") as FusionForm);
  const dennis = makeUnit({ id: "d1", team: "A", name: "Dennis the Apprentice", kind: "minion", summoner: "h" });
  const state = makeState([hector, dennis], [makeUnit({ id: "e1", team: "B" })]);
  const spores = () => state.units["d1"]!.statuses.find((s) => s.kind === "stack" && s.name === "Lingering Spores")?.magnitude ?? 0;

  // A non-Serum status expires anywhere -> the trigger must NOT fire (this was the every-expiry over-fire).
  emit(state, { type: "statusExpired", unit: "e1", kind: "dot", name: "Bleed" });
  assert.equal(spores(), 0, "a non-Serum expiry does not place a Lingering Spore");

  // A Serum effect ends -> one Lingering Spore stack is placed on Dennis.
  emit(state, { type: "statusExpired", unit: "e1", kind: "dot", name: "Burning Blood Serum" });
  assert.equal(spores(), 1, "a Serum-named status expiry places a Lingering Spore stack");

  // Another Serum ending stacks it further.
  emit(state, { type: "statusExpired", unit: "e1", kind: "regen", name: "Stoneseal Serum" });
  assert.equal(spores(), 2, "each Serum effect ending stacks Lingering Spores");
});
