/**
 * Turn-level energy PLANNING: the reservation + joint-feasibility helpers the client uses so a player can
 * never queue more skills than the pool can pay. The old client gated each skill against the FULL pool
 * independently, so N heroes could each "afford" a skill while the set together could not — and the engine,
 * paying greedily at resolution, silently DROPPED the excess. These lock the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveEnergy, reservationTotal, canPayAfter, canUsePlanned, performAction } from "../src/scheduler.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

const cost = (generic: number, specific: number) => ({ generic, specific });

test("reserveEnergy sums specific per caster-element and total generic across a queued set", () => {
  const f = makeUnit({ id: "f", currentElement: "fire", skills: [skill("fs", [], { cost: cost(1, 2) })] });
  const w = makeUnit({ id: "w", currentElement: "water", skills: [skill("ws", [], { cost: cost(0, 1) })] });
  const state = makeState([f, w], [makeUnit({ id: "e", team: "B" })]);
  const r = reserveEnergy(state, [{ unit: "f", skillId: "fs" }, { unit: "w", skillId: "ws" }]);
  assert.deepEqual(r.specific, { fire: 2, water: 1 });
  assert.equal(r.generic, 1);
  assert.equal(reservationTotal(r), 4);
});

test("canPayAfter: a color's specific room shrinks as same-color skills reserve it", () => {
  const u = makeUnit({ id: "u", currentElement: "fire" });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { fire: 2 };
  const none = { specific: {}, generic: 0 };
  assert.equal(canPayAfter(state.teams.A.energy, u, cost(0, 1), none), true, "1 fire fits in 2");
  const oneFire = { specific: { fire: 1 }, generic: 0 };
  assert.equal(canPayAfter(state.teams.A.energy, u, cost(0, 1), oneFire), true, "a 2nd fire fits (2 >= 1+1)");
  const twoFire = { specific: { fire: 2 }, generic: 0 };
  assert.equal(canPayAfter(state.teams.A.energy, u, cost(0, 1), twoFire), false, "a 3rd fire does NOT (2 < 2+1)");
});

test("canPayAfter is JOINT feasibility, not greedy: generic can reallocate off a color a specific needs", () => {
  // Pool {fire:2, water:2}. A water hero already queued a 2-generic skill. A fire hero now wants 1 fire.
  // A greedy "pay generic from fire first" bookkeeping would wrongly show fire exhausted; joint feasibility
  // knows the 2 generic can come from water, leaving fire free.
  const fireHero = makeUnit({ id: "f", currentElement: "fire" });
  const state = makeState([fireHero], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { fire: 2, water: 2 };
  const reservedByWaterGeneric = { specific: {}, generic: 2 }; // the water hero's 2 generic
  assert.equal(canPayAfter(state.teams.A.energy, fireHero, cost(0, 1), reservedByWaterGeneric), true);
  // The color still gates specific though: with 3 already reserved out of 4 total, only 1 energy remains,
  // so a 2-fire skill cannot be paid even though fire itself holds 2.
  assert.equal(canPayAfter(state.teams.A.energy, fireHero, cost(0, 2), { specific: {}, generic: 3 }), false, "only 4-3=1 energy left, can't pay a 2-cost skill");
});

test("canUsePlanned excludes the unit's OWN queued action (re-choosing a skill), counts every other unit's", () => {
  const a = makeUnit({ id: "a", currentElement: "fire", skills: [skill("a1", [], { cost: cost(0, 2) }), skill("a2", [], { cost: cost(0, 1) })] });
  const b = makeUnit({ id: "b", currentElement: "fire", skills: [skill("b1", [], { cost: cost(0, 2) })] });
  const state = makeState([a, b], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { fire: 3 };
  // Nothing queued: both of a's skills are affordable.
  assert.equal(canUsePlanned(state, a, a.skills![0]!, []), true);
  // a has ALREADY queued its 2-fire skill; re-examining a's tiles must ignore a's own action, so its 1-fire
  // alternative still shows usable (choosing it would REPLACE the 2-fire, not stack on it).
  const aQueued = [{ unit: "a", skillId: "a1" }];
  assert.equal(canUsePlanned(state, a, a.skills![1]!, aQueued), true, "a can swap to its cheaper skill");
  // But b's 2-fire skill, given a's 2-fire already queued, does NOT fit (3 < 2+2).
  assert.equal(canUsePlanned(state, b, b.skills![0]!, aQueued), false, "b is priced out by a's queued skill");
});

test("end-to-end: a jointly-feasible set the client vetted pays IN FULL — no skill is dropped", () => {
  // Pool {fire:2, water:2}. H1 (water) casts 2 generic; H2 (fire) casts 2 fire. Feasible only if the 2
  // generic is paid from WATER (leaving fire for H2). Naive generic-first would drain fire and drop H2 —
  // the exact bug. The client's allocation reserves every specific first, so it pays generic from water.
  const h1 = makeUnit({ id: "h1", currentElement: "water", skills: [skill("g", [], { targeting: "self", cost: cost(2, 0) })] });
  const h2 = makeUnit({ id: "h2", currentElement: "fire", skills: [skill("s", [], { targeting: "self", cost: cost(0, 2) })] });
  const state = makeState([h1, h2], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { fire: 2, water: 2 };

  // 1) The client would let the player queue BOTH (each affordable given the other reserved).
  assert.equal(canUsePlanned(state, h1, h1.skills![0]!, [{ unit: "h2", skillId: "s" }]), true);
  assert.equal(canUsePlanned(state, h2, h2.skills![0]!, [{ unit: "h1", skillId: "g" }]), true);

  // 2) With the client's surplus-only generic allocation, the engine resolves BOTH (no insufficient-energy).
  state.genericPay = { water: 2 }; // generic drawn off water, not fire — exactly what planGeneric/defaultAlloc yield
  assert.equal(performAction(state, { unit: "h1", skillId: "g" }).ok, true, "H1's generic skill resolves");
  const r2 = performAction(state, { unit: "h2", skillId: "s" });
  assert.equal(r2.ok, true, "H2's fire skill still resolves — not dropped");
  assert.equal(state.teams.A.energy.fire, 0);
  assert.equal(state.teams.A.energy.water, 0);
});
