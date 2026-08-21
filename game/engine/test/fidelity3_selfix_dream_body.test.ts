import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — selector fix for xyris "Dream Body" (base roster trigger, source "Dream Body").
// Frozen passive: "Whenever this Hero is the sole target of a skill, he gains Elemental Essence."
// Authored trigger: on skillUsed, when and[count(eventTargets)==1, declaredTargetsSelf] -> applyStatus
// elemental_essence to self.
//
// The just-fixed bug class: this used to read the event-selector `eventTarget`, which does NOT resolve
// for a skillUsed event (that event carries `targets` (plural), not `target`) — so it never fired. The
// fix reads eventTargets (the declared-target LIST) for the count, and declaredTargetsSelf to confirm
// Xyris himself is that sole target. Xyris' single-target skills (e.g. Reveal Hidden Truth / xyris1) do
// NOT grant Essence on their own, so any Essence Xyris gains here is attributable to Dream Body alone.

test("Dream Body: a single-target skill whose SOLE target is Xyris grants him Elemental Essence", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([xyris], [enemy]);
  state.teams.A.energy = { generic: 40, shadow: 40 };

  assert.ok(!xyris.statuses.some((s) => s.kind === "elemental_essence"), "precondition: Xyris starts with no Essence");

  // A single-target skill (Reveal Hidden Truth) declared with Xyris himself as the one and only target.
  const res = performAction(state, { unit: "x", skillId: "xyris1", targets: ["x"] });
  assert.ok(res.ok, `the self-targeted cast resolved (${JSON.stringify(res)})`);

  assert.ok(
    xyris.statuses.some((s) => s.kind === "elemental_essence"),
    "Xyris is the sole target of the skill, so Dream Body grants Elemental Essence",
  );
});

test("Dream Body CONTROL: a single-target skill aimed at an ENEMY (not Xyris) grants NO Essence", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([xyris], [enemy]);
  state.teams.A.energy = { generic: 40, shadow: 40 };

  // Same single-target skill, but declared onto the enemy: Xyris is NOT among the event's targets, so the
  // fixed selector (declaredTargetsSelf) must be false and Dream Body must not fire. This is the fix's whole
  // point — a skill whose sole target is someone ELSE must not hand Xyris Essence.
  const res = performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  assert.ok(res.ok, `the enemy-targeted cast resolved (${JSON.stringify(res)})`);
  assert.equal(enemy.hp, 85, "the enemy actually took the single-target hit (15 damage), confirming it was the target");

  assert.ok(
    !xyris.statuses.some((s) => s.kind === "elemental_essence"),
    "Xyris was not the target, so Dream Body grants no Essence",
  );
});
