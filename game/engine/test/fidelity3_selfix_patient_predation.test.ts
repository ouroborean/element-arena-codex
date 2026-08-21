import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Status, Unit } from "../src/types.ts";

// Fidelity Campaign 3 — selector fix — Zev'kir (mirror fusion) "Patient Predation".
//
// Frozen: "Call Tides will now continue until a new harmful skill is used on Zev'kir. The harmful skill is
// reflected to its user and Call Tides ends."  Authored as a kind:"reflect" skillDeclared trigger, gated on
//   and[ has(channeling,self), eventHasTag:"Harmful", declaredTargetsSelf ]  ->  removeStatus channeling(self),
//   redirectTo eventSource (the caster).
//
// THE FIX: the gate used to be `sameUnit[eventTarget, self]`. On a `skillDeclared` event there is NO singular
// `target` field (it carries `targets`, the plural declared-target list), so `eventTarget` resolved to nothing
// and the reflect could NEVER fire. The gate is now `declaredTargetsSelf` — "is Zev'kir among the declared
// targets?" — which reads `event.targets`. The two controls below prove BOTH halves of that gate really fire:
// only when Zev'kir is channeling (has(channeling)) AND only when the harmful skill is aimed at Zev'kir himself
// (declaredTargetsSelf), never at an ally beside him.

// A concealment-free enemy nuke: 30 Harmful damage to its single declared target.
const bite = () => skill("bite", [{ op: "damage", amount: 30, to: "target" }], { tags: ["Harmful", "Instant"] });

const callTides = (): Status => ({
  kind: "channeling", name: "zevkir1", duration: null, appliedBy: "zev", appliedTurn: 0,
});
const isChanneling = (u: Unit) => u.statuses.some((s) => s.kind === "channeling");

/** Zev'kir (mirror fusion, holding Patient Predation) on team A; one enemy nuker on team B. */
function setup(zevChanneling: boolean, extraAllies: Unit[] = []) {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  applyFusion(zev, fusionForm("zevkir", "mirror")!); // installs the Patient Predation reflect trigger
  if (zevChanneling) zev.statuses.push(callTides());
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, skills: [bite()] });
  const state = makeState([zev, ...extraAllies], [enemy]);
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { zev, enemy, state };
}

test("Patient Predation: while Channeling, a harmful skill aimed at Zev'kir is reflected onto its caster and Channeling ends", () => {
  const { zev, enemy, state } = setup(true);

  assert.equal(isChanneling(zev), true, "precondition: Zev'kir is Channeling Call Tides");
  const r = performAction(state, { unit: "e", skillId: "bite", targets: ["zev"] });

  assert.equal(r.ok, true, "the enemy's action resolved");
  assert.equal(r.countered, undefined, "a reflect resolves the skill (it is not cancelled like a counter)");
  assert.equal(zev.hp, 100, "the harmful skill was reflected AWAY from Zev'kir — he takes no damage");
  assert.equal(enemy.hp, 70, "the 30 damage was redirected back onto its caster (the enemy)");
  assert.equal(isChanneling(zev), false, "Call Tides ends when the reflect fires (removeStatus channeling from self)");
});

test("Patient Predation CONTROL — NOT Channeling: the harmful skill is NOT reflected and lands on Zev'kir", () => {
  // has(channeling,self) fails -> the reflect never intercepts. This is the exact state the broken `eventTarget`
  // gate could never distinguish from the channeling case; the real observable is that damage lands on Zev'kir.
  const { zev, enemy, state } = setup(false);

  const r = performAction(state, { unit: "e", skillId: "bite", targets: ["zev"] });

  assert.equal(r.ok, true, "the enemy's action resolved");
  assert.equal(zev.hp, 70, "not Channeling -> no reflect -> the 30 damage lands on Zev'kir");
  assert.equal(enemy.hp, 100, "the caster is untouched — nothing was redirected back");
});

test("Patient Predation CONTROL — declaredTargetsSelf: a harmful skill aimed at an ALLY (not Zev'kir) is NOT reflected", () => {
  // Zev'kir IS Channeling, but the harmful skill targets his ally, not him. declaredTargetsSelf is false
  // (Zev'kir is not among event.targets), so the reflect must not fire — the whole point of the fixed gate.
  const ally = makeUnit({ id: "ally", team: "A", hp: 100 });
  const { zev, enemy, state } = setup(true, [ally]);

  const r = performAction(state, { unit: "e", skillId: "bite", targets: ["ally"] });

  assert.equal(r.ok, true, "the enemy's action resolved");
  assert.equal(ally.hp, 70, "the ally, the declared target, takes the 30 damage — nothing was reflected");
  assert.equal(enemy.hp, 100, "the caster is untouched (no redirect back onto it)");
  assert.equal(zev.hp, 100, "Zev'kir, not a target, is untouched");
  assert.equal(isChanneling(zev), true, "a skill aimed elsewhere does not consume Zev'kir's Channeling");
});
