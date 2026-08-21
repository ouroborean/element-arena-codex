import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 5 — count-of-holders -> stackSum-of-magnitudes. saya "Well-Used Panic Button"
// (per-device 10 Shield/Piercing) and laria "Ritual of Culling Night" (1 Ritual Power per Deepening Shadows
// stack) both counted the number of HOLDERS, undercounting when one unit stacks the resource more than once.
// This locks the property they now depend on: stackSum sums magnitudes across the selector.

const stack = (name: string, mag: number): Unit["statuses"][number] => ({ kind: "stack", name, magnitude: mag, duration: null, appliedBy: "a", appliedTurn: 0 });

test("stackSum sums a named stack's magnitude across a selector, not the number of holders", () => {
  const a = makeUnit({ id: "a", team: "A" });
  const e1 = makeUnit({ id: "e1", team: "B", statuses: [stack("Spider Mine", 2)] });
  const e2 = makeUnit({ id: "e2", team: "B", statuses: [stack("Spider Mine", 3)] });
  const st = makeState([a], [e1, e2]);

  runEffects(st, [{ op: "addStack", name: "Tally", amount: { ref: "stackSum", name: "Spider Mine", of: { faction: "enemies" } }, to: "self" }], { caster: a, self: a });

  const tally = a.statuses.find((s) => s.name === "Tally");
  assert.equal(tally?.magnitude, 5, "stackSum = 2 + 3 = 5 (total mines), not 2 (the number of mine-bearing enemies)");
});
