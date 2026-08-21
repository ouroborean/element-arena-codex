import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts"; // side-effect: pulls in custom-handler registration via hero.ts
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// ===========================================================================
// Adversarial, SPEC-DERIVED behavioural suite for Aramao, Spectre of the Sands
// — his entire BASE kit. Every assertion is anchored to the FROZEN prose (the
// oracle in content/frozen/skills.json), never to the implementation.
//
//   aramao0 "Dune Stalker" (passive): "Aramao deals 5 more damage to the enemy
//        Hero directly across from him, and he gains Elemental Essence whenever
//        he damages them."
//   aramao1 "Desert Knife": "Deals 10 Piercing damage to target enemy. If used
//        on an enemy Hero that isn't directly across from Aramao, he will swap
//        positions with the ally that is. Using this skill does not break Veiled."
//   aramao2 "Sand Quake": "Deals 10 Piercing damage to all enemies and extends
//        the duration of all Veiled effects by 2 turns. Using this skill does
//        not break Veiled."
//   aramao3 "Mirage Trap": "Aramao targets an enemy Hero for 1 turn. If they are
//        directly across from Aramao, he will counter the first non-Strategic
//        skill they use. If they are not, he will counter the first Strategic
//        skill they use."
//   aramao4 "Desert Veil": "Targets an allied Hero or Aramao. If targeting
//        Aramao, applies Veiled to Aramao and a random allied Hero for 2 turns.
//        If targeting an ally, applies Veiled to them and Aramao for 2 turns and
//        swaps their positions."
//   aramao5 "Heart of the Desert": "If there is only one Hero adjacent to
//        Aramao, heal that Hero and Aramao for 15 HP. If there are two Heroes
//        adjacent to Aramao, heal them both for 15 HP. This effect Bypasses."
//   aramao6 "Trial of the Sands": "For 3 turns, all allied Heroes are Veiled at
//        the end of each turn. During this time, Aramao will use Desert Knife on
//        any enemy that uses a Harmful skill on him. After being used, Aramao's
//        team randomly swaps places once."
//
// GEOMETRY (game facts, used only to set up the board):
//   * formation slots run 0,1,2; makeState assigns them in listed order per side.
//   * "directly across" = the living enemy Hero in the SAME slot as Aramao.
//   * "adjacent" = a living ally Hero whose slot differs from Aramao's by 1.
// Aramao's element is "nomad": specific costs are paid from the nomad pool.
// ===========================================================================

const has = (u: Unit, kind: string, name?: string): boolean =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const veiledOf = (u: Unit) => u.statuses.find((s) => s.kind === "veiled");
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const skillOf = (u: Unit, id: string): SkillInstance => (u.skills ?? []).find((s) => s.id === id)!;

/** Aramao on team A; caller supplies allies (listed with Aramao) and enemies to fix slots. */
function fund(state: MatchState) {
  state.teams.A.energy = { generic: 40, nomad: 40 };
  state.teams.B.energy = { generic: 40, nomad: 40 };
}

// A plain enemy Hero that carries a non-Strategic Harmful attack (10 normal to its target),
// a Strategic skill (marks itself so we can see whether it resolved), all off cooldown.
function enemyWith(id: string): Unit {
  const attack = skill("ek", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], {
    name: "Enemy Knife", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  });
  const strat = skill("es", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "esRan", duration: null } }], {
    name: "Enemy Scheme", tags: ["Strategic", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  });
  return makeUnit({ id, team: "B", hp: 100, maxHp: 100, skills: [attack, strat] });
}

// --------------------------------------------------------------------------- //
//  aramao0 — Dune Stalker (passive)
// --------------------------------------------------------------------------- //

test("aramao0: +5 to the enemy directly across (10 Knife -> 15 total) AND gains Elemental Essence", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");     // slot 0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0 = across
  const state = makeState([aramao], [e0], 1);
  fund(state);
  assert.equal(essenceCount(aramao), 0, "no essence before he damages the across enemy");
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 85, "10 Piercing + 5 from Dune Stalker = 15 damage to the across enemy");
  assert.equal(essenceCount(aramao), 1, "gains Elemental Essence for damaging the across enemy");
});

test("aramao0 CONTROL: a NON-across enemy takes no +5 and grants no Essence", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");           // slot 0, across = e0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 }); // slot 1 (not across)
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 90, "a non-across enemy takes only the base 10 (no Dune Stalker +5)");
  assert.equal(essenceCount(aramao), 0, "no Elemental Essence for damaging a non-across enemy");
});

// --------------------------------------------------------------------------- //
//  aramao1 — Desert Knife
// --------------------------------------------------------------------------- //

test("aramao1: 10 Piercing to target (Piercing ignores Damage Reduction)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");           // slot 0, across = e0
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 }); // slot 0 (across, avoided as target)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, statuses: [{ kind: "damage_reduction", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }] }); // slot 1
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  // Control skill: a NORMAL 10-damage attack, which DR reduces to 5.
  (aramao.skills ??= []).push(skill("ctlN", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], {
    element: "nomad", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  }));
  const rNorm = performAction(state, { unit: "ar", skillId: "ctlN", targets: ["e1"] });
  assert.equal(rNorm.ok, true);
  assert.equal(e1.hp, 95, "normal damage is reduced by DR 5 -> only 5 lands (control)");
  const rPierce = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(rPierce.ok, true);
  assert.equal(e1.hp, 85, "Desert Knife is Piercing: DR is ignored, the full 10 lands");
});

test("aramao1: cost is 1 generic, cooldown 0", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(state.teams.A.energy.generic, 39, "1 generic paid");
  assert.equal(skillOf(aramao, "aramao1").currentCd, 0, "Desert Knife has no cooldown");
});

test("aramao1: used on a NON-across enemy, Aramao swaps with the ally directly across from that enemy", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 }); // slot 0
  const aramao = loadHero(heroById("aramao"), "A", "ar");              // slot 1
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });   // slot 0 (across from ally)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });   // slot 1 (across from Aramao)
  const state = makeState([ally, aramao], [e0, e1], 1);
  fund(state);
  assert.equal(aramao.slot, 1);
  assert.equal(ally.slot, 0);
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] }); // e0 is NOT across from Aramao
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 90, "e0 took the base 10 (it was not across at damage time, so no +5)");
  assert.equal(aramao.slot, 0, "Aramao took the slot of the ally who was across from the target");
  assert.equal(ally.slot, 1, "and that ally took Aramao's old slot");
});

test("aramao1 CONTROL: used on the enemy already directly across, NO swap occurs", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 }); // slot 0
  const aramao = loadHero(heroById("aramao"), "A", "ar");              // slot 1
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });   // slot 0
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });   // slot 1 = across
  const state = makeState([ally, aramao], [e0, e1], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] }); // e1 IS across
  assert.equal(r.ok, true);
  assert.equal(aramao.slot, 1, "no swap when the target is already directly across");
  assert.equal(ally.slot, 0, "the ally stays put too");
  assert.equal(e1.hp, 85, "the across enemy still eats the Dune Stalker +5 (10+5)");
});

test("aramao1: using Desert Knife does NOT break Veiled (control: a normal Harmful skill DOES)", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([aramao], [e0], 1);
  fund(state);
  // Control: a plain Harmful skill without the opt-out breaks the caster's Veiled.
  (aramao.skills ??= []).push(skill("ctlH", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], {
    element: "nomad", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  }));
  aramao.statuses.push({ kind: "veiled", duration: 2, appliedBy: "ar", appliedTurn: 0 });
  performAction(state, { unit: "ar", skillId: "ctlH", targets: ["e0"] });
  assert.equal(has(aramao, "veiled"), false, "control: a normal Harmful cast strips Veiled");
  // Now re-Veil and use Desert Knife: the Veiled must survive.
  aramao.statuses.push({ kind: "veiled", duration: 2, appliedBy: "ar", appliedTurn: 0 });
  performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e0"] });
  assert.equal(has(aramao, "veiled"), true, "Desert Knife does NOT break Veiled");
});

// --------------------------------------------------------------------------- //
//  aramao2 — Sand Quake
// --------------------------------------------------------------------------- //

test("aramao2: 10 Piercing to ALL enemies (the across enemy also eats Dune Stalker +5)", () => {
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
  assert.equal(skillOf(aramao, "aramao2").currentCd, 2, "Sand Quake has a 2-turn cooldown");
});

test("aramao2: extends the duration of ALL Veiled effects by 2 (allies, self AND enemies); does not break/ touch non-Veiled", () => {
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
  assert.equal(veiledOf(aramao)!.duration, 5, "Aramao's own Veiled 3 -> 5 (and it was NOT broken by his Harmful cast)");
  assert.equal(veiledOf(e0)!.duration, 3, "an enemy's Veiled 1 -> 3 (ALL Veiled effects)");
  assert.equal(has(aramao, "veiled"), true, "Sand Quake does not break Aramao's Veiled");
  assert.equal(ally.statuses.find((s) => s.kind === "mark" && s.name === "ctlMark")!.duration, 2, "a non-Veiled status is untouched");
});

// --------------------------------------------------------------------------- //
//  aramao3 — Mirage Trap
// --------------------------------------------------------------------------- //

test("aramao3: target ACROSS -> counters their first NON-Strategic skill (and only the first); a Strategic skill is NOT countered", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0, across = e0
  const e0 = enemyWith("e0");                             // slot 0 (across)
  const state = makeState([aramao], [e0], 1);
  fund(state);
  const cast = performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e0"] });
  assert.equal(cast.ok, true);
  assert.equal(state.teams.A.energy.nomad, 39, "Mirage Trap costs 1 specific (nomad)");
  assert.equal(skillOf(aramao, "aramao3").currentCd, 2, "Mirage Trap has a 2-turn cooldown");

  // A Strategic skill must NOT be countered when armed against non-Strategic (across case).
  const strat = performAction(state, { unit: "e0", skillId: "es", targets: ["e0"] });
  assert.equal(strat.ok, true);
  assert.notEqual(strat.countered, true, "a Strategic skill is not countered in the across case");
  assert.equal(has(e0, "mark", "esRan"), true, "the Strategic skill actually resolved");

  const hpBefore = aramao.hp;
  const first = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // first NON-Strategic
  assert.equal(first.countered, true, "the first non-Strategic skill is countered");
  assert.equal(aramao.hp, hpBefore, "the countered attack deals no damage");

  const second = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // second NON-Strategic
  assert.notEqual(second.countered, true, "only the FIRST non-Strategic skill is countered");
  assert.equal(aramao.hp, hpBefore - 10, "the second attack lands for its 10");
});

test("aramao3: target NOT across -> counters their first STRATEGIC skill; a non-Strategic skill is NOT countered", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // slot 0, across = e0
  const e0 = enemyWith("e0");                             // slot 0 (across)
  const e1 = enemyWith("e1");                             // slot 1 (NOT across)
  const state = makeState([aramao], [e0, e1], 1);
  fund(state);
  const cast = performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e1"] }); // target the NON-across enemy
  assert.equal(cast.ok, true);

  const hpBefore = aramao.hp;
  const nonStrat = performAction(state, { unit: "e1", skillId: "ek", targets: ["ar"] }); // non-Strategic
  assert.notEqual(nonStrat.countered, true, "a non-Strategic skill is not countered in the not-across case");
  assert.equal(aramao.hp, hpBefore - 10, "the non-Strategic attack lands");

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
  // No Mirage Trap cast at all.
  const r = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] });
  assert.notEqual(r.countered, true, "without a trap, nothing is countered");
  assert.equal(aramao.hp, 90, "the attack lands normally");
});

// --------------------------------------------------------------------------- //
//  aramao4 — Desert Veil
// --------------------------------------------------------------------------- //

test("aramao4: targeting Aramao -> Veils Aramao and exactly ONE random OTHER allied Hero, both for 2 turns, no swap", () => {
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
  const othersVeiled = [al1, al2].filter((u) => has(u, "veiled"));
  assert.equal(othersVeiled.length, 1, "exactly one OTHER allied Hero is Veiled (random)");
  assert.equal(veiledOf(othersVeiled[0]!)!.duration, 2, "the random ally's Veil is 2 turns");
  assert.equal(aramao.slot, 0, "no position swap in the self-target branch");
  assert.equal(al1.slot, 1);
  assert.equal(state.teams.A.energy.nomad, 39, "Desert Veil costs 1 specific (nomad)");
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

// --------------------------------------------------------------------------- //
//  aramao5 — Heart of the Desert
// --------------------------------------------------------------------------- //

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
  assert.equal(aramao.hp, 65, "Aramao is also healed 15 when exactly one Hero is adjacent");
  assert.equal(far.hp, 50, "a non-adjacent ally is not healed");
  assert.equal(skillOf(aramao, "aramao5").currentCd, 1, "cooldown 1");
});

test("aramao5: TWO Heroes adjacent -> heals both for 15, but NOT Aramao", () => {
  const left = makeUnit({ id: "left", team: "A", hp: 50, maxHp: 100 }); // slot 0
  const aramao = loadHero(heroById("aramao"), "A", "ar");               // slot 1 (both neighbours adjacent)
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

// --------------------------------------------------------------------------- //
//  aramao6 — Trial of the Sands
// --------------------------------------------------------------------------- //

test("aramao6: Veils ALL allied Heroes at the END of each turn (not on cast); enemies are never Veiled by it", () => {
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
  endTurn(state); // end team A's turn -> the re-veil window fires on turnEnd
  assert.equal(has(aramao, "veiled"), true, "Aramao is Veiled at turn end");
  assert.equal(has(al1, "veiled"), true, "ally 1 is Veiled at turn end");
  assert.equal(has(al2, "veiled"), true, "ally 2 is Veiled at turn end");
  assert.equal(has(e0, "veiled"), false, "the enemy is not Veiled");
  assert.equal(skillOf(aramao, "aramao6").currentCd, 4, "cooldown 4");
});

test("aramao6: while active, an enemy using a Harmful skill on Aramao is hit back by Desert Knife", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar"); // solo -> shuffle is a no-op, keeps slot 0
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

test("aramao6 CONTROL: without Trial active, no Desert Knife retaliation occurs", () => {
  const aramao = loadHero(heroById("aramao"), "A", "ar");
  const e0 = enemyWith("e0");
  const state = makeState([aramao], [e0], 1);
  fund(state);
  const r = performAction(state, { unit: "e0", skillId: "ek", targets: ["ar"] }); // no Trial cast beforehand
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
  const r = performAction(state, { unit: "e0", skillId: "es", targets: ["ar"] }); // Strategic (non-Harmful), aimed at Aramao
  assert.equal(r.ok, true);
  assert.equal(e0.hp, 100, "a non-Harmful skill on Aramao provokes no Desert Knife");
});

test("aramao6: after being used, Aramao's team randomly swaps places once (slots stay a valid permutation)", () => {
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
