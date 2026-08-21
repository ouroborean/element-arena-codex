import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

// Fidelity Campaign 3 coverage — pyrrha:judgment "Judgment Day" (#34).
// Frozen (pyrrhajudgment1): "Target enemy with 7 or more stacks of Flames of Judgment is instantly
// killed. This skill Bypasses and cannot be countered or reflected."
// SHIPPING: the generated pyrrhajudgment1 carries the "Uncounterable" tag; resolveDeclaration()
// early-returns { cancelled:false } on skill.tags.includes("Uncounterable") BEFORE the counter/reflect
// (findInterrupt) loop — so an armed counter never cancels the skill and never retaliates.
//
// Setup: a pyrrha with the judgment fusion (so she has pyrrhajudgment1). The enemy holds 7 Flames of
// Judgment stacks AND arms a counter whose retaliation deals 40 to the declaring caster (eventSource).
// The Uncounterable tag must suppress BOTH the cancellation and the retaliation, so the kill lands and
// pyrrha is untouched. The control strips the tag off the instance and re-casts: now the counter fires,
// the skill is cancelled (enemy survives), and pyrrha eats the 40 — proving the tag is what did the work.

function arm() {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(pyrrha, fusionForm("pyrrha", "judgment")!);
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100, maxHp: 100, kind: "hero",
    statuses: [status("stack", { name: "Flames of Judgment", magnitude: 7 })],
  });
  // A counter that both cancels the declaration and blasts the declaring caster (eventSource == pyrrha).
  enemy.triggers = [{
    on: "skillDeclared", owner: "e", kind: "counter", source: "t",
    effect: [{ op: "damage", amount: 40, to: "eventSource" }],
  }];
  const state = makeState([pyrrha], [enemy]);
  state.teams.A.energy = { generic: 20, judgment: 20 };
  return { pyrrha, enemy, state };
}

test("Judgment Day is uncounterable: the kill lands and the armed counter never fires back", () => {
  const { pyrrha, enemy, state } = arm();
  const skill = pyrrha.skills!.find((s) => s.id === "pyrrhajudgment1")!;
  assert.ok(skill.tags.includes("Uncounterable"), "precondition: pyrrhajudgment1 carries the Uncounterable tag");
  const pyrrhaHp = pyrrha.hp;

  const r = performAction(state, { unit: "p", skillId: "pyrrhajudgment1", targets: ["e"] });

  assert.equal(r.ok, true, "the cast is legal and resolves");
  assert.notEqual(r.countered, true, "not countered — the Uncounterable early-return skipped the counter loop");
  assert.equal(enemy.alive, false, "the 7-stack enemy is instantly killed (effects ran)");
  assert.equal(enemy.hp, 0);
  assert.equal(pyrrha.hp, pyrrhaHp, "the counter's retaliation never fired at the caster");
});

test("control: without the Uncounterable tag the same counter cancels the skill and hits back", () => {
  const { pyrrha, enemy, state } = arm();
  const skill = pyrrha.skills!.find((s) => s.id === "pyrrhajudgment1")!;
  skill.tags = skill.tags.filter((t) => t !== "Uncounterable"); // strip the tag on this instance only
  const pyrrhaHp = pyrrha.hp;

  const r = performAction(state, { unit: "p", skillId: "pyrrhajudgment1", targets: ["e"] });

  assert.equal(r.countered, true, "with the tag gone the counter cancels the declaration");
  assert.equal(enemy.alive, true, "the kill effect never ran — enemy survives");
  assert.equal(pyrrha.hp, pyrrhaHp - 40, "the counter's retaliation reached the caster");
});
