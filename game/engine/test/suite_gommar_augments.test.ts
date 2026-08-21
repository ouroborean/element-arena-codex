import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, effectiveCost } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// ============================================================================
// Adversarial, SPEC-DERIVED AUGMENT suite for GOMMAR, Frostfang Chieftain.
// The FROZEN augment prose (content/frozen/augments.json) is the sole oracle:
//
//  gommar1 Icy Shrapnel:
//    "Iceblood Hammer and Foot of the Mountain now mark a random enemy on use.
//     The following turn, that enemy will take 20 damage."
//  gommar2 Frozen Fortress:
//    "While Frost-Covered, Gommar gains 10 points of DR"
//  gommar3 Winter's Howl:
//    "Breath of the North now lowers the targets damage by 15, lowered by 5
//     every time they use a skill."
//  gommar4 Flashfreeze:
//    "After Gommar consumes Frost-Covered, he regains it at the end of his next
//     turn."
//  gommar5 Brittle Ice:
//    "Iceblood Hammer deals 5 less damage and costs one fewer r each time it is
//     used, stacking up to twice."
//
// Canon relied on (frozen passive gommar0 + gommar4 augment text): Frost-Covered
// is a per-round enhance CHARGE gained at round start; Gommar's actives CONSUME
// it (gommar4 frozen literally: "After Gommar consumes Frost-Covered ...").
// ============================================================================

function frost(u: Unit): void {
  u.statuses.push({ kind: "mark", name: "Frost-Covered", duration: null, appliedBy: u.id, appliedTurn: 0 });
}
function hasFrost(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "mark" && s.name === "Frost-Covered");
}
function shrapnelMark(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "mark" && s.name === "Icy Shrapnel");
}
function odmNamed(u: Unit, name: string) {
  return u.statuses.find((s) => s.kind === "outgoing_damage_mod" && s.name === name);
}
function giveEnergy(state: MatchState): void {
  state.teams.A.energy = { generic: 40, ice: 40 };
  state.teams.B.energy = { generic: 40, ice: 40 };
}
function sk(u: Unit, id: string): SkillInstance {
  return (u.skills ?? []).find((s) => s.id === id)!;
}
const probe = (id: string, amt: number) =>
  skill(id, [{ op: "damage", amount: amt, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single", cost: { generic: 0, specific: 0 } });

// --------------------------------------------------------------------------- //
//  gommar1 — Icy Shrapnel
//  "Iceblood Hammer and Foot of the Mountain now mark a random enemy on use.
//   The following turn, that enemy will take 20 damage."
// --------------------------------------------------------------------------- //

test("gommar1: Iceblood Hammer marks an enemy; that enemy takes 20 the FOLLOWING turn", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar1")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered (mark is unconditional, not Frost-gated)");

  performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] });
  assert.equal(e.hp, 80, "the base 20 lands immediately (no Frost splash) and the delayed hit has NOT yet fired");
  assert.equal(shrapnelMark(e), true, "the enemy is marked with Icy Shrapnel on use");

  // "The following turn" — the delayed 20 fires when the 1-turn mark lapses at Gommar's next turn-end,
  // NOT during the current turn nor the intervening enemy turn.
  endTurn(state); // Gommar's current turn ends — mark survives its birth turn
  assert.equal(e.hp, 80, "no delayed damage yet at Gommar's own turn-end");
  endTurn(state); // enemy turn ends — not the applier's team, no tick
  assert.equal(e.hp, 80, "no delayed damage yet at the enemy's turn-end");
  endTurn(state); // Gommar's NEXT turn ends — mark lapses, delayed 20 fires
  assert.equal(e.hp, 60, "the marked enemy takes 20 the following turn");
  assert.equal(shrapnelMark(e), false, "the mark is spent once it deals its delayed damage");
});

test("gommar1: Foot of the Mountain marks ONE random enemy; only the marked one takes the delayed 20", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar1")!);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar2", targets: [] });
  assert.equal(e1.hp, 80, "Foot of the Mountain's base 20 hits the whole enemy team");
  assert.equal(e2.hp, 80, "Foot of the Mountain's base 20 hits the whole enemy team");
  const marked = [e1, e2].filter(shrapnelMark);
  assert.equal(marked.length, 1, "exactly ONE random enemy is marked (not the whole team)");
  const target = marked[0]!;
  const spared = target === e1 ? e2 : e1;

  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(target.hp, 60, "the marked enemy takes the delayed 20");
  assert.equal(spared.hp, 80, "the UNmarked enemy takes no delayed damage");
});

test("gommar1 control: a skill NOT named by the augment (Breath of the North) leaves no Icy Shrapnel mark", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar1")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["e"] });
  assert.equal(e.hp, 75, "Breath of the North still deals its 25");
  assert.equal(shrapnelMark(e), false, "only Iceblood Hammer & Foot of the Mountain mark — not Breath of the North");
});

test("gommar1 control: WITHOUT the augment, Iceblood Hammer applies no Icy Shrapnel mark", () => {
  const g = loadHero(heroById("gommar"), "A", "g"); // no augment
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] });
  assert.equal(shrapnelMark(e), false, "the mark is added by the augment, not the base kit");
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(e.hp, 80, "and there is no delayed 20 without the augment");
});

// --------------------------------------------------------------------------- //
//  gommar2 — Frozen Fortress
//  "While Frost-Covered, Gommar gains 10 points of DR"
// --------------------------------------------------------------------------- //

test("gommar2: while Frost-Covered, incoming (normal) damage to Gommar is reduced by 10", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar2")!);
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [probe("hit", 20)] });
  const state = makeState([g], [e]);
  giveEnergy(state);

  emit(state, { type: "turnStart", team: "A" }); // materialise the "while Frost-Covered" DR
  performAction(state, { unit: "e", skillId: "hit", targets: ["g"] });
  assert.equal(g.hp, 90, "a 20 hit is cut to 10 by the 10 points of DR");
});

test("gommar2 control: NOT Frost-Covered => no DR, full damage", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar2")!);
  assert.equal(hasFrost(g), false, "precondition: no Frost-Covered mark");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [probe("hit", 20)] });
  const state = makeState([g], [e]);
  giveEnergy(state);

  emit(state, { type: "turnStart", team: "A" }); // the DR gate must fail
  performAction(state, { unit: "e", skillId: "hit", targets: ["g"] });
  assert.equal(g.hp, 80, "no Frost-Covered => no DR => the full 20 lands");
});

test("gommar2: the grant is exactly 10 DR and does NOT stack past 10 across turns", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar2")!);
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [probe("hit", 20)] });
  const state = makeState([g], [e]);
  giveEnergy(state);

  emit(state, { type: "turnStart", team: "A" });
  emit(state, { type: "turnStart", team: "B" });
  emit(state, { type: "turnStart", team: "A" }); // three refreshes — must not accumulate to 30
  performAction(state, { unit: "e", skillId: "hit", targets: ["g"] });
  assert.equal(g.hp, 90, "DR stays at 10 (frozen says 10 points), a 20 hit still lands 10 — it does not deepen to 20/30");
});

// --------------------------------------------------------------------------- //
//  gommar3 — Winter's Howl
//  "Breath of the North now lowers the targets damage by 15, lowered by 5 every
//   time they use a skill."
// --------------------------------------------------------------------------- //

test("gommar3: Breath of the North lowers the target's damage by 15 (up from base 5)", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar3")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [probe("ehit", 20)] });
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g, ally], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["e"] });
  assert.equal(e.hp, 75, "the base 25 still lands");
  assert.equal(odmNamed(e, "Winter's Howl")?.magnitude, -15, "the debuff lowers the target's damage by 15, not 5");

  // Prove the -15 is a real outgoing reduction: the debuffed enemy's own 20 attack now deals only 5.
  performAction(state, { unit: "e", skillId: "ehit", targets: ["al"] });
  assert.equal(ally.hp, 95, "the enemy's 20 attack is cut to 5 by the -15 (applied before this use's decay)");
});

test("gommar3: the -15 debuff decays +5 toward 0 each time the debuffed enemy uses a skill, and floors at 0", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar3")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero",
    statuses: [{ kind: "outgoing_damage_mod", name: "Winter's Howl", magnitude: -15, duration: null, appliedBy: "g", appliedTurn: 0 }] });
  const state = makeState([g], [e]);
  const mag = () => odmNamed(e, "Winter's Howl")?.magnitude ?? 0;
  const use = () => emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["g"], tags: [] });

  assert.equal(mag(), -15, "starts at -15");
  use(); assert.equal(mag(), -10, "1st enemy skill use: -15 -> -10 (lowered by 5)");
  use(); assert.equal(mag(), -5, "2nd use: -10 -> -5");
  use(); assert.equal(mag(), 0, "3rd use: -5 -> 0");
  use(); assert.equal(mag(), 0, "4th use: floors at 0 — never flips into a +5 damage BUFF");
});

test("gommar3 control: another enemy WITHOUT the debuff using a skill does not decay it ('every time THEY use a skill')", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar3")!);
  const debuffed = makeUnit({ id: "e1", team: "B", kind: "hero",
    statuses: [{ kind: "outgoing_damage_mod", name: "Winter's Howl", magnitude: -15, duration: null, appliedBy: "g", appliedTurn: 0 }] });
  const other = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([g], [debuffed, other]);

  emit(state, { type: "skillUsed", caster: "e2", skillId: "x", targets: ["g"], tags: [] });
  assert.equal(odmNamed(debuffed, "Winter's Howl")?.magnitude, -15, "an UNdebuffed enemy's skill use leaves the debuff at -15");
});

test("gommar3: the Frost-Covered branch is preserved — Piercing bypasses Damage Reduction", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar3")!);
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["e"] });
  assert.equal(e.hp, 75, "Frost-Covered -> Piercing 25 ignores the 10 DR (would be 15 if it had become normal)");
});

// --------------------------------------------------------------------------- //
//  gommar4 — Flashfreeze
//  "After Gommar consumes Frost-Covered, he regains it at the end of his next
//   turn."
// --------------------------------------------------------------------------- //

test("gommar4: consuming Frost-Covered schedules a regain at the END of Gommar's NEXT turn", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar4")!);
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  // Using an active while Frost-Covered CONSUMES it (canon enhance charge).
  performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] });
  assert.equal(hasFrost(g), false, "Iceblood Hammer consumed Frost-Covered");

  endTurn(state); // Gommar's CURRENT turn ends — this is not yet "his next turn"
  assert.equal(hasFrost(g), false, "not regained at his own current turn-end");
  endTurn(state); // enemy turn ends
  assert.equal(hasFrost(g), false, "not regained at the enemy's turn-end");
  endTurn(state); // Gommar's NEXT turn ends — regain fires now
  assert.equal(hasFrost(g), true, "Frost-Covered regained at the end of his next turn");
});

test("gommar4 control: WITHOUT the augment, a consumed Frost-Covered is NOT regained next turn", () => {
  const g = loadHero(heroById("gommar"), "A", "g"); // no augment
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] });
  assert.equal(hasFrost(g), false, "consumed");
  endTurn(state); endTurn(state); endTurn(state); endTurn(state);
  assert.equal(hasFrost(g), false, "no Flashfreeze => it stays consumed (only round-start would re-grant it)");
});

// --------------------------------------------------------------------------- //
//  gommar5 — Brittle Ice
//  "Iceblood Hammer deals 5 less damage and costs one fewer r each time it is
//   used, stacking up to twice."
// --------------------------------------------------------------------------- //

test("gommar5: Iceblood Hammer deals 5 less damage each use, stacking up to twice (20, 15, 10, 10)", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar5")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 400, maxHp: 400 });
  const state = makeState([g], [e]);
  const s = sk(g, "gommar1");
  const recast = (): number => {
    s.currentCd = 0;
    giveEnergy(state);
    const before = e.hp;
    performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] });
    return before - e.hp;
  };

  assert.equal(recast(), 20, "1st use: full 20");
  assert.equal(recast(), 15, "2nd use: 5 less -> 15");
  assert.equal(recast(), 10, "3rd use: 10 less -> 10 (two stacks)");
  assert.equal(recast(), 10, "4th use: floored at 10 (stacks cap at twice / -10)");
});

test.skip("SUSPECTED BUG: gommar5 'costs one fewer r each time it is used' never reduces the cost — it stays at 2 (the in-skill custom node gates on a skillUsed event that is not present during effect execution)", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar5")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 400, maxHp: 400 });
  const state = makeState([g], [e]);
  const s = sk(g, "gommar1");

  assert.equal(effectiveCost(g, s, state).generic, 2, "base Iceblood Hammer costs 2 generic (r)");
  const cast = () => { s.currentCd = 0; giveEnergy(state); performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] }); };

  cast();
  assert.equal(effectiveCost(g, s, state).generic, 1, "after 1 use the next cast should cost one fewer -> 1");
  cast();
  assert.equal(effectiveCost(g, s, state).generic, 0, "after 2 uses it should cost two fewer -> 0 (cap)");
  cast();
  assert.equal(effectiveCost(g, s, state).generic, 0, "and stay floored at 0 (stacking up to twice)");
});

test.skip("SUSPECTED BUG: gommar5 re-authored Iceblood Hammer no longer CONSUMES Frost-Covered — canon says Gommar's actives consume it (gommar4 frozen: 'After Gommar consumes Frost-Covered')", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  applyAugment(g, augmentById("gommar5")!);
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 400, maxHp: 400 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar1", targets: ["e"] });
  assert.equal(hasFrost(g), false, "using Iceblood Hammer while Frost-Covered must consume the enhance charge");
});
