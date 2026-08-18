import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost, performAction, startTurn, endTurn } from "../src/scheduler.ts";
import { runEffects, emit } from "../src/effects/interpret.ts";
import { spendShield, totalShield } from "../src/damage.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers custom handlers
import "../content/custom_effects.ts";
import { registerMinion } from "../src/minions.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { Unit } from "../src/types.ts";
import type { TriggeredEffect } from "../src/events.ts";

// Golden coverage for the fidelity-debt fixes: the new engine primitives (skillId-scoped
// cost_mod, the acted-this-turn ledger, conditional Uncounterable, mark-gated AoE→single,
// shield-spend) and every previously-unbacked `custom` handler. The roster smoke test only
// proves no-throw; these prove the behaviour.

// --- skillId-scoped cost_mod -------------------------------------------------- //
test("a scoped cost_mod discounts only its skill; a global one discounts all", () => {
  const u = makeUnit({ id: "u", team: "A" });
  u.skills = [skill("a", [], { cost: { generic: 0, specific: 4 } }), skill("b", [], { cost: { generic: 2, specific: 0 } })];

  u.statuses.push(status("cost_mod", { magnitude: -1, skillId: "a" }));
  assert.deepEqual(effectiveCost(u, u.skills[0]!), { generic: 0, specific: 3 }, "scoped -1 spills onto a's specific");
  assert.deepEqual(effectiveCost(u, u.skills[1]!), { generic: 2, specific: 0 }, "b untouched by a's scoped mod");

  u.statuses.push(status("cost_mod", { magnitude: -1 })); // global
  assert.deepEqual(effectiveCost(u, u.skills[1]!), { generic: 1, specific: 0 }, "global -1 hits b");
  assert.deepEqual(effectiveCost(u, u.skills[0]!), { generic: 0, specific: 2 }, "a gets both scoped + global");
});

test("syl's Leyline decay grows a scoped discount each of her turns and resets on use", () => {
  const u = makeUnit({ id: "syl", team: "A" });
  u.skills = [skill("s5", [], { cost: { generic: 0, specific: 4 } })];
  u.triggers = [
    { on: "turnStart", owner: "syl", source: "Leyline", effect: [{ op: "custom", fn: "decaySkillCost", args: { skillId: "s5", amount: 1, min: 0 } }] },
    { on: "skillUsed", owner: "syl", source: "Leyline", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "custom", fn: "resetScopedCostMod", args: { skillId: "s5" } }] },
  ];
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "turnStart", team: "A" });
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(effectiveCost(u, u.skills[0]!).specific, 2, "two of my turns → 4-2");
  emit(state, { type: "turnStart", team: "B" }); // not my turn — no decay
  assert.equal(effectiveCost(u, u.skills[0]!).specific, 2);
  emit(state, { type: "turnStart", team: "A" });
  emit(state, { type: "turnStart", team: "A" });
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(effectiveCost(u, u.skills[0]!).specific, 0, "floored at min 0, never negative");

  emit(state, { type: "skillUsed", caster: "syl", skillId: "s5", targets: [] });
  assert.equal(effectiveCost(u, u.skills[0]!).specific, 4, "using s5 resets to base");
});

// --- acted-this-turn ledger + exileActingAlone -------------------------------- //
function bkTrigger(): TriggeredEffect {
  return { on: "turnEnd", owner: "bk", source: "Exile", effect: [{ op: "custom", fn: "exileActingAlone", args: { mark: "Exile", markDuration: 1 } }] };
}

test("Black Knight acting alone this turn gains Exile + Essence; with an ally acting he does not", () => {
  const bk = makeUnit({ id: "bk", team: "A" });
  bk.triggers = [bkTrigger()];
  const ally = makeUnit({ id: "ally", team: "A" });
  const state = makeState([bk, ally], [makeUnit({ id: "e", team: "B" })]);

  state.actedThisTurn = ["bk"]; // only the Black Knight acted
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(bk.statuses.some((s) => s.kind === "mark" && s.name === "Exile"), "alone → Exile");
  assert.ok(bk.statuses.some((s) => s.kind === "elemental_essence"), "alone → Essence");

  state.actedThisTurn = ["bk", "ally"]; // an ally also acted
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(!bk.statuses.some((s) => s.kind === "mark" && s.name === "Exile"), "not alone → Exile dropped");
});

test("performAction records the actor in the turn ledger; startTurn clears it", () => {
  const u = makeUnit({ id: "u", team: "A", skills: [skill("hit", [{ op: "damage", amount: 5, to: "target" }], { tags: ["Harmful"] })] });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 5 };
  performAction(state, { unit: "u", skillId: "hit", targets: ["e"] });
  assert.deepEqual(state.actedThisTurn, ["u"]);
  startTurn(state);
  assert.deepEqual(state.actedThisTurn, [], "a new turn starts a fresh ledger");
});

// --- conditional Uncounterable ------------------------------------------------ //
test("uncounterableIf blocks a counter exactly when its condition holds", () => {
  const mk = () => {
    const caster = makeUnit({ id: "c", team: "A" });
    caster.skills = [skill("s", [{ op: "damage", amount: 5, to: "target" }], {
      tags: ["Harmful"], uncounterableIf: { has: "mark", name: "Frost", of: "caster" },
    })];
    const foe = makeUnit({ id: "f", team: "B" });
    foe.triggers = [{ on: "skillDeclared", owner: "f", kind: "counter", source: "ctr", when: { eventHasTag: "Harmful" }, effect: [] }];
    const state = makeState([caster], [foe]);
    state.teams.A.energy = { generic: 5 };
    return { state, caster };
  };

  const a = mk();
  assert.equal(performAction(a.state, { unit: "c", skillId: "s", targets: ["f"] }).countered, true, "no Frost → countered");

  const b = mk();
  b.caster.statuses.push(status("mark", { name: "Frost" }));
  const r = performAction(b.state, { unit: "c", skillId: "s", targets: ["f"] });
  assert.ok(!r.countered, "Frost-Covered → cannot be countered");
});

// --- mark-gated AoE → single -------------------------------------------------- //
test("Twisted Nightmares narrows a marked caster's all-enemies skill to one target", () => {
  const caster = makeUnit({ id: "c", team: "A", statuses: [status("mark", { name: "Twisted Nightmares" })] });
  caster.skills = [skill("aoe", [{ op: "damage", amount: 10, to: "target" }], { targeting: "all-enemies", tags: ["Harmful"] })];
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const state = makeState([caster], [e1, e2]);
  state.teams.A.energy = { generic: 5 };

  performAction(state, { unit: "c", skillId: "aoe" });
  const hit = [e1, e2].filter((u) => u.hp < 100).length;
  assert.equal(hit, 1, "only one enemy is struck while the caster is marked");
});

// --- shield-spend + consumeShield --------------------------------------------- //
test("spendShield drains the pool in order and caps at what's available", () => {
  const u = makeUnit({ id: "u", team: "A", shield: 30 });
  u.shields.push({ amount: 20, duration: null, appliedBy: "u", appliedTurn: 0 });
  assert.equal(spendShield(u, 40), 40, "spends across instances");
  assert.equal(totalShield(u), 10);
  assert.equal(spendShield(u, 999), 10, "cannot overspend");
  assert.equal(totalShield(u), 0);
});

test("consumeShield spends from the caster's real Shield pool (keeper)", () => {
  const u = makeUnit({ id: "k", team: "A", shield: 75 });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "custom", fn: "consumeShield", args: { amount: 25, of: "caster" } }], { caster: u, self: u, targets: [] });
  assert.equal(totalShield(u), 50);
});

// --- positional swap ---------------------------------------------------------- //
test("swapWithAllyAcrossFromTarget swaps the caster with the ally in the target's slot", () => {
  const aramao = makeUnit({ id: "ar", team: "A", slot: 0 });
  const ally = makeUnit({ id: "al", team: "A", slot: 2 });
  const target = makeUnit({ id: "t", team: "B", slot: 2 });
  const state = makeState([aramao, ally], [target, makeUnit({ id: "t0", team: "B", slot: 0 })]);
  // makeState assigns slots by order; force the ones we asserted on.
  aramao.slot = 0; ally.slot = 2; target.slot = 2;

  runEffects(state, [{ op: "custom", fn: "swapWithAllyAcrossFromTarget" }], { caster: aramao, self: aramao, targets: [target] });
  assert.equal(aramao.slot, 2, "aramao moves into the ally's slot (across from the target)");
  assert.equal(ally.slot, 0, "the ally takes aramao's old slot");
});

// --- echo (repeatEventSkill) -------------------------------------------------- //
test("repeatEventSkill re-runs the just-used skill against the same targets", () => {
  const caster = makeUnit({ id: "x", team: "A" });
  caster.skills = [skill("blast", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"] })];
  // an observer whose trigger echoes any skillUsed once
  caster.triggers = [{ on: "skillUsed", owner: "x", source: "Echo", effect: [{ op: "custom", fn: "repeatEventSkill" }] }];
  const foe = makeUnit({ id: "f", team: "B" });
  const state = makeState([caster], [foe]);
  state.teams.A.energy = { generic: 5 };

  performAction(state, { unit: "x", skillId: "blast", targets: ["f"] });
  assert.equal(foe.hp, 80, "10 from the cast + 10 from the echo");
});

// --- augment-if-helpful (scratch) --------------------------------------------- //
test("augmentIfHelpful_healAndInvuln heals + shields a Helpful skill's targets, ignores Harmful", () => {
  const scratch = makeUnit({ id: "s", team: "A" });
  scratch.triggers = [{ on: "skillUsed", owner: "s", source: "Deal", effect: [{ op: "custom", fn: "augmentIfHelpful_healAndInvuln", args: { heal: 15, invulnerableDuration: 1 } }] }];
  const ally = makeUnit({ id: "a", team: "A", hp: 50 });
  ally.skills = [
    skill("mend", [{ op: "heal", amount: 1, to: "target" }], { tags: ["Helpful"] }),
    skill("stab", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful"] }),
  ];
  const state = makeState([scratch, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 9 };

  performAction(state, { unit: "a", skillId: "mend", targets: ["a"] });
  assert.ok(ally.hp >= 65, "Helpful → +15 heal from the deal");
  assert.ok(ally.statuses.some((s) => s.kind === "invulnerable"), "Helpful → Invulnerable");

  ally.statuses = []; const before = ally.hp;
  performAction(state, { unit: "a", skillId: "stab", targets: ["a"] });
  assert.ok(!ally.statuses.some((s) => s.kind === "invulnerable"), "Harmful → no augment");
  assert.equal(ally.hp, before - 1, "only the stab's own damage");
});

// --- clone a countered skill onto a summoned minion (xyris4) ------------------ //
test("cloneCounteredSkillOntoMinion copies the countered skill onto the fresh Dream Reflection", () => {
  registerMinion({ name: "Dream Reflection", maxHp: 35, skills: [skill("xyrisminion1", [], { name: "placeholder" })] });
  const xyris = makeUnit({ id: "xy", team: "A", currentElement: "shadow" });
  xyris.triggers = [{
    on: "skillDeclared", owner: "xy", kind: "counter", source: "Somnic", when: { eventHasTag: "Harmful" },
    effect: [
      { op: "summon", template: "Dream Reflection", count: 1, hp: 35 },
      { op: "custom", fn: "cloneCounteredSkillOntoMinion", args: { minionTemplate: "Dream Reflection", copyFrom: "eventSkill", placeholderSkillId: "xyrisminion1" } },
    ],
  }];
  const foe = makeUnit({ id: "f", team: "B", currentElement: "fire" });
  foe.skills = [skill("foeblast", [{ op: "damage", amount: 9, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 2 } })];
  const state = makeState([xyris], [foe]);
  state.teams.B.energy = { fire: 5 };

  const r = performAction(state, { unit: "f", skillId: "foeblast", targets: ["xy"] });
  assert.equal(r.countered, true, "the harmful skill is countered");
  const reflection = Object.values(state.units).find((u) => u.kind === "minion" && u.name === "Dream Reflection")!;
  assert.ok(reflection, "a Dream Reflection was summoned");
  assert.ok((reflection.skills ?? []).some((s) => s.id === "foeblast"), "the countered skill was cloned onto it");
  assert.ok(!(reflection.skills ?? []).some((s) => s.id === "xyrisminion1"), "the placeholder was replaced");
  assert.equal(reflection.currentElement, "shadow", "specific cost re-elemented to Xyris' element");
});

test("at the minion cap, a blocked clone-summon does NOT corrupt an existing Dream Reflection", () => {
  registerMinion({ name: "Dream Reflection", maxHp: 35, skills: [skill("xyrisminion1", [], { name: "placeholder" })] });
  const xyris = makeUnit({ id: "xy", team: "A", currentElement: "shadow" });
  xyris.triggers = [{
    on: "skillDeclared", owner: "xy", kind: "counter", source: "Somnic", when: { eventHasTag: "Harmful" },
    effect: [
      { op: "summon", template: "Dream Reflection", count: 1, hp: 35 },
      { op: "custom", fn: "cloneCounteredSkillOntoMinion", args: { minionTemplate: "Dream Reflection", placeholderSkillId: "xyrisminion1" } },
    ],
  }];
  const foe = makeUnit({ id: "f", team: "B", currentElement: "fire", statuses: [] });
  foe.skills = [skill("foeblast", [{ op: "damage", amount: 9, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 2 } })];
  const state = makeState([xyris], [foe]);
  state.teams.B.energy = { fire: 5 };
  // Fill team A to the 6-minion cap with an OLDER Dream Reflection already carrying a cloned skill.
  for (let i = 0; i < 6; i++) {
    const id = `xy:Dream Reflection:${i}`;
    state.units[id] = { id, kind: "minion", name: "Dream Reflection", team: "A", hp: 35, maxHp: 35, shields: [], baseElement: "shadow", currentElement: "night", statuses: [], alive: true, summoner: "xy", skills: [skill("oldcloned", [], {})], triggers: [] } as unknown as Unit;
    state.teams.A.units.push(id);
  }

  performAction(state, { unit: "f", skillId: "foeblast", targets: ["xy"] });
  const reflections = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Dream Reflection");
  assert.equal(reflections.length, 6, "cap holds — no new minion created");
  for (const r of reflections) {
    assert.ok(!(r.skills ?? []).some((s) => s.id === "foeblast"), "no existing reflection was overwritten with the countered skill");
    assert.equal(r.currentElement, "night", "no existing reflection's element was clobbered");
  }
});

// --- dormant skillGranted wiring (zephyrex4) ---------------------------------- //
test("the Wind Step window grants Essence only when a skillGranted fires inside it", () => {
  const z = makeUnit({ id: "z", team: "A", currentElement: "wind" });
  z.triggers = [{
    on: "skillGranted", owner: "z", kind: "react", source: "Wind Step",
    when: { and: [{ sameUnit: ["eventUnit", "self"] }, { has: "mark", name: "Wind Step Window", of: "self" }] },
    effect: [
      { op: "applyStatus", to: "self", status: { kind: "elemental_essence", duration: null } },
      { op: "removeStatus", kind: "mark", name: "Wind Step Window", from: "self" },
    ],
  }];
  const state = makeState([z], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "skillGranted", unit: "z", skillId: "newskill", source: null });
  assert.ok(!z.statuses.some((s) => s.kind === "elemental_essence"), "no window → no essence (dormant)");

  runEffects(state, [{ op: "custom", fn: "grantEssenceIfSkillReceivedWithin", args: { turns: 1, to: "self" } }], { caster: z, self: z, targets: [] });
  assert.ok(z.statuses.some((s) => s.kind === "mark" && s.name === "Wind Step Window"), "Wind Step opens the window");
  emit(state, { type: "skillGranted", unit: "z", skillId: "newskill", source: null });
  assert.ok(z.statuses.some((s) => s.kind === "elemental_essence"), "granted-in-window → essence");
  assert.ok(!z.statuses.some((s) => s.kind === "mark" && s.name === "Wind Step Window"), "window consumed");
});

// --- essence one-shot at the roster level ------------------------------------- //
test("a hero granted Essence spends it as element income on its next turn, then reverts to generic", () => {
  const u = makeUnit({ id: "u", team: "A", currentElement: "fire", statuses: [status("elemental_essence")] });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  startTurn(state); // income
  assert.equal(state.teams.A.energy.fire, 1);
  assert.equal(state.teams.A.energy.generic ?? 0, 0, "swapped, not added");
  endTurn(state); // A → B
  startTurn(state); // B's turn — nothing for A
  state.activeTeam = "A"; startTurn(state); // A again, no essence now
  assert.equal(state.teams.A.energy.fire, 1, "no further fire income");
  assert.equal(state.teams.A.energy.generic, 1, "reverts to generic once the charge is gone");
});
