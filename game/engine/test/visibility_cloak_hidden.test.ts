import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { Status, Unit } from "../src/types.ts";

// PR 2 — the `hidden` flag on skill events is now UNIFIED: a cast is Invisible if the skill is isHidden OR
// its caster is currently concealed by a cloak (veiled / cloak). So a reader like Sera "Eyes of Vengeance"
// ({not:{eventHidden:true}}) ignores a Harmful skill cast from stealth, not only an inherently-Invisible one.
// The concealment is captured BEFORE the veil-break, so a stealth STRIKE (which breaks veiled) still reads
// Invisible for its own cast.

const eyes = (u: Unit): number => u.statuses.find((s) => s.kind === "stack" && s.name === "Eyes of Vengeance")?.magnitude ?? 0;

function seraSetup(enemyStatuses: Status[]) {
  const sera = loadHero(heroById("sera"), "A", "sera");
  const ally = makeUnit({ id: "a2", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", statuses: enemyStatuses,
    skills: [skill("strike", [], { tags: ["Harmful"], targeting: "single" })] });
  const state = makeState([sera, ally], [enemy]);
  state.teams.B.energy = { generic: 5 };
  return { enemy, state };
}

test("a veiled caster's Harmful skill reads as Invisible — Sera gains no stack, and there is no telegraph", () => {
  const { enemy, state } = seraSetup([status("veiled", { appliedBy: "e" })]);
  performAction(state, { unit: "e", skillId: "strike", targets: ["a2"] });
  assert.equal(eyes(enemy), 0, "a veiled attacker's strike is Invisible → no Eyes of Vengeance (flag captured pre-break)");
  assert.ok(!state.log.some((l) => l.includes("used")), "the cloaked cast leaves no `used` telegraph");
});

test("a cloak-window caster's Harmful skill reads as Invisible — Sera gains no stack", () => {
  const { enemy, state } = seraSetup([status("cloak", { name: "Endless Night", duration: 2, appliedBy: "e" })]);
  performAction(state, { unit: "e", skillId: "strike", targets: ["a2"] });
  assert.equal(eyes(enemy), 0, "a cloaked attacker's strike is Invisible → no Eyes of Vengeance");
});

test("an un-concealed caster's Harmful skill stays visible — Sera stacks (the unified flag does not over-hide)", () => {
  const { enemy, state } = seraSetup([]);
  performAction(state, { unit: "e", skillId: "strike", targets: ["a2"] });
  assert.equal(eyes(enemy), 1, "a visible attacker → Sera stacks");
  assert.ok(state.log.some((l) => l.includes("used")), "a visible cast telegraphs normally");
});
