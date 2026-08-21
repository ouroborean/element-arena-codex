import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts"; // side-effect: registers custom handlers via hero.ts
import { fusionForm, FUSIONS } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED suite for ARAMAO's FUSION FORM.
//
// IMPORTANT STRUCTURAL FACT (spec-derived, from content/frozen/characters.json):
//   Aramao, Spectre of the Sands is authored with  "starts_fused": true,
//   "can_fuse": false,  "fusion_skills": {},  element = "nomad".  Exactly like
//   Dennis, Aramao has NO menu of ~7 elemental fusion variants; he is PERMANENTLY
//   fused in a single Nomad form. That one form's passive + active skills ARE his
//   fusion kit:
//     - fusion passive : aramao0  "Dune Stalker"
//     - fusion actives : aramao1 .. aramao6
//   (The generated FUSIONS table therefore contains ZERO "aramao" forms — the
//   "nomad" fusion KEY that exists there is other heroes fusing INTO Aramao's
//   element, not Aramao's own form.)
//
// Section 0 pins that spec fact as an executable guard. Sections 1..7 then treat
// Aramao's single permanent Nomad form as THE fusion form and verify its passive +
// every active against the FROZEN prose (content/frozen/skills.json), the sole
// oracle. Authored/roster content is consulted ONLY for how to drive (ids, costs,
// element, status names), never for what to assert.
//
// Frozen text under test (verbatim from content/frozen/skills.json):
//  aramao0 Dune Stalker (passive): "Aramao deals 5 more damage to the enemy Hero
//    directly across from him, and he gains Elemental Essence whenever he damages
//    them."
//  aramao1 Desert Knife: "Deals 10 Piercing damage to target enemy. If used on an
//    enemy Hero that isn't directly across from Aramao, he will swap positions with
//    the ally that is. Using this skill does not break Veiled."
//  aramao2 Sand Quake: "Deals 10 Piercing damage to all enemies and extends the
//    duration of all Veiled effects by 2 turns. Using this skill does not break
//    Veiled."
//  aramao3 Mirage Trap: "Aramao targets an enemy Hero for 1 turn. If they are
//    directly across from Aramao, he will counter the first non-Strategic skill they
//    use. If they are not, he will counter the first Strategic skill they use."
//  aramao4 Desert Veil: "Targets an allied Hero or Aramao. If targeting Aramao,
//    applies Veiled to Aramao and a random allied Hero for 2 turns. If targeting an
//    ally, applies Veiled to them and Aramao for 2 turns and swaps their positions."
//  aramao5 Heart of the Desert: "If there is only one Hero adjacent to Aramao, heal
//    that Hero and Aramao for 15 HP. If there are two Heroes adjacent to Aramao, heal
//    them both for 15 HP. This effect Bypasses."
//  aramao6 Trial of the Sands: "For 3 turns, all allied Heroes are Veiled at the end
//    of each turn. During this time, Aramao will use Desert Knife on any enemy that
//    uses a Harmful skill on him. After being used, Aramao's team randomly swaps
//    places once."
//
// GEOMETRY (game facts, used ONLY to set up the board):
//   * formation slots run 0,1,2; makeState assigns them in listed order per side.
//   * "directly across" = the living enemy Hero in the SAME slot as Aramao.
//   * "adjacent"        = a living ally Hero whose slot differs from Aramao's by 1.
//   Aramao's element is "nomad": specific costs are paid from the nomad pool.
// =============================================================================

// ---- status/skill readers (names/kinds learned from authored content = how to OBSERVE) ----
const has = (u: Unit, kind: string, name?: string): boolean =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const veiledOf = (u: Unit) => u.statuses.find((s) => s.kind === "veiled");
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const skillOf = (u: Unit, id: string): SkillInstance => (u.skills ?? []).find((s) => s.id === id)!;

function fund(state: MatchState): void {
  state.teams.A.energy = { generic: 40, nomad: 40 };
  state.teams.B.energy = { generic: 40, nomad: 40 };
}

// A plain enemy Hero carrying a non-Strategic Harmful attack ("ek": 10 normal to its target)
// and a Strategic skill ("es": marks itself so we can see whether it resolved), both off cooldown.
function enemyWith(id: string): Unit {
  const attack = skill("ek", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], {
    name: "Enemy Knife", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  });
  const strat = skill("es", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "esRan", duration: null } }], {
    name: "Enemy Scheme", tags: ["Strategic", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  });
  return makeUnit({ id, team: "B", hp: 100, maxHp: 100, skills: [attack, strat] });
}

// =============================================================================
// Section 0 — SPEC GUARD: Aramao is permanently fused and has NO elemental forms.
// Oracle: frozen characters.json (starts_fused:true, can_fuse:false, fusion_skills:{}).
// The engine's generated fusion table must therefore expose ZERO "aramao" forms.
// =============================================================================
test("aramao SPEC: the frozen roster marks Aramao permanently fused / non-fusing (Nomad form)", () => {
  const chars = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../content/frozen/characters.json", import.meta.url)), "utf8"),
  ) as any;
  const arr: any[] = Array.isArray(chars) ? chars : Object.values(chars);
  const ar = arr.find((c) => c.id === "aramao");
  assert.ok(ar, "Aramao is in the frozen roster");
  assert.equal(ar.starts_fused, true, "frozen: Aramao starts fused");
  assert.equal(ar.can_fuse, false, "frozen: Aramao cannot fuse into other elements");
  assert.equal(ar.element.name, "nomad", "frozen: Aramao's permanent form is the Nomad element");
  assert.deepEqual(ar.fusion_skills, {}, "frozen: Aramao has no menu of elemental fusion variants");
});

test("aramao SPEC: no elemental fusion FORMS exist for Aramao (can_fuse:false is honored by the engine)", () => {
  const aramaoForms = FUSIONS.filter((f) => f.hero === "aramao");
  assert.equal(aramaoForms.length, 0, "the generated fusion table contains no Aramao forms");
  const allKeys = [...new Set(FUSIONS.map((f) => f.key))];
  assert.ok(allKeys.includes("nomad"), "the 'nomad' key exists (other heroes fuse INTO Aramao's element)");
  for (const key of allKeys) {
    assert.equal(fusionForm("aramao", key), undefined, `Aramao must have no '${key}' fusion form`);
  }
});

// =============================================================================
// Section 1 — FUSION PASSIVE: aramao0 "Dune Stalker"
//   "Aramao deals 5 more damage to the enemy Hero directly across from him, and he
//    gains Elemental Essence whenever he damages them."
// =============================================================================

test("aramao0: +5 to the enemy directly across (10 Piercing Knife -> 15) AND he gains Elemental Essence", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");            // slot 0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0 = across
  const state = makeState([aramao], [e0], 1);
  fund(state);
  assert.equal(essenceCount(aramao), 0, "no essence before he damages the across enemy");
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 85, "the across enemy takes 10 Piercing + Dune Stalker 5 = 15");
  assert.equal(essenceCount(aramao), 1, "gains one Elemental Essence for damaging the across enemy");
});

test("aramao0 CONTROL: a NON-across enemy takes no +5 and grants no Essence", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");            // slot 0, across = e0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 }); // slot 1 (not across)
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 90, "a non-across enemy takes only the base 10 (no Dune Stalker +5)");
  assert.equal(essenceCount(aramao), 0, "no Elemental Essence for damaging a non-across enemy");
});

// SUSPECTED BUG: frozen aramao0 grants Essence "whenever he damages them" — a per-hit,
// uncapped gain (the designers add explicit "once per turn"/"may only grant once" caps on
// OTHER essence sources precisely because the default is repeatable), and Elemental Essence
// is a countable resource (Hector "consumes 3 Elemental Essence"). Two same-turn Desert
// Knives on the across enemy should therefore leave Aramao holding 2 Essence. The engine
// models elemental_essence as a single non-stacking flag (verified: 3 real hits -> exactly
// one elemental_essence status, no magnitude), so the second gain is silently dropped and
// essenceCount stays 1. Under-delivers Aramao's essence economy vs the frozen prose.
test.skip("SUSPECTED BUG: aramao0 grants Essence per hit (whenever) but engine caps essence at 1 (non-stacking status)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");            // slot 0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 200, maxHp: 200 }); // slot 0 = across, fat enough to survive twice
  const state = makeState([aramao], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(essenceCount(aramao), 1, "first hit -> 1 Essence");
  performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] }); // Desert Knife has cd 0
  assert.equal(essenceCount(aramao), 2, "second hit on the across enemy -> a second Essence (whenever he damages them)");
  assert.equal(e0.hp, 170, "both Knives landed for 15 (10 Piercing + 5)");
});

test("aramao0 CONTROL: the +5 and Essence are ARAMAO's alone — an ALLY hitting his across enemy gets neither", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");            // slot 0, across = e0
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 }); // slot 1
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });   // slot 0 = across from Aramao
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });   // slot 1
  (ally.skills ??= []).push(skill("alk", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], {
    element: "nomad", name: "Ally Knife", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  }));
  const state = makeState([aramao, ally], [e0, e1], 1);
  fund(state);
  const r = performAction(state, { unit: "al", skillId: "alk", targets: ["e0"] }); // ally hits Aramao's across enemy
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 90, "the ally's hit on the across enemy is the flat 10 — the +5 belongs to Aramao only");
  assert.equal(essenceCount(aramao), 0, "Aramao gains no Essence off an ally's damage");
});

// =============================================================================
// Section 2 — aramao1 "Desert Knife"
// =============================================================================

test("aramao1: 10 PIERCING to target (Piercing ignores Damage Reduction; control: normal is reduced)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");            // slot 0, across = e0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0 (across; avoided as target)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, statuses: [
    { kind: "damage_reduction", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 },
  ] }); // slot 1
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  (aramao.skills ??= []).push(skill("ctlN", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], {
    element: "nomad", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  }));
  const rNorm = performAction(state, { unit: "ar", skillId: "ctlN", targets: ["e1"] });
  assert.equal(rNorm.ok, true);
  assert.equal(e1.hp, 95, "control: a normal 10 hit is reduced by DR 5 -> only 5 lands");
  const rPierce = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(rPierce.ok, true);
  assert.equal(e1.hp, 85, "Desert Knife is Piercing: DR ignored, the full 10 lands");
});

test("aramao1: costs 1 generic, cooldown 0", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(state.teams.A.energy.generic, 39, "1 generic paid");
  assert.equal(state.teams.A.energy.nomad, 40, "no specific (nomad) paid");
  assert.equal(skillOf(aramao, "aramao1").currentCd, 0, "Desert Knife has no cooldown");
});

test("aramao1: on a NON-across enemy, Aramao swaps with the ally across from that target (target takes base 10, no Essence)", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 }); // slot 0 (across from e0)
  const aramao = loadHero(heroById("aramao"), "A", "ar");             // slot 1 (across from e1)
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });  // slot 0
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });  // slot 1
  const state = makeState([ally, aramao], [e0, e1], 1);
  fund(state);
  assert.equal(aramao.slot, 1);
  assert.equal(ally.slot, 0);
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] }); // e0 NOT across from Aramao
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 90, "e0 was not across at damage time -> base 10 only, no +5");
  assert.equal(essenceCount(aramao), 0, "no Essence: the target was not the across enemy");
  assert.equal(aramao.slot, 0, "Aramao swaps into the slot of the ally who was across from the target");
  assert.equal(ally.slot, 1, "that ally takes Aramao's old slot");
});

test("aramao1 CONTROL: on the enemy already directly across, NO swap (and the across enemy still eats +5)", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 }); // slot 0
  const aramao = loadHero(heroById("aramao"), "A", "ar");             // slot 1 = across from e1
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });  // slot 0
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });  // slot 1 (across)
  const state = makeState([ally, aramao], [e0, e1], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] }); // e1 IS across
  assert.equal(r.ok, true);
  assert.equal(aramao.slot, 1, "no swap when the target is already directly across");
  assert.equal(ally.slot, 0, "the ally stays put too");
  assert.equal(e1.hp, 85, "the across enemy eats 10 Piercing + Dune Stalker 5 = 15");
});

test("aramao1: using Desert Knife does NOT break Veiled (control: a plain Harmful cast DOES)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao], [e0], 1);
  fund(state);
  (aramao.skills ??= []).push(skill("ctlH", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], {
    element: "nomad", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  }));
  aramao.statuses.push({ kind: "veiled", duration: 2, appliedBy: "ar", appliedTurn: 0 });
  performAction(state, { unit: "ar", skillId: "ctlH", targets: ["e0"] });
  assert.equal(has(aramao, "veiled"), false, "control: a normal Harmful cast strips the caster's Veiled");
  aramao.statuses.push({ kind: "veiled", duration: 2, appliedBy: "ar", appliedTurn: 0 });
  performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(has(aramao, "veiled"), true, "Desert Knife does NOT break Veiled");
});

// =============================================================================
// Section 3 — aramao2 "Sand Quake"
// =============================================================================

test("aramao2: 10 Piercing to ALL enemies (across enemy also eats +5 and grants Essence); costs 2 generic, cd 2", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");            // slot 0, across = e0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 }); // slot 1
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 }); // slot 2
  const state = makeState([aramao], [e0, e1, e2], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao2", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 85, "the across enemy takes 10 + Dune Stalker 5 = 15");
  assert.equal(e1.hp, 90, "a non-across enemy takes the flat 10");
  assert.equal(e2.hp, 90, "every enemy is hit for 10");
  assert.equal(essenceCount(aramao), 1, "damaging the across enemy grants Essence here too");
  assert.equal(state.teams.A.energy.generic, 38, "Sand Quake costs 2 generic");
  assert.equal(skillOf(aramao, "aramao2").currentCd, 2, "Sand Quake has a 2-turn cooldown");
});

test("aramao2: 10 PIERCING ignores enemy Damage Reduction (control: a normal AoE would be reduced)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");           // slot 0, across = e0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0 (across; excluded from the DR check)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, statuses: [
    { kind: "damage_reduction", magnitude: 4, duration: null, appliedBy: "x", appliedTurn: 0 },
  ] }); // slot 1
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao2", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 90, "Piercing ignores DR 4 -> the full 10 lands on the DR enemy");
});

test("aramao2: extends ALL Veiled durations by 2 (self, ally AND enemy); non-Veiled untouched; own Veiled not broken", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100, statuses: [
    { kind: "veiled", duration: 2, appliedBy: "ar", appliedTurn: 0 },
    { kind: "mark", name: "ctlMark", duration: 2, appliedBy: "ar", appliedTurn: 0 }, // control: not a Veil
  ] }); // slot 1
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0, across = e0
  aramao.statuses.push({ kind: "veiled", duration: 3, appliedBy: "ar", appliedTurn: 0 });
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100, statuses: [
    { kind: "veiled", duration: 1, appliedBy: "e0", appliedTurn: 0 },
  ] });
  const state = makeState([aramao, ally], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao2", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(veiledOf(ally)!.duration, 4, "ally's Veiled 2 -> 4");
  assert.equal(veiledOf(aramao)!.duration, 5, "Aramao's own Veiled 3 -> 5");
  assert.equal(veiledOf(e0)!.duration, 3, "an enemy's Veiled 1 -> 3 (ALL Veiled effects, both teams)");
  assert.equal(has(aramao, "veiled"), true, "Sand Quake does not break Aramao's Veiled");
  assert.equal(ally.statuses.find((s) => s.kind === "mark" && s.name === "ctlMark")!.duration, 2, "a non-Veiled status is untouched");
});

test("aramao2 CONTROL: on a board with NO Veiled effects, nothing gains a Veil", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const al = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 });
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao, al], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao2", targets: [] });
  assert.equal(has(aramao, "veiled"), false, "Sand Quake does not CREATE Veiled where there was none");
  assert.equal(has(al, "veiled"), false, "ally gains no Veil");
  assert.equal(has(e0, "veiled"), false, "enemy gains no Veil");
});

// =============================================================================
// Section 4 — aramao3 "Mirage Trap"
// =============================================================================

test("aramao3: target ACROSS -> counters their first NON-Strategic skill only; a Strategic skill is NOT countered", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0, across = e0
  const e0 = enemyWith("e0");                             // slot 0 (across)
  const state = makeState([aramao], [e0], 1);
  fund(state);
  const cast = performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e0"] });
  assert.equal(cast.ok, true);
  assert.equal(state.teams.A.energy.nomad, 39, "Mirage Trap costs 1 specific (nomad)");
  assert.equal(state.teams.A.energy.generic, 40, "no generic paid");
  assert.equal(skillOf(aramao, "aramao3").currentCd, 2, "Mirage Trap has a 2-turn cooldown");

  const strat = performAction(state, { unit: "e0", skillId: "es", targets: ["e0"] });
  assert.equal(strat.ok, true);
  assert.notEqual(strat.countered, true, "a Strategic skill is NOT countered in the across case");
  assert.equal(has(e0, "mark", "esRan"), true, "the Strategic skill actually resolved");

  const hp = aramao.hp;
  const first = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // first NON-Strategic
  assert.equal(first.countered, true, "the first non-Strategic skill is countered");
  assert.equal(aramao.hp, hp, "the countered attack deals no damage");

  const second = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // second NON-Strategic
  assert.notEqual(second.countered, true, "only the FIRST non-Strategic skill is countered");
  assert.equal(aramao.hp, hp - 10, "the second attack lands for its 10");
});

test("aramao3: target NOT across -> counters their first STRATEGIC skill only; a non-Strategic skill is NOT countered", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0, across = e0
  const e0 = enemyWith("e0");                             // slot 0 (across)
  const e1 = enemyWith("e1");                             // slot 1 (NOT across)
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  const cast = performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e1"] }); // trap the NON-across enemy
  assert.equal(cast.ok, true);

  const hp = aramao.hp;
  const nonStrat = performAction(state, { unit: "e1", skillId: "ek", targets: ["ar"] }); // non-Strategic
  assert.notEqual(nonStrat.countered, true, "a non-Strategic skill is NOT countered in the not-across case");
  assert.equal(aramao.hp, hp - 10, "the non-Strategic attack lands");

  const first = performAction(state, { unit: "e1", skillId: "es", targets: ["e1"] }); // first Strategic
  assert.equal(first.countered, true, "the first Strategic skill is countered");
  assert.equal(has(e1, "mark", "esRan"), false, "the countered Strategic skill did not resolve");

  const second = performAction(state, { unit: "e1", skillId: "es", targets: ["e1"] }); // second Strategic
  assert.notEqual(second.countered, true, "only the FIRST Strategic skill is countered");
  assert.equal(has(e1, "mark", "esRan"), true, "the second Strategic skill resolves");
});

test("aramao3 CONTROL: an un-trapped enemy is never countered", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = enemyWith("e0");
  const state = makeState([aramao], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // no trap cast at all
  assert.notEqual(r.countered, true, "without a trap, nothing is countered");
  assert.equal(aramao.hp, 90, "the attack lands normally");
});

test("aramao3 CONTROL: the trap watches only the TRAPPED enemy — a different enemy's matching skill is not countered", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0, across = e0
  const e0 = enemyWith("e0");                             // slot 0 (across = trapped for non-Strategic)
  const e1 = enemyWith("e1");                             // slot 1 (untrapped)
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e0"] }); // trap e0 only
  const hp = aramao.hp;
  const other = performAction(state, { unit: "e1", skillId: "ek", targets: ["ar"] }); // e1's non-Strategic
  assert.notEqual(other.countered, true, "the untrapped enemy is not countered");
  assert.equal(aramao.hp, hp - 10, "e1's attack lands");
});

// =============================================================================
// Section 5 — aramao4 "Desert Veil"
// =============================================================================

test("aramao4: targeting Aramao -> Veils Aramao and exactly ONE random OTHER ally for 2 turns; no swap", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 }); // slot 1
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 }); // slot 2
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao, al1, al2], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao4", targets: ["ar"] });
  assert.equal(r.ok, true);
  assert.equal(has(aramao, "veiled"), true, "Aramao is Veiled");
  assert.equal(veiledOf(aramao)!.duration, 2, "for 2 turns");
  const others = [al1, al2].filter((u) => has(u, "veiled"));
  assert.equal(others.length, 1, "exactly ONE other allied Hero is Veiled (random)");
  assert.equal(veiledOf(others[0]!)!.duration, 2, "the random ally's Veil is 2 turns");
  assert.equal(aramao.slot, 0, "no position swap in the self-target branch");
  assert.equal(al1.slot, 1, "allies keep their slots in the self-target branch");
  assert.equal(al2.slot, 2);
  assert.equal(state.teams.A.energy.nomad, 39, "Desert Veil costs 1 specific (nomad)");
  assert.equal(skillOf(aramao, "aramao4").currentCd, 1, "cooldown 1");
});

test("aramao4: targeting an ally -> Veils that ally AND Aramao for 2, swaps their positions, leaves other allies alone", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 }); // slot 1 (the target)
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 }); // slot 2 (bystander)
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao, al1, al2], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao4", targets: ["al1"] });
  assert.equal(r.ok, true);
  assert.equal(has(al1, "veiled"), true, "the targeted ally is Veiled");
  assert.equal(has(aramao, "veiled"), true, "Aramao is Veiled");
  assert.equal(veiledOf(al1)!.duration, 2, "ally Veil 2 turns");
  assert.equal(veiledOf(aramao)!.duration, 2, "Aramao Veil 2 turns");
  assert.equal(aramao.slot, 1, "Aramao and the targeted ally swap positions");
  assert.equal(al1.slot, 0, "the ally takes Aramao's old slot");
  assert.equal(has(al2, "veiled"), false, "a non-targeted ally is NOT Veiled");
  assert.equal(al2.slot, 2, "the bystander ally does not move");
});

// =============================================================================
// Section 6 — aramao5 "Heart of the Desert"
// =============================================================================

test("aramao5: exactly ONE Hero adjacent -> heals that Hero AND Aramao for 15; a non-adjacent ally is not healed", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0
  const adj = makeUnit({ id: "adj", team: "A", hp: 50, maxHp: 100 }); // slot 1 (adjacent to slot 0)
  const far = makeUnit({ id: "far", team: "A", hp: 50, maxHp: 100 }); // slot 2 (NOT adjacent to slot 0)
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  aramao.hp = 50;
  const state = makeState([aramao, adj, far], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao5", targets: ["ar"] });
  assert.equal(r.ok, true);
  assert.equal(adj.hp, 65, "the single adjacent Hero is healed 15");
  assert.equal(aramao.hp, 65, "Aramao is ALSO healed 15 when exactly one Hero is adjacent");
  assert.equal(far.hp, 50, "a non-adjacent ally is not healed");
  assert.equal(state.teams.A.energy.generic, 39, "costs 1 generic");
  assert.equal(skillOf(aramao, "aramao5").currentCd, 1, "cooldown 1");
});

test("aramao5: TWO Heroes adjacent -> heals both for 15, but NOT Aramao", () => {
  const left = makeUnit({ id: "left", team: "A", hp: 50, maxHp: 100 });  // slot 0
  const aramao = loadHero(heroById("aramao"), "A", "ar");                // slot 1 (both neighbours adjacent)
  const right = makeUnit({ id: "right", team: "A", hp: 50, maxHp: 100 }); // slot 2
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  aramao.hp = 50;
  const state = makeState([left, aramao, right], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao5", targets: ["ar"] });
  assert.equal(r.ok, true);
  assert.equal(left.hp, 65, "left neighbour healed 15");
  assert.equal(right.hp, 65, "right neighbour healed 15");
  assert.equal(aramao.hp, 50, "Aramao is NOT healed when two Heroes are adjacent");
});

test("aramao5: healing is capped at maxHp (a 15 heal cannot overheal)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0
  const adj = makeUnit({ id: "adj", team: "A", hp: 95, maxHp: 100 }); // slot 1, near full
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  aramao.hp = 90;
  const state = makeState([aramao, adj], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao5", targets: ["ar"] });
  assert.equal(adj.hp, 100, "adjacent ally 95 + 15 clamped to 100 maxHp");
  assert.equal(aramao.hp, 100, "Aramao 90 + 15 clamped to 100 maxHp");
});

// =============================================================================
// Section 7 — aramao6 "Trial of the Sands"
// =============================================================================

test("aramao6: Veils ALL allied Heroes at the END of the turn (not on cast); enemies are never Veiled by it; costs 2 generic, cd 4", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 });
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 });
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao, al1, al2], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(has(aramao, "veiled") || has(al1, "veiled") || has(al2, "veiled"), false,
    "casting Trial does NOT Veil anyone immediately");
  assert.equal(state.teams.A.energy.generic, 38, "Trial costs 2 generic");
  assert.equal(skillOf(aramao, "aramao6").currentCd, 4, "cooldown 4");
  endTurn(state); // team A's turn end -> the re-veil window fires
  assert.equal(has(aramao, "veiled"), true, "Aramao is Veiled at turn end");
  assert.equal(has(al1, "veiled"), true, "ally 1 is Veiled at turn end");
  assert.equal(has(al2, "veiled"), true, "ally 2 is Veiled at turn end");
  assert.equal(has(e0, "veiled"), false, "the enemy is NOT Veiled by Trial");
});

test("aramao6: while active, an enemy using a Harmful skill on Aramao is hit back by Desert Knife (10 Piercing + across 5); Essence gained", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // solo -> the team shuffle is a no-op, keeps slot 0
  const e0 = enemyWith("e0");                             // slot 0 = across from Aramao
  const state = makeState([aramao], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  assert.equal(aramao.slot, 0, "a one-hero team shuffle leaves Aramao in place");
  const r = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // enemy Harmful on Aramao
  assert.equal(r.ok, true);
  assert.equal(aramao.hp, 90, "the enemy's attack lands for 10");
  assert.equal(e0.hp, 85, "Aramao retaliates with Desert Knife: 10 Piercing + Dune Stalker 5 (across) = 15");
  assert.equal(essenceCount(aramao) >= 1, true, "the retaliation Knife damages the across enemy, granting Essence");
});

test("aramao6: the retaliation is single-target on the PROVOKER — a bystander enemy is not hit", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // solo -> shuffle no-op, slot 0, across = e0
  const e0 = enemyWith("e0");                             // slot 0 (across = the attacker)
  const e1 = enemyWith("e1");                             // slot 1 (bystander, does nothing)
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // only e0 attacks
  assert.equal(e0.hp, 85, "the attacker is struck by the retaliation Desert Knife (15)");
  assert.equal(e1.hp, 100, "the bystander enemy is untouched (retaliation is not AoE)");
});

test("aramao6 CONTROL: without Trial active, no Desert Knife retaliation occurs", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = enemyWith("e0");
  const state = makeState([aramao], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // no Trial beforehand
  assert.equal(r.ok, true);
  assert.equal(aramao.hp, 90, "the enemy attack lands");
  assert.equal(e0.hp, 100, "no retaliation without the Trial window");
});

test("aramao6 CONTROL: while active, a NON-Harmful enemy skill draws no retaliation", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // solo
  const e0 = enemyWith("e0");
  const state = makeState([aramao], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  const r = performAction(state, { unit: "e0", skillId: "es", targets: ["ar"] }); // Strategic (non-Harmful) on Aramao
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 100, "a non-Harmful skill on Aramao provokes no Desert Knife");
});

test("aramao6: after being used, Aramao's team randomly swaps places once (slots stay a valid permutation of 0,1,2)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 }); // slot 1
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 }); // slot 2
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao, al1, al2], [e0], 7);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  assert.equal(r.ok, true);
  const slots = [aramao.slot, al1.slot, al2.slot].slice().sort((a, b) => (a! - b!));
  assert.deepEqual(slots, [0, 1, 2], "the three heroes still occupy slots 0,1,2 exactly (a permutation)");
});
