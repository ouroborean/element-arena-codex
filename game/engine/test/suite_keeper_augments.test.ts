import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, effectiveCost, startRound } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers keeper customs + augment customs
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { addShield, totalShield, applyDamage } from "../src/damage.ts";
import type { Unit } from "../src/types.ts";

// ============================================================================
// Keeper of Fables — AUGMENTS — adversarial, spec-derived behavioral suite.
//
// Oracle = the FROZEN PROSE (content/frozen/augments.json). Element = Ice, maxHp 100.
// "Tales to Tell" IS Keeper's real Shield pool (grantShield / totalShield).
//
//   keeper1 "Riveting Read":  "If Keeper of Fables still has Shield on Tales to Tell after
//       using Page-turner, the targeted enemy is stunned for 1 turn. Page-turner's cooldown
//       is increased by 1."
//   keeper2 "Flat Design":    "If Character Development targets an ally it hasn't targeted yet
//       this round, Keeper of Fables gains Elemental Essence."
//   keeper3 "Plot Twist":     "If Keeper of Fables is the only living Hero you control, Hero's
//       Return only consumes 50 Shield and costs one less [65]."
//   keeper4 "Good Pacing":    "Shield from Tales to Tell can only take a maximum of 20 damage
//       from a single hit."
//   keeper5 "Nose in a Book": "If Keeper of Fables doesn't act during his turn, he heals his
//       team for 5 health."
//
// Base kit (drivers): Page-turner (keeper1 skill) consume 25 Shield -> 25 dmg to an enemy, cd 0.
// Character Development (keeper2 skill) consume 25 Shield -> heal ally 30. Hero's Return
// (keeper5 skill) consume 75 Shield -> revive a DEAD ally at 50 HP, cost {generic:0, specific:2}.
// ============================================================================

const ICE = () => ({ generic: 40, ice: 40 });
const hasStun = (u: Unit) => u.statuses.some((s) => s.kind === "stun");
const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const stripEssence = (u: Unit) => { u.statuses = u.statuses.filter((s) => s.kind !== "elemental_essence"); };
function skillOf(u: Unit, id: string) {
  return (u.skills ?? []).find((s) => s.id === id)!;
}

// ---------------------------------------------------------------------------
// keeper1 — "Riveting Read"
//   Clause A: leftover Shield after Page-turner -> the targeted enemy is stunned 1 turn.
//   Clause B: Page-turner's cooldown is increased by 1 (base 0 -> 1).
// ---------------------------------------------------------------------------

function k1setup() {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper1")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [enemy]);
  state.teams.A.energy = ICE();
  return { k, enemy, state };
}

test("keeper1: leftover Shield after Page-turner stuns the targeted enemy for 1 turn (still deals 25)", () => {
  const { k, enemy, state } = k1setup();
  addShield(k, 40, null, k.id, 0); // 40 -> after 25 consumed, 15 remains > 0

  const r = performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(r.ok, true, "the cast succeeds");
  assert.equal(enemy.hp, 75, "Page-turner still deals its 25 damage");
  assert.equal(totalShield(k), 15, "25 Shield consumed, 15 remains (the 'still has Shield' case)");
  assert.ok(hasStun(enemy), "leftover Shield after Page-turner => the target is stunned");
  const st = enemy.statuses.find((s) => s.kind === "stun")!;
  assert.equal(st.duration, 1, "stunned for exactly 1 turn");
});

test("keeper1 CONTROL: exactly 25 Shield -> none left after Page-turner -> NO stun", () => {
  const { k, enemy, state } = k1setup();
  addShield(k, 25, null, k.id, 0); // consumed to 0

  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(enemy.hp, 75, "the 25 damage still lands");
  assert.equal(totalShield(k), 0, "all 25 consumed, none remaining");
  assert.ok(!hasStun(enemy), "no Shield remains -> 'still has Shield' is false -> no stun");
});

test("keeper1 CONTROL: 0 Shield -> Page-turner whiffs (no damage) and cannot stun", () => {
  const { k, enemy, state } = k1setup();
  // no Shield at all: base skill's >=25 guard fails; there is no Shield left => no stun.

  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(enemy.hp, 100, "no Shield -> Page-turner deals no damage");
  assert.ok(!hasStun(enemy), "no Shield -> no stun");
});

test("keeper1: Page-turner's cooldown is increased by 1 (base 0 -> 1)", () => {
  const { k, enemy, state } = k1setup();
  assert.equal(skillOf(k, "keeper1").cooldown, 1, "the augment sets Page-turner's cooldown to 1");
  addShield(k, 60, null, k.id, 0);

  const r1 = performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(r1.ok, true, "first cast succeeds");
  assert.ok(skillOf(k, "keeper1").currentCd >= 1, "Page-turner is now on cooldown");

  const r2 = performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(r2.ok, false, "cannot cast Page-turner again immediately");
  assert.equal(r2.reason, "on-cooldown", "because Page-turner now carries a 1-turn cooldown");
});

test("keeper1 CONTROL: WITHOUT the augment, Page-turner has 0 cooldown and never stuns despite leftover Shield", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [enemy]);
  state.teams.A.energy = ICE();
  addShield(k, 40, null, k.id, 0);

  assert.equal(skillOf(k, "keeper1").cooldown, 0, "base Page-turner cooldown is 0");
  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.ok(!hasStun(enemy), "base Page-turner never stuns");
  assert.equal(skillOf(k, "keeper1").currentCd, 0, "and is immediately recastable (cd 0)");
});

// ---------------------------------------------------------------------------
// keeper2 — "Flat Design": Character Development targeting an ally not yet
//   targeted THIS ROUND grants Keeper Elemental Essence.
// ---------------------------------------------------------------------------

function k2setup() {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper2")!);
  const al1 = makeUnit({ id: "al1", team: "A", kind: "hero", hp: 60, maxHp: 100 });
  const al2 = makeUnit({ id: "al2", team: "A", kind: "hero", hp: 60, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, al1, al2], [enemy]);
  state.teams.A.energy = ICE();
  return { k, al1, al2, enemy, state };
}

test("keeper2: targeting an ally not yet targeted this round grants Keeper Elemental Essence", () => {
  const { k, state } = k2setup();
  addShield(k, 40, null, k.id, 0);
  assert.ok(!hasEssence(k), "precondition: Keeper holds no Essence");

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.ok(hasEssence(k), "first-time target this round => Keeper gains Elemental Essence");
});

test("keeper2 CONTROL: re-targeting the SAME ally in the same round grants NO further Essence", () => {
  const { k, state } = k2setup();
  addShield(k, 80, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.ok(hasEssence(k), "the first cast grants Essence");
  stripEssence(k); // clear so any second grant would be observable

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.ok(!hasEssence(k), "al1 was already targeted this round => no new Essence");
});

test("keeper2: targeting a DIFFERENT (fresh) ally grants Essence again", () => {
  const { k, state } = k2setup();
  addShield(k, 80, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  stripEssence(k);
  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al2"] });
  assert.ok(hasEssence(k), "al2 is a fresh target this round => Essence granted");
});

test("keeper2: the 'this round' set resets each round (same ally grants Essence again next round)", () => {
  const { k, state } = k2setup();
  addShield(k, 40, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.ok(hasEssence(k), "targeted al1 this round");

  startRound(state); // a fresh round clears the round-permanent 'Flat Design' marks (and all statuses)
  assert.ok(!hasEssence(k), "round reset also cleared last round's Essence");
  state.teams.A.energy = ICE();
  addShield(k, 40, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.ok(hasEssence(k), "next round => al1 is a fresh target again => Essence granted");
});

test("keeper2: fires on TARGETING an ally regardless of whether the 25-Shield heal lands", () => {
  const { k, al1, state } = k2setup();
  // 0 Shield: the base heal guard (>=25) fails, so nothing is healed. The augment keys on
  // 'targets an ally', not on the heal.
  assert.equal(totalShield(k), 0, "no Shield -> the heal cannot land");
  const before = al1.hp;

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.equal(al1.hp, before, "with no Shield the 30 heal did NOT land");
  assert.ok(hasEssence(k), "yet merely targeting a fresh ally still grants Keeper Essence");
});

test("keeper2 CONTROL: WITHOUT the augment, Character Development grants no Essence", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const al1 = makeUnit({ id: "al1", team: "A", kind: "hero", hp: 60, maxHp: 100 });
  const state = makeState([k, al1], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE();
  addShield(k, 40, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al1"] });
  assert.ok(!hasEssence(k), "base Character Development does not grant Essence");
});

// ---------------------------------------------------------------------------
// keeper3 — "Plot Twist": when Keeper is the only living Hero on his team,
//   Hero's Return consumes 50 Shield (not 75) AND costs one less energy.
//   (Hero's Return = keeper5 skill; base cost {generic:0, specific:2}.)
// ---------------------------------------------------------------------------

function k3solo(shield: number) {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper3")!);
  const dead = makeUnit({ id: "da", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, dead], [enemy]);
  state.teams.A.energy = ICE();
  if (shield > 0) addShield(k, shield, null, k.id, 0);
  return { k, dead, enemy, state };
}

function k3notSolo(shield: number) {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper3")!);
  const living = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const dead = makeUnit({ id: "da", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, living, dead], [enemy]);
  state.teams.A.energy = ICE();
  if (shield > 0) addShield(k, shield, null, k.id, 0);
  return { k, living, dead, enemy, state };
}

test("keeper3: solo Keeper's Hero's Return consumes only 50 Shield (not 75)", () => {
  const { k, state } = k3solo(50);
  const r = performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(r.ok, true, "the cast resolves");
  assert.equal(totalShield(k), 0, "solo => exactly 50 Shield consumed (50 -> 0)");
});

test("keeper3: solo with 74 Shield -> the lowered 50 threshold lets it fire and consumes 50", () => {
  const { k, state } = k3solo(74);
  performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  // Base Hero's Return needs 75 (74 would do nothing); Plot Twist lets 50 through, spending 50.
  assert.equal(totalShield(k), 24, "solo consumes 50 (74 -> 24), proving the threshold dropped to 50");
});

test("keeper3 CONTROL: solo with 49 Shield -> below the 50 threshold -> nothing consumed", () => {
  const { k, state } = k3solo(49);
  performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(totalShield(k), 49, "49 < 50 => no Shield spent");
});

test("keeper3 CONTROL: NOT solo (a living ally hero exists) -> base 75 threshold applies (74 does nothing)", () => {
  const { k, state } = k3notSolo(74);
  performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(totalShield(k), 74, "not solo => needs 75 => 74 insufficient => no Shield spent");
});

test("keeper3: NOT solo with 75 Shield -> base path consumes the full 75", () => {
  const { k, state } = k3notSolo(75);
  performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(totalShield(k), 0, "not solo => the base 75 is consumed (75 -> 0)");
});

test("keeper3: solo -> Hero's Return costs one less energy; not solo -> full base cost", () => {
  // Frozen: '... costs one less [65]'. Base Hero's Return costs 2 (specific). The discount is a
  // reduction of exactly one energy unit while Keeper is the only living Hero. (Data-tension note:
  // [65]=Generic but the base cost has no Generic component; the engine spills the -1 onto Specific,
  // preserving the intended 'one cheaper when solo'. We assert the TOTAL drops by one.)
  {
    const { k, state } = k3solo(0);
    const c = effectiveCost(k, skillOf(k, "keeper5"), state);
    assert.equal(c.generic + c.specific, 1, "solo: base total 2, reduced by one => total 1");
  }
  {
    const { k, state } = k3notSolo(0);
    const c = effectiveCost(k, skillOf(k, "keeper5"), state);
    assert.equal(c.generic + c.specific, 2, "not solo: full base cost (total 2), no discount");
  }
});

// SUSPECTED BUG: frozen says solo Hero's Return revives the dead ally (consuming 50 Shield). Plot Twist
// correctly consumes 50 (asserted above) but the revive never lands: Hero's Return is single-target Helpful,
// and a DEAD ally is filtered out of legalTargets/resolveTargets (u.alive gate), so the cast silently
// defaults to a living enemy and the revive op no-ops on it. The dead ally stays dead — the Shield is spent
// for nothing. Root cause is the shared base keeper5 targeting bug (also flagged in suite_keeper_base), which
// Plot Twist inherits; the frozen augment's promised revive is therefore unreachable through a real cast.
test("keeper3: solo Hero's Return revives the targeted dead ally, consuming 50 Shield", () => {
  const { k, dead, state } = k3solo(50);
  performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(dead.alive, true, "solo Hero's Return should return the dead ally to life");
  assert.equal(dead.hp, 50, "at 50 HP");
  assert.equal(totalShield(k), 0, "having spent the 50 Shield");
});

// ---------------------------------------------------------------------------
// keeper4 — "Good Pacing": Keeper's Shield absorbs at most 20 from a single hit;
//   overflow above 20 falls through to HP.
// ---------------------------------------------------------------------------

test("keeper4: a single hit spends at most 20 Shield; the overflow falls through to HP", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper4")!);
  k.hp = 100;
  addShield(k, 100, null, k.id, 0);

  const r = applyDamage(k, { amount: 50, type: "normal", isNew: true });
  assert.equal(r.shieldAbsorbed, 20, "only 20 Shield may absorb one hit");
  assert.equal(totalShield(k), 80, "100 -> 80 (only 20 spent)");
  assert.equal(k.hp, 70, "the remaining 30 overflows to HP (100 -> 70)");
});

test("keeper4: a hit at exactly 20 is absorbed fully (no HP loss)", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper4")!);
  k.hp = 100;
  addShield(k, 100, null, k.id, 0);

  const r = applyDamage(k, { amount: 20, type: "normal", isNew: true });
  assert.equal(r.shieldAbsorbed, 20, "a 20-damage hit is fully absorbed");
  assert.equal(k.hp, 100, "no HP lost");
  assert.equal(totalShield(k), 80, "100 -> 80");
});

test("keeper4: the cap is PER HIT (two separate hits each absorb up to 20)", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper4")!);
  k.hp = 100;
  addShield(k, 100, null, k.id, 0);

  applyDamage(k, { amount: 30, type: "normal", isNew: true }); // absorbs 20, 10 to HP
  applyDamage(k, { amount: 30, type: "normal", isNew: true }); // absorbs 20 again, 10 to HP
  assert.equal(totalShield(k), 60, "each hit spent 20 (100 -> 60), not a shared/global cap");
  assert.equal(k.hp, 80, "each hit overflowed 10 to HP (100 -> 80)");
});

test("keeper4 CONTROL: WITHOUT the augment, Shield absorbs the whole 50 (no per-hit cap)", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  k.hp = 100;
  addShield(k, 100, null, k.id, 0);

  const r = applyDamage(k, { amount: 50, type: "normal", isNew: true });
  assert.equal(r.shieldAbsorbed, 50, "base Shield absorbs the full hit");
  assert.equal(k.hp, 100, "no HP lost");
  assert.equal(totalShield(k), 50, "100 -> 50");
});

// ---------------------------------------------------------------------------
// keeper5 — "Nose in a Book": if Keeper does NOT act on his turn, at his team's
//   turn-end he heals his team (incl. self) for 5.
// ---------------------------------------------------------------------------

function k5setup() {
  const k = loadHero(heroById("keeper"), "A", "k");
  applyAugment(k, augmentById("keeper5")!);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 60, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 40, maxHp: 100 });
  const state = makeState([k, ally], [enemy]);
  k.hp = 50;
  return { k, ally, enemy, state };
}

test("keeper5: if Keeper doesn't act, his team heals 5 at team turn-end (incl. self, not enemies)", () => {
  const { k, ally, enemy, state } = k5setup();
  // makeState starts actedThisTurn empty -> Keeper did not act.
  emit(state, { type: "turnEnd", team: "A" });
  assert.equal(k.hp, 55, "Keeper heals 5 (50 -> 55)");
  assert.equal(ally.hp, 65, "his ally heals 5 (60 -> 65)");
  assert.equal(enemy.hp, 40, "the enemy is NOT healed");
});

test("keeper5 CONTROL: if Keeper acted this turn, there is no heal", () => {
  const { k, ally, state } = k5setup();
  state.actedThisTurn = ["k"]; // Keeper acted
  emit(state, { type: "turnEnd", team: "A" });
  assert.equal(k.hp, 50, "Keeper acted => no heal");
  assert.equal(ally.hp, 60, "ally unhealed");
});

test("keeper5 CONTROL: only Keeper's OWN team turn-end fires the heal (enemy turn-end does nothing)", () => {
  const { k, ally, state } = k5setup();
  emit(state, { type: "turnEnd", team: "B" }); // the enemy team's turn-end
  assert.equal(k.hp, 50, "the enemy team's turn-end must not heal Keeper's team");
  assert.equal(ally.hp, 60, "ally unhealed");
});

test("keeper5 CONTROL: WITHOUT the augment, an idle turn-end heals nobody", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 60, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  k.hp = 50;
  emit(state, { type: "turnEnd", team: "A" });
  assert.equal(k.hp, 50, "no augment => no heal");
  assert.equal(ally.hp, 60, "no augment => no heal");
});
