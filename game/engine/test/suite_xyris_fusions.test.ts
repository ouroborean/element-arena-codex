import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, tickDots, grantIncome } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers xyris triggers + fusion custom fns
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { MatchState, Unit, Status } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";
import type { TriggeredEffect } from "../src/events.ts";

// =============================================================================
// XYRIS, King of Dreams — FUSION FORMS — adversarial, SPEC-DERIVED behavioral suite.
// Oracle = the FROZEN prose (content/frozen/skills.json). Fusion forms are enumerated
// from fusions.authored.json (hero:"xyris"): assassin, curse, dimension, ion, mirror,
// moon, night, ninja, ritual, vigilante. Each replaces the base passive (xyris0 Dream
// Body) and inserts one active. Frozen text of each (passive0 / active1):
//
//   assassin0 Before I Wake: "When Enter the Dreamscape ends, affected enemies receive
//             damage equal to the damage they received while it was active."
//   assassin1 Dream Knife: "Deals 15 damage to an enemy affected by Enter the Dreamscape."
//   curse0 Hypnagogic Curse: "Xyris now starts the game at 1HP. Damage now heals him, and
//             healing damages him. Xyris will now die when he reaches 100 HP."
//   curse1 Dream Weaving: "Xyris and a targeted Hero swap their current HP."
//   dimension0 Dreamform Paradox: "Whenever Dream Body triggers, the cooldown on Astral
//             Rejection and Somnic Apparition are reduced by 1."
//   dimension1 Astral Rejection: "Target Hero is Banished (Stunned, Untargetable,
//             Invulnerable) for 1 turn. This effect cancels any skills that they had delayed."
//   ion0 Dark Arcadia: "Enter the Dreamscape now affects all living units."
//   ion1 Phantasia Pulse: "Deals 20 damage to target enemy, increased by 10 for each hero
//             with Elemental Essence on the enemy team. Xyris is healed for 10 HP for each
//             hero with Elemental Essence on his team."
//   mirror0 Darkness and Truth: "Simulacrums and Dream Reflections ignore counters and stuns."
//   mirror1 Simulacrum: "Xyris targets one ally or enemy and creates a Simulacrum minion that
//             possesses their Basic skills. Simulacrums are created with 30 HP and their
//             specific costs are the same as Xyris's."
//   moon0 Captured Humanity: "Enemies countered by Dream Reflection are permanently Mooncursed.
//             (Mooncursed characters have their Strategic skills stunned, deal 5 more
//             non-affliction damage, and suffer 10 Affliction damage each turn.)"
//   moon1 Wild Hunt: "Xyris targets all Mooncursed units. For 3 turns, they are Shattered and
//             Isolated. Allied targets deal 5 more non-Affliction damage with new skills."
//   night0 Quiet Nightmare: "Xyris will Silence enemies that he damages for 1 turn."
//   night1 Spine Chill: "Xyris deals 20 damage to all enemies and Paralyzes their cooldowns
//             for 1 turn."
//   ninja0 Dream Infiltration: "Enter the Dreamscape no longer deals damage, but targets all
//             enemies. Xyris's skills Bypass against targets affected by Enter the Dreamscape."
//   ninja1 Steal Secrets: "Xyris targets one enemy and creates a Dream Reflection minion with a
//             copy of the skill that the targeted enemy used last. Can only be used on a target
//             affected by Enter the Dreamscape, and will fail if the target has not yet used a skill."
//   ritual0 Shadow Court Ritual: "Any time Elemental Essence is gained, Xyris gains 5 Ritual
//             Power. After reaching 75 Ritual Power, all units have their skill cooldowns reduced by 1."
//   ritual1 Heartfire: "Target unit receives 20 Affliction damage. Xyris and the target both
//             gain Elemental Essence."
//   vigilante0 Dreams of Power: "Xyris deals 5 more damage to enemies with Elemental Essence,
//             and gains Elemental Essence when using Harmful skills on them."
//   vigilante1 Sacred Severing: "Deals 30 damage to target enemy, cancels any cancellable skill
//             they are using, and Silences them for 2 turns."
//
// NB (engine glossary): "Silence" = suppresses Elemental Essence income (scheduler.hasEssenceIncome),
// NOT a cast-lock. So Silence tests assert the status + duration and, where sharp, income suppression.
// "Enter the Dreamscape affected" is modeled as a mark named "Enter the Dreamscape".
// =============================================================================

const ESSENCE = "elemental_essence";
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === ESSENCE).length;
const st = (u: Unit, kind: Status["kind"], name?: string): Status | undefined =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const teamMinions = (state: MatchState, team: string): Unit[] =>
  Object.values(state.units).filter((u) => u.kind === "minion" && u.team === team && u.alive);
const dreamMark = (): Status => status("mark", { name: "Enter the Dreamscape", duration: null });

// Generous, colour-agnostic energy so cost is never the thing under test.
const fund = (state: MatchState, team: "A" | "B") => {
  state.teams[team].energy = {
    generic: 40, shadow: 40, water: 40,
    assassin: 40, curse: 40, dimension: 40, ion: 40, mirror: 40,
    moon: 40, night: 40, ninja: 40, ritual: 40, vigilante: 40,
  };
};

function fused(id: string, element: string, team: "A" | "B" = "A"): Unit {
  const x = loadHero(heroById("xyris"), team, id);
  applyFusion(x, fusionForm("xyris", element)!);
  return x;
}

// --- driver skills (drivers only; assertions come from the frozen prose) ---
const eHarm = (amount = 6): ReturnType<typeof skill> =>
  skill("eHarm", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "single", element: "water",
  });
const eAoe = (amount = 8): ReturnType<typeof skill> =>
  skill("eAoe", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "all-enemies", element: "water",
  });
const eStrategic = (): ReturnType<typeof skill> =>
  skill("eStrat", [{ op: "heal", amount: 1, to: "self" } as Effect], {
    tags: ["Strategic", "Instant"], targeting: "self", element: "water",
  });
const eHelp = (): ReturnType<typeof skill> =>
  skill("eHelp", [{ op: "heal", amount: 5, to: "self" } as Effect], {
    tags: ["Helpful", "Instant"], targeting: "self", element: "water",
  });

// ###########################################################################
// # assassin — "Before I Wake" (passive) + "Dream Knife" (active)
// ###########################################################################

test("assassin0 companion: casting Enter the Dreamscape stamps the 'affected' mark on the target", () => {
  const x = fused("x", "assassin");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e]);
  fund(state, "A");
  assert.equal(st(e, "mark", "Enter the Dreamscape"), undefined, "no affected-mark yet");
  const r = performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] });
  assert.ok(r.ok, "Enter the Dreamscape casts");
  assert.ok(st(e, "mark", "Enter the Dreamscape"), "the target is now 'affected by Enter the Dreamscape'");
});

test("assassin0: on Enter the Dreamscape ENDING, the affected enemy takes damage equal to what it received while active", () => {
  const x = fused("x", "assassin");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [dreamMark()] });
  const dealer = makeUnit({ id: "d", team: "B", kind: "hero" });
  const state = makeState([x], [e, dealer]);

  // While affected, the enemy receives a clean 12 damage — banked by the passive.
  runEffects(state, [{ op: "damage", amount: 12, dtype: "normal", to: "target" }], { caster: dealer, targets: [e] });
  assert.equal(e.hp, 88, "control point: 12 damage landed while affected");

  // The affected-state ENDS -> payback equal to the 12 it received.
  emit(state, { type: "statusExpired", unit: "e", kind: "mark", name: "Enter the Dreamscape" });
  assert.equal(e.hp, 76, "on end, the enemy receives 12 more (equal to the damage received while active)");
});

test("assassin0 CONTROL: an UN-affected enemy takes no payback when a status of the same name 'ends'", () => {
  const x = fused("x", "assassin");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // no affected-mark
  const dealer = makeUnit({ id: "d", team: "B", kind: "hero" });
  const state = makeState([x], [e, dealer]);

  runEffects(state, [{ op: "damage", amount: 12, dtype: "normal", to: "target" }], { caster: dealer, targets: [e] });
  assert.equal(e.hp, 88, "12 landed but nothing is banked (never affected)");
  emit(state, { type: "statusExpired", unit: "e", kind: "mark", name: "Enter the Dreamscape" });
  assert.equal(e.hp, 88, "no payback — the enemy was never affected");
});

test("assassin0 END-TO-END: cast Enter the Dreamscape, bank damage over its life, and pay it back on natural expiry", () => {
  const x = fused("x", "assassin");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const dealer = makeUnit({ id: "d", team: "B", kind: "hero" });
  const state = makeState([x], [e, dealer]);
  fund(state, "A");

  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] }); // stamps the affected-mark (dur 2)
  const afterCast = e.hp;
  runEffects(state, [{ op: "damage", amount: 13, dtype: "normal", to: "target" }], { caster: dealer, targets: [e] });
  assert.equal(afterCast - e.hp, 13, "13 was received while affected");

  // Cycle turns until the affected-state naturally ends (its statusExpired drives the payback).
  let paidBack = 0;
  for (let i = 0; i < 8; i++) {
    const before = e.hp;
    endTurn(state);
    if (!st(e, "mark", "Enter the Dreamscape")) { paidBack = before - e.hp; break; }
  }
  assert.equal(paidBack, 13, "on the affected-state ending, the enemy receives exactly the 13 it took while active");
});

test("assassin1 Dream Knife: deals 15 to an enemy AFFECTED by Enter the Dreamscape", () => {
  const x = fused("x", "assassin");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [dreamMark()] });
  const state = makeState([x], [e]);
  fund(state, "A");
  const r = performAction(state, { unit: "x", skillId: "xyrisassassin1", targets: ["e"] });
  assert.ok(r.ok, "Dream Knife casts");
  assert.equal(e.hp, 85, "an affected enemy takes exactly 15");
});

test("assassin1 CONTROL: Dream Knife deals nothing to an enemy NOT affected by Enter the Dreamscape", () => {
  const x = fused("x", "assassin");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // no mark
  const state = makeState([x], [e]);
  fund(state, "A");
  performAction(state, { unit: "x", skillId: "xyrisassassin1", targets: ["e"] });
  assert.equal(e.hp, 100, "no damage — the target is not Dreamscape-affected");
});

// ###########################################################################
// # curse — "Hypnagogic Curse" (passive) + "Dream Weaving" (active)
// ###########################################################################

test("curse0: at round start Xyris is set to 1 HP", () => {
  const x = fused("x", "curse");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([x], [e]);
  assert.equal(x.hp, 100, "loads at full before the round begins");
  emit(state, { type: "roundStart" });
  assert.equal(x.hp, 1, "Hypnagogic Curse starts Xyris at 1 HP");
});

test("curse0: Damage now HEALS Xyris", () => {
  const x = fused("x", "curse");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([x], [e]);
  emit(state, { type: "roundStart" }); // hp -> 1, curse installed
  runEffects(state, [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], { caster: e, targets: [x] });
  assert.equal(x.hp, 11, "damage heals him: 1 + 10 = 11");
  assert.ok(x.alive, "he is not killed by 'damage' — it heals");
});

test("curse0: HEALING now damages Xyris", () => {
  const x = fused("x", "curse");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([x], [e]);
  emit(state, { type: "roundStart" });
  x.hp = 50;
  runEffects(state, [{ op: "heal", amount: 10, to: "target" }], { caster: e, targets: [x] });
  assert.equal(x.hp, 40, "healing damages him: 50 - 10 = 40");
});

test("curse0: Xyris DIES when he reaches 100 HP", () => {
  const x = fused("x", "curse");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([x], [e]);
  emit(state, { type: "roundStart" });
  x.hp = 95;
  // Damage heals him toward the inverted lethal ceiling of 100.
  runEffects(state, [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], { caster: e, targets: [x] });
  assert.ok(x.hp >= 100, "crossed the 100 HP ceiling");
  assert.equal(x.alive, false, "Xyris dies at 100 HP (the inverted death threshold)");
});

test("curse1 Dream Weaving: Xyris and the targeted Hero swap current HP", () => {
  const x = fused("x", "curse");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", hp: 80, maxHp: 100 });
  const state = makeState([x], [foe]);
  fund(state, "A");
  x.hp = 30;
  const r = performAction(state, { unit: "x", skillId: "xyriscurse1", targets: ["e"] });
  assert.ok(r.ok, "Dream Weaving casts");
  assert.equal(x.hp, 80, "Xyris took the target's HP");
  assert.equal(foe.hp, 30, "the target took Xyris' HP");
});

// ###########################################################################
// # dimension — "Dreamform Paradox" (passive) + "Astral Rejection" (active)
// ###########################################################################

test("dimension0: when Dream Body triggers (Xyris sole-targeted), Astral Rejection and Somnic Apparition each lose 1 cooldown + Xyris gains Essence", () => {
  const x = fused("x", "dimension");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eHarm(6)] });
  const state = makeState([x], [e]);
  fund(state, "A"); fund(state, "B");

  const astral = x.skills!.find((s) => s.id === "xyrisdimension1")!;
  const somnic = x.skills!.find((s) => s.id === "xyris4")!;
  astral.currentCd = 2; somnic.currentCd = 2;
  const eBefore = essenceCount(x);

  const r = performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] }); // Xyris is the sole target
  assert.ok(r.ok, "the enemy hits Xyris");
  assert.equal(astral.currentCd, 1, "Astral Rejection cooldown reduced by 1");
  assert.equal(somnic.currentCd, 1, "Somnic Apparition cooldown reduced by 1");
  assert.equal(essenceCount(x) - eBefore, 1, "Dream Body still grants Essence when Xyris is sole-targeted");
});

test("dimension0 CONTROL: a shared AOE (Xyris + ally) is NOT a sole-target trigger — no cooldown reduction", () => {
  const x = fused("x", "dimension");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eAoe(5)] });
  const state = makeState([x, ally], [e]);
  fund(state, "A"); fund(state, "B");

  const astral = x.skills!.find((s) => s.id === "xyrisdimension1")!;
  astral.currentCd = 2;
  performAction(state, { unit: "e", skillId: "eAoe", targets: [] });
  assert.equal(astral.currentCd, 2, "an AOE hitting two units did not reduce the cooldown");
});

test("dimension0 CONTROL: a skill sole-targeting SOMEONE ELSE does not reduce Xyris' cooldowns", () => {
  const x = fused("x", "dimension");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eHarm(6)] });
  const state = makeState([x, ally], [e]);
  fund(state, "A"); fund(state, "B");

  const astral = x.skills!.find((s) => s.id === "xyrisdimension1")!;
  astral.currentCd = 2;
  performAction(state, { unit: "e", skillId: "eHarm", targets: ["a"] }); // hits the ally, not Xyris
  assert.equal(astral.currentCd, 2, "Xyris was not the target — no reduction");
});

test("dimension1 Astral Rejection: Banishes the target (Stun+Untargetable+Invulnerable, 1 turn) and cancels their delayed skills", () => {
  const x = fused("x", "dimension");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", statuses: [status("channeling", { name: "bigcast" })] });
  const state = makeState([x], [foe]);
  fund(state, "A");

  const r = performAction(state, { unit: "x", skillId: "xyrisdimension1", targets: ["e"] });
  assert.ok(r.ok, "Astral Rejection casts");
  const stn = st(foe, "stun"); const unt = st(foe, "untargetable"); const inv = st(foe, "invulnerable");
  assert.ok(stn && unt && inv, "Banish = Stunned + Untargetable + Invulnerable");
  assert.equal(stn!.duration, 1, "stun lasts 1 turn");
  assert.equal(unt!.duration, 1, "untargetable lasts 1 turn");
  assert.equal(inv!.duration, 1, "invulnerable lasts 1 turn");
  assert.equal(st(foe, "channeling"), undefined, "the target's delayed skill is cancelled");
});

test("dimension1 CONTROL: without Astral Rejection the target keeps its delayed skill", () => {
  const x = fused("x", "dimension");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", statuses: [status("channeling", { name: "bigcast" })] });
  const state = makeState([x], [foe]);
  assert.ok(st(foe, "channeling"), "the delayed skill is present when not Banished");
});

// ###########################################################################
// # ion — "Dark Arcadia" (passive) + "Phantasia Pulse" (active)
// ###########################################################################

test("ion0: Enter the Dreamscape now affects ALL living units (its Helpful-stun lands beyond the single target)", () => {
  const x = fused("x", "ion");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x, ally], [e1, e2]);
  fund(state, "A");
  emit(state, { type: "roundStart" }); // installs Dark Arcadia's rewrite

  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e1"] });
  // "all living units" -> the Enter-the-Dreamscape effect reaches every living unit, not just e1.
  for (const u of [e1, e2, ally, x]) {
    assert.ok(st(u, "stun"), `Enter the Dreamscape affects ${u.id} (all living units)`);
  }
});

test("ion0 CONTROL: a NON-ion Xyris' Enter the Dreamscape only affects its single target", () => {
  const x = loadHero(heroById("xyris"), "A", "x"); // base, unfused
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e1, e2]);
  fund(state, "A");
  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e1"] });
  assert.ok(st(e1, "stun"), "the declared target is affected");
  assert.equal(st(e2, "stun"), undefined, "a second enemy is NOT affected without Dark Arcadia");
});

test("ion1 Phantasia Pulse: 20 + 10/essence-enemy damage; Xyris healed 10/essence-ally", () => {
  const x = fused("x", "ion");
  x.hp = 50;
  x.statuses.push(status(ESSENCE)); // Xyris counts as an essence ally
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", statuses: [status(ESSENCE)] });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status(ESSENCE)] });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status(ESSENCE)] });
  const state = makeState([x, ally], [e1, e2]);
  fund(state, "A");

  const r = performAction(state, { unit: "x", skillId: "xyrision1", targets: ["e1"] });
  assert.ok(r.ok, "Phantasia Pulse casts");
  assert.equal(e1.hp, 60, "20 + 10*(2 essence enemies) = 40 damage");
  assert.equal(x.hp, 70, "healed 10*(2 essence allies incl. Xyris) = 20 (50 -> 70)");
});

test("ion1 CONTROL: with NO Elemental Essence in play, Phantasia Pulse deals a flat 20 and heals 0", () => {
  const x = fused("x", "ion");
  x.hp = 50;
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e1]);
  fund(state, "A");
  performAction(state, { unit: "x", skillId: "xyrision1", targets: ["e1"] });
  assert.equal(e1.hp, 80, "no essence enemies -> flat 20");
  assert.equal(x.hp, 50, "no essence allies -> no heal");
});

// ###########################################################################
// # mirror — "Darkness and Truth" (passive) + "Simulacrum" (active)
// ###########################################################################

test("mirror0: a Dream Reflection IGNORES stuns — it can still act after a stun is applied", () => {
  const x = fused("x", "mirror");
  const refl = makeUnit({
    id: "m", team: "A", kind: "minion", name: "Dream Reflection", summoner: "x",
    skills: [skill("mhit", [{ op: "damage", amount: 7, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"] })],
  });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x, refl], [e]);
  fund(state, "A");
  emit(state, { type: "roundStart" }); // tags Simulacrum/Dream Reflection minions

  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } } as Effect], { caster: e, targets: [refl] });
  const r = performAction(state, { unit: "m", skillId: "mhit", targets: ["e"] });
  assert.ok(r.ok, "the Dream Reflection acts despite the stun (stuns are ignored)");
  assert.equal(e.hp, 93, "its skill resolved");
});

test("mirror0 CONTROL: an ordinary minion is stopped by the same stun", () => {
  const x = fused("x", "mirror");
  const pet = makeUnit({
    id: "m", team: "A", kind: "minion", name: "Goblin", summoner: "x",
    skills: [skill("mhit", [{ op: "damage", amount: 7, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"] })],
  });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x, pet], [e]);
  fund(state, "A");
  emit(state, { type: "roundStart" });

  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } } as Effect], { caster: e, targets: [pet] });
  const r = performAction(state, { unit: "m", skillId: "mhit", targets: ["e"] });
  assert.equal(r.ok, false, "an ordinary minion cannot act while stunned");
  assert.equal(r.reason, "stunned", "rejected specifically for the stun");
});

test("mirror0: a Dream Reflection IGNORES counters — its Harmful skill is not countered", () => {
  const x = fused("x", "mirror");
  const refl = makeUnit({
    id: "m", team: "A", kind: "minion", name: "Dream Reflection", summoner: "x",
    skills: [skill("mhit", [{ op: "damage", amount: 7, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"] })],
  });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  e.triggers = [{
    on: "skillDeclared", owner: "e", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] }, effect: [],
  } as TriggeredEffect];
  const state = makeState([x, refl], [e]);
  fund(state, "A");
  emit(state, { type: "roundStart" });

  const r = performAction(state, { unit: "m", skillId: "mhit", targets: ["e"] });
  assert.ok(!r.countered, "the Dream Reflection's skill is not countered");
  assert.equal(e.hp, 93, "its damage landed");
});

test("mirror0 CONTROL: an ordinary minion IS countered by the same trap", () => {
  const x = fused("x", "mirror");
  const pet = makeUnit({
    id: "m", team: "A", kind: "minion", name: "Goblin", summoner: "x",
    skills: [skill("mhit", [{ op: "damage", amount: 7, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"] })],
  });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  e.triggers = [{
    on: "skillDeclared", owner: "e", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] }, effect: [],
  } as TriggeredEffect];
  const state = makeState([x, pet], [e]);
  fund(state, "A");
  emit(state, { type: "roundStart" });

  const r = performAction(state, { unit: "m", skillId: "mhit", targets: ["e"] });
  assert.equal(r.countered, true, "an ordinary minion is countered");
  assert.equal(e.hp, 100, "no damage — the skill was negated");
});

test("mirror1 Simulacrum: creates a 30-HP Simulacrum with the target's BASIC skills, specific costs re-elemented to Xyris' element", () => {
  const x = fused("x", "mirror"); // currentElement -> "mirror"
  const foe = makeUnit({
    id: "e", team: "B", kind: "hero", currentElement: "water",
    skills: [
      skill("ebasic", [{ op: "damage", amount: 9, dtype: "normal", to: "target" } as Effect], { klass: "basic", element: "water", cost: { generic: 0, specific: 2 } }),
      skill("eult", [{ op: "damage", amount: 40, dtype: "normal", to: "target" } as Effect], { klass: "ultimate", element: "water", cost: { generic: 0, specific: 3 } }),
    ],
  });
  const state = makeState([x], [foe]);
  fund(state, "A");
  assert.equal(teamMinions(state, "A").length, 0, "no minions yet");

  const r = performAction(state, { unit: "x", skillId: "xyrismirror1", targets: ["e"] });
  assert.ok(r.ok, "Simulacrum casts");
  const sim = teamMinions(state, "A")[0]!;
  assert.equal(sim.name, "Simulacrum", "a Simulacrum was created");
  assert.equal(sim.maxHp, 30, "created with 30 HP");
  const copiedBasic = (sim.skills ?? []).find((s) => s.id === "ebasic");
  assert.ok(copiedBasic, "it possesses the target's BASIC skill");
  assert.equal((sim.skills ?? []).some((s) => s.id === "eult"), false, "it does NOT possess non-basic skills");
  assert.equal(copiedBasic!.cost.specific, 2, "the copied skill keeps its Specific amount");
  assert.equal(sim.currentElement, "mirror", "its Specific costs are paid in Xyris' current Element");
});

// ###########################################################################
// # moon — "Captured Humanity" (passive) + "Wild Hunt" (active)
// ###########################################################################

test("moon0: an enemy countered (counterFired) is permanently Mooncursed — mark + Strategic-stun + '+5 damage' + 10 Affliction DoT", () => {
  const x = fused("x", "moon");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e]);

  emit(state, { type: "counterFired", counterer: "x", caster: "e", skillId: "whatever" });
  assert.ok(st(e, "mark", "Mooncursed"), "bears the permanent Mooncursed mark");
  const stn = st(e, "stun");
  assert.ok(stn && stn.scope && stn.scope.tag === "Strategic" && stn.scope.mode === "only", "Strategic skills are stunned (scoped stun)");
  assert.equal(stn!.duration, null, "permanently");
  const mod = st(e, "outgoing_damage_mod");
  assert.ok(mod && mod.magnitude === 5, "deals 5 more (non-affliction) damage");
  const dot = st(e, "dot", "Mooncursed");
  assert.ok(dot && dot.magnitude === 10 && dot.dtype === "affliction", "suffers a 10 Affliction DoT");
  assert.equal(dot!.duration, null, "the DoT is permanent");
});

test("moon0: the Mooncursed DoT actually deals 10 Affliction on a tick", () => {
  const x = fused("x", "moon");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e]);
  emit(state, { type: "counterFired", counterer: "x", caster: "e", skillId: "w" });
  state.turn = 2; // let the DoT (applied turn 1 by team A) tick
  tickDots(state, "A");
  assert.equal(e.hp, 90, "10 Affliction each turn");
});

test("moon0: Mooncursed stuns STRATEGIC skills but not others", () => {
  const x = fused("x", "moon");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eStrategic(), eHarm(6)] });
  const state = makeState([x], [e]);
  fund(state, "B");
  emit(state, { type: "counterFired", counterer: "x", caster: "e", skillId: "w" });
  assert.equal(performAction(state, { unit: "e", skillId: "eStrat", targets: [] }).reason, "stunned", "its Strategic skill is stunned");
  assert.ok(performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] }).ok, "its Harmful skill is unaffected");
});

test("moon0: Mooncursed adds +5 to the enemy's non-affliction damage", () => {
  const x = fused("x", "moon");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eHarm(10)] });
  const state = makeState([x], [e]);
  fund(state, "B");
  emit(state, { type: "counterFired", counterer: "x", caster: "e", skillId: "w" });
  const before = x.hp;
  performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] });
  assert.equal(before - x.hp, 15, "10 base + 5 from Mooncursed");
});

test("moon0 CONTROL: a non-Mooncursed enemy deals only its base damage (no +5)", () => {
  const x = fused("x", "moon");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eHarm(10)] });
  const state = makeState([x], [e]);
  fund(state, "B");
  const before = x.hp;
  performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] });
  assert.equal(before - x.hp, 10, "without Mooncurse the enemy deals its flat 10");
});

test("moon0 CONTROL: an ALLY caught by counterFired is NOT Mooncursed (only enemies)", () => {
  const x = fused("x", "moon");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const state = makeState([x, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "counterFired", counterer: "e", caster: "a", skillId: "w" });
  assert.equal(st(ally, "mark", "Mooncursed"), undefined, "no Mooncurse on an ally");
});

test("moon1 Wild Hunt: all Mooncursed units are Shattered + Isolated 3 turns; allied Mooncursed also get +5 damage", () => {
  const x = fused("x", "moon");
  const curseAlly = makeUnit({ id: "a", team: "A", kind: "hero", statuses: [status("mark", { name: "Mooncursed", duration: null })] });
  const curseFoe = makeUnit({ id: "e", team: "B", kind: "hero", statuses: [status("mark", { name: "Mooncursed", duration: null })] });
  const plainFoe = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([x, curseAlly], [curseFoe, plainFoe]);
  fund(state, "A");

  const r = performAction(state, { unit: "x", skillId: "xyrismoon1", targets: [] });
  assert.ok(r.ok, "Wild Hunt casts");
  for (const u of [curseAlly, curseFoe]) {
    const sh = st(u, "shatter"); const iso = st(u, "isolated");
    assert.ok(sh && sh.duration === 3, `${u.id} Shattered for 3`);
    assert.ok(iso && iso.duration === 3, `${u.id} Isolated for 3`);
  }
  const allyMod = st(curseAlly, "outgoing_damage_mod");
  assert.ok(allyMod && allyMod.magnitude === 5 && allyMod.duration === 3, "the allied Mooncursed gets +5 damage for 3 turns");
  assert.equal(st(curseFoe, "outgoing_damage_mod"), undefined, "an enemy Mooncursed does NOT get the +5 buff");
  assert.equal(st(plainFoe, "shatter"), undefined, "a non-Mooncursed unit is untouched");
});

// ###########################################################################
// # night — "Quiet Nightmare" (passive) + "Spine Chill" (active)
// ###########################################################################

test("night0: Xyris Silences an enemy he damages for 1 turn", () => {
  const x = fused("x", "night");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e]);
  fund(state, "A");
  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // Reveal Hidden Truth -> 15 dmg
  const sil = st(e, "silence");
  assert.ok(sil, "the damaged enemy is Silenced");
  assert.equal(sil!.duration, 1, "for 1 turn");
});

test("night0: the Silence functionally suppresses the enemy's Essence income", () => {
  const x = fused("x", "night");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, currentElement: "water", statuses: [status(ESSENCE)] });
  const state = makeState([x], [e]);
  fund(state, "A");
  state.teams.B.energy = { generic: 0 };
  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // silences e
  grantIncome(state, "B");
  assert.equal(state.teams.B.energy.water ?? 0, 0, "Silenced: essence is NOT converted to element income");
  assert.ok(st(e, ESSENCE), "the essence charge is kept (not consumed) while Silenced");
});

test("night0 CONTROL: an enemy Xyris does NOT damage is not Silenced", () => {
  const x = fused("x", "night");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([x], [e]);
  assert.equal(st(e, "silence"), undefined, "no damage, no Silence");
});

test("night1 Spine Chill: deals 20 to ALL enemies", () => {
  const x = fused("x", "night");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e1, e2]);
  fund(state, "A");
  const r = performAction(state, { unit: "x", skillId: "xyrisnight1", targets: [] });
  assert.ok(r.ok, "Spine Chill casts");
  assert.equal(e1.hp, 80, "enemy 1 took 20");
  assert.equal(e2.hp, 80, "enemy 2 took 20");
});

test("night1 Spine Chill: Paralyzes enemy cooldowns for 1 turn (they do not tick down)", () => {
  const x = fused("x", "night");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eHarm(6)] });
  e.skills![0]!.currentCd = 2; e.skills![0]!.cdSetTurn = 0;
  const state = makeState([x], [e]);
  fund(state, "A");

  performAction(state, { unit: "x", skillId: "xyrisnight1", targets: [] }); // paralyze enemy cooldowns 1 turn
  endTurn(state); // A ends (turn 1 -> 2, active B)
  endTurn(state); // B ends: advanceCooldowns(B) would normally tick e's cooldown
  assert.equal(e.skills![0]!.currentCd, 2, "the enemy's cooldown was frozen this turn (still 2)");
});

test("night1 CONTROL: without the Paralyze an enemy cooldown ticks down normally", () => {
  const x = fused("x", "night");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eHarm(6)] });
  e.skills![0]!.currentCd = 2; e.skills![0]!.cdSetTurn = 0;
  const state = makeState([x], [e]);
  fund(state, "A");
  endTurn(state); // A
  endTurn(state); // B: e's cooldown ticks
  assert.equal(e.skills![0]!.currentCd, 1, "a normal cooldown drops by 1");
});

// ###########################################################################
// # ninja — "Dream Infiltration" (passive) + "Steal Secrets" (active)
// ###########################################################################

test("ninja0: Enter the Dreamscape deals NO damage but hits ALL enemies", () => {
  const x = fused("x", "ninja");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [e1, e2]);
  fund(state, "A");
  emit(state, { type: "roundStart" }); // installs Dream Infiltration rewrite

  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e1"] });
  assert.equal(e1.hp, 100, "no damage (Enter the Dreamscape no longer deals damage)");
  assert.equal(e2.hp, 100, "no damage to the other enemy either");
  assert.ok(st(e1, "stun"), "e1 is affected (Helpful-stun)");
  assert.ok(st(e2, "stun"), "e2 is affected too — it targets all enemies");
});

test("ninja0: Xyris' skills Bypass (pierce) against Dreamscape-affected targets", () => {
  const x = fused("x", "ninja");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, shield: 50, statuses: [dreamMark()] });
  const state = makeState([x], [e]);
  fund(state, "A");
  emit(state, { type: "roundStart" }); // installs the Bypass hook

  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // 15 normal, but Bypass vs affected
  assert.equal(e.hp, 85, "damage bypassed the Shield and hit HP directly (15)");
});

test("ninja0 CONTROL: against a NON-affected target Xyris' damage is absorbed by Shield", () => {
  const x = fused("x", "ninja");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, shield: 50 }); // no affected-mark
  const state = makeState([x], [e]);
  fund(state, "A");
  emit(state, { type: "roundStart" });
  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  assert.equal(e.hp, 100, "no Bypass -> the Shield eats the 15, HP untouched");
});

test("ninja1 Steal Secrets: on a Dreamscape-affected enemy that has used a skill, summons a Dream Reflection copying its last skill", () => {
  const x = fused("x", "ninja");
  const foe = makeUnit({
    id: "e", team: "B", kind: "hero", currentElement: "water", statuses: [dreamMark()],
    skills: [skill("efire", [{ op: "damage", amount: 11, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"], element: "water", cost: { generic: 0, specific: 1 } })],
  });
  const state = makeState([x], [foe]);
  fund(state, "A"); fund(state, "B");
  performAction(state, { unit: "e", skillId: "efire", targets: ["x"] }); // the enemy uses a skill (its "last")
  assert.equal(teamMinions(state, "A").length, 0, "no minion before Steal Secrets");

  const r = performAction(state, { unit: "x", skillId: "xyrisninja1", targets: ["e"] });
  assert.ok(r.ok, "Steal Secrets casts");
  const refl = teamMinions(state, "A")[0]!;
  assert.equal(refl.name, "Dream Reflection", "a Dream Reflection was summoned");
  assert.ok((refl.skills ?? []).some((s) => s.id === "efire"), "it carries a copy of the enemy's last-used skill");
});

test("ninja1 Steal Secrets: the Dream Reflection copies the enemy's LAST-used skill (not an earlier one)", () => {
  const x = fused("x", "ninja");
  const foe = makeUnit({
    id: "e", team: "B", kind: "hero", currentElement: "water", statuses: [dreamMark()],
    skills: [
      skill("skA", [{ op: "damage", amount: 5, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"], element: "water" }),
      skill("skB", [{ op: "damage", amount: 9, dtype: "normal", to: "target" } as Effect], { tags: ["Harmful", "Instant"], element: "water" }),
    ],
  });
  const state = makeState([x], [foe]);
  fund(state, "A"); fund(state, "B");
  performAction(state, { unit: "e", skillId: "skA", targets: ["x"] });
  performAction(state, { unit: "e", skillId: "skB", targets: ["x"] }); // last-used = skB
  performAction(state, { unit: "x", skillId: "xyrisninja1", targets: ["e"] });

  const refl = teamMinions(state, "A")[0]!;
  const ids = (refl.skills ?? []).map((s) => s.id);
  assert.ok(ids.includes("skB"), "carries the LAST-used skill (skB)");
  assert.equal(ids.includes("skA"), false, "does not carry the earlier skA");
});

test("ninja1 CONTROL: Steal Secrets fails (no minion) if the affected enemy has NOT used a skill", () => {
  const x = fused("x", "ninja");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", statuses: [dreamMark()], skills: [eHarm(6)] });
  const state = makeState([x], [foe]);
  fund(state, "A");
  performAction(state, { unit: "x", skillId: "xyrisninja1", targets: ["e"] });
  assert.equal(teamMinions(state, "A").length, 0, "no Dream Reflection — the target never used a skill");
});

test("ninja1 CONTROL: Steal Secrets does nothing on an enemy NOT affected by Enter the Dreamscape", () => {
  const x = fused("x", "ninja");
  const foe = makeUnit({
    id: "e", team: "B", kind: "hero", skills: [eHarm(6)], // no affected-mark
  });
  const state = makeState([x], [foe]);
  fund(state, "A"); fund(state, "B");
  performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] }); // enemy has a last-used skill
  performAction(state, { unit: "x", skillId: "xyrisninja1", targets: ["e"] });
  assert.equal(teamMinions(state, "A").length, 0, "no minion — the target is not Dreamscape-affected");
});

// ###########################################################################
// # ritual — "Shadow Court Ritual" (passive) + "Heartfire" (active)
// ###########################################################################

test("ritual0: each Elemental Essence gain grants Xyris 5 Ritual Power", () => {
  const x = fused("x", "ritual");
  const state = makeState([x], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.equal(st(x, "stack", "Ritual Power"), undefined, "no Ritual Power yet");
  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: ESSENCE });
  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: ESSENCE });
  assert.equal(st(x, "stack", "Ritual Power")!.magnitude, 10, "2 essence gains -> 10 Ritual Power");
});

test("ritual0: reaching 75 Ritual Power reduces EVERY unit's cooldowns by 1, once", () => {
  const x = fused("x", "ritual");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eHarm(6)] });
  const state = makeState([x], [e]);
  x.skills!.find((s) => s.id === "xyris1")!.currentCd = 3;
  e.skills![0]!.currentCd = 3;

  for (let i = 0; i < 14; i++) emit(state, { type: "statusApplied", unit: "x", source: "x", kind: ESSENCE }); // 70
  assert.equal(st(x, "stack", "Ritual Power")!.magnitude, 70, "70 Ritual Power");
  assert.equal(x.skills!.find((s) => s.id === "xyris1")!.currentCd, 3, "below the threshold: no reduction yet");

  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: ESSENCE }); // 75 -> fires
  assert.equal(st(x, "stack", "Ritual Power")!.magnitude, 75, "75 Ritual Power");
  assert.equal(x.skills!.find((s) => s.id === "xyris1")!.currentCd, 2, "Xyris' cooldown dropped by 1");
  assert.equal(e.skills![0]!.currentCd, 2, "the enemy's cooldown dropped by 1 too (all units)");

  x.skills!.find((s) => s.id === "xyris1")!.currentCd = 3;
  emit(state, { type: "statusApplied", unit: "x", source: "x", kind: ESSENCE }); // 80 -> must NOT re-fire
  assert.equal(x.skills!.find((s) => s.id === "xyris1")!.currentCd, 3, "the threshold reward fires only once");
});

test("ritual1 Heartfire: 20 Affliction to the target; Xyris and the target both gain Elemental Essence", () => {
  const x = fused("x", "ritual");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [foe]);
  fund(state, "A");
  const xE = essenceCount(x);
  const r = performAction(state, { unit: "x", skillId: "xyrisritual1", targets: ["e"] });
  assert.ok(r.ok, "Heartfire casts");
  assert.equal(foe.hp, 80, "target receives 20 Affliction");
  assert.ok(essenceCount(x) - xE >= 1, "Xyris gains Elemental Essence");
  assert.ok(essenceCount(foe) >= 1, "the target gains Elemental Essence");
});

// ###########################################################################
// # vigilante — "Dreams of Power" (passive) + "Sacred Severing" (active)
// ###########################################################################

test("vigilante0: Xyris deals 5 MORE to an essence-holding enemy and gains Essence when he does", () => {
  const x = fused("x", "vigilante");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status(ESSENCE)] });
  const state = makeState([x], [e]);
  fund(state, "A");
  const xE = essenceCount(x);
  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // Reveal Hidden Truth: 15 base
  assert.equal(e.hp, 80, "15 base + 5 bonus vs an essence enemy = 20");
  assert.equal(essenceCount(x) - xE, 1, "Xyris gains Elemental Essence for a Harmful hit on an essence enemy");
});

test("vigilante0 CONTROL: against an enemy WITHOUT Essence there is no bonus and no Essence gain", () => {
  const x = fused("x", "vigilante");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // no essence
  const state = makeState([x], [e]);
  fund(state, "A");
  const xE = essenceCount(x);
  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  assert.equal(e.hp, 85, "no bonus -> flat 15");
  assert.equal(essenceCount(x) - xE, 0, "no Essence gained (target had none)");
});

test("vigilante1 Sacred Severing: 30 damage, cancels a channel, and Silences for 2 turns", () => {
  const x = fused("x", "vigilante");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("channeling", { name: "bigcast" })] });
  const state = makeState([x], [foe]);
  fund(state, "A");
  const r = performAction(state, { unit: "x", skillId: "xyrisvigilante1", targets: ["e"] });
  assert.ok(r.ok, "Sacred Severing casts");
  assert.equal(foe.hp, 70, "deals 30");
  assert.equal(st(foe, "channeling"), undefined, "the cancellable skill they were using is cancelled");
  const sil = st(foe, "silence");
  assert.ok(sil && sil.duration === 2, "Silenced for 2 turns");
});

test("vigilante1 CONTROL: with no channel to cancel, Sacred Severing still deals 30 and Silences", () => {
  const x = fused("x", "vigilante");
  const foe = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([x], [foe]);
  fund(state, "A");
  performAction(state, { unit: "x", skillId: "xyrisvigilante1", targets: ["e"] });
  assert.equal(foe.hp, 70, "30 damage regardless");
  assert.ok(st(foe, "silence"), "still Silenced");
});
