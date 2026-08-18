import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { performAction } from "../src/scheduler.ts";
import { registerMinion } from "../src/minions.ts";
import { stackCount } from "../src/status.ts";
import type { Unit } from "../src/types.ts";
import type { TriggeredEffect } from "../src/events.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

// Trinity, per the simplified design: an untargetable + undamageable hero whose passive summons
// three Ranger minions. Each Ranger's on-death trigger decrements a RangersAlive stack on its
// summoner (Trinity) and, when it hits 0, `defeat`s her. No composite-unit subsystem needed.
const rangerDeathLink: Omit<TriggeredEffect, "owner"> = {
  on: "unitDied", source: "Prismari Rangers",
  when: { sameUnit: ["eventUnit", "self"] },
  effect: [
    { op: "modifyStatus", kind: "stack", name: "RangersAlive", magnitudeDelta: -1, from: "summoner" },
    { op: "if", cond: { cmp: "<=", left: { ref: "stackCount", name: "RangersAlive", of: "summoner" }, right: 0 }, then: [{ op: "defeat", to: "summoner" }] },
  ],
};
registerMinion({ name: "Prisma Ranger", maxHp: 65, element: "prism", triggers: [rangerDeathLink] });

function trinityMatch() {
  const trinity = makeUnit({
    id: "t", team: "A", name: "Prisma Trinity", currentElement: "prism",
    statuses: [
      status("untargetable", { duration: null }),
      status("damage_ignore", { duration: null }),
      status("stack", { name: "RangersAlive", magnitude: 3, duration: null }),
    ],
  });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, skills: [skill("zap", [{ op: "damage", amount: 100, to: "target" }], { tags: ["Harmful", "Instant"] })] });
  const state = makeState([trinity], [enemy]);
  runEffects(state, [{ op: "summon", template: "Prisma Ranger", count: 3 }], { caster: trinity });
  const rangers = state.teams.A.units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.kind === "minion");
  return { trinity, enemy, state, rangers };
}

test("Trinity is undamageable and untargetable", () => {
  const { trinity, state } = trinityMatch();
  const attacker = state.units.e!;
  runEffects(state, [{ op: "damage", amount: 50, to: "target" }], { caster: attacker, targets: [trinity] });
  assert.equal(trinity.hp, 100, "damage_ignore: undamageable");
  assert.equal(performAction(state, { unit: "e", skillId: "zap", targets: ["t"] }).reason, "no-legal-target", "untargetable");
});

test("Trinity dies only when all three Rangers are dead (linked death via defeat)", () => {
  const { trinity, state, rangers } = trinityMatch();
  assert.equal(rangers.length, 3);
  assert.equal(stackCount(trinity, "RangersAlive"), 3);

  const kill = (r: Unit) => runEffects(state, [{ op: "damage", amount: 100, to: "target" }], { caster: state.units.e!, targets: [r] });

  kill(rangers[0]!);
  assert.equal(rangers[0]!.alive, false);
  assert.equal(stackCount(trinity, "RangersAlive"), 2);
  assert.equal(trinity.alive, true, "still alive with 2 Rangers down");

  kill(rangers[1]!);
  assert.equal(stackCount(trinity, "RangersAlive"), 1);
  assert.equal(trinity.alive, true);

  kill(rangers[2]!);
  assert.equal(trinity.alive, false, "the third Ranger's death defeats Trinity");
  assert.equal(trinity.hp, 0);
});
