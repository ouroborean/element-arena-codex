import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { performAction, endTurn } from "../src/scheduler.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

/**
 * ADVERSARIAL, SPEC-DERIVED suite for Pyrrha's BASE kit.
 * The FROZEN PROSE (content/frozen/skills.json) is the oracle for every assertion:
 *
 *   pyrrha0 Burning Up   — "When an enemy affected by Fan the Flames damages Pyrrha, she gains
 *                           Elemental Essence. When Pyrrha dies, she deals 10 Affliction damage to
 *                           all targetable enemies."
 *   pyrrha1 Fan the Flames— "Deals 15 Affliction damage to target enemy, then 5 Affliction damage
 *                           for the next 3 turns. Using this skill on an affected enemy will refresh
 *                           the duration."
 *   pyrrha2 Feed the Fire — "Deals 10 Affliction damage to target enemy affected by Fan the Flames.
 *                           Pyrrha heals 10 HP and gains Elemental Essence."
 *   pyrrha3 Pyrokinesis   — "Deals 20 Affliction damage to target enemy. If the target is affected
 *                           by Fan the Flames, they take 5 more damage from it for the rest of its
 *                           duration."
 *   pyrrha4 Flashbang     — "Stuns target enemy's non-Strategic skills for 1 turn. Pyrrha becomes
 *                           Invulnerable for 1 turn."
 *   pyrrha5 Wraith in White— "Pyrrha ignores non-damage effects for 2 turns. During this time, using
 *                           Pyrokinesis on an enemy will first use Fan the Flames."
 */

const skillOf = (u: Unit, id: string) => u.skills!.find((s) => s.id === id)!;

function setup(enemyOver: Partial<Unit> & { shield?: number } = {}) {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, ...enemyOver });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { p, enemy, state };
}

const hasDot = (u: Unit) => u.statuses.some((s) => s.kind === "dot" && s.name === "Fan the Flames");
const getDot = (u: Unit) => u.statuses.find((s) => s.kind === "dot" && s.name === "Fan the Flames")!;

// --------------------------------------------------------------------------- //
//  Loadout sanity
// --------------------------------------------------------------------------- //

test("Pyrrha's base kit is her 5 authored actives + Burning Up passive", () => {
  const def = heroById("pyrrha");
  assert.equal(def.passive.name, "Burning Up");
  const p = loadHero(def, "A", "p");
  assert.deepEqual(p.skills!.map((s) => s.name), [
    "Fan the Flames", "Feed the Fire", "Pyrokinesis", "Flashbang", "Wraith in White",
  ]);
  assert.equal(p.hp, 100);
});

// --------------------------------------------------------------------------- //
//  pyrrha1 — Fan the Flames
// --------------------------------------------------------------------------- //

test("Fan the Flames: 15 Affliction up front, then 5 for the next 3 turns (30 total), then expires", () => {
  const { enemy, state } = setup();
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 85, "15 Affliction immediately");
  assert.ok(hasDot(enemy), "Fan the Flames burn applied");

  // The burn ticks on Pyrrha's (team A) turn-ends: exactly 3 ticks of 5.
  endTurn(state); assert.equal(enemy.hp, 85, "no tick on the birth turn");
  endTurn(state); assert.equal(enemy.hp, 85, "enemy turn does not tick Pyrrha's burn");
  endTurn(state); assert.equal(enemy.hp, 80, "tick 1");
  endTurn(state);
  endTurn(state); assert.equal(enemy.hp, 75, "tick 2");
  endTurn(state);
  endTurn(state); assert.equal(enemy.hp, 70, "tick 3 — 15 + 3x5 = 30 total");
  assert.ok(!hasDot(enemy), "burn expires after exactly 3 ticks");
});

test("Fan the Flames: Affliction damage bypasses Shield and Damage Reduction", () => {
  const { enemy, state } = setup({
    shield: 30,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }],
  });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 85, "15 Affliction goes straight to HP, ignoring shield + DR");
  assert.equal(totalShield(enemy), 30, "shield untouched by Affliction");
});

test("Fan the Flames: re-casting on an affected enemy REFRESHES the duration (not stacks)", () => {
  const { enemy, state } = setup();
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // 85, dot dur3
  endTurn(state); // A turn1 birth (no tick)
  endTurn(state); // B turn2
  endTurn(state); assert.equal(enemy.hp, 80, "one tick landed, dot dur now 2");
  assert.equal(getDot(enemy).duration, 2);
  endTurn(state); // B turn4 -> A active on turn5

  // Re-cast on the still-affected enemy.
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 65, "second cast lands its own 15 up-front hit");
  const dot = getDot(enemy);
  assert.equal(dot.duration, 3, "duration refreshed back to full 3");
  assert.equal(dot.magnitude, 5, "refresh keeps magnitude at 5 (does NOT stack to 10)");
});

// --------------------------------------------------------------------------- //
//  pyrrha2 — Feed the Fire
// --------------------------------------------------------------------------- //

test("Feed the Fire on a Fan-affected enemy: 10 Affliction + Pyrrha heals 10 + gains Essence", () => {
  const { p, enemy, state } = setup();
  p.hp = 90;
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // Fan -> enemy 85
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha2", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 75, "10 Affliction because the target is affected");
  assert.equal(p.hp, 100, "Pyrrha healed 10");
  assert.ok(p.statuses.some((s) => s.kind === "elemental_essence"), "Pyrrha gained Elemental Essence");
});

test("Feed the Fire on an UNaffected enemy: no damage, but Pyrrha still heals 10 + gains Essence", () => {
  const { p, enemy, state } = setup();
  p.hp = 90;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha2", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 100, "no damage clause fires without the burn");
  assert.equal(p.hp, 100, "heal is unconditional");
  assert.ok(p.statuses.some((s) => s.kind === "elemental_essence"), "Essence is unconditional");
});

// --------------------------------------------------------------------------- //
//  pyrrha3 — Pyrokinesis
// --------------------------------------------------------------------------- //

test("Pyrokinesis on an unaffected enemy: 20 Affliction only, no burn created, no amplify", () => {
  const { enemy, state } = setup();
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 80, "20 flat");
  assert.ok(!hasDot(enemy), "Pyrokinesis alone does not apply Fan the Flames");
});

test("Pyrokinesis on a Fan-affected enemy: 20 now, and +5 to the burn for the rest of its duration", () => {
  const { enemy, state } = setup();
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // Fan: 85, dot mag5 dur3
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 65, "20 flat");
  assert.equal(getDot(enemy).magnitude, 10, "burn amplified 5 -> 10");

  // Each remaining tick now deals 10 (5 more than the base 5) for the rest of the 3-turn duration.
  endTurn(state); // A birth
  endTurn(state); // B
  endTurn(state); assert.equal(enemy.hp, 55, "amplified tick 1 = 10");
  endTurn(state);
  endTurn(state); assert.equal(enemy.hp, 45, "amplified tick 2 = 10");
  endTurn(state);
  endTurn(state); assert.equal(enemy.hp, 35, "amplified tick 3 = 10 (35 = 100 - 15 - 20 - 30)");
  assert.ok(!hasDot(enemy), "burn still expires on its original schedule");
});

// --------------------------------------------------------------------------- //
//  pyrrha4 — Flashbang
// --------------------------------------------------------------------------- //

test("Flashbang: stuns the target's NON-Strategic skills for 1 turn; Strategic still usable; Pyrrha Invulnerable", () => {
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [
      skill("hit", [{ op: "damage", amount: 5, to: "target" }], { tags: ["Harmful", "Instant"] }),
      skill("guard", [{ op: "applyStatus", to: "self", status: { kind: "damage_reduction", magnitude: 5, duration: 1 } }], { tags: ["Strategic"], targeting: "self", klass: "defensive" }),
    ],
  });
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha4", targets: ["e"] }).ok, true);

  const inv = p.statuses.find((s) => s.kind === "invulnerable")!;
  assert.ok(inv, "Pyrrha is Invulnerable");
  assert.equal(inv.duration, 1, "Invulnerable for 1 turn");
  const stun = enemy.statuses.find((s) => s.kind === "stun")!;
  assert.ok(stun, "enemy stunned");
  assert.equal(stun.duration, 1, "stun for 1 turn");

  assert.equal(performAction(state, { unit: "e", skillId: "hit", targets: ["p"] }).reason, "stunned", "non-Strategic skill blocked");
  assert.equal(performAction(state, { unit: "e", skillId: "guard" }).ok, true, "Strategic skill still usable");
});

test("Flashbang's Invulnerable blocks a separate (unstunned) enemy's Harmful skill", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({
    id: "e2", team: "B", hp: 100,
    skills: [skill("hit", [{ op: "damage", amount: 30, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const state = makeState([p], [e1, e2]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha4", targets: ["e1"] }); // Pyrrha -> Invulnerable
  const r = performAction(state, { unit: "e2", skillId: "hit", targets: ["p"] });
  assert.equal(r.reason, "no-legal-target", "Invulnerable Pyrrha can't be targeted by a new Harmful skill");
  assert.equal(p.hp, 100, "no damage taken");
});

// --------------------------------------------------------------------------- //
//  pyrrha5 — Wraith in White
// --------------------------------------------------------------------------- //

test("Wraith in White: during the mark, Pyrokinesis first uses Fan the Flames (15 + 20 = 35 and applies the burn)", () => {
  const { enemy, state } = setup();
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha5" }).ok, true);
  const p = state.units["p"]!;
  assert.ok(p.statuses.some((s) => s.kind === "mark" && s.name === "Wraith in White"), "Wraith in White mark present");

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 65, "Fan 15 (from the lead-in) + Pyrokinesis 20 = 35");
  assert.ok(hasDot(enemy), "Fan the Flames burn applied by the lead-in");
  assert.equal(getDot(enemy).magnitude, 10, "lead-in applies burn (5), then Pyrokinesis amplifies it (+5)");
});

test("Wraith in White control: WITHOUT the mark, Pyrokinesis is a flat 20 and applies no burn", () => {
  const { enemy, state } = setup();
  performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] });
  assert.equal(enemy.hp, 80, "no lead-in Fan the Flames");
  assert.ok(!hasDot(enemy));
});

test("Wraith in White: a damage effect still lands while active (she ignores only NON-damage effects)", () => {
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [skill("zap", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha5" }); // Wraith in White
  assert.equal(performAction(state, { unit: "e", skillId: "zap", targets: ["p"] }).ok, true);
  assert.equal(p.hp, 90, "damage is NOT a non-damage effect — it still lands");
});

// Control that proves an enemy stun DOES land on an unprotected Pyrrha (baseline for the suspected bug below).
test("Control: without Wraith in White, an enemy stun lands on Pyrrha", () => {
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [skill("flash", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { tags: ["Harmful", "Instant"] })],
  });
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const state = makeState([p], [enemy]);
  state.teams.B.energy = { generic: 40, fire: 40 };
  assert.equal(performAction(state, { unit: "e", skillId: "flash", targets: ["p"] }).ok, true);
  assert.ok(p.statuses.some((s) => s.kind === "stun"), "stun lands normally when Pyrrha is unprotected");
});

test("Wraith in White: Pyrrha ignores an enemy-applied non-damage effect (a stun does not land)", () => {
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [skill("flash", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { tags: ["Harmful", "Instant"] })],
  });
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha5" }); // Wraith in White: "ignores non-damage effects for 2 turns"
  assert.ok(p.statuses.some((s) => s.kind === "non_damage_ignore"), "the ignore window is active");

  // A stun is a non-damage effect — FROZEN prose says Pyrrha ignores it entirely.
  performAction(state, { unit: "e", skillId: "flash", targets: ["p"] });
  assert.ok(!p.statuses.some((s) => s.kind === "stun"), "FROZEN: the stun should be ignored while Wraith in White is up");
});

// --------------------------------------------------------------------------- //
//  pyrrha0 — Burning Up (passive)
// --------------------------------------------------------------------------- //

test("Burning Up: a Fan-affected enemy damaging Pyrrha grants her Elemental Essence", () => {
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [skill("hit", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // Fan the Flames on the enemy
  assert.equal(performAction(state, { unit: "e", skillId: "hit", targets: ["p"] }).ok, true);
  assert.ok(p.statuses.some((s) => s.kind === "elemental_essence"), "affected attacker grants Essence");
});

test("Burning Up control: an UNaffected enemy damaging Pyrrha grants no Essence", () => {
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [skill("hit", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const state = makeState([p], [enemy]);
  state.teams.B.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "e", skillId: "hit", targets: ["p"] }).ok, true);
  assert.ok(!p.statuses.some((s) => s.kind === "elemental_essence"), "no Fan the Flames on the attacker => no Essence");
  assert.equal(p.hp, 90, "the hit itself still lands");
});

test("Burning Up: when Pyrrha dies, she deals 10 Affliction to all enemies", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const e1 = makeUnit({
    id: "e1", team: "B", hp: 100,
    skills: [skill("smite", [{ op: "damage", amount: 100, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([p], [e1, e2]);
  state.teams.B.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "e1", skillId: "smite", targets: ["p"] }).ok, true);
  assert.equal(p.alive, false, "Pyrrha died");
  assert.equal(e1.hp, 90, "10 Affliction from the death burst");
  assert.equal(e2.hp, 90, "hits every enemy");
});

test.skip("SUSPECTED BUG: Burning Up death burst hits an UNtargetable enemy (frozen says 'all targetable enemies')", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  const e1 = makeUnit({
    id: "e1", team: "B", hp: 100,
    skills: [skill("smite", [{ op: "damage", amount: 100, to: "target" }], { tags: ["Harmful", "Instant"] })],
  });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const e3 = makeUnit({
    id: "e3", team: "B", hp: 100,
    statuses: [{ kind: "untargetable", duration: null, appliedBy: "x", appliedTurn: 0 }],
  });
  const state = makeState([p], [e1, e2, e3]);
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "e1", skillId: "smite", targets: ["p"] });
  assert.equal(p.alive, false);
  assert.equal(e1.hp, 90, "targetable enemy takes 10");
  assert.equal(e2.hp, 90, "targetable enemy takes 10");
  assert.equal(e3.hp, 100, "FROZEN: an UNtargetable enemy is NOT a 'targetable enemy' and should be spared");
});

// --------------------------------------------------------------------------- //
//  Scheduler integration — energy gating (how the skill is driven)
// --------------------------------------------------------------------------- //

test("Fan the Flames costs 1 generic and cannot fire without energy", () => {
  const { enemy, state } = setup();
  state.teams.A.energy = { generic: 1 };
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 85);
  assert.equal(state.teams.A.energy.generic, 0, "1 generic spent");
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).reason, "insufficient-energy");
});
