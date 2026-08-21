import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// ===========================================================================================
// ADVERSARIAL, SPEC-DERIVED suite for Maggie Thorncursed's AUGMENTS.
// Oracle = the FROZEN prose (content/frozen/augments.json). Every expectation below is derived
// from that text, NOT from the effect trees. Content/roster was read only to learn HOW to drive
// (augment ids, which base skill each touches, costs, element="unholy", the status names
// "Curse of Thorns" / "Bramblelash" / "Grasping Vines" / "elemental_essence").
//
//   maggie1 Leeching Briars: "When Maggie gains Elemental Essence from Bramblelash, she heals 5
//     health for every stack of Curse of Thorns on her."
//   maggie2 Fractal Thorns: "Bramblelash, Thornburst, and Grasping Vines deal 5 additional damage
//     if Maggie has 2 or more stacks of Curse of Thorns. This damage increases to 10 when she has 4
//     or more."
//   maggie3 Mutual Assurance: "When Maggie's Shield is damaged while Bramblebarrier is active, she
//     deals 5 Piercing damage to the enemy team."
//   maggie4 Hold Still: "Enemies stunned by Grasping Vines take 15 more damage from Bramblelash."
//   maggie5 Scornful Thorns: "Targets marked by Bramblelash receive 10 additional damage from
//     Thornburst."
//
// Base-kit facts used to build controls (from the base frozen prose, verified by suite_maggie_base):
//   Bramblelash = 15 to target (and marks it with a "Bramblelash" mark). Thornburst = 30 to one
//   enemy, or ALL enemies at >= 3 Curse of Thorns. Grasping Vines = a delayed 15 (mark-guarded) that
//   lands on Maggie's following turn. Cursed Resistance ("Bramblebarrier") = 10 shield per Curse
//   stack. Curse of Thorns accumulates one stack per skill use (immediate skills read the stacks that
//   exist at cast; the passive's own +1 for the cast lands afterward — proven by suite_maggie_base
//   maggie3, seed-2 => single target).
// ===========================================================================================

function fullEnergy(): { generic: number; unholy: number } {
  return { generic: 40, unholy: 40 };
}
// Seed N stacks of Curse of Thorns directly (precondition; matches maggie0's accumulating stack).
function seedCurse(u: Unit, n: number): void {
  u.statuses.push(status("stack", { name: "Curse of Thorns", magnitude: n, duration: null, appliedBy: "maggie", appliedTurn: 0 }));
}
// A Bramblelash mark, exactly as the base skill applies it (kind "mark", name "Bramblelash").
function markBramblelash(u: Unit): void {
  u.statuses.push(status("mark", { name: "Bramblelash", duration: 2, appliedBy: "maggie", appliedTurn: 0 }));
}
function withMaggie(augId: string): Unit {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  applyAugment(maggie, augmentById(augId)!);
  return maggie;
}

// ===========================================================================================
// maggie1 — Leeching Briars: gaining Elemental Essence heals 5 per Curse of Thorns stack.
//
// Driving note: Bramblelash is Maggie's ONLY Elemental Essence source, and the base kit never
// actually grants it (see suite_maggie_base's SUSPECTED-BUG skip). Per the augment's own model, a
// generic Essence gain ON Maggie == "gains Elemental Essence from Bramblelash". We drive it the same
// way the fidelity3 tests do: land an `elemental_essence` statusApplied on Maggie. HP is dropped to
// 50 first so the heal is observable (heal clamps at maxHp).
// ===========================================================================================

test("maggie1 Leeching Briars: gaining Elemental Essence heals 5 x Curse-of-Thorns stacks; scales with stacks", () => {
  // 3 stacks => heal 15 (50 -> 65).
  {
    const maggie = withMaggie("maggie1");
    maggie.hp = 50;
    seedCurse(maggie, 3);
    maggie.statuses.push(status("elemental_essence", {}));
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    emit(state, { type: "statusApplied", unit: "maggie", source: "maggie", kind: "elemental_essence" });
    assert.equal(maggie.hp, 65, "5 x 3 Curse of Thorns = 15 healed");
  }
  // 2 stacks => heal 10 (50 -> 60). Scaling control: fewer stacks => proportionally less heal.
  {
    const maggie = withMaggie("maggie1");
    maggie.hp = 50;
    seedCurse(maggie, 2);
    maggie.statuses.push(status("elemental_essence", {}));
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    emit(state, { type: "statusApplied", unit: "maggie", source: "maggie", kind: "elemental_essence" });
    assert.equal(maggie.hp, 60, "5 x 2 Curse of Thorns = 10 healed");
  }
  // 0 stacks => "5 for every stack" = 0 healed.
  {
    const maggie = withMaggie("maggie1");
    maggie.hp = 50;
    maggie.statuses.push(status("elemental_essence", {}));
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    emit(state, { type: "statusApplied", unit: "maggie", source: "maggie", kind: "elemental_essence" });
    assert.equal(maggie.hp, 50, "no Curse of Thorns stacks => no heal");
  }
});

test("maggie1 Leeching Briars: only an Essence gain ON MAGGIE heals — a non-Essence status, or an enemy's Essence, does not", () => {
  // CONTROL A — a non-Essence status lands on Maggie: no heal (the trigger keys on the applied kind).
  {
    const maggie = withMaggie("maggie1");
    maggie.hp = 50;
    seedCurse(maggie, 3);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    emit(state, { type: "statusApplied", unit: "maggie", source: "maggie", kind: "mark", name: "Bramblelash" });
    assert.equal(maggie.hp, 50, "a mark (not Essence) landing on Maggie does not heal");
  }
  // CONTROL B — Essence is gained by an ENEMY, not Maggie ("...on HER"): Maggie does not heal.
  {
    const maggie = withMaggie("maggie1");
    maggie.hp = 50;
    seedCurse(maggie, 3);
    const enemy = makeUnit({ id: "e", team: "B" });
    enemy.statuses.push(status("elemental_essence", {}));
    const state = makeState([maggie], [enemy]);
    emit(state, { type: "statusApplied", unit: "e", source: "e", kind: "elemental_essence" });
    assert.equal(maggie.hp, 50, "an enemy gaining Essence does not heal Maggie");
  }
  // CONTROL C (over-fire guard) — Maggie still HOLDS Essence from a prior gain, but the status now
  // landing on her is a mark, not an Essence gain: it must NOT re-fire the leech heal.
  {
    const maggie = withMaggie("maggie1");
    maggie.hp = 50;
    seedCurse(maggie, 3);
    maggie.statuses.push(status("elemental_essence", {}));
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "mark", name: "Decoy" });
    assert.equal(maggie.hp, 50, "a non-Essence status on an essence-holding Maggie must not re-heal");
  }
});

// ===========================================================================================
// maggie2 — Fractal Thorns: +5 dmg at >= 2 Curse of Thorns, +10 at >= 4, on Bramblelash /
// Thornburst / Grasping Vines.
// ===========================================================================================

test("maggie2 Fractal Thorns — Bramblelash: +0 below 2 stacks, +5 at 2-3, +10 at 4+", () => {
  // CONTROL — 1 stack (< 2): base 15 only.
  {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, 1);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 85, "1 Curse stack => no Fractal Thorns bonus, plain 15");
  }
  // +5 tier — 2 stacks: 15 + 5 = 20.
  {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, 2);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 80, "2 Curse stacks => 15 + 5 = 20");
  }
  // +10 tier — 4 stacks: 15 + 10 = 25.
  {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, 4);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 75, "4 Curse stacks => 15 + 10 = 25");
  }
});

test("maggie2 Fractal Thorns — Thornburst: +5 at 2 stacks (single), +10 at 4 stacks (all enemies); none below 2", () => {
  // CONTROL — 1 stack: single-target base 30, no bonus.
  {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, 1);
    const e1 = makeUnit({ id: "e1", team: "B" });
    const e2 = makeUnit({ id: "e2", team: "B" });
    const state = makeState([maggie], [e1, e2]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
    assert.equal(e1.hp, 70, "1 Curse stack => plain 30");
    assert.equal(e2.hp, 100, "still single-target at 1 stack");
  }
  // +5 tier — 2 stacks: single-target (< 3), 30 + 5 = 35.
  {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, 2);
    const e1 = makeUnit({ id: "e1", team: "B" });
    const e2 = makeUnit({ id: "e2", team: "B" });
    const state = makeState([maggie], [e1, e2]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
    assert.equal(e1.hp, 65, "2 Curse stacks => 30 + 5 = 35 on the single target");
    assert.equal(e2.hp, 100, "2 stacks (< 3) => Thornburst is still single-target");
  }
  // +10 tier — 4 stacks: all enemies (>= 3), each 30 + 10 = 40.
  {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, 4);
    const e1 = makeUnit({ id: "e1", team: "B" });
    const e2 = makeUnit({ id: "e2", team: "B" });
    const state = makeState([maggie], [e1, e2]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
    assert.equal(e1.hp, 60, "4 stacks => 30 + 10 = 40, all enemies");
    assert.equal(e2.hp, 60, "4 stacks => every enemy takes 40");
  }
});

test("maggie2 Fractal Thorns — Grasping Vines: the delayed hit gains +5 at 2 stacks, +10 at 4 stacks; +0 below 2", () => {
  // The bonus is evaluated when the delayed hit resolves (Maggie's following turn). Seeds 0/2/4 are
  // chosen so the passive's own +1 stack (added for the cast) can never cross a tier boundary:
  //   seed 0 -> {0,1} both < 2 (no bonus); seed 2 -> {2,3} both in [2,4) (+5); seed 4 -> {4,5} both >= 4 (+10).
  const runGV = (seed: number): number => {
    const maggie = withMaggie("maggie2");
    seedCurse(maggie, seed);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie2", targets: ["e"] }).ok, "Grasping Vines prepared");
    assert.equal(e.hp, 100, "no instant damage on cast");
    endTurn(state); endTurn(state); endTurn(state); // A birth, B, A -> the delayed hit fires
    return e.hp;
  };
  assert.equal(runGV(0), 85, "below 2 stacks => plain delayed 15");
  assert.equal(runGV(2), 80, "2 stacks => delayed 15 + 5 = 20");
  assert.equal(runGV(4), 75, "4 stacks => delayed 15 + 10 = 25");
});

// ===========================================================================================
// maggie3 — Mutual Assurance: when Maggie's Shield is damaged while Bramblebarrier is active, she
// deals 5 Piercing to the enemy team.
//
// Driving note: Bramblebarrier == the Shield granted by Cursed Resistance; the base kit models it as
// Maggie's plain Shield pool, so a shieldDamaged on Maggie == "while Bramblebarrier is active".
// ===========================================================================================

test("maggie3 Mutual Assurance: damaging Maggie's (Bramblebarrier) shield deals 5 to the whole enemy team", () => {
  const maggie = withMaggie("maggie3");
  seedCurse(maggie, 3); // 3 x 10 = 30 shield from Cursed Resistance ("Bramblebarrier")
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  e1.skills = [skill("bite", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })];
  const state = makeState([maggie], [e1, e2]);
  state.teams.A.energy = fullEnergy();
  state.teams.B.energy = { generic: 10 };
  // Raise the actual Bramblebarrier.
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie4", targets: ["maggie"] }).ok, "Cursed Resistance (Bramblebarrier) up");
  assert.equal(totalShield(maggie), 30, "precondition: 30 shield (Bramblebarrier active)");
  // An enemy strikes Maggie; the shield absorbs the hit -> shieldDamaged fires.
  assert.ok(performAction(state, { unit: "e1", skillId: "bite", targets: ["maggie"] }).ok, "enemy hits Maggie's shield");
  assert.equal(maggie.hp, 100, "the hit was absorbed by the shield, not Maggie's HP");
  assert.equal(totalShield(maggie), 20, "the shield took the 10 (Bramblebarrier was damaged)");
  assert.equal(e1.hp, 95, "the attacker takes 5 Piercing from Mutual Assurance");
  assert.equal(e2.hp, 95, "the whole enemy team takes 5 Piercing, not just the attacker");
});

test("maggie3 Mutual Assurance: no shield (Bramblebarrier inactive) => attacking Maggie does NOT retaliate", () => {
  const maggie = withMaggie("maggie3"); // no shield seeded
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  e1.skills = [skill("bite", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })];
  const state = makeState([maggie], [e1, e2]);
  state.teams.B.energy = { generic: 10 };
  assert.ok(performAction(state, { unit: "e1", skillId: "bite", targets: ["maggie"] }).ok);
  assert.equal(maggie.hp, 90, "with no shield the 10 lands on Maggie's HP (no shieldDamaged event)");
  assert.equal(e1.hp, 100, "no shield damaged => no Piercing retaliation");
  assert.equal(e2.hp, 100, "no shield damaged => enemy team untouched");
});

test("maggie3 Mutual Assurance: it is MAGGIE'S shield that must be damaged — an ally's damaged shield does not retaliate", () => {
  const maggie = withMaggie("maggie3");
  const ally = makeUnit({ id: "ally", team: "A", shield: 30 });
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  e1.skills = [skill("bite", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })];
  const state = makeState([maggie, ally], [e1, e2]);
  state.teams.B.energy = { generic: 10 };
  assert.ok(performAction(state, { unit: "e1", skillId: "bite", targets: ["ally"] }).ok, "enemy damages the ALLY's shield");
  assert.equal(totalShield(ally), 20, "precondition: it was the ally's shield that got damaged");
  assert.equal(e1.hp, 100, "an ally's damaged shield does not trigger Maggie's Mutual Assurance");
  assert.equal(e2.hp, 100, "enemy team untouched when it was not Maggie's own shield");
});

// ===========================================================================================
// maggie4 — Hold Still: enemies stunned by Grasping Vines take 15 more from Bramblelash.
//
// Driving note: Grasping Vines is Maggie's only stun source, so "stunned by Grasping Vines" is
// modeled as the Bramblelash target simply carrying a stun.
// ===========================================================================================

test("maggie4 Hold Still: Bramblelash deals 15 + 15 to a stunned target; a non-stunned target takes only 15", () => {
  // POSITIVE — stunned target: 15 base + 15 = 30.
  {
    const maggie = withMaggie("maggie4");
    const e = makeUnit({ id: "e", team: "B" });
    e.statuses.push(status("stun", { duration: 1, appliedBy: "maggie", appliedTurn: 0 }));
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 70, "stunned target => 15 + 15 = 30 from Bramblelash");
  }
  // CONTROL — not stunned: plain 15.
  {
    const maggie = withMaggie("maggie4");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 85, "an un-stunned target takes only Bramblelash's base 15");
  }
});

// ===========================================================================================
// maggie5 — Scornful Thorns: targets marked by Bramblelash take +10 from Thornburst.
// ===========================================================================================

test("maggie5 Scornful Thorns: a Bramblelash-marked target takes 30 + 10 from Thornburst; an unmarked one takes only 30", () => {
  // POSITIVE (single-target branch, < 3 Curse) — marked target: 30 + 10 = 40.
  {
    const maggie = withMaggie("maggie5");
    seedCurse(maggie, 1);
    const e1 = makeUnit({ id: "e1", team: "B" });
    const e2 = makeUnit({ id: "e2", team: "B" });
    markBramblelash(e1);
    const state = makeState([maggie], [e1, e2]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
    assert.equal(e1.hp, 60, "marked target => 30 + 10 = 40");
    assert.equal(e2.hp, 100, "single-target: the other enemy is untouched");
  }
  // CONTROL — unmarked target: plain 30.
  {
    const maggie = withMaggie("maggie5");
    seedCurse(maggie, 1);
    const e2 = makeUnit({ id: "e2", team: "B" });
    const state = makeState([maggie], [e2]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e2"] }).ok);
    assert.equal(e2.hp, 70, "unmarked target => no Scornful Thorns bonus, plain 30");
  }
});

test("maggie5 Scornful Thorns: the +10 mirrors Thornburst's all-enemies targeting — only the MARKED enemies get it", () => {
  const maggie = withMaggie("maggie5");
  seedCurse(maggie, 3); // 3+ Curse => Thornburst hits all enemies
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const e3 = makeUnit({ id: "e3", team: "B" });
  markBramblelash(e1);
  markBramblelash(e2);
  const state = makeState([maggie], [e1, e2, e3]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
  assert.equal(e1.hp, 60, "marked enemy => 30 + 10 = 40");
  assert.equal(e2.hp, 60, "the other marked enemy => 30 + 10 = 40");
  assert.equal(e3.hp, 70, "the UNMARKED enemy takes only the base 30 (no bonus)");
});
