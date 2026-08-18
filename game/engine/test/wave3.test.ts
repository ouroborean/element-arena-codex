import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { performAction } from "../src/scheduler.ts";
import { applyDamage } from "../src/damage.ts";
import { registerMinion } from "../src/minions.ts";
import type { Unit } from "../src/types.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

registerMinion({ name: "Seedling", maxHp: 25, element: "earth" });
registerMinion({ name: "Worldsprout", maxHp: 40, element: "earth" });
registerMinion({ name: "Tester", maxHp: 25, element: "earth", skills: [skill("poke", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful"] })] });
const minionsOf = (state: ReturnType<typeof makeState>) => state.teams.A.units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.kind === "minion");

test("revive brings a dead ally back at N HP", () => {
  const healer = makeUnit({ id: "h", team: "A" });
  const dead = makeUnit({ id: "d", team: "A", hp: 0, maxHp: 100, alive: false });
  const state = makeState([healer, dead], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "revive", to: { faction: "allies", alive: false }, hp: 40 }], { caster: healer });
  assert.equal(dead.alive, true);
  assert.equal(dead.hp, 40);
});

test("revive_ward intercepts a lethal hit once (fate6 'return to 40 on first death')", () => {
  const attacker = makeUnit({ id: "a", team: "B" });
  const fate = makeUnit({ id: "f", team: "A", hp: 30, maxHp: 100, statuses: [status("revive_ward", { magnitude: 40 })] });
  makeState([fate], [attacker]);
  const r1 = applyDamage(fate, { amount: 100, type: "true" });
  assert.equal(fate.alive, true);
  assert.equal(fate.hp, 40, "revived to the ward's HP");
  assert.equal(r1.lethal, false);
  assert.ok(!fate.statuses.some((s) => s.kind === "revive_ward"), "ward consumed");
  const r2 = applyDamage(fate, { amount: 100, type: "true" });
  assert.equal(fate.alive, false, "second lethal hit kills (no ward left)");
  assert.equal(r2.lethal, true);
});

test("transform retemplates a unit in place, preserving HP, without firing death", () => {
  const gaia = makeUnit({ id: "g", team: "A", currentElement: "earth" });
  const state = makeState([gaia], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "summon", template: "Seedling" }], { caster: gaia });
  const seed = minionsOf(state)[0]!;
  seed.hp = 20;
  const deaths: string[] = [];
  seed.triggers = [{ on: "unitDied", owner: seed.id, source: "t", effect: [] }];

  runEffects(state, [{ op: "transform", to: { faction: "allies", kind: "minion" }, template: "Worldsprout", keepHp: true }], { caster: gaia });
  assert.equal(seed.name, "Worldsprout");
  assert.equal(seed.maxHp, 40);
  assert.equal(seed.hp, 20, "HP preserved (keepHp)");
  assert.equal(seed.alive, true);
  assert.deepEqual(deaths, [], "no death fired");
});

test("useSkill invokes a named skill inline (dennis6-style)", () => {
  const dennis = makeUnit({ id: "de", team: "A", skills: [
    skill("serum", [{ op: "heal", amount: 10, to: "target" }], { tags: ["Helpful"] }),
    skill("inject", [{ op: "useSkill", skillId: "serum", on: "target" }], { tags: ["Strategic"] }),
  ] });
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  const state = makeState([dennis, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, dennis.skills![1]!.effects, { caster: dennis, targets: [ally] });
  assert.equal(ally.hp, 60, "serum ran via useSkill");
});

test("isKind condition distinguishes minion vs hero (gaia3: only minions trigger)", () => {
  const gaia = makeUnit({ id: "g", team: "A", hp: 50, maxHp: 100, currentElement: "earth", skills: [skill("jab", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful"] })] });
  gaia.triggers = [{ on: "skillUsed", owner: "g", source: "Channel Vitality", when: { isKind: "eventSource", kind: "minion" }, effect: [{ op: "heal", amount: 10, to: "self" }] }];
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([gaia], [e]);
  runEffects(state, [{ op: "summon", template: "Tester" }], { caster: gaia });
  const m = minionsOf(state).find((u) => u.name === "Tester")!;

  performAction(state, { unit: m.id, skillId: "poke", targets: ["e"] }); // minion acts -> heal
  assert.equal(gaia.hp, 60);
  performAction(state, { unit: "g", skillId: "jab", targets: ["e"] }); // hero acts -> no heal
  assert.equal(gaia.hp, 60);
});

test("sum aggregates a metric across a selector (blackknight2: team missing HP)", () => {
  const bk = makeUnit({ id: "bk", team: "A", hp: 70, maxHp: 100 }); // missing 30
  const ally = makeUnit({ id: "al", team: "A", hp: 80, maxHp: 100 }); // missing 20
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([bk, ally], [e]);
  runEffects(state, [{ op: "damage", to: "target", amount: { ref: "sum", metric: "missingHp", of: { faction: "allies" } } }], { caster: bk, targets: [e] });
  assert.equal(e.hp, 50, "100 - (30+20)");
});
