import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 27 — jarrik:sun "Dawnbreak": marks all enemies with Cinders, but "this effect
// cannot be consumed to create Cinderling minions". A companion "Dawnbreak Cinders" marker: Call Cinders
// (jarrik3) still damages these enemies as Cinders-marked, but skips the mark-removal + Cinderling summon.

const minionCount = (st: MatchState): number => Object.values(st.units).filter((u) => u.kind === "minion" && u.team === "A" && u.alive).length;
const mark = (name: string): Unit["statuses"][number] => ({ kind: "mark", name, duration: 3, appliedBy: "j", appliedTurn: 0 });

test("Call Cinders consumes regular Cinders into a Cinderling but not Dawnbreak Cinders", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  const regular = makeUnit({ id: "r", team: "B", hp: 100, maxHp: 100, kind: "hero", statuses: [mark("Cinders")] });
  const dawn = makeUnit({ id: "d", team: "B", hp: 100, maxHp: 100, kind: "hero", statuses: [mark("Cinders"), mark("Dawnbreak Cinders")] });
  const state = makeState([jarrik], [regular, dawn]);
  state.teams.A.energy = { generic: 20, fire: 20 };
  const before = minionCount(state);

  performAction(state, { unit: "j", skillId: "jarrik3", targets: [] });

  assert.ok(regular.hp < 100, "the regular Cinders enemy takes damage");
  assert.equal(dawn.hp, regular.hp, "the Dawnbreak Cinders enemy takes the SAME damage (still counts as Cinders)");
  assert.ok(!regular.statuses.some((s) => s.name === "Cinders"), "regular Cinders is consumed");
  assert.ok(dawn.statuses.some((s) => s.name === "Cinders"), "Dawnbreak Cinders is NOT consumed");
  assert.equal(minionCount(state), before + 1, "exactly ONE Cinderling (from the regular Cinders only)");
});
