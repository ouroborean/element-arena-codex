/**
 * Hybrid (fusion) energy paying its COMPONENT elements' specific costs, one-directional: Mirror (= Water +
 * Shadow) energy can pay a Water or a Shadow specific cost, but no base energy can pay a Mirror cost, and one
 * Mirror unit can only cover ONE component demand at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canPay, canPayAfter, reserveEnergy, performAction } from "../src/scheduler.ts";
import { elementComponents, hybridsFor } from "../src/elements.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

const cost = (generic: number, specific: number) => ({ generic, specific });

test("mapping: Mirror = Water + Shadow, and Mirror covers water/shadow but not vice-versa", () => {
  assert.deepEqual(elementComponents("mirror").sort(), ["shadow", "water"]);
  assert.ok(hybridsFor("water").includes("mirror"));
  assert.ok(hybridsFor("shadow").includes("mirror"));
  assert.deepEqual(hybridsFor("mirror"), []); // a hybrid has no hybrids → base energy can't pay a hybrid cost
});

test("canPay: Mirror energy pays a Water (or Shadow) specific cost; Water energy cannot pay a Mirror cost", () => {
  assert.equal(canPay({ mirror: 1 }, "water", cost(0, 1)), true, "mirror pays water");
  assert.equal(canPay({ mirror: 1 }, "shadow", cost(0, 1)), true, "mirror pays shadow");
  assert.equal(canPay({ water: 1 }, "mirror", cost(0, 1)), false, "water does NOT pay mirror (one-directional)");
  assert.equal(canPay({ fire: 1 }, "water", cost(0, 1)), false, "an unrelated colour never substitutes");
});

test("end-to-end: a Water hero's water-specific skill resolves paid entirely from Mirror energy", () => {
  const water = makeUnit({ id: "w", team: "A", currentElement: "water", skills: [skill("ws", [], { targeting: "self", cost: cost(0, 1) })] });
  const state = makeState([water], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { mirror: 1 };
  const r = performAction(state, { unit: "w", skillId: "ws" });
  assert.equal(r.ok, true, "resolves");
  assert.equal(state.teams.A.energy.mirror, 0, "the mirror energy was consumed");
  assert.equal(state.teams.A.energy.water ?? 0, 0, "water pool untouched (there was none)");
});

test("end-to-end: a base colour is drawn BEFORE a hybrid (hybrid only covers the shortfall)", () => {
  const water = makeUnit({ id: "w", team: "A", currentElement: "water", skills: [skill("ws", [], { targeting: "self", cost: cost(0, 2) })] });
  const state = makeState([water], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { water: 1, mirror: 2 };
  const r = performAction(state, { unit: "w", skillId: "ws" });
  assert.equal(r.ok, true);
  assert.equal(state.teams.A.energy.water, 0, "own water spent first");
  assert.equal(state.teams.A.energy.mirror, 1, "only the 1-shortfall came from mirror");
});

test("end-to-end: base energy cannot pay a hybrid cost", () => {
  const mirror = makeUnit({ id: "m", team: "A", currentElement: "mirror", skills: [skill("ms", [], { targeting: "self", cost: cost(0, 1) })] });
  const state = makeState([mirror], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { water: 5, shadow: 5 }; // components, but not mirror itself
  const r = performAction(state, { unit: "m", skillId: "ms" });
  assert.equal(r.ok, false, "no mirror energy → cannot pay a mirror-specific cost from its components");
});

test("canPayAfter: one Mirror unit cannot cover both a water and a shadow demand in one turn", () => {
  const shadowCaster = makeUnit({ id: "s", team: "A", currentElement: "shadow" });
  const state = makeState([shadowCaster], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { mirror: 1 };
  const reservedWater = { specific: { water: 1 }, generic: 0 }; // a teammate already queued a water cost
  assert.equal(canPayAfter(state.teams.A.energy, shadowCaster, cost(0, 1), reservedWater), false,
    "the single mirror is already spoken for by the water cost");
  // With a spare water base for the water demand, the mirror is free to cover shadow.
  state.teams.A.energy = { mirror: 1, water: 1 };
  assert.equal(canPayAfter(state.teams.A.energy, shadowCaster, cost(0, 1), reservedWater), true);
});
