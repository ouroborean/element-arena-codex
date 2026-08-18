import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAugment, applyPatch, registerAugmentCustom, type Augment } from "../content/augment.ts";
import { loadHero, type HeroDef } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { effectiveCost } from "../src/scheduler.ts";
import { runEffects, emit } from "../src/effects/interpret.ts";
import { findNode } from "../src/effects/patch.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// A tiny hero whose damage node is addressable (id "dmg") — the target of node surgery.
function dummyDef(): HeroDef {
  return {
    id: "dummy", name: "Dummy", element: "fire", maxHp: 100,
    passive: { name: "p", description: "" },
    skills: [skill("hit", [{ op: "damage", amount: 10, to: "target", id: "dmg" }], { tags: ["Harmful"], cost: { generic: 1, specific: 0 } })],
    triggers: [],
  };
}

test("patchNode rewrites one addressable node in a skill's effect tree", () => {
  const u = loadHero(dummyDef(), "A", "u");
  applyPatch(u, { op: "patchNode", skillId: "hit", nodeId: "dmg", replace: { op: "damage", amount: 25, to: "target", id: "dmg" } });
  const foe = makeUnit({ id: "f", team: "B", hp: 100 });
  const state = makeState([u], [foe]);
  runEffects(state, u.skills![0]!.effects, { caster: u, self: u, targets: [foe] });
  assert.equal(foe.hp, 75, "the node's amount was rewritten 10 → 25");
});

test("patching one hero never corrupts the shared HeroDef or a teammate built from it", () => {
  const def = dummyDef();
  const u1 = loadHero(def, "A", "u1");
  const u2 = loadHero(def, "A", "u2");
  applyPatch(u1, { op: "patchNode", skillId: "hit", nodeId: "dmg", replace: { op: "damage", amount: 25, to: "target", id: "dmg" } });

  const dmgOf = (unit: Unit) => (findNode(unit.skills![0]!.effects, "dmg") as { amount: number }).amount;
  assert.equal(dmgOf(u1), 25, "u1 patched");
  assert.equal(dmgOf(u2), 10, "u2 untouched (no shared-tree corruption)");
  assert.equal((findNode(def.skills[0]!.effects, "dmg") as { amount: number }).amount, 10, "the authored HeroDef is pristine");
});

test("patchNode reaches a node nested inside applyStatus.status.onExpire", () => {
  const def: HeroDef = {
    id: "d2", name: "D2", element: "fire", maxHp: 100, passive: { name: "p", description: "" }, triggers: [],
    skills: [skill("burn", [{ op: "applyStatus", to: "target", status: { kind: "dot", name: "Burn", dtype: "affliction", magnitude: 5, duration: 2, onExpire: [{ op: "damage", amount: 20, to: "target", id: "burst" }] } }], { tags: ["Harmful"] })],
  };
  const u = loadHero(def, "A", "u");
  assert.ok(findNode(u.skills![0]!.effects, "burst"), "the onExpire-nested node is addressable");
  applyPatch(u, { op: "patchNode", skillId: "burn", nodeId: "burst", replace: { op: "damage", amount: 40, to: "target", id: "burst" } });
  const burst = findNode(u.skills![0]!.effects, "burst") as { amount: number };
  assert.equal(burst.amount, 40, "the onExpire burst was rewritten 20 → 40");
});

test("appendEffect adds behaviour to a skill (ando3-style 'also marks a second target')", () => {
  const u = loadHero(dummyDef(), "A", "u");
  applyPatch(u, { op: "appendEffect", skillId: "hit", effect: [{ op: "applyStatus", to: "target", status: { kind: "mark", name: "Electroblade", duration: null } }] });
  const foe = makeUnit({ id: "f", team: "B", hp: 100 });
  const state = makeState([u], [foe]);
  runEffects(state, u.skills![0]!.effects, { caster: u, self: u, targets: [foe] });
  assert.equal(foe.hp, 90, "original damage still runs");
  assert.ok(foe.statuses.some((s) => s.kind === "mark" && s.name === "Electroblade"), "the appended effect ran too");
});

test("setSkillMeta retunes a skill's cost/cooldown", () => {
  const u = loadHero(dummyDef(), "A", "u");
  applyPatch(u, { op: "setSkillMeta", skillId: "hit", meta: { cost: { generic: 0, specific: 2 }, cooldown: 3 } });
  assert.deepEqual(effectiveCost(u, u.skills![0]!), { generic: 0, specific: 2 });
  assert.equal(u.skills![0]!.cooldown, 3);
});

test("addSkill / replaceSkill edit the kit; addTrigger/removeTrigger edit reactive behaviour", () => {
  const u = loadHero(dummyDef(), "A", "u");
  applyPatch(u, { op: "addSkill", skill: skill("bonus", [{ op: "heal", amount: 5, to: "self" }]), slot: 0 });
  assert.equal(u.skills![0]!.id, "bonus", "inserted at slot 0");
  applyPatch(u, { op: "replaceSkill", skillId: "hit", skill: skill("hit", [{ op: "damage", amount: 99, to: "target" }], { tags: ["Harmful"] }) });
  assert.equal((u.skills!.find((s) => s.id === "hit")!.effects[0] as { amount: number }).amount, 99, "skill replaced");

  applyPatch(u, { op: "addTrigger", trigger: { on: "turnStart", source: "Aug", effect: [{ op: "heal", amount: 7, to: "self" }] } });
  assert.ok((u.triggers ?? []).some((t) => t.source === "Aug" && t.owner === "u"), "trigger added + re-owned");
  applyPatch(u, { op: "removeTrigger", source: "Aug" });
  assert.ok(!(u.triggers ?? []).some((t) => t.source === "Aug"), "trigger removed");
});

test("a full augment applies its patches and is recorded on the hero (cumulative)", () => {
  // ando4 "On the Clock": Overclock is now permanent, but Ando takes 15 Affliction on a Supercharged skill.
  const u = loadHero(dummyDef(), "A", "u");
  const aug: Augment = {
    id: "dummy4", name: "On the Clock", description: "…",
    patches: [
      { op: "patchNode", skillId: "hit", nodeId: "dmg", replace: { op: "damage", amount: 20, to: "target", id: "dmg" } },
      { op: "addTrigger", trigger: { on: "skillUsed", source: "On the Clock", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "healthLoss", amount: 15, to: "self" }] } },
    ],
  };
  applyAugment(u, aug);
  assert.deepEqual(u.augments, ["dummy4"], "augment recorded");
  assert.equal((findNode(u.skills![0]!.effects, "dmg") as { amount: number }).amount, 20);

  const state = makeState([u], [makeUnit({ id: "f", team: "B" })]);
  emit(state, { type: "skillUsed", caster: "u", skillId: "hit", targets: ["f"] });
  assert.equal(u.hp, 85, "the added self-damage trigger fired");
});

test("an augment custom escape hatch runs its registered handler", () => {
  registerAugmentCustom("markSelf", (unit) => { unit.statuses.push({ kind: "mark", name: "Aug", duration: null, appliedBy: unit.id, appliedTurn: 0 }); });
  const u = loadHero(dummyDef(), "A", "u");
  applyPatch(u, { op: "custom", fn: "markSelf" });
  assert.ok(u.statuses.some((s) => s.kind === "mark" && s.name === "Aug"));
  assert.throws(() => applyPatch(u, { op: "custom", fn: "nope" }), /not registered/);
});
