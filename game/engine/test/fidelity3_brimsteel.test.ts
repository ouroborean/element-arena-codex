import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// Fidelity Campaign 3, PR 26 — jarrik:brimstone "Brimsteel Scabbard": arms a one-shot rider on the next
// Blade of Ashes — triple damage, uncounterable, and a Cinderling if it strikes a Cinders-marked enemy.
// Wired by making jarrikbrimstone1 arm a skillId-scoped skill_damage_bonus (+20 -> triple the base-10 hit)
// + a mark that jarrik1's uncounterableIf reads and whose consume branch summons a Cinderling and clears both.

const minionCount = (st: MatchState, team: string): number => Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive).length;

test("Brimsteel Scabbard makes the next Blade of Ashes triple + summon a Cinderling, then reverts", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "brimstone")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, kind: "hero" });
  const state = makeState([jarrik], [enemy]);
  state.teams.A.energy = { generic: 20, fire: 20, brimstone: 20 };

  performAction(state, { unit: "j", skillId: "jarrikbrimstone1", targets: [] }); // arm
  assert.ok(jarrik.statuses.some((s) => s.kind === "skill_damage_bonus" && s.name === "Brimsteel Scabbard"), "armed the +20 skill_damage_bonus");
  const minionsBefore = minionCount(state, "A");

  const hp1 = enemy.hp;
  performAction(state, { unit: "j", skillId: "jarrik1", targets: ["e"] }); // fire the rider
  assert.equal(hp1 - enemy.hp, 30, "Blade of Ashes deals triple (10 -> 30)");
  assert.ok(!jarrik.statuses.some((s) => s.name === "Brimsteel Scabbard"), "the mark + bonus are consumed (one-shot)");
  assert.equal(minionCount(state, "A"), minionsBefore + 1, "a Cinderling was created");

  const hp2 = enemy.hp;
  performAction(state, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(hp2 - enemy.hp, 10, "the next Blade of Ashes is a normal 10");
});
