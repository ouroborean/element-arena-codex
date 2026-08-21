import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 17 — ayana:vengeance "Divine Ire": "she permanently deals 5 additional damage to
// them with Voice of Light (stacks)". The +5/stack "Divine Ire" marker was recorded but base Voice of Light
// never read it. Base ayana1 now deals 15 + statusMag(Divine Ire) to each enemy (both branches; the marker's
// magnitude accumulates +5 per application, so statusMag IS the bonus). Reads 0 for a non-Divine-Ire ayana.

function castVoL(ireMag: number): number {
  const ayana = loadHero(heroById("ayana"), "A", "ay");
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, kind: "hero",
    statuses: ireMag ? [{ kind: "stack", name: "Divine Ire", magnitude: ireMag, duration: null, appliedBy: "ay", appliedTurn: 0 }] : [] });
  const state = makeState([ayana], [enemy]);
  state.teams.A.energy = { generic: 10 };
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
  return 100 - enemy.hp;
}

test("Voice of Light deals 15 + the target's Divine Ire magnitude", () => {
  assert.equal(castVoL(0), 15, "no Divine Ire -> plain 15");
  assert.equal(castVoL(5), 20, "one Divine Ire stack (+5) -> 20");
  assert.equal(castVoL(10), 25, "two Divine Ire stacks (+10) -> 25");
});
