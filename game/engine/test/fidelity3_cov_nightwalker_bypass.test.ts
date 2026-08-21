import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — Laria "Nightwalker" augment (laria4):
// Frozen (augments.json): "Characters with 3 or more stacks of Deepening Shadows Bypass."
// Shipping: laria4 adds a `statusApplied` trigger (source "Nightwalker") that, when the unit a
// status just landed on now holds >= 3 stacks of "Deepening Shadows", applyStatus a
// `conditional_bypass` named "Bypass" with no `bypassCond` (unconditional attacker-side Bypass —
// the holder's outgoing damage ignores DR + Shield; see damage.ts bypassesAgainst).
// Observable: after a statusApplied event, does the receiving unit hold conditional_bypass "Bypass"?
//
// NOTE: statusApplied carries the recipient in `event.unit`, so the trigger keys the recipient via
// the `eventUnit` selector (same pattern as ando:battery Capacitor Upgrade / Titania's Whimsy). A
// `eventTarget` selector does NOT resolve for statusApplied (that event has no `target` field), so
// this augment only Bypasses when the recipient is addressed as eventUnit.

const hasBypass = (u: { statuses: { kind: string; name?: string; bypassCond?: unknown }[] }) =>
  u.statuses.some((s) => s.kind === "conditional_bypass" && s.name === "Bypass");

test("Nightwalker: a unit that reaches 3+ Deepening Shadows gains an unconditional Bypass; 2 stacks does not", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria4")!);

  // e3 already holds 3 Deepening Shadows stacks; e2 holds only 2. (Deepening Shadows is a
  // { kind:"stack", name, magnitude } resource — see roster/status.ts rawStackCount.)
  const ds = (magnitude: number) => ({ kind: "stack" as const, name: "Deepening Shadows", magnitude, duration: null, appliedBy: "la", appliedTurn: 0 });
  const e3 = makeUnit({ id: "e3", team: "B", statuses: [ds(3)] });
  const e2 = makeUnit({ id: "e2", team: "B", statuses: [ds(2)] });
  const state = makeState([laria], [e3, e2]);

  assert.equal(hasBypass(state.units["e3"]!), false, "no Bypass before any statusApplied fires");
  assert.equal(hasBypass(state.units["e2"]!), false, "no Bypass before any statusApplied fires");

  // Positive: a status lands on the 3-stack unit -> it gains Bypass.
  emit(state, { type: "statusApplied", unit: "e3", source: null, kind: "stack", name: "Deepening Shadows" });
  assert.equal(hasBypass(state.units["e3"]!), true, "3+ Deepening Shadows -> the unit gains conditional_bypass 'Bypass'");

  // The granted Bypass is UNCONDITIONAL (bypassCond absent) -> its holder's damage always ignores DR+Shield.
  const grant = state.units["e3"]!.statuses.find((s) => s.kind === "conditional_bypass" && s.name === "Bypass")!;
  assert.equal((grant as { bypassCond?: unknown }).bypassCond, undefined, "Bypass carries no bypassCond (unconditional)");

  // Negative/control: a status lands on the 2-stack unit -> NO Bypass (below the 3-stack threshold).
  emit(state, { type: "statusApplied", unit: "e2", source: null, kind: "stack", name: "Deepening Shadows" });
  assert.equal(hasBypass(state.units["e2"]!), false, "only 2 Deepening Shadows -> no Bypass");
});
