import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHeal } from "../src/damage.ts";
import { makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 10 — ayana:anointment "Blessed Leylines": "+5 healing received from all sources
// (does not stack)". Modeled with a new incoming_heal_mod StatusKind that applyHeal adds to every heal,
// taking the MAX across instances (non-stacking).

const healMod = (mag: number): Unit["statuses"][number] => ({ kind: "incoming_heal_mod", name: "Blessed Leylines", magnitude: mag, duration: null, appliedBy: "u", appliedTurn: 0 });

test("incoming_heal_mod adds to every heal the unit receives", () => {
  const u = makeUnit({ id: "u", team: "A", hp: 50, maxHp: 100, statuses: [healMod(5)] });
  applyHeal(u, 10);
  assert.equal(u.hp, 65, "a 10 heal + 5 Leylines = 15");
});

test("incoming_heal_mod does NOT stack — two copies apply the MAX, not the sum", () => {
  const u = makeUnit({ id: "u", team: "A", hp: 50, maxHp: 100, statuses: [healMod(5), healMod(5)] });
  applyHeal(u, 10);
  assert.equal(u.hp, 65, "two +5 mods give +5 (MAX), not +10");
});

test("a zero heal receives no bonus", () => {
  const u = makeUnit({ id: "u", team: "A", hp: 50, maxHp: 100, statuses: [healMod(5)] });
  applyHeal(u, 0);
  assert.equal(u.hp, 50, "no heal requested -> no Leylines bonus");
});
