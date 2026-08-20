import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost, endTurn } from "../src/scheduler.ts";
import { runEffects, emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { SkillInstance } from "../src/skill.ts";

// Engine-fidelity — gaia:nomad "Sandstorm" (Worldfist): "Deals 5 to the enemy team for 4 turns. During this
// time, Rampart costs [65], and enemies damaged by Worldfist are Blinded for 1 turn." The two "during this
// time" auras (previously documented, not expressed) are installed by worldfistAuras.

test("Worldfist auras: Rampart costs [65] and Worldfist's damage blinds enemies for the 4-turn window", () => {
  const gaia = loadHero(heroById("gaia"), "A", "gaia");
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([gaia], [enemy]);
  const rampart = (gaia.skills ?? []).find((s) => s.id === "gaia4") as SkillInstance;

  assert.deepEqual(effectiveCost(gaia, rampart, state), { generic: 0, specific: 1 }, "Rampart base cost = 1 [earth]");

  // Cast Sandstorm's aura installer (the custom node in gaianomad1's effect tree).
  runEffects(state, [{ op: "custom", fn: "worldfistAuras", args: { turns: 4, rampartId: "gaia4" } }], { caster: gaia, self: gaia });

  // Aura 1: Rampart now costs [65] = 1 generic (any color pays it).
  assert.deepEqual(effectiveCost(gaia, rampart, state), { generic: 1, specific: 0 }, "Rampart costs [65] during the window");

  // Aura 2: any enemy Worldfist (Gaia) damages is Blinded (the Sandstorm dot ticks source=Gaia would too).
  emit(state, { type: "damageDealt", source: "gaia", target: "e", amount: 5, dtype: "normal", isNew: true });
  assert.ok(enemy.statuses.some((s) => s.kind === "blind"), "the damaged enemy is Blinded");

  // Both auras are temporary (Gaia-anchored, 4 turns) — drive Gaia's turn-ends until they revert.
  for (let i = 0; i < 10; i++) endTurn(state);
  assert.deepEqual(effectiveCost(gaia, rampart, state), { generic: 0, specific: 1 }, "Rampart cost reverts after the window");
  const enemy2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  state.units["e2"] = enemy2;
  state.teams.B.units.push("e2");
  emit(state, { type: "damageDealt", source: "gaia", target: "e2", amount: 5, dtype: "normal", isNew: true });
  assert.ok(!enemy2.statuses.some((s) => s.kind === "blind"), "the blind watch has expired — no more blinding");
});
