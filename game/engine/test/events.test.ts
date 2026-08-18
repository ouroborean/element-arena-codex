import { test } from "node:test";
import assert from "node:assert/strict";
import { emit, registerCustom, runEffects } from "../src/effects/interpret.ts";
import type { TriggeredEffect } from "../src/events.ts";
import { MAX_TRIGGER_DEPTH } from "../src/events.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

test("reactive on-damage trigger fires after the hit", () => {
  const attacker = makeUnit({ id: "a", team: "A" });
  const w = makeUnit({ id: "w", team: "B", hp: 100 });
  // "When I take damage, heal 5."
  w.triggers = [{
    on: "damageDealt", owner: "w", source: "test",
    when: { sameUnit: ["eventTarget", "self"] },
    effect: [{ op: "heal", amount: 5, to: "self" }],
  }];
  const state = makeState([attacker], [w]);

  runEffects(state, [{ op: "damage", amount: 20, to: "target" }], { caster: attacker, targets: [w] });
  assert.equal(w.hp, 85, "100 - 20 + 5 reactive heal");
});

test("on-death trigger can retaliate against the killer", () => {
  const attacker = makeUnit({ id: "a", team: "A", hp: 100 });
  const w = makeUnit({ id: "w", team: "B", hp: 10 });
  w.triggers = [{
    on: "unitDied", owner: "w", source: "test",
    when: { sameUnit: ["eventUnit", "self"] },
    effect: [{ op: "damage", amount: 10, to: "eventSource" }],
  }];
  const state = makeState([attacker], [w]);

  runEffects(state, [{ op: "damage", amount: 20, to: "target" }], { caster: attacker, targets: [w] });
  assert.equal(w.alive, false);
  assert.equal(attacker.hp, 90, "killer took 10 retaliation");
});

test("re-entrant trigger chains are capped (no infinite reflect/react loop)", () => {
  const x = makeUnit({ id: "x", team: "A", hp: 100 });
  const y = makeUnit({ id: "y", team: "B", hp: 100 });
  const ping: TriggeredEffect = {
    on: "damageDealt", owner: "x", source: "test",
    when: { sameUnit: ["eventTarget", "self"] },
    effect: [{ op: "damage", amount: 1, to: { faction: "enemies" } }],
  };
  x.triggers = [ping];
  y.triggers = [{ ...ping, owner: "y" }];
  const state = makeState([x], [y]);

  // Kick the ping-pong; it must terminate via the depth guard.
  emit(state, { type: "damageDealt", source: "x", target: "x", amount: 1, dtype: "normal" });

  assert.ok(x.hp < 100 && x.hp >= 100 - MAX_TRIGGER_DEPTH, "bounded damage to x");
  assert.ok(y.hp < 100 && y.hp >= 100 - MAX_TRIGGER_DEPTH, "bounded damage to y");
  assert.ok(state.log.some((l) => l.includes("trigger depth cap")), "cap was hit");
});

test("triggers fire in a deterministic order (team A before team B)", () => {
  const order: string[] = [];
  registerCustom("record", (ctx) => { order.push(ctx.self.id); });
  const trig = (owner: string): TriggeredEffect => ({
    on: "roundStart", owner, source: "test", effect: [{ op: "custom", fn: "record" }],
  });
  const a = makeUnit({ id: "a1", team: "A", triggers: [trig("a1")] });
  const b = makeUnit({ id: "b1", team: "B", triggers: [trig("b1")] });
  const state = makeState([a], [b]);

  emit(state, { type: "roundStart" });
  assert.deepEqual(order, ["a1", "b1"]);
});

test("Stealth suppresses a stealthed attacker from setting off enemy triggers", () => {
  const attacker = makeUnit({ id: "a", team: "A", statuses: [status("stealth")] });
  const w = makeUnit({ id: "w", team: "B", hp: 100 });
  w.triggers = [{
    on: "damageDealt", owner: "w", source: "test",
    when: { sameUnit: ["eventTarget", "self"] },
    effect: [{ op: "heal", amount: 5, to: "self" }],
  }];
  const state = makeState([attacker], [w]);

  runEffects(state, [{ op: "damage", amount: 20, to: "target" }], { caster: attacker, targets: [w] });
  assert.equal(w.hp, 80, "reactive heal suppressed because attacker is Stealthed");

  // Remove stealth → trigger fires normally.
  attacker.statuses = [];
  w.hp = 100;
  runEffects(state, [{ op: "damage", amount: 20, to: "target" }], { caster: attacker, targets: [w] });
  assert.equal(w.hp, 85);
});

test("a trigger-applied status is attributed to the owner's passive (effect provenance)", () => {
  // Deferred trigger effects run in a fresh context; a status they apply must still learn its source.
  // With no explicit sourceSkillId, it defaults to the owner's current passive id (base or fusion).
  const trig: TriggeredEffect = {
    on: "roundStart", owner: "a1", source: "Frostfang",
    effect: [{ op: "applyStatus", to: "self", status: { kind: "taunt", duration: 1 } }],
  };
  const a = makeUnit({ id: "a1", team: "A", heroId: "gommar", triggers: [trig] });
  const state = makeState([a], [makeUnit({ id: "b1", team: "B" })]);

  emit(state, { type: "roundStart" });
  assert.equal(a.statuses.find((s) => s.kind === "taunt")?.sourceId, "gommar0", "attributed to base passive");

  a.fused = "aurora"; a.statuses = [];
  emit(state, { type: "roundStart" });
  assert.equal(a.statuses.find((s) => s.kind === "taunt")?.sourceId, "gommaraurora0", "attributed to the fusion passive");
});

test("an installed watch's status is attributed to the installing skill (sourceSkillId)", () => {
  // A runtime-installed watch carries the id of the skill that installed it, so a status it applies
  // later shows THAT skill's icon (not the owner's passive) — the precise watch-trigger case.
  const watch: TriggeredEffect = {
    on: "roundStart", owner: "a1", source: "Shadow Seekers", sourceSkillId: "sylninja1",
    effect: [{ op: "applyStatus", to: "self", status: { kind: "stun", duration: 1 } }],
  };
  const a = makeUnit({ id: "a1", team: "A", heroId: "syl", triggers: [watch] });
  const state = makeState([a], [makeUnit({ id: "b1", team: "B" })]);

  emit(state, { type: "roundStart" });
  assert.equal(a.statuses.find((s) => s.kind === "stun")?.sourceId, "sylninja1");
});
