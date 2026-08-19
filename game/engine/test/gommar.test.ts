import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { ROSTER } from "../content/roster.generated.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

const gommarSkills = () => ROSTER.find((h) => h.id === "gommar")!.skills!.map((s) => ({ ...s, currentCd: 0 }));
const frostCovered = () => status("mark", { name: "Frost-Covered", duration: null });

test("Frost-Covered is an enhance-charge: consumed when Gommar uses an active, re-granted by Ice Body", () => {
  const g = makeUnit({ id: "a1", team: "A", slot: 0, heroId: "gommar", currentElement: "ice", skills: gommarSkills(), statuses: [frostCovered()] });
  const state = makeState([g], [makeUnit({ id: "b1", team: "B", slot: 0, hp: 100 })]);
  state.teams.A.energy = { generic: 20, ice: 20 };
  const hasFC = () => g.statuses.some((s) => s.kind === "mark" && s.name === "Frost-Covered");

  assert.ok(hasFC(), "starts the round Frost-Covered");
  const r = performAction(state, { unit: "a1", skillId: "gommar1", targets: ["b1"] });
  assert.ok(r.ok, "Iceblood Hammer resolves");
  assert.ok(!hasFC(), "using an active consumes Frost-Covered");

  // Ice Body re-grants the charge (targets self; needs no Frost-Covered to run).
  performAction(state, { unit: "a1", skillId: "gommar4", targets: ["a1"] });
  assert.ok(hasFC(), "Ice Body re-grants Frost-Covered");
});
