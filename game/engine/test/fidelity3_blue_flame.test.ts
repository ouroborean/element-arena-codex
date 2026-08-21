import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects, emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// Fidelity Campaign 3, PR 28 — jarrik:plasma "Blue Flame Spirits": "Cinderling minions are replaced by Azure
// Sparkling minions." A new Azure Sparkling template (a plasma re-skin of Cinderling); the fusion holds a
// permanent Blue Flame Spirits mark, and summonMinion mints Azure Sparkling for any Cinderling Jarrik summons.

const names = (st: MatchState): string[] => Object.values(st.units).filter((u) => u.kind === "minion" && u.team === "A").map((u) => u.name);

test("a plasma-fused Jarrik's Cinderling summons become Azure Sparkling", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "plasma")!);
  const state = makeState([jarrik], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" }); // applies the Blue Flame Spirits mark

  runEffects(state, [{ op: "summon", template: "Cinderling", count: 1 }], { caster: jarrik, self: jarrik });

  assert.ok(names(state).includes("Azure Sparkling"), "the Cinderling summon minted an Azure Sparkling");
  assert.ok(!names(state).includes("Cinderling"), "no Cinderling was created");
});

test("a non-plasma Jarrik still summons Cinderlings", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  const state = makeState([jarrik], [makeUnit({ id: "e", team: "B" })]);

  runEffects(state, [{ op: "summon", template: "Cinderling", count: 1 }], { caster: jarrik, self: jarrik });
  assert.ok(names(state).includes("Cinderling"), "unfused Jarrik summons a Cinderling");
});
