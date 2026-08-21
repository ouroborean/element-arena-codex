import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 29 — jarrik:dragon "Drakken": "After using this skill, Jarrik can no longer apply,
// trigger, or consume Cinders." A persistent Drakken self-mark gates all three: the applyStatus op suppresses
// Cinders application, and the Cinders passive + Call Cinders' consume are gated on the mark's absence.

const drakken = (u: Unit): void => { u.statuses.push({ kind: "mark", name: "Drakken", duration: null, appliedBy: "j", appliedTurn: 0 }); };
const minions = (st: MatchState): number => Object.values(st.units).filter((u) => u.kind === "minion" && u.team === "A" && u.alive).length;

test("under Drakken, Blade of Ashes applies NO Cinders (apply is locked)", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  drakken(jarrik);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, kind: "hero" });
  const state = makeState([jarrik], [enemy]);
  state.teams.A.energy = { generic: 20, fire: 20 };

  performAction(state, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.ok(!enemy.statuses.some((s) => s.name === "Cinders"), "no Cinders applied while Drakken is held");
});

test("under Drakken, Call Cinders does not consume Cinders into Cinderlings", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  drakken(jarrik);
  const marked = makeUnit({ id: "m", team: "B", hp: 100, maxHp: 100, kind: "hero",
    statuses: [{ kind: "mark", name: "Cinders", duration: null, appliedBy: "j", appliedTurn: 0 }] });
  const state = makeState([jarrik], [marked]);
  state.teams.A.energy = { generic: 20, fire: 20 };
  const before = minions(state);

  performAction(state, { unit: "j", skillId: "jarrik3", targets: [] });
  assert.equal(minions(state), before, "no Cinderling created (consume locked)");
  assert.ok(marked.statuses.some((s) => s.name === "Cinders"), "the Cinders mark is not consumed");
});
