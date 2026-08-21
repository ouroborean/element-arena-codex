import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts"; // side-effect: registers the Shadow Clone minion template
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — laria:ninja "Shadow Clones", the `statusApplied` reactive trigger whose gate was
// fixed from a STATE check on the recipient to an EVENT check on the applied status.
//
//   when: { and: [ sameUnit(eventSource, self),  { eventStatusKind: "stack", name: "Deepening Shadows" } ] }
//   effect: removeStatus stack "Deepening Shadows" from eventUnit; summon "Shadow Clone" count 1
//
// "Whenever Laria would create one or more stacks of Deepening Shadows, she instead creates a Shadow Clone."
// The old gate keyed on has(stack "Deepening Shadows", eventUnit) — a STATE read on the recipient — so it
// fired on ANY status Laria applied to a target that ALREADY held a Deepening Shadows stack, spawning a
// spurious clone. The fixed gate keys on eventStatusKind:"stack" name:"Deepening Shadows": it fires ONLY when
// the status just APPLIED is a Deepening Shadows stack.

const dsStack = () => ({ kind: "stack" as const, name: "Deepening Shadows", magnitude: 1, duration: null, appliedBy: "laria", appliedTurn: 0 });
const cloneCount = (state: ReturnType<typeof makeState>) =>
  Object.values(state.units).filter((u) => u.team === "A" && u.kind === "minion" && u.name === "Shadow Clone").length;
const holdsDS = (u: { statuses: { kind: string; name?: string }[] }) =>
  u.statuses.some((s) => s.kind === "stack" && s.name === "Deepening Shadows");

function setup() {
  const laria = loadHero(heroById("laria"), "A", "laria");
  const form = fusionForm("laria", "ninja");
  assert.ok(form, "fusion form laria:ninja must exist");
  applyFusion(laria, form as FusionForm);
  const enemy = makeUnit({ id: "e1", team: "B", name: "Enemy" });
  const state = makeState([laria], [enemy]);
  return { state, laria, enemy };
}

test("Shadow Clones: applying a Deepening Shadows stack summons exactly one Shadow Clone; a different status to a DS-holder does not", () => {
  // Positive — Laria applies a Deepening Shadows stack to the enemy. eventSource == self and the APPLIED
  // status IS a Deepening Shadows stack, so the trigger converts it into one Shadow Clone (the placed stack
  // is removed from the recipient and a clone is minted instead).
  {
    const { state, enemy } = setup();
    enemy.statuses.push(dsStack()); // the stack she just placed on the enemy
    assert.equal(cloneCount(state), 0, "no Shadow Clone before the trigger fires");

    emit(state, { type: "statusApplied", unit: "e1", source: "laria", kind: "stack", name: "Deepening Shadows" });

    assert.equal(cloneCount(state), 1, "exactly one Shadow Clone minion summoned");
    assert.equal(holdsDS(enemy), false, "the placed Deepening Shadows stack was removed from the recipient (created a clone instead)");
  }

  // Over-fire control (fresh setup) — the enemy ALREADY holds a Deepening Shadows stack, and Laria applies a
  // DIFFERENT status to them (kind:"mark", name:"Decoy"). Pre-fix, has(stack "Deepening Shadows", eventUnit)
  // was true (the recipient holds a DS stack), so ANY status Laria applied spawned a clone. The fixed gate
  // requires the APPLIED status itself to be a Deepening Shadows stack, so nothing fires here.
  {
    const { state, enemy } = setup();
    enemy.statuses.push(dsStack()); // the enemy already holds a Deepening Shadows stack from before

    emit(state, { type: "statusApplied", unit: "e1", source: "laria", kind: "mark", name: "Decoy" });

    assert.equal(cloneCount(state), 0, "a non-Deepening-Shadows status applied to a DS-holder must NOT summon a Shadow Clone");
    assert.equal(holdsDS(enemy), true, "the enemy's pre-existing Deepening Shadows stack is untouched (trigger did not fire)");
  }
});
