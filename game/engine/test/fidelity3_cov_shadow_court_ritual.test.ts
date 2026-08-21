import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 (coverage) — xyris:ritual "Shadow Court Ritual" (#42/#74). Frozen text:
// "Any time Elemental Essence is gained, Xyris gains 5 Ritual Power. After reaching 75 Ritual Power,
// all units have their skill cooldowns reduced by 1."
// SHIPPING: the fusion form "ritual" carries a statusApplied trigger gated {eventStatusKind:elemental_essence}
// that adds 5 to Xyris's "Ritual Power" stack (to:self). The gate keys off the APPLIED status kind, so it fires
// on ANY unit's essence gain, and only on essence — never on an unrelated status landing.

const ritualPower = (u: { statuses: { kind: string; name?: string; magnitude?: number }[] }): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === "Ritual Power")?.magnitude ?? 0;

test("Shadow Court Ritual: each Elemental Essence gain (on any unit) grants Xyris +5 Ritual Power", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyFusion(xyris, fusionForm("xyris", "ritual")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, kind: "hero" });
  const state = makeState([xyris], [enemy]);

  assert.equal(ritualPower(xyris), 0, "Xyris starts with no Ritual Power");

  // Essence gained on the ENEMY (any unit) still credits Xyris's Ritual Power (+5).
  emit(state, { type: "statusApplied", unit: "e", source: null, kind: "elemental_essence" });
  assert.equal(ritualPower(xyris), 5, "first Elemental Essence gain -> +5 Ritual Power");

  // A second essence gain (this time on Xyris herself) stacks another +5 (=10).
  emit(state, { type: "statusApplied", unit: "x", source: null, kind: "elemental_essence" });
  assert.equal(ritualPower(xyris), 10, "second Elemental Essence gain -> +5 again (=10)");

  // Well below 75: no cooldown-reduction threshold latched yet.
  assert.ok(!xyris.statuses.some((s) => s.name === "Ritual Unleashed"), "the 75 threshold has not fired at 10 Ritual Power");
});

test("Shadow Court Ritual control: an unrelated status applied does NOT grant Ritual Power", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyFusion(xyris, fusionForm("xyris", "ritual")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, kind: "hero" });
  const state = makeState([xyris], [enemy]);

  // A non-essence status landing (a plain mark) must not move Ritual Power — the gate is essence-only.
  emit(state, { type: "statusApplied", unit: "x", source: null, kind: "mark", name: "Cinders" });
  assert.equal(ritualPower(xyris), 0, "an unrelated (non-essence) status applied does not grant Ritual Power");
});
