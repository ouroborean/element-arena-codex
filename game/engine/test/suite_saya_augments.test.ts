import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { tickDurationsForTeam } from "../src/status.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Status, Unit } from "../src/types.ts";

// =====================================================================================================
// Saya, Genius Inventor — AUGMENTS adversarial suite. The FROZEN augment prose (content/frozen/augments.json)
// is the oracle for WHAT each augment must do; the base skill's FROZEN prose (content/frozen/skills.json)
// grounds the behavior it modifies. Authored/generated content is consulted ONLY for HOW to drive (ids,
// costs, the status/stack/mark names the skills produce), NEVER to decide what to assert.
//
// Frozen augment text (all Lightning, element id 3):
//   saya1 Royalties       — "When Saya gives an ally Elemental Essence with Universal Energy Conduit, she
//                            also gains Elemental Essence"
//   saya2 Link Coils      — "Saya Coil deals an additional 5 damage for every Saya Coil she has active"
//   saya3 What's Mine is Yours — "Spider Mines now affects a single enemy, but only lasts for one turn."
//   saya4 Kinetic Converter    — "Reduces the cooldown of Plasma Shield to 1 turn, but reduces the shield
//                            it grants to 25."
//   saya5 Hair Trigger    — "Well-Used Panic Button will now trigger when Saya falls below 60 health."
//
// Grounding base frozen text:
//   saya1 Universal Energy Conduit — "Gives a random ally Elemental Essence at the end of Saya's turns."
//   saya2 Saya Coil        — "Deals 10 damage to a random enemy at the end of every turn ... up to 3 active."
//   saya3 Spider Mines      — two mines on random enemies; "If those enemies use a new skill, their spider
//                             mine detonates, dealing 15 damage."
//   saya4 Plasma Shield     — "Saya gains 40 shield and ignores affliction damage for 1 turn." (cd 3)
//   saya0 Well-Used Panic Button — "The first time Saya falls below 40 health due to damage, her next Stroke
//                             of Genius will detonate all of her inventions ..."
// =====================================================================================================

// ---- drive helpers (names taken from authored content; magnitudes/durations derived from frozen) --------
const coilStackStatus = (n: number): Status => ({ kind: "stack", name: "Saya Coil", magnitude: n, duration: null, appliedBy: "s", appliedTurn: 0 });

const essenceOf = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const clearEssence = (state: MatchState): void => {
  for (const u of Object.values(state.units)) u.statuses = u.statuses.filter((s) => s.kind !== "elemental_essence");
};
const coilStack = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === "Saya Coil")?.magnitude ?? 0;
const hasMine = (u: Unit): boolean => u.statuses.some((s) => s.name === "Spider Mine");
const mineDuration = (u: Unit): number | null | undefined => u.statuses.find((s) => s.name === "Spider Mine")?.duration;
const armed = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "Panic Armed");

/** Fresh Saya (id "s", team A, lightning), optionally with an augment applied, plus allies/enemies + energy. */
function setup(augId: string | null, opts: { allies?: number; enemies?: number; enemyHp?: number } = {}) {
  const saya = loadHero(heroById("saya"), "A", "s");
  if (augId) applyAugment(saya, augmentById(augId)!);
  const allies: Unit[] = [];
  for (let i = 0; i < (opts.allies ?? 0); i++) allies.push(makeUnit({ id: `a${i + 1}`, team: "A", name: `Ally${i + 1}` }));
  const enemies: Unit[] = [];
  const eHp = opts.enemyHp ?? 100;
  for (let i = 0; i < (opts.enemies ?? 1); i++) enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", name: `Enemy${i + 1}`, hp: eHp, maxHp: eHp }));
  const state = makeState([saya, ...allies], enemies);
  state.teams.A.energy = { generic: 40, lightning: 40 };
  state.teams.B.energy = { generic: 40, lightning: 40 };
  const sk = (id: string) => saya.skills!.find((s) => s.id === id)!;
  return { state, saya, allies, enemies, sk };
}

// =====================================================================================================
// saya1 — Royalties: "When Saya gives an ally Elemental Essence with Universal Energy Conduit, she also
//         gains Elemental Essence"
//
// The base conduit grants a random ally Essence ONLY at Saya's turn-ends (casting grants nothing — see
// suite_saya_base). Royalties couples a Saya self-grant to that ally-grant: whenever the conduit gives an
// ally Essence, Saya also gains one, at that same moment, on the same recurring cadence.
//
// Engine (probed): the augment appends the self-grant onto the conduit's ON-CAST effect list, so Saya gains
// Essence ONCE, on cast — before any ally has been given Essence — and never again in step with the
// turn-end ally-grants. Both tests below faithfully encode the frozen coupling and are SKIPPED as executable
// bug reports (Elemental Essence does not stack in this engine, so counts are read as distinct holders).
// =====================================================================================================

test("saya1 Royalties self-grant fires on cast, not coupled to the ally-grant — casting alone must grant nothing", () => {
  // Frozen: Saya gains Essence WHEN she gives an ally Essence. The ally-grant happens only at turn-end
  // (the base conduit grants nothing on cast), so casting the conduit — before any turn-end — must not
  // grant Saya (or anyone) Essence. Engine grants Saya one Essence immediately on cast.
  const { state, saya } = setup("saya1", { allies: 1, enemies: 1 });
  performAction(state, { unit: "s", skillId: "saya1", targets: [] });
  assert.equal(essenceOf(saya), 0, "no self-grant merely from casting the conduit (no ally has been given Essence yet)");
  assert.equal(essenceOf(state.units["a1"]!), 0, "no ally grant on cast either (grant is at Saya's turn-end)");
});

test("saya1 Royalties does not co-fire — a turn-end that grants the ally must ALSO grant Saya (two holders)", () => {
  // Frozen: each turn-end where the conduit gives the ally Essence must leave BOTH the ally and Saya
  // holding Essence. Engine grants exactly one holder per turn-end (the base random pick), never two.
  const { state, saya, allies } = setup("saya1", { allies: 1, enemies: 1 });
  const ally = allies[0]!;
  performAction(state, { unit: "s", skillId: "saya1", targets: [] });

  let sawAllyGrant = false;
  let maxHolders = 0;
  for (let i = 0; i < 8; i++) {
    clearEssence(state); // isolate each turn-end (Essence does not stack; clear so we count THIS turn-end's grants)
    emit(state, { type: "turnEnd", team: "A" });
    const holders = [saya, ally].filter((u) => essenceOf(u) > 0).length;
    maxHolders = Math.max(maxHolders, holders);
    if (essenceOf(ally) > 0) {
      sawAllyGrant = true;
      assert.equal(essenceOf(saya), 1, "Royalties: when the conduit grants the ally Essence, Saya also gains it");
    }
  }
  assert.equal(sawAllyGrant, true, "precondition: over 8 turn-ends the conduit granted the ally at least once");
  assert.equal(maxHolders, 2, "a granting turn-end leaves BOTH the ally and Saya holding Essence (the co-fire)");
});

// =====================================================================================================
// saya2 — Link Coils: "Saya Coil deals an additional 5 damage for every Saya Coil she has active"
// =====================================================================================================

test("saya2 Link Coils: one active coil deals 10 + 5 = 15 at turn-end (base would deal 10)", () => {
  // With augment: 1 coil -> 10 base + 5*(1 active) = 15.
  const aug = setup("saya2", { enemies: 1 });
  assert.equal(performAction(aug.state, { unit: "s", skillId: "saya2", targets: [] }).ok, true, "coil constructs");
  assert.equal(coilStack(aug.saya), 1, "one Saya Coil active");
  emit(aug.state, { type: "turnEnd", team: "A" });
  assert.equal(aug.enemies[0]!.hp, 85, "Link Coils: 1 coil deals 10 + 5*1 = 15");

  // Control: without the augment the same single coil deals only the base 10.
  const base = setup(null, { enemies: 1 });
  performAction(base.state, { unit: "s", skillId: "saya2", targets: [] });
  emit(base.state, { type: "turnEnd", team: "A" });
  assert.equal(base.enemies[0]!.hp, 90, "base: 1 coil deals 10 (no per-coil bonus)");
});

test("saya2 Link Coils: the bonus scales with active-coil COUNT — 2 coils deal 2 x (10 + 5*2) = 40 (base 20)", () => {
  // With augment: build 2 coils, each hit = 10 + 5*(2 active) = 20 -> 40 total on the lone enemy.
  const aug = setup("saya2", { enemies: 1 });
  performAction(aug.state, { unit: "s", skillId: "saya2", targets: [] });
  aug.sk("saya2").currentCd = 0; // clear the 1-turn cooldown to build the second coil
  performAction(aug.state, { unit: "s", skillId: "saya2", targets: [] });
  assert.equal(coilStack(aug.saya), 2, "two Saya Coils active");
  emit(aug.state, { type: "turnEnd", team: "A" });
  assert.equal(aug.enemies[0]!.hp, 60, "Link Coils with 2 coils: 2 hits of (10 + 5*2) = 40 total");

  // Control: base 2 coils deal 2 x 10 = 20.
  const base = setup(null, { enemies: 1 });
  performAction(base.state, { unit: "s", skillId: "saya2", targets: [] });
  base.sk("saya2").currentCd = 0;
  performAction(base.state, { unit: "s", skillId: "saya2", targets: [] });
  emit(base.state, { type: "turnEnd", team: "A" });
  assert.equal(base.enemies[0]!.hp, 80, "base: 2 coils deal 20 total");
});

// =====================================================================================================
// saya3 — What's Mine is Yours: "Spider Mines now affects a single enemy, but only lasts for one turn."
// =====================================================================================================

test("saya3 What's Mine is Yours: affects a SINGLE chosen enemy (not two random), and the mine lasts one turn", () => {
  const { state, enemies } = setup("saya3", { enemies: 2 });
  const res = performAction(state, { unit: "s", skillId: "saya3", targets: ["e1"] });
  assert.equal(res.ok, true, "augmented Spider Mines casts on a single chosen target");

  assert.equal(hasMine(enemies[0]!), true, "the chosen enemy (e1) receives a spider mine");
  assert.equal(hasMine(enemies[1]!), false, "the OTHER enemy (e2) receives nothing — frozen: affects a single enemy");
  assert.equal(mineDuration(enemies[0]!), 1, "frozen: the mine 'only lasts for one turn' (duration 1)");
});

test("saya3 What's Mine is Yours: the single mine expires after one of Saya's turns", () => {
  const { state, enemies } = setup("saya3", { enemies: 1 });
  performAction(state, { unit: "s", skillId: "saya3", targets: ["e1"] }); // applied on turn 1 (appliedTurn = 1)

  // Same-turn tick must NOT expire a mine born this turn (control that the ticker is not over-firing).
  tickDurationsForTeam(state, "A");
  assert.equal(hasMine(enemies[0]!), true, "the mine survives its birth turn");

  // One of Saya's turns later, the duration-1 mine ticks to 0 and is gone.
  state.turn = 2;
  tickDurationsForTeam(state, "A");
  assert.equal(hasMine(enemies[0]!), false, "the mine expires after one turn (duration 1)");
});

test.skip("SUSPECTED BUG: saya3 What's Mine is Yours — the augmented mine never detonates (applied as a mark, detonation reads a stack)", () => {
  // Frozen: the augment changes only targeting (single) and duration (1 turn); the base detonation
  // clause is preserved — "If those enemies use a new skill, their spider mine detonates, dealing 15
  // damage." Engine (probed): the base detonation trigger fires only for a `stack` named "Spider Mine";
  // the augment's replaceSkill applies the mine as a `mark` named "Spider Mine", which the trigger never
  // reads — so the augmented mine deals no detonation damage.
  const saya = loadHero(heroById("saya"), "A", "s");
  applyAugment(saya, augmentById("saya3")!);
  const e1 = makeUnit({ id: "e1", team: "B", name: "Mined", hp: 100, maxHp: 100, skills: [skill("epoke", [], { targeting: "self", tags: ["Strategic"] })] });
  const e2 = makeUnit({ id: "e2", team: "B", name: "Clean", hp: 100, maxHp: 100, skills: [skill("epoke2", [], { targeting: "self", tags: ["Strategic"] })] });
  const state = makeState([saya], [e1, e2]);
  state.teams.A.energy = { generic: 40, lightning: 40 };
  state.teams.B.energy = { generic: 40, lightning: 40 };

  assert.equal(performAction(state, { unit: "s", skillId: "saya3", targets: ["e1"] }).ok, true, "mine placed on e1");
  assert.equal(hasMine(e1), true, "e1 bears the mine");
  assert.equal(hasMine(e2), false, "e2 bears no mine (single-target)");

  // Control: the mine-free enemy acting detonates nothing.
  assert.equal(performAction(state, { unit: "e2", skillId: "epoke2", targets: [] }).ok, true, "e2 acts");
  assert.equal(e1.hp, 100, "e2 acting does not detonate e1's mine");

  // Frozen: the mine-bearing enemy using a new skill detonates its mine for 15.
  assert.equal(performAction(state, { unit: "e1", skillId: "epoke", targets: [] }).ok, true, "e1 acts");
  assert.equal(e1.hp, 85, "e1's spider mine detonates for 15 when e1 uses a new skill");
  assert.equal(hasMine(e1), false, "the detonated mine is consumed");
});

// =====================================================================================================
// saya4 — Kinetic Converter: "Reduces the cooldown of Plasma Shield to 1 turn, but reduces the shield it
//         grants to 25."
// =====================================================================================================

test("saya4 Kinetic Converter: Plasma Shield now grants 25 shield on a 1-turn cooldown (base 40 / cd 3)", () => {
  const { state, saya, sk } = setup("saya4", { enemies: 1 });
  const res = performAction(state, { unit: "s", skillId: "saya4", targets: [] });
  assert.equal(res.ok, true, "augmented Plasma Shield casts");
  assert.equal(totalShield(saya), 25, "frozen: the shield it grants is reduced to 25");
  assert.equal(sk("saya4").cooldown, 1, "frozen: cooldown reduced to 1 turn");
  assert.equal(sk("saya4").currentCd, 1, "the cast puts it on its (new) 1-turn cooldown, not 3");

  // Control: base Plasma Shield grants 40 on a 3-turn cooldown.
  const base = setup(null, { enemies: 1 });
  performAction(base.state, { unit: "s", skillId: "saya4", targets: [] });
  assert.equal(totalShield(base.saya), 40, "base Plasma Shield grants 40 shield");
  assert.equal(base.sk("saya4").cooldown, 3, "base Plasma Shield cooldown is 3");
  assert.equal(base.sk("saya4").currentCd, 3, "base cast puts it on a 3-turn cooldown");
});

test("saya4 Kinetic Converter: the augment keeps the base clauses it does not change (1-turn affliction-ignore)", () => {
  const { state, saya } = setup("saya4", { enemies: 1 });
  performAction(state, { unit: "s", skillId: "saya4", targets: [] });
  const ign = saya.statuses.find((s) => s.kind === "damage_ignore" && s.dtype === "affliction");
  assert.ok(ign, "Plasma Shield still grants the affliction damage-ignore");
  assert.equal(ign!.duration, 1, "the affliction-ignore still lasts 1 turn");

  // Behavioral proof the ignore is live: affliction is voided, leaving both HP and the (25) shield untouched.
  runEffects(state, [{ op: "damage", amount: 25, dtype: "affliction", to: "target" }], { caster: state.units["e1"]!, targets: [saya] });
  assert.equal(saya.hp, 100, "affliction damage is ignored -> no HP lost");
  assert.equal(totalShield(saya), 25, "affliction did not touch the 25 shield either (voided)");
});

// =====================================================================================================
// saya5 — Hair Trigger: "Well-Used Panic Button will now trigger when Saya falls below 60 health."
// =====================================================================================================

test("saya5 Hair Trigger: a damage drop below 60 (but above the base 40) arms the next Stroke of Genius", () => {
  // The base threshold is 40 (verified out-of-process: a base Saya dropping 70->55 does NOT arm). Hair
  // Trigger raises it to 60, so a drop to 55 now arms.
  const { state, saya } = setup("saya5", { enemies: 1 });
  saya.hp = 70;
  saya.statuses.push(coilStackStatus(2)); // some inventions on hand
  assert.equal(armed(saya), false, "not armed before the drop");

  runEffects(state, [{ op: "damage", amount: 15, dtype: "normal", to: "target" }], { caster: state.units["e1"]!, targets: [saya] });
  assert.equal(saya.hp, 55, "Saya fell to 55 (below the new 60 threshold, still above the base 40)");
  assert.equal(armed(saya), true, "Hair Trigger arms Well-Used Panic Button on a sub-60 drop");
});

test("saya5 Hair Trigger: 'below 60' is a strict threshold — a drop that leaves Saya above 60 does not arm", () => {
  const { state, saya } = setup("saya5", { enemies: 1 });
  saya.hp = 70;
  saya.statuses.push(coilStackStatus(2));
  runEffects(state, [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { caster: state.units["e1"]!, targets: [saya] });
  assert.equal(saya.hp, 65, "Saya is at 65 — not below 60");
  assert.equal(armed(saya), false, "no arm while Saya remains above the 60 threshold");
});

test.skip("SUSPECTED BUG: saya5 Hair Trigger leaks — retunePassiveThreshold mutates a shared trigger, so an un-augmented Saya also gets the 60 threshold", () => {
  // Frozen: Hair Trigger retunes THIS Saya's passive to 60. An un-augmented Saya must keep the base 40
  // threshold (a drop to 55 must NOT arm — verified out-of-process). Engine (probed): applying Hair
  // Trigger to one Saya instance mutates the shared passive-trigger object, so a DIFFERENT, un-augmented
  // Saya loaded afterward in the same process is contaminated and arms at 55.
  const sayaA = loadHero(heroById("saya"), "A", "sA");
  applyAugment(sayaA, augmentById("saya5")!); // retune A's threshold to 60

  const sayaB = loadHero(heroById("saya"), "A", "sB"); // fresh, NO augment -> frozen base threshold is 40
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([sayaB], [e1]);
  state.teams.B.energy = { generic: 40 };
  sayaB.hp = 70;
  runEffects(state, [{ op: "damage", amount: 15, dtype: "normal", to: "target" }], { caster: e1, targets: [sayaB] });
  assert.equal(sayaB.hp, 55, "sayaB fell to 55");
  assert.equal(armed(sayaB), false, "an un-augmented Saya keeps the base 40 threshold: a drop to 55 must NOT arm");
});
