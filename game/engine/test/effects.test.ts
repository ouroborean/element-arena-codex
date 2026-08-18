import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { totalShield } from "../src/damage.ts";
import { findNode } from "../src/effects/patch.ts";
import type { Effect } from "../src/effects/ast.ts";
import { applyStatus } from "../src/status.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

// Each test transcribes a REAL skill's description into the DSL and asserts the
// interpreter produces the value the prose promises. The description is the oracle.

test("gommarglacier1: 'Deals 25 damage to all enemies'", () => {
  const caster = makeUnit({ id: "a1", team: "A" });
  const e1 = makeUnit({ id: "b1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "b2", team: "B", hp: 100 });
  const state = makeState([caster], [e1, e2]);

  const effects: Effect[] = [{ op: "damage", amount: 25, to: { faction: "enemies" } }];
  runEffects(state, effects, { caster });

  assert.equal(e1.hp, 75);
  assert.equal(e2.hp, 75);
});

test("gaiagrave1 Decompose: 'Target enemy loses 20 health' (not damage — ignores shield)", () => {
  const caster = makeUnit({ id: "a1", team: "A" });
  const target = makeUnit({ id: "b1", team: "B", hp: 100, shield: 50 });
  const state = makeState([caster], [target]);

  runEffects(state, [{ op: "healthLoss", amount: 20, to: "target" }], { caster, targets: [target] });

  assert.equal(target.hp, 80);
  assert.equal(totalShield(target), 50, "health loss bypasses shield");
});

test("gaia2 Worldfist: '10 damage, increased by 5 for each Channel Earth this battle'", () => {
  const caster = makeUnit({ id: "a1", team: "A" });
  applyStatus(caster, status("stack", { name: "Channel Earth", magnitude: 3, duration: null }));
  const target = makeUnit({ id: "b1", team: "B", hp: 100 });
  const state = makeState([caster], [target]);

  const effects: Effect[] = [
    {
      op: "damage",
      to: "target",
      amount: {
        op: "add",
        args: [10, { op: "mul", args: [{ ref: "stackCount", name: "Channel Earth", of: "caster" }, 5] }],
      },
    },
  ];
  runEffects(state, effects, { caster, targets: [target] });
  assert.equal(target.hp, 75, "10 + 3*5 = 25");
});

test("laria3: '5 damage; if target had 4+ stacks, deals True damage' (type mutation)", () => {
  const effects: Effect[] = [
    {
      op: "if",
      cond: { cmp: ">=", left: { ref: "stackCount", name: "Deepening Shadows", of: "target" }, right: 4 },
      then: [{ op: "damage", amount: 5, dtype: "true", to: "target" }],
      else: [{ op: "damage", amount: 5, dtype: "normal", to: "target" }],
    },
  ];

  // Target with DR 3: normal branch is reduced to 2, true branch ignores DR.
  const caster = makeUnit({ id: "a1", team: "A" });
  const lowStacks = makeUnit({ id: "b1", team: "B", hp: 100, statuses: [status("damage_reduction", { magnitude: 3 })] });
  const s1 = makeState([caster], [lowStacks]);
  runEffects(s1, effects, { caster, targets: [lowStacks] });
  assert.equal(lowStacks.hp, 98, "normal 5 - 3 DR = 2");

  const caster2 = makeUnit({ id: "a1", team: "A" });
  const hiStacks = makeUnit({ id: "b1", team: "B", hp: 100, statuses: [status("damage_reduction", { magnitude: 3 })] });
  applyStatus(hiStacks, status("stack", { name: "Deepening Shadows", magnitude: 4, duration: null }));
  const s2 = makeState([caster2], [hiStacks]);
  runEffects(s2, effects, { caster: caster2, targets: [hiStacks] });
  assert.equal(hiStacks.hp, 95, "true 5, DR ignored");
});

test("count scaling: 'X damage for each dead ally' (ayanavengeance1 shape)", () => {
  const caster = makeUnit({ id: "a1", team: "A" });
  const deadAlly1 = makeUnit({ id: "a2", team: "A", hp: 0, alive: false });
  const deadAlly2 = makeUnit({ id: "a3", team: "A", hp: 0, alive: false });
  const target = makeUnit({ id: "b1", team: "B", hp: 100 });
  const state = makeState([caster, deadAlly1, deadAlly2], [target]);

  const effects: Effect[] = [
    {
      op: "damage",
      to: "target",
      amount: {
        op: "mul",
        args: [15, { ref: "count", of: { faction: "allies", alive: false } }],
      },
    },
  ];
  runEffects(state, effects, { caster, targets: [target] });
  assert.equal(target.hp, 70, "15 * 2 dead allies = 30");
});

test("random targeting is deterministic under a fixed seed", () => {
  const build = () => {
    const caster = makeUnit({ id: "a1", team: "A" });
    const enemies = [1, 2, 3, 4].map((i) => makeUnit({ id: `b${i}`, team: "B", hp: 100 }));
    const state = makeState([caster], enemies, 42);
    const effects: Effect[] = [
      { op: "damage", amount: 30, to: { pick: "random", from: { faction: "enemies" } } },
    ];
    runEffects(state, effects, { caster });
    return enemies.find((e) => e.hp < 100)?.id;
  };
  assert.equal(build(), build(), "same seed hits the same random enemy");
});

test("addStack accumulates and drives scaling in one cast", () => {
  const caster = makeUnit({ id: "a1", team: "A" });
  const target = makeUnit({ id: "b1", team: "B", hp: 100 });
  const state = makeState([caster], [target]);
  const effects: Effect[] = [
    { op: "addStack", name: "Cinders", amount: 2, to: "caster" },
    { op: "damage", to: "target", amount: { op: "mul", args: [{ ref: "stackCount", name: "Cinders", of: "caster" }, 10] } },
  ];
  runEffects(state, effects, { caster, targets: [target] });
  assert.equal(target.hp, 80, "2 Cinders * 10 = 20");
});

test("summon respects the 6-minion cap", () => {
  const caster = makeUnit({ id: "a1", team: "A" });
  const state = makeState([caster], [makeUnit({ id: "b1", team: "B" })]);
  runEffects(state, [{ op: "summon", template: "Seedling", count: 8, hp: 25 }], { caster });
  const minions = state.teams.A.units.filter((id) => state.units[id]?.kind === "minion");
  assert.equal(minions.length, 6, "capped at 6");
});

test("nodes are individually addressable (the patch bet)", () => {
  // A skill whose damage node has a stable id an augment could target.
  const skill: Effect[] = [{ op: "damage", id: "dmg", amount: 10, to: "target" }];

  const node = findNode(skill, "dmg");
  assert.ok(node && node.op === "damage");
  // Simulate an augment patching the amount 10 -> 15.
  if (node.op === "damage") node.amount = 15;

  const caster = makeUnit({ id: "a1", team: "A" });
  const target = makeUnit({ id: "b1", team: "B", hp: 100 });
  const state = makeState([caster], [target]);
  runEffects(state, skill, { caster, targets: [target] });
  assert.equal(target.hp, 85, "patched damage applied");
});
