import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — Laria "Vanishing Powder" augment (laria5):
// Frozen (augments.json): "When a character receives their 3rd stack of Deepening Shadows, they
// gain the effects of Vanish."
// Shipping: laria5 adds a `statusApplied` trigger (source "Vanishing Powder") that, when the unit a
// status just landed on now holds exactly 3 stacks of "Deepening Shadows", applyStatus a
// `damage_reduction` named "Vanish" (magnitude 15, duration 3) to that unit.
//
// eventUnit is the CORRECT recipient: statusApplied carries the recipient in `event.unit`, and the
// frozen text says the character who "receives their 3rd stack" is the same character who "gains the
// effects of Vanish" — i.e. the status recipient, not its source. A `eventTarget` selector does NOT
// resolve for statusApplied (that event has no `target` field): the original eventTarget bug meant
// the trigger silently never fired. The fix (eventTarget -> eventUnit) addresses the recipient.
//
// The gate is `== 3` (their *3rd* stack), so the moment of crossing to 3 fires; 2 stacks (below the
// threshold) must NOT fire — this is the control.

const hasVanish = (u: { statuses: { kind: string; name?: string }[] }) =>
  u.statuses.some((s) => s.kind === "damage_reduction" && s.name === "Vanish");

test("Vanishing Powder: receiving the 3rd Deepening Shadows stack grants Vanish; 2 stacks does not", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria5")!);

  // e3 holds exactly 3 Deepening Shadows stacks (just received its 3rd); e2 holds only 2.
  // (Deepening Shadows is a { kind:"stack", name, magnitude } resource — see roster/status.ts rawStackCount.)
  const ds = (magnitude: number) => ({ kind: "stack" as const, name: "Deepening Shadows", magnitude, duration: null, appliedBy: "la", appliedTurn: 0 });
  const e3 = makeUnit({ id: "e3", team: "B", statuses: [ds(3)] });
  const e2 = makeUnit({ id: "e2", team: "B", statuses: [ds(2)] });
  const state = makeState([laria], [e3, e2]);

  assert.equal(hasVanish(state.units["e3"]!), false, "no Vanish before any statusApplied fires");
  assert.equal(hasVanish(state.units["e2"]!), false, "no Vanish before any statusApplied fires");

  // Positive: a Deepening Shadows stack lands on the 3-stack unit (its 3rd) -> it gains Vanish.
  emit(state, { type: "statusApplied", unit: "e3", source: "la", kind: "stack", name: "Deepening Shadows" });
  assert.equal(hasVanish(state.units["e3"]!), true, "3rd Deepening Shadows -> the recipient gains damage_reduction 'Vanish'");

  // The granted Vanish carries the frozen numbers (magnitude 15, duration 3).
  const grant = state.units["e3"]!.statuses.find((s) => s.kind === "damage_reduction" && s.name === "Vanish")!;
  assert.equal((grant as { magnitude?: number }).magnitude, 15, "Vanish magnitude 15");
  assert.equal((grant as { duration?: number }).duration, 3, "Vanish duration 3");

  // Negative/control: a status lands on the 2-stack unit -> NO Vanish (below the 3-stack threshold).
  emit(state, { type: "statusApplied", unit: "e2", source: "la", kind: "stack", name: "Deepening Shadows" });
  assert.equal(hasVanish(state.units["e2"]!), false, "only 2 Deepening Shadows -> no Vanish");
});
