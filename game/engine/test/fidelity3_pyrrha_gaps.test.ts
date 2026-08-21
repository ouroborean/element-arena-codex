import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3 verification follow-ups (pyrrha):
//  #35 Blastoff "invulnerable for 2 turns, OR until she uses a new skill" — the early self-cancel was missing.
//  #51 Flames of Judgment "...or using a skill ON PYRRHA OR HER ALLIES gives enemies a stack" — the target gate
//      was missing (it fired on any enemy skill).

const hasInvuln = (u: Unit): boolean => u.statuses.some((s) => s.kind === "invulnerable" && s.name === "Blastoff");
const hasGrace = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "Blastoff Grace");
const foj = (u: Unit): number => u.statuses.find((s) => s.kind === "stack" && s.name === "Flames of Judgment")?.magnitude ?? 0;

test("#35 Blastoff Invulnerable survives its own cast, then ends on Pyrrha's NEXT skill", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "mechanic")!);
  const state = makeState([pyrrha], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  // Post-Blastoff state: the skill applied the named Invulnerable + the one-shot grace.
  pyrrha.statuses.push({ kind: "invulnerable", name: "Blastoff", duration: 2, appliedBy: "p", appliedTurn: 0 });
  pyrrha.statuses.push({ kind: "mark", name: "Blastoff Grace", duration: 2, appliedBy: "p", appliedTurn: 0 });

  // The Blastoff cast's own skillUsed: grace is consumed, Invulnerable survives.
  emit(state, { type: "skillUsed", caster: "p", skillId: "pyrrhamechanic1", targets: ["e"], tags: ["Harmful"] });
  assert.ok(hasInvuln(pyrrha), "Invulnerable survives the Blastoff cast that applied it");
  assert.ok(!hasGrace(pyrrha), "the one-shot grace was consumed");

  // Her next skill: no grace left, so the Invulnerable ends early.
  emit(state, { type: "skillUsed", caster: "p", skillId: "pyrrha1", targets: ["e"], tags: ["Harmful"] });
  assert.ok(!hasInvuln(pyrrha), "the Invulnerable ends when she uses a new skill");
});

test("#35 an enemy's skill does NOT end Pyrrha's Blastoff Invulnerable", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "mechanic")!);
  const state = makeState([pyrrha], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  pyrrha.statuses.push({ kind: "invulnerable", name: "Blastoff", duration: 2, appliedBy: "p", appliedTurn: 0 });
  pyrrha.statuses.push({ kind: "mark", name: "Blastoff Grace", duration: 2, appliedBy: "p", appliedTurn: 0 });

  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["p"], tags: ["Harmful"] });
  assert.ok(hasInvuln(pyrrha), "only Pyrrha's own skill cancels it, not an enemy's");
  assert.ok(hasGrace(pyrrha), "the grace is untouched by an enemy's skill");
});

test("#51 Flames of Judgment fires when an enemy targets Pyrrha or an ally, not on a self/ally-targeted enemy skill", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "judgment")!);
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([pyrrha, ally], [e1, e2]);

  emit(state, { type: "skillUsed", caster: "e1", skillId: "atk", targets: ["p"], tags: ["Harmful"] });
  assert.equal(foj(e1), 1, "an enemy skill aimed at Pyrrha grants that enemy a stack");

  emit(state, { type: "skillUsed", caster: "e1", skillId: "atk", targets: ["a"], tags: ["Harmful"] });
  assert.equal(foj(e1), 2, "an enemy skill aimed at Pyrrha's ally also grants a stack");

  emit(state, { type: "skillUsed", caster: "e2", skillId: "buff", targets: ["e2"], tags: ["Strategic"] });
  assert.equal(foj(e2), 0, "an enemy skill aimed at itself grants NO stack (the target gate)");

  emit(state, { type: "skillUsed", caster: "e2", skillId: "buff", targets: ["e1"], tags: ["Helpful"] });
  assert.equal(foj(e2), 0, "an enemy skill aimed at its own ally grants NO stack");
});
