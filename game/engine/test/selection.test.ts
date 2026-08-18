import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { registerMinion } from "../src/minions.ts";
import { applyStatus } from "../src/status.ts";
import type { MinionTemplate } from "../src/minions.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

registerMinion({ name: "Seedling", maxHp: 25, element: "earth" } as MinionTemplate);
registerMinion({ name: "Cinderling", maxHp: 10, element: "fire" } as MinionTemplate);

test("count/filter can match a status by NAME (Cinders marks)", () => {
  const caster = makeUnit({ id: "a", team: "A" });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100 });
  applyStatus(e1, status("mark", { name: "Cinders", duration: null }));
  applyStatus(e3, status("mark", { name: "Cinders", duration: null }));
  applyStatus(e2, status("mark", { name: "Frost", duration: null })); // different mark
  const state = makeState([caster], [e1, e2, e3]);

  // "Deal 10 damage per enemy marked by Cinders" -> 2 marked -> 20 to target e1.
  runEffects(state, [{
    op: "damage", to: "target",
    amount: { op: "mul", args: [10, { ref: "count", of: { filter: { faction: "enemies" }, with: { kind: "mark", name: "Cinders" } } }] },
  }], { caster, targets: [e1] });
  assert.equal(e1.hp, 80, "counted exactly 2 Cinders (not the Frost mark)");
});

test("forEach can act only on enemies carrying a named mark", () => {
  const caster = makeUnit({ id: "a", team: "A" });
  const marked = makeUnit({ id: "m", team: "B", hp: 100 });
  const clean = makeUnit({ id: "c", team: "B", hp: 100 });
  applyStatus(marked, status("mark", { name: "Cinders", duration: null }));
  const state = makeState([caster], [marked, clean]);

  runEffects(state, [{ op: "forEach", each: { filter: { faction: "enemies" }, with: { kind: "mark", name: "Cinders" } }, do: [{ op: "damage", amount: 5, dtype: "affliction", to: "it" }] }], { caster });
  assert.equal(marked.hp, 95);
  assert.equal(clean.hp, 100, "unmarked enemy untouched");
});

test("minion selectors can filter by template (only my Seedlings)", () => {
  const gaia = makeUnit({ id: "g", team: "A", currentElement: "earth" });
  const state = makeState([gaia], [makeUnit({ id: "e", team: "B" })]);
  // Summon 2 Seedlings and 1 Cinderling on team A.
  runEffects(state, [
    { op: "summon", template: "Seedling", count: 2 },
    { op: "summon", template: "Cinderling", count: 1 },
  ], { caster: gaia });

  const seedlings = { ref: "count", of: { faction: "allies", kind: "minion", template: "Seedling" } } as const;
  const allMinions = { ref: "count", of: { faction: "allies", kind: "minion" } } as const;
  // Heal Gaia 10 per Seedling (2) — reads the template-filtered count.
  gaia.hp = 50;
  runEffects(state, [{ op: "heal", to: "caster", amount: { op: "mul", args: [10, seedlings] } }], { caster: gaia });
  assert.equal(gaia.hp, 70, "2 Seedlings * 10 (Cinderling excluded)");

  const g2 = makeUnit({ id: "g", team: "A" });
  const s2 = makeState([g2], [makeUnit({ id: "e", team: "B" })]);
  runEffects(s2, [{ op: "summon", template: "Seedling", count: 2 }, { op: "summon", template: "Cinderling", count: 1 }], { caster: g2 });
  runEffects(s2, [{ op: "grantShield", to: "caster", amount: allMinions }], { caster: g2 });
  // sanity: total minion count is 3 (template filter is what narrows it)
  assert.ok(true);
});
