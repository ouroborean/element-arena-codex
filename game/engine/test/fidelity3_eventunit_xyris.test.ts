import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

// Fidelity Campaign 3 — statusApplied triggers were firing on the "eventTarget" selector, which does
// NOT resolve for statusApplied events (they carry "unit", not "target"), so the trigger silently never
// fired. Fix: "eventTarget" -> "eventUnit" (the status recipient).
//
// Somnic Adaptation (augment xyris2): "Xyris gains 5 permanent Shield each time he gains Elemental Essence."
// Elemental Essence is modeled as a status kind ("elemental_essence"); when it lands on Xyris a statusApplied
// event fires with unit = Xyris, and the trigger gates on sameUnit(eventUnit, self) + has elemental_essence.
// eventUnit (the recipient of the applied status) is the CORRECT unit: the frozen means the Hero WHO gains
// the essence, which is exactly the unit the essence status landed on.

test("Somnic Adaptation: Xyris gains 5 permanent Shield each time Elemental Essence lands on him", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris2")!);
  // Essence is present on Xyris at the moment the statusApplied event fires (applyStatus adds the status,
  // then emits the event), so the `has elemental_essence` gate holds.
  xyris.statuses.push(status("elemental_essence"));
  const state = makeState([xyris], [makeUnit({ id: "e", team: "B" })]);

  const before = totalShield(xyris);
  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: "elemental_essence" });
  assert.equal(totalShield(xyris), before + 5, "gaining Elemental Essence grants 5 permanent Shield");

  // "each time" — a second gain grants another 5 (the trigger is not one-shot; the Shield is permanent).
  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: "elemental_essence" });
  assert.equal(totalShield(xyris), before + 10, "each further essence gain grants another 5 Shield");

  // Permanent: the granted shields carry no duration.
  assert.ok(xyris.shields.every((s) => s.duration === null), "granted Shield is permanent (no duration)");
});

test("Somnic Adaptation: does NOT fire when the status lands on someone else (eventUnit gate)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris2")!);
  xyris.statuses.push(status("elemental_essence")); // Xyris holds essence...
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([xyris], [enemy]);

  const before = totalShield(xyris);
  // ...but the essence event's recipient is the ENEMY, not Xyris. eventUnit != self -> must not fire.
  emit(state, { type: "statusApplied", unit: "e", source: "e", kind: "elemental_essence" });
  assert.equal(totalShield(xyris), before, "essence landing on another unit grants Xyris no Shield");
});

test("Somnic Adaptation: does NOT fire when Xyris has no Elemental Essence", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris2")!);
  const state = makeState([xyris], [makeUnit({ id: "e", team: "B" })]);

  const before = totalShield(xyris);
  // A statusApplied on Xyris while he holds no essence: the `has elemental_essence` gate fails.
  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: "poison" });
  assert.equal(totalShield(xyris), before, "no essence held -> no Shield granted");
});
