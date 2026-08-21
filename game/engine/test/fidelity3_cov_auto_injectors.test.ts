import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 coverage — Dennis "Auto-Injectors" (augment dennis1):
// "Dennis will automatically use HS-46 Ascendant Serum on himself any time he receives a stun effect."
// SHIPPING: a statusApplied react trigger gated {sameUnit:[eventUnit,self]} AND {eventStatusKind:"stun"}
// -> useSkill dennis3 ("HS-46 Ascendant Serum") by self on self.
// dennis3's effects (roster.generated.ts): 5 Affliction damage to caster, applyStatus non_damage_ignore,
// and applyStatus mark "HS-46 Ascendant Serum" — those are the observables we lock.

const SERUM_MARK = "HS-46 Ascendant Serum";
const hasSerumMark = (u: { statuses: { kind: string; name?: string }[] }) =>
  u.statuses.some((s) => s.kind === "mark" && s.name === SERUM_MARK);

test("Auto-Injectors fires HS-46 Ascendant Serum when a STUN lands on Dennis", () => {
  const dennis = loadHero(heroById("dennis"), "A", "d");
  applyAugment(dennis, augmentById("dennis1")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B" })]);

  assert.ok(!hasSerumMark(dennis), "precondition: no HS-46 mark before any stun");
  const hpBefore = dennis.hp;

  // A stun status LANDING on Dennis auto-injects HS-46.
  emit(state, { type: "statusApplied", unit: "d", source: null, kind: "stun" });

  assert.ok(hasSerumMark(dennis), "HS-46 Ascendant Serum was auto-used on Dennis (its mark is present)");
  assert.equal(dennis.hp, hpBefore - 5, "HS-46 dealt its 5 Affliction self-damage");
  assert.ok(
    dennis.statuses.some((s) => s.kind === "non_damage_ignore"),
    "HS-46 applied its non_damage_ignore status",
  );
});

test("Auto-Injectors does NOT fire on a non-stun status landing on Dennis", () => {
  const dennis = loadHero(heroById("dennis"), "A", "d");
  applyAugment(dennis, augmentById("dennis1")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B" })]);

  const hpBefore = dennis.hp;

  // An unrelated (non-stun) status applied to Dennis must not auto-inject.
  emit(state, { type: "statusApplied", unit: "d", source: null, kind: "mark", name: "Something Else" });

  assert.ok(!hasSerumMark(dennis), "no HS-46 mark: a non-stun status does not trigger Auto-Injectors");
  assert.equal(dennis.hp, hpBefore, "no HS-46 self-damage on a non-stun status");
  assert.ok(
    !dennis.statuses.some((s) => s.kind === "non_damage_ignore"),
    "no HS-46 non_damage_ignore status on a non-stun status",
  );
});
