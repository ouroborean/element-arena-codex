import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { performAction, canUse } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + hero/augment triggers
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------------------------- //
//  Zephyrex — AUGMENTS behavioral suite. The FROZEN augment prose (content/frozen/augments.json)
//  is the ORACLE for what to assert; the authored/generated content is consulted only to learn how
//  to DRIVE (augment ids, which base skill each touches, costs, status names). Element = Wind.
//
//  Base-skill id ↔ name map (roster.generated.ts):
//    zephyrex1 Arcadian Duet   (1 generic, Harmful)  — target becomes Invulnerable + Isolated
//    zephyrex2 Elegant Sweep   (1 gen + 1 wind, Channel, self)
//    zephyrex3 Sonic Thrust    (1 wind, Harmful, Bypassing; requires Wind Step on cooldown)
//    zephyrex4 Wind Step       (free, hidden Strategic; base: 15 DR for 1 turn)
//    zephyrex5 Perfect Execution (1 wind, ultimate, Harmful) — grants "Perfection"
//  Passive Biting Wind: an enemy becoming Invulnerable takes 15 piercing "first".
//
//  Frozen augment text (the oracle):
//    zephyrex1 Blade of Romance:  "If Arcadian Duet targets a different enemy than its last target,
//                                  Zephyrex gains Elemental Essence."
//    zephyrex2 Blade of Symphonies: "Using Sonic Thrust on an enemy will also use Arcadian Duet on them."
//    zephyrex3 Wind Dancer:       "Wind Step now targets an enemy, lowering their non-Affliction damage
//                                  by 10 for 1 turn. If that enemy uses a new harmful skill during this
//                                  time, Zephyrex gains Elemental Essence. This effect is invisible."
//    zephyrex4 Zephyr Blade:      "Perfection now grants Zephyrex immunity to Stuns."
//    zephyrex5 Polite Denial:     "Elegant Sweep is now invisible, and Zephyrex gains the effect of Wind
//                                  Step while it is active."
// ---------------------------------------------------------------------------------------------- //

const hp = (s: MatchState, id: string) => s.units[id]!.hp;
const sk = (u: { skills?: SkillInstance[] }, id: string) => (u.skills ?? []).find((x) => x.id === id)!;
const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const hasMark = (u: Unit, name: string) => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const clearEssence = (u: Unit) => { u.statuses = u.statuses.filter((s) => s.kind !== "elemental_essence"); };

// =============================================================================================== //
//  zephyrex1 — Blade of Romance
//  "If Arcadian Duet targets a DIFFERENT enemy than its LAST target, Zephyrex gains Elemental Essence."
// =============================================================================================== //

test("Blade of Romance: the FIRST Arcadian Duet cast (a new/different target) grants Elemental Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex1")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  assert.equal(hasEssence(zeph), false, "starts without Elemental Essence");
  const r = performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  assert.equal(r.ok, true, "Arcadian Duet resolves");
  assert.equal(hasEssence(zeph), true, "a target different from the (nonexistent) last target grants Essence");
  assert.equal(hasMark(foe, "Arcadian Target"), true, "the target is stamped as the last Arcadian target");
});

test("Blade of Romance: re-casting on the SAME enemy grants NO further Essence (not a different target)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex1")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 60, generic: 60 };

  performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  assert.equal(hasEssence(zeph), true, "first cast grants Essence and marks e1");
  // Control: strip the granted Essence and the Invulnerable/Isolated the Duet applied (so e1 is a legal
  // Harmful target again), but LEAVE the "Arcadian Target" mark — e1 is still the last target.
  clearEssence(zeph);
  foe.statuses = foe.statuses.filter((s) => s.kind !== "invulnerable" && s.kind !== "isolated");
  assert.equal(hasMark(foe, "Arcadian Target"), true, "e1 remains the marked last target");

  const r = performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  assert.equal(r.ok, true, "the re-cast resolves");
  assert.equal(hasEssence(zeph), false, "same-target re-cast grants NO Essence");
});

test("Blade of Romance: switching to a DIFFERENT enemy grants Essence and moves the last-target mark", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex1")!);
  const foe1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe1, foe2]);
  state.teams.A.energy = { wind: 60, generic: 60 };

  performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  assert.equal(hasMark(foe1, "Arcadian Target"), true, "e1 is the last target after the first cast");
  clearEssence(zeph);

  const r = performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e2"] });
  assert.equal(r.ok, true, "the cast on a new enemy resolves");
  assert.equal(hasEssence(zeph), true, "a different target than the last grants Essence");
  assert.equal(hasMark(foe2, "Arcadian Target"), true, "the new enemy becomes the last target");
  assert.equal(hasMark(foe1, "Arcadian Target"), false, "the previous last-target mark is cleared");
});

// =============================================================================================== //
//  zephyrex2 — Blade of Symphonies
//  "Using Sonic Thrust on an enemy will also use Arcadian Duet on them."
// =============================================================================================== //

test("Blade of Symphonies: Sonic Thrust also runs Arcadian Duet — the target becomes Invulnerable + Isolated", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex2")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };
  sk(zeph, "zephyrex4").currentCd = 2; // Sonic Thrust requires Wind Step on cooldown

  const r = performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] });
  assert.equal(r.ok, true, "Sonic Thrust resolves");
  assert.equal(foe.statuses.some((s) => s.kind === "invulnerable"), true, "Arcadian Duet made the target Invulnerable");
  assert.equal(foe.statuses.some((s) => s.kind === "isolated"), true, "Arcadian Duet made the target Isolated");
  // Sonic Thrust's 20 piercing lands first; then Arcadian Duet's Invulnerable trips Biting Wind for 15 more.
  assert.equal(hp(state, "e1"), 65, "20 (Sonic Thrust) + 15 (Biting Wind off the applied Invulnerable) = 35 lost");
});

test("Blade of Symphonies control: WITHOUT the augment, Sonic Thrust does NOT apply Invulnerable/Isolated", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx"); // base kit, no augment
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };
  sk(zeph, "zephyrex4").currentCd = 2;

  const r = performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] });
  assert.equal(r.ok, true, "base Sonic Thrust resolves");
  assert.equal(foe.statuses.some((s) => s.kind === "invulnerable"), false, "no Arcadian Duet ⇒ no Invulnerable");
  assert.equal(foe.statuses.some((s) => s.kind === "isolated"), false, "no Arcadian Duet ⇒ no Isolated");
  assert.equal(hp(state, "e1"), 80, "base Sonic Thrust deals only its own 20 piercing (no Biting Wind trigger)");
});

// =============================================================================================== //
//  zephyrex3 — Wind Dancer
//  "Wind Step now targets an enemy, lowering their non-Affliction damage by 10 for 1 turn. If that
//   enemy uses a new harmful skill during this time, Zephyrex gains Elemental Essence."
// =============================================================================================== //

test("Wind Dancer: Wind Step now targets an enemy and applies a -10 non-Affliction damage debuff (1 turn)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex3")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  // The augment replaces Wind Step; it now takes an enemy target (single) and is Invisible.
  assert.equal(sk(zeph, "zephyrex4").targeting, "single", "Wind Step now targets a single enemy");
  assert.equal(sk(zeph, "zephyrex4").isHidden, true, "the effect is Invisible");

  const r = performAction(state, { unit: "zx", skillId: "zephyrex4", targets: ["e1"] });
  assert.equal(r.ok, true, "Wind Step resolves onto the enemy");
  const mod = foe.statuses.find((s) => s.kind === "outgoing_damage_mod");
  assert.ok(mod, "the enemy gets an outgoing-damage debuff");
  assert.equal(mod!.magnitude, -10, "the debuff lowers their outgoing damage by 10");
  assert.equal(mod!.duration, 1, "for 1 turn");
});

test("Wind Dancer: the debuff lowers the enemy's non-Affliction damage by 10; an unmarked enemy is unaffected", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex3")!);
  const foe1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100,
    skills: [skill("epierce", [{ op: "damage", amount: 20, dtype: "piercing", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })] });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100,
    skills: [skill("epierce", [{ op: "damage", amount: 20, dtype: "piercing", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })] });
  const state = makeState([zeph], [foe1, foe2]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: ["e1"] }); // debuff e1 only
  performAction(state, { unit: "e1", skillId: "epierce", targets: ["zx"] });
  assert.equal(hp(state, "zx"), 90, "the debuffed enemy's 20 piercing is lowered by 10 → 10 lands");
  performAction(state, { unit: "e2", skillId: "epierce", targets: ["zx"] });
  assert.equal(hp(state, "zx"), 70, "an UNdebuffed enemy's 20 piercing lands in full (control)");
});

test("Wind Dancer: only NON-Affliction damage is lowered — Affliction damage is untouched", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex3")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100,
    skills: [skill("eafflict", [{ op: "damage", amount: 20, dtype: "affliction", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })] });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: ["e1"] }); // apply -10 debuff to e1
  performAction(state, { unit: "e1", skillId: "eafflict", targets: ["zx"] });
  assert.equal(hp(state, "zx"), 80, "Affliction damage is NOT lowered by the debuff — full 20 lands");
});

test("Wind Dancer: a debuffed enemy using a HARMFUL skill grants Zephyrex Elemental Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex3")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: ["e1"] }); // mark + debuff e1
  assert.equal(hasEssence(zeph), false, "no Essence yet");
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["zx"], tags: ["Harmful"] });
  assert.equal(hasEssence(zeph), true, "the marked enemy using a harmful skill grants Essence");
});

test("Wind Dancer controls: a NON-harmful skill, or an UNmarked enemy, grants no Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex3")!);
  const foe1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe1, foe2]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: ["e1"] }); // mark e1 only

  // Control A (tag gate): the marked enemy uses a NON-harmful (Strategic) skill → no Essence.
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["e1"], tags: ["Strategic"] });
  assert.equal(hasEssence(zeph), false, "a non-harmful skill from the marked enemy grants no Essence");

  // Control B (mark gate): an UNmarked enemy uses a Harmful skill → no Essence.
  emit(state, { type: "skillUsed", caster: "e2", skillId: "x", targets: ["zx"], tags: ["Harmful"] });
  assert.equal(hasEssence(zeph), false, "a harmful skill from an unmarked enemy grants no Essence");
});

// =============================================================================================== //
//  zephyrex4 — Zephyr Blade
//  "Perfection now grants Zephyrex immunity to Stuns."
// =============================================================================================== //

test("Zephyr Blade: using Perfect Execution (which grants Perfection) makes Zephyrex immune to Stuns", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex4")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  const r = performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(r.ok, true, "Perfect Execution resolves");
  const imm = zeph.statuses.find((s) => s.kind === "mark" && s.name === "Stun Immunity");
  assert.ok(imm, "Perfection grants a Stun-Immunity mark");
  assert.equal(imm!.duration, 1, "the immunity lasts as long as Perfection (1 turn)");

  // Positive: an unscoped Stun on Zephyrex no longer stops him acting.
  zeph.statuses.push(status("stun", { duration: 1 }));
  assert.equal(canUse(state, zeph, sk(zeph, "zephyrex1")), true, "stun-immune Zephyrex can still use Arcadian Duet while Stunned");

  // Control: remove the immunity → the very same Stun now blocks the skill.
  zeph.statuses = zeph.statuses.filter((s) => !(s.kind === "mark" && s.name === "Stun Immunity"));
  assert.equal(canUse(state, zeph, sk(zeph, "zephyrex1")), false, "without the immunity, the Stun blocks the skill");
});

test("Zephyr Blade control: WITHOUT the augment, Perfect Execution grants no Stun immunity", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx"); // base kit
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(zeph.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity"), false, "no immunity granted by base Perfect Execution");
  zeph.statuses.push(status("stun", { duration: 1 }));
  assert.equal(canUse(state, zeph, sk(zeph, "zephyrex1")), false, "base Zephyrex is stopped by the Stun");
});

// =============================================================================================== //
//  zephyrex5 — Polite Denial
//  "Elegant Sweep is now invisible, and Zephyrex gains the effect of Wind Step while it is active."
//  (Wind Step's effect = 15 damage reduction for 1 turn.)
// =============================================================================================== //

test("Polite Denial: Elegant Sweep is now Invisible and grants Zephyrex the Wind Step effect (15 DR)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex5")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  assert.equal(sk(zeph, "zephyrex2").isHidden, true, "Elegant Sweep is now Invisible");
  const r = performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  assert.equal(r.ok, true, "Elegant Sweep resolves");
  const dr = zeph.statuses.find((s) => s.kind === "damage_reduction");
  assert.ok(dr, "Zephyrex gains the Wind Step effect");
  assert.equal(dr!.magnitude, 15, "15 damage reduction (Wind Step's effect)");
  assert.equal(dr!.duration, 1, "for 1 turn");
});

test("Polite Denial: the granted 15 DR actually mitigates a normal hit; base Elegant Sweep does not", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  applyAugment(zeph, augmentById("zephyrex5")!);
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100,
    skills: [skill("ehit", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })] });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }); // gain 15 DR via Polite Denial
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["zx"] });
  assert.equal(hp(state, "zx"), 95, "a 20 normal hit is reduced by the 15 DR → 5 lands");

  // Control: a base Zephyrex casting Elegant Sweep gains NO damage reduction.
  const base = loadHero(heroById("zephyrex"), "A", "zx2");
  const foeB = makeUnit({ id: "e3", team: "B", hp: 100, maxHp: 100,
    skills: [skill("ehit", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })] });
  const stateB = makeState([base], [foeB]);
  stateB.teams.A.energy = { wind: 40, generic: 40 };
  performAction(stateB, { unit: "zx2", skillId: "zephyrex2", targets: [] });
  assert.equal(base.statuses.some((s) => s.kind === "damage_reduction"), false, "base Elegant Sweep grants no DR");
  performAction(stateB, { unit: "e3", skillId: "ehit", targets: ["zx2"] });
  assert.equal(hp(stateB, "zx2"), 80, "with no DR the full 20 normal lands (control)");
});
