import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// PR — Maggie "Grasping Vines" hidden-targets: "target invisible to enemy". The prepared mark AND its queued
// strike are invisible:true, so redactState hides both from the enemy — they cannot see WHICH of their units
// is prepared until the delayed hit lands. The `schedule` op now honours a per-node invisible flag.

test("Grasping Vines conceals the prepared target from the enemy (mark + queued strike invisible)", () => {
  const maggie = loadHero(heroById("maggie"), "A", "m");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([maggie], [enemy]);
  state.teams.A.energy = { generic: 10, unholy: 10 };

  performAction(state, { unit: "m", skillId: "maggie2", targets: ["e"] });

  const mark = enemy.statuses.find((s) => s.name === "Grasping Vines");
  assert.ok(mark?.invisible, "the Grasping Vines mark is stamped invisible");
  const queued = state.scheduled.find((e) => e.caster === "m");
  assert.ok(queued?.invisible, "the queued strike is stamped invisible");

  // The enemy cannot see which of their units is prepared, nor the pending strike; Maggie sees both.
  assert.ok(!redactState(state, "B").units["e"]!.statuses.some((s) => s.name === "Grasping Vines"), "the enemy cannot see the mark");
  assert.equal(redactState(state, "B").scheduled.length, 0, "the enemy cannot see the queued strike");
  assert.ok(redactState(state, "A").units["e"]!.statuses.some((s) => s.name === "Grasping Vines"), "Maggie still sees the mark");
  assert.equal(redactState(state, "A").scheduled.length, 1, "Maggie still sees the queued strike");
});
