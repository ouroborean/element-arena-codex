import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 21 — ayana:prism "Prism Sentence": a marked enemy takes DOUBLE Voice-of-Light
// damage (a source-scoped incoming_damage_mult x2 via viaSourceId), and casting VoL on it ALSO casts it on
// the whole enemy team, Bypassing (base ayana1: if the target is Prism-marked, a forEach-enemies bypass hit).

const prismMarks = (): Unit["statuses"] => [
  { kind: "mark", name: "Prism Sentence", duration: 2, appliedBy: "ay", appliedTurn: 0 },
  { kind: "incoming_damage_mult", name: "Prism Sentence", magnitude: 2, viaSourceId: "ayana1.hit", duration: 2, appliedBy: "ay", appliedTurn: 0 },
];

test("VoL on a Prism-marked enemy doubles it AND spreads a bypassing hit to the whole enemy team", () => {
  const ayana = loadHero(heroById("ayana"), "A", "ay");
  const marked = makeUnit({ id: "m", team: "B", hp: 100, maxHp: 100, kind: "hero", statuses: prismMarks() });
  const other = makeUnit({ id: "o", team: "B", hp: 100, maxHp: 100, kind: "hero", shield: 50,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "o", appliedTurn: 0 }] });
  const state = makeState([ayana], [marked, other]);
  state.teams.A.energy = { generic: 10 };

  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["m"] });

  // marked: primary 15 x2 = 30, plus the team-spread hit on it 15 x2 = 30 -> 60.
  assert.equal(marked.hp, 40, "the marked enemy takes the doubled primary + the doubled spread hit");
  // other: the spread hit is 15, Bypassing its 10 DR and 50 Shield (and not doubled, since it isn't marked).
  assert.equal(other.hp, 85, "the spread hit bypasses DR + Shield on the rest of the team");
});

test("VoL on a non-Prism enemy is a normal single 15, no spread", () => {
  const ayana = loadHero(heroById("ayana"), "A", "ay");
  const target = makeUnit({ id: "t", team: "B", hp: 100, maxHp: 100, kind: "hero" });
  const other = makeUnit({ id: "o", team: "B", hp: 100, maxHp: 100, kind: "hero" });
  const state = makeState([ayana], [target, other]);
  state.teams.A.energy = { generic: 10 };

  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["t"] });
  assert.equal(target.hp, 85, "plain VoL deals 15");
  assert.equal(other.hp, 100, "no spread without a Prism-marked target");
});
