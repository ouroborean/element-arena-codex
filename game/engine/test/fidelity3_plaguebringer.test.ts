import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 15 — blackknight:blight Plaguebringer. Two fixes:
//  (1) the base "Exile" enhanced-state maintainer was dropped by replace-mode fusion (so Plaguebringer's
//      Exile gate was never satisfied) -> the maintainer trigger is now origin:"innate" and survives fusion.
//  (2) "enemies AFFECTED by his enhanced abilities" now reacts on skillUsed + forEach eventAffected.

test("the Exile enhanced-state maintainer survives replace-mode fusion (origin:innate)", () => {
  const bk = loadHero(heroById("blackknight"), "A", "b");
  applyFusion(bk, fusionForm("blackknight", "blight")!);
  assert.ok((bk.triggers ?? []).some((t) => t.source === "Exile" && t.on === "turnEnd"), "Exile maintainer is kept post-fusion");
});

test("Plaguebringer applies+stacks its dot on affected enemies while enhanced, and not while un-enhanced", () => {
  const bk = loadHero(heroById("blackknight"), "A", "b");
  applyFusion(bk, fusionForm("blackknight", "blight")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([bk], [enemy]);
  const dot = (): number | undefined => enemy.statuses.find((s) => s.kind === "dot" && s.name === "Plaguebringer")?.magnitude;

  // Un-enhanced (no Exile mark): no dot.
  emit(state, { type: "skillUsed", caster: "b", skillId: "x", targets: ["e"], affected: ["e"] });
  assert.equal(dot(), undefined, "un-enhanced abilities do not apply Plaguebringer");

  // Enhanced (acting alone -> Exile mark held): affected enemy gets the dot; it stacks +5 per enhanced ability.
  bk.statuses.push({ kind: "mark", name: "Exile", duration: 1, appliedBy: "b", appliedTurn: 0 });
  emit(state, { type: "skillUsed", caster: "b", skillId: "y", targets: ["e"], affected: ["e"] });
  assert.equal(dot(), 5, "an affected enemy gets a 5-Affliction Plaguebringer dot");
  emit(state, { type: "skillUsed", caster: "b", skillId: "z", targets: ["e"], affected: ["e"] });
  assert.equal(dot(), 10, "a second enhanced ability stacks it to 10");
});
