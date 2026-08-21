import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Status, Unit } from "../src/types.ts";

// Fidelity Campaign 3 — Tidecaller Zev'kir, "Repulse" (zevkir4), the kind:"counter" skillDeclared trigger
// whose event-selector was fixed from the never-resolving `eventTarget` to `eventTargets`.
//
// Frozen note: "Lasting reaction placed by Repulse (invisible): negates the first Harmful skill received by
// the Repulse-marked ally, consumes the mark, and makes Zev'kir begin channeling Call Tides."
//
// The trigger (owned by Zev'kir) gates on:
//   and[ eventHasTag:"Harmful", { has:"mark", name:"Repulse", of:"eventTargets" } ]
// and on a match runs:
//   removeStatus mark Repulse from eventTargets  +  useSkill zevkir1 (Call Tides) by self.
//
// A `skillDeclared` event carries `targets` (the declared target LIST), never a singular `target`, so the
// old `eventTarget` selector resolved to NOTHING: the `has(mark Repulse, of:eventTarget)` gate could never
// hold and the counter never fired — the marked ally was hit anyway. The fix reads `eventTargets`, i.e. the
// actual unit(s) the enemy declared its Harmful skill against, so the mark on the TARGETED ally is seen.

const REPULSE_MARK: Status = { kind: "mark", name: "Repulse", duration: null, appliedBy: "zev", appliedTurn: 0 };
const hasRepulse = (u: Unit) => u.statuses.some((s) => s.kind === "mark" && s.name === "Repulse");
const callTidesStacks = (u: Unit) => u.statuses.filter((s) => s.kind === "stack" && s.name === "Call Tides").length;

// A plain single-target Harmful attack the enemy declares against a chosen ally.
const harmful = (dmg: number) =>
  skill("enemyAtk", [{ op: "damage", amount: dmg, to: "target" }], { tags: ["Harmful", "Instant"], cooldown: 0 });

test("Repulse counters the Harmful skill aimed at the Repulse-marked ally and consumes the mark", () => {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  // Sanity: the loaded hero actually carries the fixed counter trigger.
  assert.ok(
    (zev.triggers ?? []).some((t) => t.on === "skillDeclared" && t.kind === "counter"),
    "Zev'kir carries the Repulse counter trigger",
  );

  const ally = makeUnit({ id: "ally", team: "A", hp: 100, statuses: [{ ...REPULSE_MARK }] });
  const enemy = makeUnit({ id: "enemy", team: "B", hp: 100, skills: [harmful(30)] });
  const state = makeState([zev, ally], [enemy]);
  state.teams.B.energy = { generic: 40, fire: 40 };

  assert.equal(hasRepulse(ally), true, "the ally bears the Repulse mark before the attack");
  assert.equal(callTidesStacks(zev), 0, "Zev'kir holds no Call Tides stacks yet");

  // The enemy declares its Harmful skill TARGETING the Repulse-marked ally.
  const r = performAction(state, { unit: "enemy", skillId: "enemyAtk", targets: ["ally"] });

  assert.equal(r.ok, true, "the action was accepted");
  assert.equal(r.countered, true, "Repulse counters the Harmful skill declared at the marked ally");
  assert.equal(state.units["ally"]!.hp, 100, "the countered skill's harmful effect never lands on the ally");
  assert.equal(hasRepulse(state.units["ally"]!), false, "the Repulse mark is consumed by the counter");
  assert.equal(
    callTidesStacks(state.units["zev"]!), 1,
    "the counter fired its full effect: Zev'kir began channeling Call Tides (useSkill zevkir1)",
  );
});

test("Control — the Harmful skill lands on an UNMARKED ally (eventTargets reads the real target, not Zev'kir)", () => {
  // The pre-fix `eventTarget` selector resolved to nobody, so the gate was always false and the counter never
  // fired for ANY target. This control instead pins the correct positive/negative split: the counter must key
  // on WHICH ally was targeted. Here the enemy hits a different, unmarked ally — the counter must NOT fire.
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  const markedAlly = makeUnit({ id: "marked", team: "A", hp: 100, statuses: [{ ...REPULSE_MARK }] });
  const otherAlly = makeUnit({ id: "other", team: "A", hp: 100 }); // no Repulse
  const enemy = makeUnit({ id: "enemy", team: "B", hp: 100, skills: [harmful(30)] });
  const state = makeState([zev, markedAlly, otherAlly], [enemy]);
  state.teams.B.energy = { generic: 40, fire: 40 };

  const r = performAction(state, { unit: "enemy", skillId: "enemyAtk", targets: ["other"] });

  assert.equal(r.countered, undefined, "no counter: the targeted ally does not bear Repulse");
  assert.equal(state.units["other"]!.hp, 70, "the Harmful skill lands in full on the unmarked ally");
  assert.equal(hasRepulse(state.units["marked"]!), true, "the OTHER ally's Repulse mark is untouched — nothing consumed it");
  assert.equal(callTidesStacks(state.units["zev"]!), 0, "Zev'kir did not begin channeling — the counter never ran");
});

test("Control — a NON-Harmful skill aimed at the Repulse-marked ally is not countered", () => {
  // The eventHasTag:"Harmful" half of the gate: Repulse negates the first *Harmful* skill only.
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  const ally = makeUnit({ id: "ally", team: "A", hp: 100, statuses: [{ ...REPULSE_MARK }] });
  const helpful = skill("enemyBuff", [{ op: "heal", amount: 10, to: "target" }], { tags: ["Helpful", "Instant"], cooldown: 0 });
  const enemy = makeUnit({ id: "enemy", team: "B", hp: 100, skills: [helpful] });
  const state = makeState([zev, ally], [enemy]);
  state.teams.B.energy = { generic: 40, fire: 40 };

  ally.hp = 80; // give the heal something to restore, so we can see it land
  const r = performAction(state, { unit: "enemy", skillId: "enemyBuff", targets: ["ally"] });

  assert.equal(r.countered, undefined, "a non-Harmful skill is not countered by Repulse");
  assert.equal(state.units["ally"]!.hp, 90, "the Helpful skill resolved normally (heal landed)");
  assert.equal(hasRepulse(state.units["ally"]!), true, "the Repulse mark is preserved for the first Harmful skill");
});
