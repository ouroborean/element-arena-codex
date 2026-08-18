import { test } from "node:test";
import assert from "node:assert/strict";
import { grantIncome, performAction, removeDeadMinions, startRound } from "../src/scheduler.ts";
import { registerMinion } from "../src/minions.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { stackCount } from "../src/status.ts";
import type { Unit } from "../src/types.ts";
import { seedling } from "../content/minions/seedling.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

registerMinion(seedling);

/** A hero whose round-start passive summons `count` Seedlings (Gaia's Yggdrasil's Bounty). */
function gardener(id: string, count: number): Unit {
  return makeUnit({
    id, team: "A", currentElement: "earth",
    triggers: [{ on: "roundStart", owner: id, source: "Yggdrasil's Bounty", effect: [{ op: "summon", template: "Seedling", count }] }],
  });
}

const minionsOf = (state: ReturnType<typeof makeState>, team: "A" | "B") =>
  state.teams[team].units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.kind === "minion");

test("a round-start passive summons minions from their template", () => {
  const g = gardener("g", 2);
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  startRound(state, "A");

  const m = minionsOf(state, "A");
  assert.equal(m.length, 2);
  assert.equal(m[0]!.name, "Seedling");
  assert.equal(m[0]!.maxHp, 25);
  assert.equal(m[0]!.summoner, "g");
  assert.ok(m[0]!.skills?.some((s) => s.name === "Channel Earth"));
});

test("a minion's skill affects its summoner (Channel Earth → Gaia)", () => {
  const g = gardener("g", 1);
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  startRound(state, "A");
  const seed = minionsOf(state, "A")[0]!;
  state.teams.A.energy = { generic: 1 };

  const r = performAction(state, { unit: seed.id, skillId: "seedling1" });
  assert.equal(r.ok, true);
  assert.ok(g.statuses.some((s) => s.kind === "elemental_essence"), "summoner gained Essence");
  assert.equal(stackCount(g, "Channel Earth"), 1, "summoner gained a Channel Earth stack");
});

test("summoning respects the 6-minion cap", () => {
  const g = gardener("g", 8);
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  startRound(state, "A");
  assert.equal(minionsOf(state, "A").length, 6);
});

test("a dead minion is swept off the field and frees a cap slot", () => {
  const g = gardener("g", 2);
  const enemy = makeUnit({ id: "e", team: "B", skills: [skill("zap", [{ op: "damage", amount: 25, to: "target" }], { tags: ["Harmful", "Instant"] })] });
  const state = makeState([g], [enemy]);
  startRound(state, "A");
  const seed = minionsOf(state, "A")[0]!;

  performAction(state, { unit: "e", skillId: "zap", targets: [seed.id] }); // kills it; cleanup runs
  assert.equal(state.units[seed.id], undefined, "unit deleted");
  assert.ok(!state.teams.A.units.includes(seed.id), "removed from the field");
  assert.equal(minionsOf(state, "A").length, 1);
});

test("minions do not generate energy (only living heroes do)", () => {
  const g = gardener("g", 3);
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  startRound(state, "A");
  state.teams.A.energy = {};
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.generic, 1, "1 hero → 1 generic; the 3 minions add nothing");
});

test("a fresh round clears last round's minions and re-summons them", () => {
  const g = gardener("g", 2);
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  startRound(state, "A");
  const firstIds = minionsOf(state, "A").map((m) => m.id);
  // Rough them up, then start a new round.
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: makeUnit({ id: "x", team: "B" }), targets: [state.units[firstIds[0]!]!] });

  startRound(state, "A");
  const m = minionsOf(state, "A");
  assert.equal(m.length, 2, "re-summoned");
  assert.ok(m.every((x) => x.hp === 25), "fresh full-HP minions");
  assert.ok(!m.some((x) => firstIds.includes(x.id)), "old minions gone");
});
