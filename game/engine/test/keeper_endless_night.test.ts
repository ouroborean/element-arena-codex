import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { performAction } from "../src/scheduler.ts";
import { totalShield } from "../src/damage.ts";
import { redactState } from "../src/visibility.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

// PR 3 — Keeper of Fables "night" fusion, wired onto the unified invisibility flag:
//   - "Reading in the Dark" now fires on {eventHidden} — ANY Invisible skill use banks 10 Shield, closing
//     the old gap where the mark-only reader missed every inherently-Invisible skill.
//   - "Tale of Endless Night" applies a `cloak` (non-breaking concealment window) to the whole allied team,
//     so their skill-uses read Invisible and redactState hides their effects for 2 turns.

test("Reading in the Dark banks 10 Shield on ANY Invisible skill use (eventHidden), not only Endless Night", () => {
  const keeper = loadHero(heroById("keeper"), "A", "k");
  applyFusion(keeper, fusionForm("keeper", "night")!);
  const state = makeState([keeper], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [], hidden: false });
  assert.equal(totalShield(keeper), 0, "a visible skill banks nothing");

  emit(state, { type: "skillUsed", caster: "e", skillId: "y", targets: [], tags: [], hidden: true });
  assert.equal(totalShield(keeper), 10, "an Invisible skill (from anyone) banks 10 Shield");
});

test("Tale of Endless Night cloaks the whole allied team, concealing their effects from the opponent", () => {
  const keeper = loadHero(heroById("keeper"), "A", "k");
  applyFusion(keeper, fusionForm("keeper", "night")!);
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([keeper, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 10, night: 10 };

  performAction(state, { unit: "k", skillId: "keepernight1", targets: [] });
  assert.ok(keeper.statuses.some((s) => s.kind === "cloak" && s.name === "Endless Night"), "Keeper is cloaked");
  assert.ok(ally.statuses.some((s) => s.kind === "cloak" && s.name === "Endless Night"), "the whole allied team is cloaked (all-allies)");

  // A cloaked ally's ordinary buff is now hidden from the opponent, still visible to the owner.
  ally.statuses.push({ kind: "mark", name: "Bee", duration: null, appliedBy: "a2", appliedTurn: 0 });
  assert.ok(!redactState(state, "B").units["a2"]!.statuses.some((s) => s.name === "Bee"), "the opponent cannot see a cloaked ally's effect");
  assert.ok(redactState(state, "A").units["a2"]!.statuses.some((s) => s.name === "Bee"), "the owner still sees it");
});

test("a cloak window is NOT stripped by a Harmful action (unlike veiled)", () => {
  const u = makeUnit({ id: "k", team: "A", statuses: [status("cloak", { name: "Endless Night", duration: 2, appliedBy: "k" })],
    skills: [skill("hit", [], { tags: ["Harmful"], targeting: "single" })] });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);

  performAction(state, { unit: "k", skillId: "hit", targets: ["e"] });
  assert.ok(u.statuses.some((s) => s.kind === "cloak"), "the cloak persists through a Harmful cast — the 2-turn window is intact");
});
