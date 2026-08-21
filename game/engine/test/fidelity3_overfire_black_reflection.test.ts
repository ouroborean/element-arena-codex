import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — Laria "Black Reflection" fusion (laria:mirror), the `statusApplied` trigger whose
// gate was fixed from the over-firing STATE check `has(Deepening Shadows, recipient)` to the APPLIED-status
// check `{ eventStatusKind:"stack", name:"Deepening Shadows" }`.
//
// Frozen (skills.json): "Whenever another Hero reaches 4 stacks of Deepening Shadows, Laria will swap her
// current HP with theirs."
//
// Fixed trigger (fusions.authored.json, source "Black Reflection"):
//   on statusApplied, when AND[
//     eventStatusKind:"stack" name:"Deepening Shadows",   // the APPLIED status is a Deepening Shadows stack
//     isKind eventUnit hero,                              // it landed on a Hero
//     not sameUnit(eventUnit, self),                      // "another" Hero, not Laria
//     stackCount(Deepening Shadows, eventUnit) == 4 ]     // that reaches exactly 4
//   -> custom swapCurrentHp { a: self, b: eventUnit }     // swap current HP (max HP untouched)
//
// The pre-fix gate keyed on has(Deepening Shadows, recipient) — a STATE test that held true for EVERY status
// applied to a hero already carrying 4 Deepening Shadows. That over-fired: applying ANY unrelated status (a
// mark, a debuff, ...) to a hero who already sat at 4 stacks would re-swap Laria's HP. The eventStatusKind
// gate requires the APPLIED status itself to be the Deepening Shadows stack, so only the stack gain fires it.
//
// Deepening Shadows is a `{ kind:"stack", name:"Deepening Shadows", magnitude }` resource; rawStackCount reads
// `magnitude` (see engine/src/status.ts), so magnitude 4 == 4 stacks.

const ds = (magnitude: number) => ({ kind: "stack" as const, name: "Deepening Shadows", magnitude, duration: null as number | null, appliedBy: "la", appliedTurn: 0 });

/** Laria fused into her Mirror form + one ENEMY HERO holding `stacks` Deepening Shadows, in a fresh state. */
function setup(enemyStacks: number) {
  const laria = loadHero(heroById("laria"), "A", "la");
  const form = fusionForm("laria", "mirror");
  assert.ok(form, "fusion form laria:mirror (Black Reflection) must exist");
  applyFusion(laria, form as FusionForm);
  laria.hp = 100; // her current HP going into the swap

  const enemy = makeUnit({ id: "e1", team: "B", name: "Enemy Hero", hp: 30, statuses: [ds(enemyStacks)] });
  const state = makeState([laria], [enemy]);
  return { state, laria, enemy };
}

test("Black Reflection: a hero reaching 4 Deepening Shadows swaps Laria's current HP with theirs; an unrelated status on a 4-stack hero does not", () => {
  // Positive — the Deepening Shadows stack that brings the enemy hero to 4 is the one APPLIED. eventUnit is
  // the enemy (kind hero, != Laria) at exactly 4 stacks -> swapCurrentHp: Laria 100<->30 enemy.
  {
    const { state, laria, enemy } = setup(4);
    assert.equal(laria.hp, 100, "Laria starts at 100 current HP");
    assert.equal(enemy.hp, 30, "the enemy hero starts at 30 current HP");

    emit(state, { type: "statusApplied", unit: "e1", source: "la", kind: "stack", name: "Deepening Shadows" });

    assert.equal(state.units["la"]!.hp, 30, "Laria's current HP swapped to the enemy's 30");
    assert.equal(state.units["e1"]!.hp, 100, "the enemy hero's current HP swapped to Laria's 100");
  }

  // Over-fire control — the enemy hero ALREADY holds 4 Deepening Shadows, but the APPLIED status is an
  // unrelated mark (kind:"mark", name:"Decoy"), NOT a Deepening Shadows stack. Pre-fix, has(Deepening
  // Shadows, recipient) was true and the HP re-swapped; the eventStatusKind gate must leave HP untouched.
  {
    const { state, laria, enemy } = setup(4);
    assert.equal(laria.hp, 100, "Laria at 100 before the unrelated status");
    assert.equal(enemy.hp, 30, "enemy at 30 before the unrelated status");

    emit(state, { type: "statusApplied", unit: "e1", source: "la", kind: "mark", name: "Decoy" });

    assert.equal(state.units["la"]!.hp, 100, "an unrelated status on a 4-stack hero must NOT swap Laria's HP");
    assert.equal(state.units["e1"]!.hp, 30, "the enemy hero's HP is unchanged");
  }

  // Boundary control — the gate is `== 4` ("reaches 4"). A Deepening Shadows stack applied to a hero already
  // at 5 stacks reads stackCount == 5 != 4, so it must NOT swap (only the crossing to exactly 4 fires).
  {
    const { state, laria, enemy } = setup(5);

    emit(state, { type: "statusApplied", unit: "e1", source: "la", kind: "stack", name: "Deepening Shadows" });

    assert.equal(state.units["la"]!.hp, 100, "a Deepening Shadows stack at 5 (!=4) must not swap Laria's HP");
    assert.equal(state.units["e1"]!.hp, 30, "the enemy hero's HP is unchanged at 5 stacks");
  }
});
