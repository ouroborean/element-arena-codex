import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 4 — tag/flag/mark gates on existing primitives (Unstunnable tag, Uncounterable
// tag, eventHasTag'Harmful' gate, a real Stun Immunity mark). Behavioral locks for the two with engine reach.

test("ayana:divine Verse of Ascension casts while Ayana is stunned (Unstunnable); her normal skills do not", () => {
  const ayana = loadHero(heroById("ayana"), "A", "ay");
  applyFusion(ayana, fusionForm("ayana", "divine")!);
  ayana.statuses.push({ kind: "stun", duration: 1, appliedBy: "ay", appliedTurn: 0 }); // unscoped stun
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([ayana], [enemy]);
  state.teams.A.energy = { generic: 10, divine: 10 };

  assert.equal(performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] }).ok, false, "a normal skill is blocked by the stun");
  assert.equal(performAction(state, { unit: "ay", skillId: "ayanadivine1", targets: [] }).ok, true, "Verse of Ascension casts through the stun (Unstunnable tag)");
});

test("aramao Trial of the Sands retaliates on a HARMFUL enemy skill targeting Aramao, not on a non-Harmful one", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  aramao.statuses.push({ kind: "mark", name: "Trial of the Sands", duration: 3, appliedBy: "ar", appliedTurn: 0 }); // window up
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, kind: "hero" });
  const state = makeState([aramao], [enemy]);

  emit(state, { type: "skillUsed", caster: "e", skillId: "foe_strat", targets: ["ar"], tags: ["Strategic"] });
  assert.equal(enemy.hp, 100, "a non-Harmful skill on Aramao does NOT trigger Desert Knife retaliation");

  emit(state, { type: "skillUsed", caster: "e", skillId: "foe_harm", targets: ["ar"], tags: ["Harmful"] });
  assert.ok(enemy.hp < 100, "a Harmful skill on Aramao DOES retaliate with Desert Knife");
});
