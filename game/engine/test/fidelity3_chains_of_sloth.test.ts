import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 19 — jarrik:devil "Chains of Sloth": "cost 1 more, increasing by 1 each turn; each
// new skill they use lowers the current magnitude by 1." A named cost_mod escalated +1 at each turn-end and
// decayed -1 on the holder's skillUsed (floored at 0), via modifyStatus in the Belphegor's Blade triggers.

test("Chains of Sloth escalates +1 each turn-end and decays -1 per holder skill, flooring at 0", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "devil")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero",
    statuses: [{ kind: "cost_mod", name: "Chains of Sloth", magnitude: 1, duration: 3, appliedBy: "j", appliedTurn: 0 }] });
  const state = makeState([jarrik], [enemy]);
  const mag = (): number | undefined => enemy.statuses.find((s) => s.kind === "cost_mod" && s.name === "Chains of Sloth")?.magnitude;

  emit(state, { type: "turnEnd", team: "B" });
  assert.equal(mag(), 2, "turn-end escalates +1 -> 2");

  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] });
  assert.equal(mag(), 1, "the holder's skill use decays -1 -> 1");
  emit(state, { type: "skillUsed", caster: "e", skillId: "y", targets: [], tags: [] });
  assert.equal(mag(), 0, "another skill decays -> 0");
  emit(state, { type: "skillUsed", caster: "e", skillId: "z", targets: [], tags: [] });
  assert.equal(mag(), 0, "floors at 0 (never a negative discount)");
});
