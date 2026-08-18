import { test } from "node:test";
import assert from "node:assert/strict";
import { pyrrha } from "../content/heroes/pyrrha.ts";
import { loadHero } from "../content/hero.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { endTurn, performAction } from "../src/scheduler.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

const skillOf = (u: ReturnType<typeof loadHero>, id: string) => u.skills!.find((s) => s.id === id)!;

function setup() {
  const p = loadHero(pyrrha, "A", "p");
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  return { p, enemy, state };
}

test("Pyrrha loads with her 5 authored active skills", () => {
  const p = loadHero(pyrrha, "A", "p");
  assert.deepEqual(p.skills!.map((s) => s.name), [
    "Fan the Flames", "Feed the Fire", "Pyrokinesis", "Flashbang", "Wraith in White",
  ]);
  assert.equal(p.hp, 100);
});

test("Fan the Flames: 15 up front, then 5 Affliction for 3 of Pyrrha's turns", () => {
  const { p, enemy, state } = setup();
  runEffects(state, skillOf(p, "pyrrha1").effects, { caster: p, targets: [enemy] });
  assert.equal(enemy.hp, 85, "15 affliction immediately");
  assert.ok(enemy.statuses.some((s) => s.kind === "dot" && s.name === "Fan the Flames"));

  // Drive turns: the dot ticks on Pyrrha's (team A) turn-ends, 3 times.
  endTurn(state); // A turn 1 end (birth) — no tick
  assert.equal(enemy.hp, 85);
  endTurn(state); // B turn 2 end — not A's dot
  assert.equal(enemy.hp, 85);
  endTurn(state); // A turn 3 — tick 1
  assert.equal(enemy.hp, 80);
  endTurn(state); // B
  endTurn(state); // A turn 5 — tick 2
  assert.equal(enemy.hp, 75);
  endTurn(state); // B
  endTurn(state); // A turn 7 — tick 3 (final), then expires
  assert.equal(enemy.hp, 70, "15 + 3x5 = 30 total");
  assert.ok(!enemy.statuses.some((s) => s.kind === "dot"), "burn expired after 3 ticks");
});

test("Affliction ignores Shield and DR (Fan the Flames on an armored target)", () => {
  const { p, state } = setup();
  const armored = makeUnit({ id: "e", team: "B", hp: 100, shield: 30, statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  state.units.e = armored;
  state.teams.B.units = ["e"];
  runEffects(state, skillOf(p, "pyrrha1").effects, { caster: p, targets: [armored] });
  assert.equal(armored.hp, 85, "affliction bypasses shield + DR");
  assert.equal(totalShield(armored), 30);
});

test("Pyrokinesis: 20 now, and +5 to an existing Fan the Flames burn for its remaining duration", () => {
  const { p, enemy, state } = setup();
  runEffects(state, skillOf(p, "pyrrha1").effects, { caster: p, targets: [enemy] }); // apply burn (85)
  runEffects(state, skillOf(p, "pyrrha3").effects, { caster: p, targets: [enemy] }); // 20 more -> 65
  assert.equal(enemy.hp, 65);
  const dot = enemy.statuses.find((s) => s.kind === "dot" && s.name === "Fan the Flames")!;
  assert.equal(dot.magnitude, 10, "burn amplified 5 -> 10");
});

test("Feed the Fire: only burns a Fan-affected target, but always heals Pyrrha + grants Essence", () => {
  // affected target
  const a = setup();
  a.p.hp = 90;
  runEffects(a.state, skillOf(a.p, "pyrrha1").effects, { caster: a.p, targets: [a.enemy] }); // burn -> 85
  runEffects(a.state, skillOf(a.p, "pyrrha2").effects, { caster: a.p, targets: [a.enemy] });
  assert.equal(a.enemy.hp, 75, "10 affliction because affected");
  assert.equal(a.p.hp, 100, "Pyrrha healed 10");
  assert.ok(a.p.statuses.some((s) => s.kind === "elemental_essence"));

  // unaffected target: no burn damage, but still heals + essence
  const b = setup();
  b.p.hp = 90;
  runEffects(b.state, skillOf(b.p, "pyrrha2").effects, { caster: b.p, targets: [b.enemy] });
  assert.equal(b.enemy.hp, 100, "no damage without the burn");
  assert.equal(b.p.hp, 100);
});

test("Flashbang: stuns the target's non-Strategic skills; Pyrrha turns Invulnerable", () => {
  const { p, state } = setup();
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [
      { id: "hit", name: "Hit", element: "fire", targeting: "single", klass: "basic", tags: ["Harmful", "Instant"], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, effects: [{ op: "damage", amount: 5, to: "target" }] },
      { id: "guard", name: "Guard", element: "fire", targeting: "self", klass: "defensive", tags: ["Strategic"], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, effects: [{ op: "applyStatus", to: "self", status: { kind: "damage_reduction", magnitude: 5, duration: 1 } }] },
    ],
  });
  state.units.e = enemy;
  state.teams.B.units = ["e"];

  runEffects(state, skillOf(p, "pyrrha4").effects, { caster: p, targets: [enemy] });
  assert.ok(p.statuses.some((s) => s.kind === "invulnerable"), "Pyrrha invulnerable");
  assert.equal(performAction(state, { unit: "e", skillId: "hit", targets: ["p"] }).reason, "stunned", "harmful blocked");
  assert.equal(performAction(state, { unit: "e", skillId: "guard" }).ok, true, "Strategic still usable");
});

test("Wraith in White makes the next Pyrokinesis lead with Fan the Flames", () => {
  const withWraith = setup();
  runEffects(withWraith.state, skillOf(withWraith.p, "pyrrha5").effects, { caster: withWraith.p, targets: [] });
  assert.ok(withWraith.p.statuses.some((s) => s.kind === "non_damage_ignore"));
  runEffects(withWraith.state, skillOf(withWraith.p, "pyrrha3").effects, { caster: withWraith.p, targets: [withWraith.enemy] });
  assert.equal(withWraith.enemy.hp, 65, "Fan 15 + Pyrokinesis 20 = 35");
  const dot = withWraith.enemy.statuses.find((s) => s.kind === "dot")!;
  assert.equal(dot.magnitude, 10, "Fan applied (5) then amplified by Pyrokinesis (+5)");

  // Baseline: Pyrokinesis alone on a fresh enemy is just 20, no burn.
  const plain = setup();
  runEffects(plain.state, skillOf(plain.p, "pyrrha3").effects, { caster: plain.p, targets: [plain.enemy] });
  assert.equal(plain.enemy.hp, 80);
  assert.ok(!plain.enemy.statuses.some((s) => s.kind === "dot"));
});

test("Burning Up passive: on death, deals 10 Affliction to all enemies", () => {
  const p = loadHero(pyrrha, "A", "p");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([p], [e1, e2]);

  // e1 lands a lethal blow on Pyrrha; her death trigger retaliates against all enemies.
  runEffects(state, [{ op: "damage", amount: 100, to: "target" }], { caster: e1, targets: [p] });
  assert.equal(p.alive, false);
  assert.equal(e1.hp, 90, "10 affliction on death");
  assert.equal(e2.hp, 90);
});

test("Burning Up passive: a Fan-affected enemy damaging Pyrrha grants her Essence", () => {
  const { p, enemy, state } = setup();
  runEffects(state, skillOf(p, "pyrrha1").effects, { caster: p, targets: [enemy] }); // Fan the Flames on enemy

  // The affected enemy hits Pyrrha → she gains Elemental Essence.
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: enemy, targets: [p] });
  assert.ok(p.statuses.some((s) => s.kind === "elemental_essence"), "essence gained");

  // An UNaffected attacker does not grant essence.
  const clean = setup();
  const other = makeUnit({ id: "o", team: "B" });
  clean.state.units.o = other;
  clean.state.teams.B.units.push("o");
  runEffects(clean.state, [{ op: "damage", amount: 10, to: "target" }], { caster: other, targets: [clean.p] });
  assert.ok(!clean.p.statuses.some((s) => s.kind === "elemental_essence"));
});

test("Flashbang's Invulnerable actually protects Pyrrha from enemy Harmful skills", () => {
  const p = loadHero(pyrrha, "A", "p");
  // e1 is Flashbang's target (gets stunned); e2 is a separate, unstunned attacker.
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({
    id: "e2", team: "B", hp: 100,
    skills: [skill("hit", [{ op: "damage", amount: 30, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const state = makeState([p], [e1, e2]);

  runEffects(state, skillOf(p, "pyrrha4").effects, { caster: p, targets: [e1] }); // Flashbang → Pyrrha Invulnerable
  const r = performAction(state, { unit: "e2", skillId: "hit", targets: ["p"] });
  assert.equal(r.reason, "no-legal-target", "enemy can't target the Invulnerable Pyrrha");
  assert.equal(p.hp, 100);
});

test("scheduler integration: Fan the Flames costs 1 generic and can't fire without energy", () => {
  const { p, state } = setup();
  state.teams.A.energy = { generic: 1 };
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(state.units.e!.hp, 85);
  assert.equal(state.teams.A.energy.generic, 0);
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).reason, "insufficient-energy");
});
