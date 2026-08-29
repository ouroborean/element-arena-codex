import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// Fidelity Campaign 3, PR 26 + PR35 — jarrik:brimstone "Brimsteel Scabbard": arms a one-shot rider on the
// next Blade of Ashes — triple damage, uncounterable, and "if it strikes an enemy AFFECTED BY Cinders, it
// automatically creates a Cinderling." Because Blade of Ashes applies Cinders after its damage, the Cinderling
// procs only when the target ALREADY bore Cinders (a pre-strike check), not from this strike's own mark.

const minionCount = (st: MatchState, team: string): number => Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive).length;
const cinders = () => ({ kind: "mark" as const, name: "Cinders", duration: null, appliedBy: "j", appliedTurn: 0 });

test("Brimsteel Scabbard triples the next Blade of Ashes and reverts; a FRESH enemy yields NO Cinderling", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "brimstone")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, kind: "hero" });
  const state = makeState([jarrik], [enemy]);
  state.teams.A.energy = { generic: 20, fire: 20, brimstone: 20 };

  performAction(state, { unit: "j", skillId: "jarrikbrimstone1", targets: [] }); // arm
  assert.ok(jarrik.statuses.some((s) => s.kind === "skill_damage_bonus" && s.name === "Brimsteel Scabbard"), "armed the +20 skill_damage_bonus");
  const minionsBefore = minionCount(state, "A");

  const hp1 = enemy.hp;
  performAction(state, { unit: "j", skillId: "jarrik1", targets: ["e"] }); // fire the rider on a not-yet-Cinders enemy
  assert.equal(hp1 - enemy.hp, 30, "Blade of Ashes deals triple (10 -> 30)");
  assert.ok(!jarrik.statuses.some((s) => s.name === "Brimsteel Scabbard"), "the mark + bonus are consumed (one-shot)");
  assert.equal(minionCount(state, "A"), minionsBefore, "NO Cinderling: the enemy was not Cinders-affected when struck");

  const hp2 = enemy.hp;
  performAction(state, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(hp2 - enemy.hp, 20, "10 base + the kept base Cinders passive's 10 Affliction (the enemy now bears Cinders from the first strike)");
});

test("Brimsteel Scabbard DOES summon a Cinderling when the struck enemy already bears Cinders", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "brimstone")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, kind: "hero", statuses: [cinders()] });
  const state = makeState([jarrik], [enemy]);
  state.teams.A.energy = { generic: 20, fire: 20, brimstone: 20 };

  performAction(state, { unit: "j", skillId: "jarrikbrimstone1", targets: [] }); // arm
  const minionsBefore = minionCount(state, "A");

  performAction(state, { unit: "j", skillId: "jarrik1", targets: ["e"] }); // strike the pre-Cinders enemy
  assert.equal(minionCount(state, "A"), minionsBefore + 1, "a Cinderling is created (the enemy was already Cinders-affected)");
});
