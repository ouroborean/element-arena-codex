import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

/**
 * ADVERSARIAL, SPEC-DERIVED suite for Pyrrha's AUGMENTS.
 * The FROZEN PROSE (content/frozen/augments.json) is the oracle for every assertion:
 *
 *   pyrrha1 Pyromania       — "Fan the Flames now costs 1 more [65], but deals 5 additional
 *                              damage per tick."
 *   pyrrha2 Flickering Form — "Pyrrha heals for 10 health any time Fan the Flames expires or
 *                              is removed."
 *   pyrrha3 Unending Hunger — "Pyrokinesis will now consume Fan the Flames to deal 15 extra
 *                              damage."
 *   pyrrha4 Concussive Force— "Flashbang now fully stuns the targeted enemy"
 *   pyrrha5 World in Flames — "While Wraith in White is active, Pyrrha deals 5 Affliction damage
 *                              to the enemy team each turn."
 *
 * Base Pyrrha kit prose (the augments modify these):
 *   Fan the Flames — "Deals 15 Affliction damage to target enemy, then 5 Affliction damage for
 *                     the next 3 turns."  (cost 1 generic)
 *   Pyrokinesis    — "Deals 20 Affliction damage to target enemy. If the target is affected by
 *                     Fan the Flames, they take 5 more damage from it for the rest of its duration."
 *   Flashbang      — "Stuns target enemy's non-Strategic skills for 1 turn. Pyrrha becomes
 *                     Invulnerable for 1 turn."
 *   Wraith in White— self ultimate that applies the 2-turn "Wraith in White" mark.
 */

const skillOf = (u: Unit, id: string) => u.skills!.find((s) => s.id === id)!;
const hasDot = (u: Unit) => u.statuses.some((s) => s.kind === "dot" && s.name === "Fan the Flames");
const getDot = (u: Unit) => u.statuses.find((s) => s.kind === "dot" && s.name === "Fan the Flames")!;

// --------------------------------------------------------------------------- //
//  pyrrha1 — Pyromania: "Fan the Flames now costs 1 more [65], but deals 5
//  additional damage per tick."
// --------------------------------------------------------------------------- //

test("Pyromania: Fan the Flames costs 1 MORE generic (1 -> 2); base costs 1 (control)", () => {
  const base = loadHero(heroById("pyrrha"), "A", "b");
  assert.equal(skillOf(base, "pyrrha1").cost.generic, 1, "control: base Fan the Flames costs 1 generic");

  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha1")!);
  assert.equal(skillOf(p, "pyrrha1").cost.generic, 2, "augmented Fan the Flames costs 2 generic (1 more)");
  assert.equal(skillOf(p, "pyrrha1").cost.specific, 0, "specific cost unchanged");
});

test("Pyromania: casting the augmented Fan the Flames drains 2 generic from the pool", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha1")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(state.teams.A.energy.generic, 38, "2 generic paid (base would leave 39)");
});

test("Pyromania: the up-front 15 hit is UNCHANGED; the burn deals 10 per tick (not 5)", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha1")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 85, "15 Affliction up front is unchanged by Pyromania");
  assert.ok(hasDot(enemy), "burn applied");
  assert.equal(getDot(enemy).magnitude, 10, "per-tick magnitude is 5 + 5 = 10");
  assert.equal(getDot(enemy).duration, 3, "duration still 3 turns");

  // Same tick cadence as the base suite: the burn ticks on Pyrrha's (team A) turn-ends only.
  endTurn(state); // A birth turn (no tick)
  endTurn(state); // B turn (no tick)
  endTurn(state); assert.equal(enemy.hp, 75, "tick 1 = 10");
  endTurn(state);
  endTurn(state); assert.equal(enemy.hp, 65, "tick 2 = 10");
  endTurn(state);
  endTurn(state); assert.equal(enemy.hp, 55, "tick 3 = 10 — total 15 + 3x10 = 45");
  assert.ok(!hasDot(enemy), "burn expires after exactly 3 ticks");
});

// --------------------------------------------------------------------------- //
//  pyrrha2 — Flickering Form: "Pyrrha heals for 10 health any time Fan the
//  Flames expires or is removed."
// --------------------------------------------------------------------------- //

test("Flickering Form: Pyrrha heals 10 when Fan the Flames EXPIRES naturally", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha2")!);
  p.hp = 50;
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // base Fan: dot dur3
  assert.equal(p.hp, 50, "no heal while the burn is still on the enemy");

  // Run the burn out. Heal must fire exactly on the expiry, not before.
  let healedAt = -1;
  for (let i = 0; i < 8 && healedAt < 0; i++) {
    endTurn(state);
    if (p.hp > 50) healedAt = i;
  }
  assert.ok(!hasDot(enemy), "burn expired");
  assert.equal(p.hp, 60, "Pyrrha healed exactly 10 when Fan the Flames expired");
});

test("Flickering Form: Pyrrha heals 10 when Fan the Flames is REMOVED (consumed by Pyrokinesis)", () => {
  // The 'removed' path is driven by Unending Hunger's consume (removeStatus -> statusLost).
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha2")!);
  applyAugment(p, augmentById("pyrrha3")!);
  p.hp = 50;
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // Fan -> dot on enemy
  assert.equal(p.hp, 50, "no heal from applying the burn");
  performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }); // Pyrokinesis consumes the burn
  assert.ok(!hasDot(enemy), "burn was removed (consumed)");
  assert.equal(p.hp, 60, "Pyrrha healed exactly 10 when the burn was removed");
});

test("Flickering Form control: the heal is NAME-gated — an unrelated status leaving does not heal", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha2")!);
  p.hp = 50;
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);

  // A differently-named status expiring must NOT heal Pyrrha...
  emit(state, { type: "statusExpired", unit: "e", kind: "dot", name: "Bleed" });
  assert.equal(p.hp, 50, "only 'Fan the Flames' leaving heals — an unrelated status does nothing");

  // ...whereas a 'Fan the Flames' expiry does (proves the control isolates the name, not the event).
  emit(state, { type: "statusExpired", unit: "e", kind: "dot", name: "Fan the Flames" });
  assert.equal(p.hp, 60, "a 'Fan the Flames' expiry heals exactly 10");
});

// --------------------------------------------------------------------------- //
//  pyrrha3 — Unending Hunger: "Pyrokinesis will now consume Fan the Flames to
//  deal 15 extra damage."
// --------------------------------------------------------------------------- //

test("Unending Hunger: Pyrokinesis on a Fan-affected enemy deals 15 EXTRA (20 -> 35) and consumes the burn", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha3")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] }); // Fan: enemy -> 85, dot present
  assert.equal(enemy.hp, 85);
  assert.ok(hasDot(enemy));

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 50, "Pyrokinesis 20 + 15 extra = 35 damage (85 - 35)");
  assert.ok(!hasDot(enemy), "Fan the Flames was CONSUMED (removed) by Pyrokinesis");
});

test("Unending Hunger control: on an UNaffected enemy, Pyrokinesis is a flat 20 with no extra and no consume", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha3")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }).ok, true);
  assert.equal(enemy.hp, 80, "no burn present -> no 15 extra, just the base 20");
  assert.ok(!hasDot(enemy), "no burn created");
});

test("Unending Hunger: the consumed burn deals NO further ticks (control: base Pyrokinesis leaves the burn ticking)", () => {
  // Augmented: burn consumed -> no ticks afterward.
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha3")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e"] });
  performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e"] }); // -> 50, consumed
  const hpAfterConsume = enemy.hp;
  for (let i = 0; i < 8; i++) endTurn(state);
  assert.equal(enemy.hp, hpAfterConsume, "a consumed burn cannot tick again");

  // Control: base Pyrrha (no augment) — Pyrokinesis on the affected enemy does NOT consume; the burn keeps ticking.
  const b = loadHero(heroById("pyrrha"), "A", "b");
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const s2 = makeState([b], [e2]);
  s2.teams.A.energy = { generic: 40, fire: 40 };
  s2.teams.B.energy = { generic: 40, fire: 40 };
  performAction(s2, { unit: "b", skillId: "pyrrha1", targets: ["e2"] }); // 85, dot mag5
  performAction(s2, { unit: "b", skillId: "pyrrha3", targets: ["e2"] }); // 65, dot amped to mag10, still present
  assert.ok(hasDot(e2), "base Pyrokinesis does NOT consume the burn");
});

// --------------------------------------------------------------------------- //
//  pyrrha4 — Concussive Force: "Flashbang now fully stuns the targeted enemy"
// --------------------------------------------------------------------------- //

function stunSetup(augment: boolean) {
  const p = loadHero(heroById("pyrrha"), "A", augment ? "p" : "b");
  if (augment) applyAugment(p, augmentById("pyrrha4")!);
  const enemy = makeUnit({
    id: "e", team: "B", hp: 100,
    skills: [
      skill("hit", [{ op: "damage", amount: 5, to: "target" }], { tags: ["Harmful", "Instant"] }),
      skill("guard", [{ op: "applyStatus", to: "self", status: { kind: "damage_reduction", magnitude: 5, duration: 1 } }], { tags: ["Strategic"], targeting: "self", klass: "defensive" }),
    ],
  });
  const state = makeState([p], [enemy]);
  state.teams.A.energy = { generic: 40, fire: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { p, enemy, state };
}

test("Concussive Force: augmented Flashbang FULLY stuns — even the target's Strategic skill is blocked", () => {
  const { p, enemy, state } = stunSetup(true);
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha4", targets: ["e"] }).ok, true);

  const stun = enemy.statuses.find((s) => s.kind === "stun")!;
  assert.ok(stun, "target is stunned");
  assert.equal(stun.duration, 1, "stun lasts 1 turn (augment only removes the Strategic carve-out)");

  assert.equal(performAction(state, { unit: "e", skillId: "hit", targets: ["p"] }).reason, "stunned", "non-Strategic blocked");
  assert.equal(performAction(state, { unit: "e", skillId: "guard" }).reason, "stunned", "FULL stun: Strategic is ALSO blocked");

  // Self-Invulnerable-1 clause is unchanged by the augment.
  const inv = p.statuses.find((s) => s.kind === "invulnerable")!;
  assert.ok(inv, "Pyrrha still becomes Invulnerable");
  assert.equal(inv.duration, 1, "Invulnerable for 1 turn");
});

test("Concussive Force control: base Flashbang stuns only non-Strategic — the Strategic skill still fires", () => {
  const { enemy, state } = stunSetup(false);
  assert.equal(performAction(state, { unit: "b", skillId: "pyrrha4", targets: ["e"] }).ok, true);
  assert.ok(enemy.statuses.some((s) => s.kind === "stun"), "target stunned");
  assert.equal(performAction(state, { unit: "e", skillId: "hit", targets: ["b"] }).reason, "stunned", "non-Strategic blocked");
  assert.equal(performAction(state, { unit: "e", skillId: "guard" }).ok, true, "base leaves Strategic usable — proves the augment changed this");
});

// --------------------------------------------------------------------------- //
//  pyrrha5 — World in Flames: "While Wraith in White is active, Pyrrha deals 5
//  Affliction damage to the enemy team each turn."
// --------------------------------------------------------------------------- //

test("World in Flames: while the Wraith in White mark is up, each turn-start deals 5 Affliction to every enemy (only)", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha5")!);
  const ally = makeUnit({ id: "a", team: "A", hp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([p, ally], [e1, e2]);
  state.teams.A.energy = { generic: 40, fire: 40 };

  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha5" }).ok, true);
  assert.ok(p.statuses.some((s) => s.kind === "mark" && s.name === "Wraith in White"), "Wraith in White mark active");

  emit(state, { type: "turnStart", team: "A" });
  assert.equal(e1.hp, 95, "enemy 1 took 5 Affliction");
  assert.equal(e2.hp, 95, "enemy 2 took 5 Affliction");
  assert.equal(p.hp, 100, "the caster is not part of the enemy team");
  assert.equal(ally.hp, 100, "an ally is not part of the enemy team");
});

test("World in Flames control: with NO Wraith in White mark, a turn-start deals nothing", () => {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(p, augmentById("pyrrha5")!);
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([p], [e1]);
  state.teams.A.energy = { generic: 40, fire: 40 };

  assert.ok(!p.statuses.some((s) => s.kind === "mark" && s.name === "Wraith in White"), "no mark (Wraith not cast)");
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(e1.hp, 100, "the 5-Affliction tick is gated on the Wraith in White mark being active");
});
