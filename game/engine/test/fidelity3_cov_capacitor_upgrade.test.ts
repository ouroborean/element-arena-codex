import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { stackCount } from "../src/status.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — ando:battery "Capacitor Upgrade" (andobattery0):
// "Expel Energy deals 5 more damage each time Ando gains Charged or Supercharged."
// The battery fusion's passiveTrigger reacts to statusApplied, gated to Ando gaining a
// "Charged" or "Supercharged" mark, by adding one "Capacitor Upgrade" stack each time.
// Observable: stackCount(ando, "Capacitor Upgrade") (each stack = +5 Expel Energy damage).

test("ando:battery Capacitor Upgrade gains a stack on each Charged/Supercharged gain, not on unrelated statuses", () => {
  const ando = loadHero(heroById("ando"), "A", "an");
  applyFusion(ando, fusionForm("ando", "battery")!);
  const state = makeState([ando], [makeUnit({ id: "e", team: "B" })]);

  assert.equal(stackCount(ando, "Capacitor Upgrade"), 0, "no stacks before any charge gain");

  // Gaining Charged adds one Capacitor Upgrade stack.
  emit(state, { type: "statusApplied", unit: "an", source: null, kind: "mark", name: "Charged" });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 1, "gaining Charged increments Capacitor Upgrade");

  // Gaining Supercharged adds another (shares the gate's OR branch).
  emit(state, { type: "statusApplied", unit: "an", source: null, kind: "mark", name: "Supercharged" });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 2, "gaining Supercharged also increments Capacitor Upgrade");

  // Control 1: an unrelated status landing on Ando must NOT increment.
  emit(state, { type: "statusApplied", unit: "an", source: null, kind: "mark", name: "Something Else" });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 2, "an unrelated status does not add a stack");

  // Control 2: another unit gaining Charged must NOT credit Ando (sameUnit gate).
  emit(state, { type: "statusApplied", unit: "e", source: null, kind: "mark", name: "Charged" });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 2, "someone else gaining Charged does not increment Ando's stacks");
});
