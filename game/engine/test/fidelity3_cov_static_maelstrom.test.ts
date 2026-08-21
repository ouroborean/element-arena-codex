import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + templates
import { heroById } from "../content/match.ts";
import { makeUnit, skill } from "./helpers.ts";

// zevkir "Static Maelstrom" (#44 / zevkircurrent0), frozen:
//   "Channeling Call Tides now changes Zev'kir's costs to Generic ..."
// SHIPPING: while Channeling, Zev'kir holds an UNSCOPED cost_currency_remap status (no skillId).
// scheduler.ts effectiveCost then moves each skill's remaining Specific cost onto Generic
// (any color may pay the remapped portion). This mirrors fidelity_cost.test.ts, which tests
// the same cost_currency_remap primitive for titania.

test("Static Maelstrom: an unscoped cost_currency_remap makes every Specific cost Generic-payable", () => {
  const z = loadHero(heroById("zevkir"), "A", "z");
  // Synthetic skills with Specific costs so the observable is exact and independent of authored numbers.
  z.skills = [
    skill("z_mixed", [], { klass: "basic", cost: { generic: 1, specific: 1 } }),
    skill("z_pure", [], { klass: "basic", cost: { generic: 0, specific: 3 } }),
    skill("z_free", [], { klass: "basic", cost: { generic: 2, specific: 0 } }),
  ];

  // Baseline (not Channeling): costs are untouched.
  assert.deepEqual(effectiveCost(z, z.skills[0]!), { generic: 1, specific: 1 }, "baseline mixed cost");
  assert.deepEqual(effectiveCost(z, z.skills[1]!), { generic: 0, specific: 3 }, "baseline pure-Specific cost");

  // Channeling Call Tides grants the unscoped remap (no skillId → applies to every skill).
  z.statuses.push({ kind: "cost_currency_remap", duration: 1, appliedBy: "z", appliedTurn: 0 });

  assert.deepEqual(effectiveCost(z, z.skills[0]!), { generic: 2, specific: 0 }, "1G+1S → 2G, 0S");
  assert.deepEqual(effectiveCost(z, z.skills[1]!), { generic: 3, specific: 0 }, "0G+3S → 3G, 0S");
  assert.deepEqual(effectiveCost(z, z.skills[2]!), { generic: 2, specific: 0 }, "no Specific → unchanged 2G");
});

test("Static Maelstrom control: without the remap status, a Specific cost stays Specific", () => {
  // Control: a bare zevkir-shaped unit with a Specific-cost skill and NO remap — the mechanic is off.
  const z = makeUnit({ id: "z2", team: "A" });
  z.skills = [skill("z2b", [], { klass: "basic", cost: { generic: 0, specific: 2 } })];

  assert.deepEqual(effectiveCost(z, z.skills[0]!), { generic: 0, specific: 2 }, "no remap → Specific unmoved");

  // And a remap SCOPED to a DIFFERENT skill leaves this one alone (only unscoped / matching applies).
  z.statuses.push({ kind: "cost_currency_remap", skillId: "someOtherSkill", duration: 1, appliedBy: "z2", appliedTurn: 0 });
  assert.deepEqual(effectiveCost(z, z.skills[0]!), { generic: 0, specific: 2 }, "mismatched-skillId remap does not apply");
});
