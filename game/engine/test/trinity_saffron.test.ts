import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import "../content/hero.ts"; // side-effect: registers handlers
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

// Engine-fidelity — Trinity's Prisma Saffron "Prisma Launch" (trinitysaffron2): "Prisma Saffron's skills will
// Bypass against target enemy..." The 'Prisma Launch: Bypass' mark used to be inert (no reader). prismaLaunchBypass
// now applies a conditional_bypass keyed to that mark, so Saffron's damage ignores DR + Shield vs the marked enemy.

test("Prisma Launch: Saffron's damage Bypasses (ignores DR + Shield) the marked enemy", () => {
  const saffron = makeUnit({ id: "s", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, shield: 30, statuses: [status("damage_reduction", { magnitude: 20 })] });
  const state = makeState([saffron], [enemy]);

  // Prisma Launch on the enemy: mark it + grant Saffron the conditional_bypass.
  runEffects(state, [
    { op: "applyStatus", to: "target", status: { kind: "mark", name: "Prisma Launch: Bypass", duration: 1 } },
    { op: "custom", fn: "prismaLaunchBypass" },
  ], { caster: saffron, self: saffron, targets: [enemy], skillId: "trinitysaffron2" });

  assert.ok(saffron.statuses.some((s) => s.kind === "conditional_bypass"), "Saffron gains conditional_bypass keyed to the mark");
  assert.ok(enemy.statuses.some((s) => s.kind === "mark" && s.name === "Prisma Launch: Bypass"), "the enemy is marked");

  // Saffron deals 25 to the marked enemy → bypasses DR(20) + Shield(30) → full 25 straight to HP.
  runEffects(state, [{ op: "damage", amount: 25, dtype: "normal", to: "target" }], { caster: saffron, self: saffron, targets: [enemy], skillId: "trinitysaffron1" });
  assert.equal(enemy.hp, 75, "25 damage bypassed DR + Shield straight to HP");
  assert.equal(totalShield(enemy), 30, "shield untouched (bypassed)");

  // Control: an UNMARKED enemy is not bypassed — DR + Shield apply normally.
  const enemy2 = makeUnit({ id: "e2", team: "B", hp: 100, shield: 30, statuses: [status("damage_reduction", { magnitude: 20 })] });
  state.units["e2"] = enemy2; state.teams.B.units.push("e2");
  runEffects(state, [{ op: "damage", amount: 25, dtype: "normal", to: "target" }], { caster: saffron, self: saffron, targets: [enemy2], skillId: "trinitysaffron1" });
  assert.equal(totalShield(enemy2), 25, "unmarked enemy: 5 (25-20 DR) absorbed by shield, none to HP");
  assert.equal(enemy2.hp, 100, "unmarked enemy takes no HP damage");
});
