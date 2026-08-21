import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers fusion custom handlers
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — Zephyrex "Cloud Step" (zephyrexcloud0) reactive trigger, on statusApplied.
//
// Frozen (skills.json): "Wind Step now lasts an additional turn."
// Fixed trigger (cloud form): on statusApplied,
//   when { and: [ sameUnit(eventUnit, self), eventStatusKind: "damage_reduction" ] }
//   effect: modifyStatus damage_reduction from:self durationDelta:+1.
// Wind Step (zephyrex4) is Zephyrex's only source of the (invisible) damage_reduction status, so
// reacting to HIM gaining damage_reduction and extending it by one turn is the faithful implementation.
//
// This locks in BOTH halves of the eventStatusKind gate fix:
//   POSITIVE      — the damage_reduction status is the one being APPLIED -> its duration is bumped +1 once.
//   OVER-FIRE     — a DIFFERENT status (mark "Decoy") applied while Zephyrex ALREADY holds
//                   damage_reduction must NOT extend the DR. Pre-fix, the gate read a STATE check
//                   (has damage_reduction on self), so it fired on EVERY status he received while he
//                   still carried DR — spuriously stacking extra Wind Step turns. The eventStatusKind
//                   gate requires the APPLIED status itself to be the damage_reduction.
//
// modifyStatus adjusts the existing status in place (no remove+re-apply), so it does NOT re-emit
// statusApplied — the positive fires exactly once (+1, not a runaway loop).

const dr = (u: { statuses: { kind: string; name?: string; duration?: number | null }[] }) =>
  u.statuses.find((s) => s.kind === "damage_reduction");

function setup() {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const form = fusionForm("zephyrex", "cloud");
  assert.ok(form, "fusion form zephyrex:cloud must exist");
  applyFusion(zeph, form!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  return { state, zeph };
}

test("Cloud Step: applying damage_reduction to Zephyrex extends its duration by 1 (once); a non-DR status does not", () => {
  // POSITIVE — the damage_reduction is the status being applied (eventUnit == self, eventStatusKind == DR).
  {
    const { state, zeph } = setup();
    zeph.statuses.push({ kind: "damage_reduction", magnitude: 5, duration: 2, appliedBy: "zx", appliedTurn: 0 });
    assert.equal(dr(zeph)?.duration, 2, "Wind Step's damage_reduction starts at duration 2");

    emit(state, { type: "statusApplied", unit: "zx", source: "zx", kind: "damage_reduction" });

    assert.equal(dr(zeph)?.duration, 3, "Cloud Step extends the newly-applied damage_reduction by one turn (2 -> 3)");
  }

  // OVER-FIRE CONTROL — Zephyrex ALREADY holds the damage_reduction (dur 2); a DIFFERENT status
  // (mark "Decoy") is applied to him. The applied status is not a damage_reduction, so Cloud Step must
  // NOT fire — the DR duration stays 2. (Pre-fix state check would have spuriously bumped it to 3.)
  {
    const { state, zeph } = setup();
    zeph.statuses.push({ kind: "damage_reduction", magnitude: 5, duration: 2, appliedBy: "zx", appliedTurn: 0 });

    emit(state, { type: "statusApplied", unit: "zx", source: "zx", kind: "mark", name: "Decoy" });

    assert.equal(dr(zeph)?.duration, 2, "a non-DR status applied while he holds DR must NOT extend the damage_reduction");
  }
});
