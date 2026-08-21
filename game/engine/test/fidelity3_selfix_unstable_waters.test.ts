import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — River Daughter, "Unstable Waters" (riverdaughteralchemy0), the alchemy-fusion passive.
// Frozen: "Undertow now increases the damage taken by the target by 5 for 2 turns."
//
// The passive is a `skillUsed` trigger. `skillUsed` carries { caster, skillId, targets } — it has NO singular
// `target` field, so the pre-fix `eventTarget` selector resolved to nothing and the +5 incoming_damage_mod
// landed on no one. The fix routes the status `to: eventTargets` (Undertow's declared single target) and gates
// the trigger to Undertow specifically via the new `{ eventSkillId: "riverdaughter2" }` condition:
//   when and[ sameUnit(eventSource, self), eventSkillId "riverdaughter2" ] -> applyStatus incoming_damage_mod +5/2.
//
// Positive: driving Undertow (riverdaughter2) on an enemy leaves that enemy holding the "Unstable Waters"
//   incoming_damage_mod (magnitude 5, duration 2) — the observable the frozen text promises.
// Control: driving a DIFFERENT River Daughter skill (River Clone, riverdaughter3) on an enemy must NOT apply
//   "Unstable Waters" — the eventSkillId gate scopes the passive to Undertow alone.

const unstableWaters = (u: { statuses: { kind: string; name?: string; magnitude?: number; duration?: number | null }[] }) =>
  u.statuses.find((s) => s.kind === "incoming_damage_mod" && s.name === "Unstable Waters");

function setup() {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  const form = fusionForm("riverdaughter", "alchemy");
  assert.ok(form, "fusion form riverdaughter:alchemy must exist");
  applyFusion(rd, form as FusionForm);
  const enemy = makeUnit({ id: "e1", team: "B", name: "Enemy" });
  const state = makeState([rd], [enemy]);
  // Undertow / River Clone each cost 1 specific. Specific cost is denominated in the caster's CURRENT element,
  // which the alchemy fusion has changed water -> alchemy, so fund the alchemy channel (plus generic).
  state.teams.A.energy = { generic: 40, water: 40, alchemy: 40 };
  return { state, rd, enemy };
}

test("Unstable Waters: casting Undertow makes its target take +5 damage for 2 turns", () => {
  const { state, rd, enemy } = setup();
  assert.equal(!!unstableWaters(enemy), false, "no Unstable Waters before Undertow is cast");

  const res = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] });
  assert.equal(res.ok, true, "Undertow resolves");

  // Undertow itself ran (20 damage), proving the skill actually fired.
  assert.equal(enemy.hp, 80, "Undertow dealt its 20 damage to the target");

  // The passive's observable: the struck enemy now carries the +5/2 incoming_damage_mod.
  const st = unstableWaters(enemy);
  assert.ok(st, "Undertow's target holds an Unstable Waters incoming_damage_mod");
  assert.equal(st?.magnitude, 5, "Unstable Waters adds +5 incoming damage");
  assert.equal(st?.duration, 2, "Unstable Waters lasts 2 turns");

  // It lands on the declared target (eventTargets), not on River Daughter herself.
  assert.equal(!!unstableWaters(rd), false, "the caster does not take the +5 modifier");
});

test("Unstable Waters CONTROL: a different River Daughter skill (River Clone) does NOT apply it (eventSkillId gate)", () => {
  const { state, rd, enemy } = setup();

  // River Clone (riverdaughter3) is also single-target on an enemy and also costs 1 Water — the ONLY thing that
  // differs from Undertow is the skillId. The passive's `eventSkillId: "riverdaughter2"` gate must reject it.
  const res = performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });
  assert.equal(res.ok, true, "River Clone resolves");

  assert.equal(!!unstableWaters(enemy), false, "River Clone must not apply Unstable Waters (wrong skillId)");
  assert.equal(!!unstableWaters(rd), false, "and it certainly does not land on the caster");
});
