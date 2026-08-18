import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { endTurn, performAction } from "../src/scheduler.ts";
import { applyDamage, totalShield } from "../src/damage.ts";
import { applyStatus } from "../src/status.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

// --- Feature 1: outgoing damage modifier ---
test("outgoing_damage_mod empowers normal/piercing but not affliction", () => {
  const a = makeUnit({ id: "a", team: "A", statuses: [status("outgoing_damage_mod", { magnitude: 5 })] });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([a], [e1, e2]);
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: a, targets: [e1] });
  assert.equal(e1.hp, 85, "10 + 5 outgoing");
  runEffects(state, [{ op: "damage", amount: 10, dtype: "affliction", to: "target" }], { caster: a, targets: [e2] });
  assert.equal(e2.hp, 90, "affliction not boosted");
});

// --- Feature 2: cost & cooldown mutation ---
test("cost_mod makes a skill cheaper", () => {
  const a = makeUnit({ id: "a", team: "A", statuses: [status("cost_mod", { magnitude: -1 })], skills: [skill("atk", [{ op: "damage", amount: 10, to: "target" }], { cost: { generic: 2, specific: 0 }, tags: ["Harmful"] })] });
  const state = makeState([a], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  state.teams.A.energy = { generic: 1 };
  assert.equal(performAction(state, { unit: "a", skillId: "atk", targets: ["e"] }).ok, true, "cost 2-1=1 paid");
  assert.equal(state.teams.A.energy.generic, 0);
});

test("modifyCooldown reduces a skill's cooldown", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [
    skill("atk", [{ op: "damage", amount: 5, to: "target" }], { cooldown: 3, tags: ["Harmful"] }),
    skill("reset", [{ op: "modifyCooldown", delta: -3, skillId: "atk" }], { tags: ["Strategic"], targeting: "self" }),
  ] });
  const state = makeState([a], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  performAction(state, { unit: "a", skillId: "atk", targets: ["e"] });
  assert.equal(a.skills![0]!.currentCd, 3);
  performAction(state, { unit: "a", skillId: "reset" });
  assert.equal(a.skills![0]!.currentCd, 0, "cooldown reset");
});

// --- Feature 3: delayed / scheduled effects ---
test("schedule defers an effect to a later caster turn", () => {
  const a = makeUnit({ id: "a", team: "A" });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  runEffects(state, [{ op: "schedule", delayTurns: 1, to: "target", effect: [{ op: "damage", amount: 20, to: "target" }] }], { caster: a, targets: [e] });
  assert.equal(e.hp, 100, "not yet");
  endTurn(state); endTurn(state); endTurn(state); // to A's next turn-end
  assert.equal(e.hp, 80, "delayed damage landed");
});

test("a status onExpire fires when it lapses (delayed kill)", () => {
  const a = makeUnit({ id: "a", team: "A" });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "mark", name: "Doom", duration: 1, onExpire: [{ op: "damage", amount: 30, to: "target" }] } }], { caster: a, targets: [e] });
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(e.hp, 70, "onExpire ran at duration lapse");
});

// --- Feature 4: expanded trigger events ---
test("healReceived fires a reactive trigger", () => {
  const healer = makeUnit({ id: "h", team: "A" });
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  ally.triggers = [{ on: "healReceived", owner: "al", source: "t", when: { sameUnit: ["eventUnit", "self"] }, effect: [{ op: "grantShield", amount: 5, to: "self" }] }];
  const state = makeState([healer, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: healer, targets: [ally] });
  assert.equal(ally.hp, 70);
  assert.equal(totalShield(ally), 5, "healReceived trigger fired");
});

test("eventTargets enumerates all targets of a skill inside a trigger", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [skill("aoe", [{ op: "damage", amount: 5, to: "target" }], { targeting: "all-enemies", tags: ["Harmful"] })] });
  a.triggers = [{ on: "skillUsed", owner: "a", source: "t", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "forEach", each: "eventTargets", do: [{ op: "applyStatus", to: "it", status: { kind: "mark", name: "Tagged", duration: null } }] }] }];
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([a], [e1, e2]);
  performAction(state, { unit: "a", skillId: "aoe" });
  assert.ok(e1.statuses.some((s) => s.name === "Tagged") && e2.statuses.some((s) => s.name === "Tagged"), "both targets tagged");
});

// --- Feature 5: audit additions ---
test("scoped damage_ignore ignores only a type (saya4) or a source (maggie5)", () => {
  const byType = makeUnit({ id: "u", team: "B", hp: 100, statuses: [status("damage_ignore", { dtype: "affliction" })] });
  assert.equal(applyDamage(byType, { amount: 20, type: "affliction" }).hpLost, 0);
  assert.equal(applyDamage(byType, { amount: 20, type: "normal" }).hpLost, 20, "normal still lands");

  const bySource = makeUnit({ id: "m", team: "A", hp: 100, statuses: [status("damage_ignore", { name: "Curse of Thorns" })] });
  assert.equal(applyDamage(bySource, { amount: 10, type: "affliction", sourceId: "Curse of Thorns" }).hpLost, 0);
  assert.equal(applyDamage(bySource, { amount: 10, type: "normal", sourceId: "other" }).hpLost, 10);
});

test("regen heals over time (the twin of dot)", () => {
  const a = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
  applyStatus(a, status("regen", { name: "Mending", magnitude: 10, duration: 2, appliedBy: "a", appliedTurn: 0 }));
  const state = makeState([a], [makeUnit({ id: "e", team: "B" })]);
  endTurn(state); // A turn-end: tick +10
  assert.equal(a.hp, 60);
  endTurn(state); endTurn(state); // to A again: tick +10, then expire
  assert.equal(a.hp, 70);
});

test("a requires gate makes a skill unselectable until met", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [skill("big", [{ op: "damage", amount: 30, to: "target" }], { tags: ["Harmful"], requires: { has: "stack", name: "Charged", of: "self" } })] });
  const state = makeState([a], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  assert.equal(performAction(state, { unit: "a", skillId: "big", targets: ["e"] }).reason, "requirements-not-met");
  applyStatus(a, status("stack", { name: "Charged", magnitude: 1, duration: null }));
  assert.equal(performAction(state, { unit: "a", skillId: "big", targets: ["e"] }).ok, true);
});

test("uncounterable makes a skill immune to counters", () => {
  const a = makeUnit({ id: "a", team: "A", hp: 100, statuses: [status("uncounterable")], skills: [skill("atk", [{ op: "damage", amount: 30, to: "target" }], { tags: ["Harmful"] })] });
  const d = makeUnit({ id: "d", team: "B", hp: 100 });
  d.triggers = [{ on: "skillDeclared", owner: "d", kind: "counter", source: "t", when: { declaredTargetsSelf: true }, effect: [] }];
  const state = makeState([a], [d]);
  const r = performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(r.countered, undefined, "counter suppressed");
  assert.equal(d.hp, 70);
});

test("heal_lock blocks incoming heals except from the allowed healer", () => {
  const healer = makeUnit({ id: "h", team: "A" });
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100, statuses: [status("heal_lock", { unitRef: "al" })] });
  const state = makeState([healer, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: healer, targets: [ally] });
  assert.equal(ally.hp, 50, "external heal blocked");
  runEffects(state, [{ op: "heal", amount: 20, to: "self" }], { caster: ally });
  assert.equal(ally.hp, 70, "self-heal allowed");
});
