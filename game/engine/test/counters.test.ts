import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import type { TriggeredEffect } from "../src/events.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

const harmful = (dmg: number, over = {}) =>
  skill("atk", [{ op: "damage", amount: dmg, to: "target" }], { tags: ["Harmful", "Instant"], ...over });

test("Counter negates the skill, puts it on cooldown, and runs its own effect", () => {
  const attacker = makeUnit({ id: "a", team: "A", hp: 100, skills: [harmful(30, { cooldown: 2 })] });
  const defender = makeUnit({ id: "d", team: "B", hp: 100 });
  // "Counter the next Harmful skill aimed at me, and punish the attacker for 10."
  defender.triggers = [{
    on: "skillDeclared", owner: "d", kind: "counter", once: true, source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    effect: [{ op: "damage", amount: 10, to: "eventSource" }],
  }];
  const state = makeState([attacker], [defender]);

  const r = performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(r.countered, true);
  assert.equal(defender.hp, 100, "skill negated — no damage landed");
  assert.equal(attacker.hp, 90, "counter punished the attacker for 10");
  assert.equal(attacker.skills![0]!.currentCd, 2, "countered skill still went on cooldown");

  // The counter was one-shot: a second attempt lands normally.
  attacker.skills![0]!.currentCd = 0;
  const r2 = performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(r2.countered, undefined);
  assert.equal(defender.hp, 70, "counter consumed — 30 landed");
});

test("Counter only intercepts skills matching its condition (Harmful)", () => {
  const attacker = makeUnit({
    id: "a", team: "A",
    skills: [harmful(30), skill("poke", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Instant"] })],
  });
  const defender = makeUnit({ id: "d", team: "B", hp: 100 });
  defender.triggers = [{
    on: "skillDeclared", owner: "d", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    effect: [],
  }];
  const state = makeState([attacker], [defender]);

  assert.equal(performAction(state, { unit: "a", skillId: "poke", targets: ["d"] }).countered, undefined);
  assert.equal(defender.hp, 90, "non-Harmful skill not countered");
  assert.equal(performAction(state, { unit: "a", skillId: "atk", targets: ["d"] }).countered, true);
  assert.equal(defender.hp, 90, "Harmful skill countered — no further damage");
});

test("Reflect redirects the skill back at its caster", () => {
  const attacker = makeUnit({ id: "a", team: "A", hp: 100, skills: [harmful(30)] });
  const defender = makeUnit({ id: "d", team: "B", hp: 100 });
  defender.triggers = [{
    on: "skillDeclared", owner: "d", kind: "reflect", once: true, source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    redirectTo: "eventSource",
    effect: [],
  }];
  const state = makeState([attacker], [defender]);

  const r = performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(r.countered, undefined, "reflect resolves the skill (not cancelled)");
  assert.equal(defender.hp, 100, "original target untouched");
  assert.equal(attacker.hp, 70, "redirected onto the caster");
});

test("Reflect-vs-Reflect terminates at the bounce cap", () => {
  const reflectTrig: Omit<TriggeredEffect, "owner"> = {
    on: "skillDeclared", kind: "reflect", source: "test",
    when: { declaredTargetsSelf: true }, redirectTo: "eventSource", effect: [],
  };
  const attacker = makeUnit({ id: "a", team: "A", hp: 100, skills: [harmful(30)], triggers: [{ ...reflectTrig, owner: "a" }] });
  const defender = makeUnit({ id: "d", team: "B", hp: 100, triggers: [{ ...reflectTrig, owner: "d" }] });
  const state = makeState([attacker], [defender]);

  const r = performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(r.ok, true, "action still completes (no infinite loop)");
  assert.ok(state.log.some((l) => l.includes("reflect bounce cap")), "bounce cap terminated the reflect chain");
});
