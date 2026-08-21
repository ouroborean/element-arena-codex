import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 coverage — pyrrha:judgment "Flames of Judgment" damage clause (#32).
// Frozen: "Receiving damage from Fan the Flames ... gives enemies a stack of Flames of Judgment."
// SHIPPING: a damageDealt passiveTrigger (source "Flames of Judgment") gated on
//   {sameUnit:[eventSource,self]} AND {isFaction:eventTarget,enemy} AND {eventSourceId:"Fan the Flames"}
//   -> addStack "Flames of Judgment" on the eventTarget.
// The damageDealt event's sourceId is the *dot's name* for dot ticks ("Fan the Flames"), else the
// casting skill's id (e.g. "pyrrha1" for a direct Fan-the-Flames hit) — so only the dot tick seeds a stack.

test("pyrrha:judgment Fan the Flames dot tick (sourceId='Fan the Flames') gives the enemy a Flames of Judgment stack", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "judgment")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([pyrrha], [enemy]);

  emit(state, { type: "damageDealt", source: "p", target: "e", amount: 5, dtype: "affliction", sourceId: "Fan the Flames" });

  const stacks = enemy.statuses.filter((s) => s.name === "Flames of Judgment");
  assert.equal(stacks.length, 1, "the dot tick lays exactly one Flames of Judgment stack on the enemy");
});

test("pyrrha:judgment a direct Fan the Flames hit (sourceId='pyrrha1') does NOT give a Flames of Judgment stack", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "judgment")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([pyrrha], [enemy]);

  // A direct-cast damage instance carries the skill's node-id (pyrrha1), not the dot name — out of scope.
  emit(state, { type: "damageDealt", source: "p", target: "e", amount: 10, dtype: "affliction", sourceId: "pyrrha1" });

  assert.ok(
    !enemy.statuses.some((s) => s.name === "Flames of Judgment"),
    "damage scoped to a skill id other than the Fan the Flames dot lays no stack",
  );
});
