import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, resolveTurn } from "../src/scheduler.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

// A skill's GENERIC cost may be paid with energy of any color; the player chooses which via
// state.genericPay. Specific costs are always paid in-color and never from the generic pool.

function caster(cost: { generic: number; specific: number }) {
  return makeUnit({ id: "u1", team: "A", skills: [skill("s1", [], { targeting: "self", cost })] });
}

test("state.genericPay routes the generic cost to the chosen color, sparing the generic pool", () => {
  const state = makeState([caster({ generic: 2, specific: 0 })], [makeUnit({ id: "b1", team: "B" })]);
  state.teams.A.energy = { generic: 5, fire: 5 };
  state.genericPay = { fire: 2 }; // pay the 2 generic out of fire instead of generic-first

  const r = performAction(state, { unit: "u1", skillId: "s1", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(state.teams.A.energy.fire, 3, "fire covered the generic cost");
  assert.equal(state.teams.A.energy.generic, 5, "generic pool untouched");
});

test("without an allocation, generic drains generic-first (default order)", () => {
  const state = makeState([caster({ generic: 2, specific: 0 })], [makeUnit({ id: "b1", team: "B" })]);
  state.teams.A.energy = { generic: 5, fire: 5 };

  performAction(state, { unit: "u1", skillId: "s1", targets: [] });
  assert.equal(state.teams.A.energy.generic, 3, "generic pool paid first");
  assert.equal(state.teams.A.energy.fire, 5, "colors untouched");
});

test("a partial allocation covers what it can, then the default order pays the rest", () => {
  const state = makeState([caster({ generic: 3, specific: 0 })], [makeUnit({ id: "b1", team: "B" })]);
  state.teams.A.energy = { generic: 5, water: 5 };
  state.genericPay = { water: 1 }; // only 1 of the 3 generic allocated to water

  performAction(state, { unit: "u1", skillId: "s1", targets: [] });
  assert.equal(state.teams.A.energy.water, 4, "1 generic from water");
  assert.equal(state.teams.A.energy.generic, 3, "remaining 2 generic from the generic pool");
});

test("resolveTurn consumes the allocation for exactly one turn", () => {
  const state = makeState([caster({ generic: 1, specific: 0 })], [makeUnit({ id: "b1", team: "B" })]);
  state.teams.A.energy = { generic: 5, fire: 5 };
  state.genericPay = { fire: 1 };

  resolveTurn(state, [{ unit: "u1", skillId: "s1", targets: [] }]);
  assert.equal(state.teams.A.energy.fire, 4, "allocation applied this turn");
  assert.equal(state.genericPay, undefined, "allocation cleared after the turn");
});
