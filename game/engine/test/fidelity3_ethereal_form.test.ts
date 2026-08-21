import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 31 — blackknight:ghost "Ethereal Form": "The turn after ignoring a skill, the
// Black Knight deals 10 additional damage." His Dead or Alive (blackknight4) "ignores all new Harmful skills
// for 1 turn" (modeled as damage_ignore + non_damage_ignore). So a skill is "ignored" exactly when it is
// Harmful, from an enemy, targets him, while that window is active. The trigger now verifies Harmful via the
// existing eventHasTag primitive (skillUsed carries tags: skill.tags), closing the over-fire on a
// non-Harmful skill that would otherwise still have landed.

const armsEthereal = (state: MatchState, bk: Unit): boolean =>
  state.scheduled.some(
    (e) =>
      e.targets.includes(bk.id) &&
      e.effect.some((op) => op.op === "applyStatus" && (op as { status?: { name?: string } }).status?.name === "Ethereal Form"),
  );

function deadOrAlive(): { state: MatchState; bk: Unit } {
  const bk = loadHero(heroById("blackknight"), "A", "b");
  applyFusion(bk, fusionForm("blackknight", "ghost")!);
  // Dead or Alive active: he ignores all new Harmful skills (damage_ignore + non_damage_ignore).
  bk.statuses.push({ kind: "damage_ignore", duration: 1, appliedBy: "b", appliedTurn: 0 });
  bk.statuses.push({ kind: "non_damage_ignore", duration: 1, appliedBy: "b", appliedTurn: 0 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([bk], [enemy]);
  return { state, bk };
}

test("ignoring an enemy Harmful skill arms Ethereal Form (+10 next turn)", () => {
  const { state, bk } = deadOrAlive();
  emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: ["b"], tags: ["Harmful"] });
  assert.ok(armsEthereal(state, bk), "a Harmful skill ignored under Dead or Alive schedules Ethereal Form");
});

test("a non-Harmful enemy skill targeting him does NOT arm Ethereal Form", () => {
  const { state, bk } = deadOrAlive();
  emit(state, { type: "skillUsed", caster: "e", skillId: "hex", targets: ["b"], tags: ["Strategic"] });
  assert.ok(!armsEthereal(state, bk), "a non-Harmful skill is not ignored by Dead or Alive -> no Ethereal Form");
});

test("without the ignore window active, even a Harmful skill does not arm it", () => {
  const bk = loadHero(heroById("blackknight"), "A", "b");
  applyFusion(bk, fusionForm("blackknight", "ghost")!);
  const state = makeState([bk], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: ["b"], tags: ["Harmful"] });
  assert.ok(!armsEthereal(state, bk), "no ignore window -> nothing was ignored -> no Ethereal Form");
});
