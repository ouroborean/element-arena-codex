import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 14 — new eventAffected selector (every unit a skill actually touched). blackknight
// Hellfire "permanently applies Hellfire to all enemy TARGETS AFFECTED by his abilities" was keyed on
// damageDealt, missing enemies affected without damage. It now reacts on skillUsed + forEach eventAffected.

test("Hellfire applies to an AFFECTED enemy (not just a damaged one), and not to allies", () => {
  const bk = loadHero(heroById("blackknight"), "A", "b");
  applyFusion(bk, fusionForm("blackknight", "devil")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const state = makeState([bk, ally], [enemy]);

  // A BK ability that AFFECTED the enemy + an ally (e.g. via a status, no damage event).
  emit(state, { type: "skillUsed", caster: "b", skillId: "x", targets: ["e"], affected: ["e", "a"] });

  assert.ok(enemy.statuses.some((s) => s.kind === "dot" && s.name === "Hellfire"), "an affected enemy gets the permanent Hellfire dot");
  assert.ok(!ally.statuses.some((s) => s.name === "Hellfire"), "an affected ally does not (enemies only)");
});

test("Hellfire does not stack — a second affecting ability adds no duplicate", () => {
  const bk = loadHero(heroById("blackknight"), "A", "b");
  applyFusion(bk, fusionForm("blackknight", "devil")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([bk], [enemy]);

  emit(state, { type: "skillUsed", caster: "b", skillId: "x", targets: ["e"], affected: ["e"] });
  emit(state, { type: "skillUsed", caster: "b", skillId: "y", targets: ["e"], affected: ["e"] });

  assert.equal(enemy.statuses.filter((s) => s.name === "Hellfire").length, 1, "only one Hellfire dot (does not stack)");
});
