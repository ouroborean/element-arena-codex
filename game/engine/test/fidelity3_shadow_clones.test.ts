import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import "../content/match.ts"; // side-effect: registers minion templates (Shadow Clone) + handlers
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 30 — laria:ninja "Shadow Clones": "Shadow Clones are treated as if they are stacks
// of Deepening Shadows." The Shadow Clone minion template now carries a Deepening Shadows stack (magnitude 1),
// so field-wide stackSum/count reads of Deepening Shadows count each live clone.

test("Shadow Clone minions count as Deepening Shadows stacks in a field-wide stackSum", () => {
  const laria = makeUnit({ id: "l", team: "A" });
  const state = makeState([laria], [makeUnit({ id: "e", team: "B" })]);

  runEffects(state, [{ op: "summon", template: "Shadow Clone", count: 2 }], { caster: laria, self: laria });
  const clones = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Shadow Clone");
  assert.equal(clones.length, 2, "two Shadow Clones summoned");

  runEffects(state, [{ op: "addStack", name: "Tally", amount: { ref: "stackSum", name: "Deepening Shadows", of: { faction: "all" } }, to: "self" }], { caster: laria, self: laria });
  assert.equal(laria.statuses.find((s) => s.name === "Tally")?.magnitude, 2, "the 2 clones count as 2 Deepening Shadows stacks");
});
