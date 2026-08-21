import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3 coverage — jarrik:dragon "Drakken" TRIGGER lock (#24).
// Frozen (jarrikdragon1): "After using this skill, Jarrik can no longer apply, trigger, or consume Cinders."
// apply + consume are covered by fidelity3_drakken_lock.test.ts; this file covers the TRIGGER case.
//
// SHIPPING: jarrik0's "Cinders" passive is a reactive damageDealt trigger (source "Cinders"), gated on
//   {sameUnit:[eventSource,self]} AND {has mark "Cinders" of eventTarget}
//   AND {not has mark "Cinders Proc Lock" of self} AND {not has mark "Drakken" of self}
//   -> deal 10 Affliction to eventTarget + grant self an Elemental Essence charge.
// The Drakken self-mark (persisted by Drakken's use) makes the last gate fail, so the rider is suppressed.

const cindersMark = { kind: "mark" as const, name: "Cinders", duration: null, appliedBy: "j", appliedTurn: 0 };
const drakken = (u: Unit): void => {
  u.statuses.push({ kind: "mark", name: "Drakken", duration: null, appliedBy: "j", appliedTurn: 0 });
};
const hasEssence = (u: Unit): boolean => u.statuses.some((s) => s.kind === "elemental_essence");

test("without Drakken, damaging a Cinders-marked enemy fires the +10 Affliction rider and grants Elemental Essence", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, kind: "hero", statuses: [cindersMark] });
  const state = makeState([jarrik], [enemy]);

  assert.ok(!hasEssence(jarrik), "precondition: Jarrik holds no Elemental Essence yet");

  // A normal hit by Jarrik on the marked enemy (event source = Jarrik, target carries Cinders).
  emit(state, { type: "damageDealt", source: "j", target: "e", amount: 20, dtype: "normal", sourceId: "jarrik1", isNew: true });

  assert.equal(enemy.hp, 90, "the enemy takes the 10 additional Affliction damage from the Cinders proc");
  assert.ok(hasEssence(jarrik), "Jarrik gains an Elemental Essence charge from the Cinders proc");
});

test("under Drakken, the same hit fires NO Cinders rider (trigger is locked)", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  drakken(jarrik);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, kind: "hero", statuses: [cindersMark] });
  const state = makeState([jarrik], [enemy]);

  emit(state, { type: "damageDealt", source: "j", target: "e", amount: 20, dtype: "normal", sourceId: "jarrik1", isNew: true });

  assert.equal(enemy.hp, 100, "no extra Affliction damage: the Drakken self-mark gates the Cinders trigger off");
  assert.ok(!hasEssence(jarrik), "no Elemental Essence granted while Drakken is held");
});
