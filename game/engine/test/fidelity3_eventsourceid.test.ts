import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 6 — the new {eventSourceId} Condition scopes a damageDealt reaction to one source.
// The damageDealt event's sourceId is a dot's name for dot ticks, else the casting skill's id (node-id if
// authored). Unlocks: Roiling Life (Worldfist only), Ice Age (Feed the Fire only), Hallowed Footsteps
// (exclude Consecrate's own ticks), Flames of Judgment (only the Fan the Flames dot tick).

test("gaia:life Roiling Life seeds its dot only on Worldfist (gaia2) damage, not other Gaia damage", () => {
  const gaia = loadHero(heroById("gaia"), "A", "g");
  applyFusion(gaia, fusionForm("gaia", "life")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([gaia], [enemy]);

  emit(state, { type: "damageDealt", source: "g", target: "e", amount: 10, dtype: "normal", sourceId: "gaia3" });
  assert.ok(!enemy.statuses.some((s) => s.name === "Roiling Life"), "non-Worldfist Gaia damage does NOT seed the dot");

  emit(state, { type: "damageDealt", source: "g", target: "e", amount: 10, dtype: "normal", sourceId: "gaia2" });
  assert.ok(enemy.statuses.some((s) => s.name === "Roiling Life"), "Worldfist (gaia2) damage seeds the Roiling Life dot");
});

test("pyrrha:apocalypse Ice Age lowers damage only on Feed the Fire (pyrrha2) damage", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "apocalypse")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([pyrrha], [enemy]);

  emit(state, { type: "damageDealt", source: "p", target: "e", amount: 10, dtype: "normal", sourceId: "pyrrha1" });
  assert.ok(!enemy.statuses.some((s) => s.kind === "outgoing_damage_mod"), "damage from a different Pyrrha skill applies no debuff");

  emit(state, { type: "damageDealt", source: "p", target: "e", amount: 10, dtype: "normal", sourceId: "pyrrha2" });
  assert.ok(enemy.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === -5), "Feed the Fire (pyrrha2) applies the -5 outgoing_damage_mod");
});
