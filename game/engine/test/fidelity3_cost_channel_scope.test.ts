import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost } from "../src/scheduler.ts";
import { makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 12 — two effectiveCost fidelity fixes:
//  #14 scratch3 "Deal: Realize Your Potential": "-1 Generic AND -1 Specific" was a single scalar -2 that
//      spilled across channels; now per-channel genericDelta/specificDelta, applied independently (no spill).
//  #68 titania Hallucinogenic Spores: "non-Strategic skills cost +1" — a tag-scoped cost_mod is now honored.

const withStatus = (s: Unit["statuses"][number]): Unit => makeUnit({ id: "u", team: "A", statuses: [s] });

test("per-channel cost_mod reduces Generic AND Specific independently, with no cross-channel spill", () => {
  const u = withStatus({ kind: "cost_mod", genericDelta: -1, specificDelta: -1, duration: 1, appliedBy: "u", appliedTurn: 0 });
  assert.deepEqual(effectiveCost(u, skill("a", [], { cost: { generic: 2, specific: 1 } })), { generic: 1, specific: 0 }, "{2,1} -> {1,0}");
  assert.deepEqual(effectiveCost(u, skill("b", [], { cost: { generic: 2, specific: 0 } })), { generic: 1, specific: 0 }, "{2,0} -> {1,0} (no spill: a flat -2 would have given {0,0})");
  assert.deepEqual(effectiveCost(u, skill("c", [], { cost: { generic: 0, specific: 3 } })), { generic: 0, specific: 2 }, "{0,3} -> {0,2}");
});

test("a tag-scoped cost_mod (scope except Strategic) hits only non-Strategic skills", () => {
  const u = withStatus({ kind: "cost_mod", magnitude: 1, scope: { tag: "Strategic", mode: "except" }, duration: 1, appliedBy: "u", appliedTurn: 0 });
  assert.deepEqual(effectiveCost(u, skill("s", [], { cost: { generic: 1, specific: 0 }, tags: ["Strategic"] })), { generic: 1, specific: 0 }, "a Strategic skill is unaffected");
  assert.deepEqual(effectiveCost(u, skill("n", [], { cost: { generic: 1, specific: 0 }, tags: ["Harmful"] })), { generic: 2, specific: 0 }, "a non-Strategic skill costs +1");
});
