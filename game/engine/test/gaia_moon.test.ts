import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost, canUse } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// Engine-fidelity — gaia:moon "Rising Indignation": "the cost of Gaia's Fury is reduced by [65], stacking...
// the Gaia's Fury minion deals and receives 10 additional damage." Reading A (per ruling): EVERY Gaia's Fury
// minion is 'Gaia, Enraged' — intrinsic +10 dealt/received + Moon Spike locked, via new MinionTemplate.statuses.

const setRI = (u: Unit, n: number): void => {
  u.statuses = u.statuses.filter((s) => !(s.kind === "stack" && s.name === "Rising Indignation"));
  if (n > 0) u.statuses.push({ kind: "stack", name: "Rising Indignation", magnitude: n, duration: null, appliedBy: u.id, appliedTurn: 0 });
};

test("Gaia's Fury cost drops [65] per Rising Indignation stack, and the enraged minion has +10 mods + Moon Spike locked", () => {
  const gaia = loadHero(heroById("gaia"), "A", "g");
  applyFusion(gaia, fusionForm("gaia", "moon")!);
  const fury = (gaia.skills ?? []).find((s) => s.id === "gaiamoon1") as SkillInstance;
  const state: MatchState = makeState([gaia], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  state.teams.A.energy = { moon: 9, generic: 9 };

  // (a) cost discount
  setRI(gaia, 0); assert.deepEqual(effectiveCost(gaia, fury, state), { generic: 3, specific: 0 }, "0 stacks → base 3");
  setRI(gaia, 2); assert.deepEqual(effectiveCost(gaia, fury, state), { generic: 1, specific: 0 }, "2 stacks → 3-2");
  setRI(gaia, 5); assert.deepEqual(effectiveCost(gaia, fury, state), { generic: 0, specific: 0 }, "over-cap → floored at 0");

  // (b/c) the summoned minion is enraged
  runEffects(state, [{ op: "summon", template: "Gaia's Fury", count: 1 }], { caster: gaia, self: gaia });
  const minion = Object.values(state.units).find((u) => u.kind === "minion" && u.name === "Gaia's Fury")!;
  assert.ok(minion, "Gaia's Fury summoned");
  assert.ok(minion.statuses.some((s) => s.kind === "mark" && s.name === "Enraged"), "the minion is Enraged");
  assert.equal(minion.statuses.find((s) => s.kind === "outgoing_damage_mod")?.magnitude, 10, "+10 dealt");
  assert.equal(minion.statuses.find((s) => s.kind === "incoming_damage_mod")?.magnitude, 10, "+10 received");

  // Moon Spike (gaiafury2) is locked while Enraged (requires:{not has Enraged}).
  const moonSpike = (minion.skills ?? []).find((s) => s.id === "gaiafury2")!;
  assert.equal(canUse(state, minion, moonSpike), false, "Moon Spike may not be used (Enraged)");
  minion.statuses = minion.statuses.filter((s) => !(s.kind === "mark" && s.name === "Enraged"));
  assert.equal(canUse(state, minion, moonSpike), true, "control: without Enraged, Moon Spike is usable");
});
