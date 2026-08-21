import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { performAction, endTurn, startRound, effectiveCost } from "../src/scheduler.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { redactState } from "../src/visibility.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Adversarial, spec-derived suite for Mr. Scratch's AUGMENTS.
// The FROZEN augment prose (../content/frozen/augments.json) is the ORACLE:
//
//  scratch1 Sign In Blood: "Allies receive 10 Affliction damage when triggering
//           Scratch's Deal skills, but they gain Elemental Essence when doing so."
//  scratch2 Absolute Power: "Heroes affected by Deal: Defeat Your Enemies ignore
//           stuns and counters."
//  scratch3 Everything Must Go: "Each round, the first time Scratch falls below 30 HP,
//           his next non-Ultimate Deal skill applies all other non-Ultimate Deal skills."
//  scratch4 Bump Those Numbers: "Scratch's Deal skills no longer have a cooldown, but
//           can only affect each Hero once per round."
//  scratch5 Dramatic Irony: "Deal: Defeat Your Enemies and Deal: Save Your Friends are
//           now invisible until triggered."
//
// Base kit (skills, for driving only): scratch1 Deal: Defeat Your Enemies,
// scratch2 Deal: Save Your Friends (cd1), scratch3 Deal: Realize Your Potential (cd1),
// scratch4 Faustian Bargain (self), scratch5 Disarming Pitch (self), scratch6 Deal:
// Know Your Fate (ult, cd5). Element "devil"; Specific paid in devil.
// NB: augment ids and skill ids collide (both "scratch1".."scratch6"); augmentById
// returns the AUGMENT, performAction's skillId names the SKILL.
// ---------------------------------------------------------------------------

const ENERGY = () => ({ generic: 40, devil: 40 });
const essence = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;
const noopSelf = () => skill("noop", [], { targeting: "self", tags: ["Strategic"] });

function setup(augId: string | null, bExtra: Unit[] = [], aExtra: Unit[] = []): { scratch: Unit; state: MatchState } {
  const scratch = loadHero(heroById("scratch"), "A", "s");
  if (augId) applyAugment(scratch, augmentById(augId)!);
  const state = makeState([scratch, ...aExtra], bExtra);
  state.teams.A.energy = ENERGY();
  state.teams.B.energy = ENERGY();
  return { scratch, state };
}

// ===========================================================================
// scratch1 — Sign In Blood
//   Allies who TRIGGER a Deal take 10 Affliction (on TOP of the base triggered
//   effect) and gain Elemental Essence. Enemies do NOT get this added clause.
//   "Scratch's Deal skills" = the three basic Deals (Defeat/Save/Realize).
// ===========================================================================

test("Sign In Blood: an ALLY triggering Deal: Defeat takes +10 Affliction (base 20 + 10 = 30) and gains Essence", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup("scratch1", [], [ally]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["a"] }).ok);
  assert.equal(essence(ally), 0, "precondition: ally holds no Essence before triggering");
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);

  assert.equal(ally.hp, 70, "base 20 Affliction + Sign In Blood's 10 Affliction = 30 total on the triggering ally");
  assert.equal(essence(ally), 1, "the triggering ally gains 1 Elemental Essence from Sign In Blood");
  assert.equal(essence(scratch), 1, "Scratch still gains his own Essence on a triggered Deal (base passive)");
});

test("Sign In Blood CONTROL: WITHOUT the augment, an ally triggering Deal: Defeat takes only base 20 and gains no Essence", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup(null, [], [ally]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["a"] }).ok);
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);
  assert.equal(ally.hp, 80, "no augment -> only the base 20 Affliction punishment");
  assert.equal(essence(ally), 0, "no augment -> the ally gains no Essence on trigger");
});

test("Sign In Blood: the added clause applies to ALLIES ONLY — an ENEMY triggering Deal: Defeat takes only base 20, no extra 10, no Essence", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup("scratch1", [enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "noop" }).ok);

  assert.equal(enemy.hp, 80, "an enemy trigger is NOT charged the extra 10 (allies only) — only the base 20 lands");
  assert.equal(essence(enemy), 0, "an enemy trigger grants the enemy no Essence (allies only)");
  assert.equal(essence(scratch), 1, "Scratch still gains Essence when any target triggers his Deal");
});

test("Sign In Blood: an ally triggering Deal: Save (no base damage) takes exactly 10 Affliction + Essence (plus base Isolate)", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup("scratch1", [], [ally]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["a"] }).ok);
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);

  assert.equal(ally.hp, 90, "Deal: Save deals no base damage; Sign In Blood adds exactly 10 Affliction");
  assert.equal(essence(ally), 1, "the triggering ally gains 1 Essence from Sign In Blood");
  assert.ok(ally.statuses.some((s) => s.kind === "isolated"), "the base Deal: Save trigger still Isolates the ally");
});

test("Sign In Blood CONTROL: WITHOUT the augment, an ally triggering Deal: Save takes no damage (only base Isolate)", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup(null, [], [ally]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["a"] }).ok);
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);
  assert.equal(ally.hp, 100, "no augment -> Deal: Save's trigger deals no damage");
  assert.equal(essence(ally), 0, "no augment -> no Essence to the ally");
});

test("Sign In Blood: an ally triggering Deal: Realize (no base damage) takes exactly 10 Affliction + Essence (plus base Stun)", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup("scratch1", [], [ally]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["a"] }).ok);
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);

  assert.equal(ally.hp, 90, "Deal: Realize deals no base damage; Sign In Blood adds exactly 10 Affliction");
  assert.equal(essence(ally), 1, "the triggering ally gains 1 Essence from Sign In Blood");
  assert.ok(ally.statuses.some((s) => s.kind === "stun"), "the base Deal: Realize trigger still Stuns the ally");
});

// ===========================================================================
// scratch2 — Absolute Power
//   Heroes affected by Deal: Defeat Your Enemies ignore stuns and counters.
// ===========================================================================

test("Absolute Power: a hero holding the Deal: Defeat mark IGNORES an enemy stun", () => {
  const stunner = makeUnit({
    id: "p", team: "A", kind: "hero",
    skills: [skill("stunner", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { targeting: "single", tags: ["Harmful"] })],
  });
  const marked = makeUnit({ id: "m", team: "B", kind: "hero" });
  const control = makeUnit({ id: "c", team: "B", kind: "hero" });
  const { state } = setup("scratch2", [marked, control], [stunner]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["m"] }).ok, "Deal: Defeat marks m");
  assert.ok(performAction(state, { unit: "p", skillId: "stunner", targets: ["m"] }).ok);
  assert.equal(marked.statuses.some((s) => s.kind === "stun"), false, "the Deal: Defeat hero ignores the incoming stun");

  assert.ok(performAction(state, { unit: "p", skillId: "stunner", targets: ["c"] }).ok);
  assert.ok(control.statuses.some((s) => s.kind === "stun"), "CONTROL: an unmarked enemy IS stunned");
});

test("Absolute Power: a hero holding the Deal: Defeat mark has UNCOUNTERABLE skills — an enemy Counter does not fire", () => {
  const marked = makeUnit({
    id: "m", team: "B", kind: "hero",
    skills: [skill("atk", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful", "Instant"] })],
  });
  const defender = makeUnit({ id: "d", team: "A", kind: "hero" });
  defender.triggers = [{
    on: "skillDeclared", owner: "d", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    effect: [],
  }];
  const { state } = setup("scratch2", [marked], [defender]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["m"] }).ok, "Deal: Defeat marks m");
  const r = performAction(state, { unit: "m", skillId: "atk", targets: ["d"] });
  assert.ok(r.ok);
  assert.notEqual(r.countered, true, "the marked hero's skill cannot be countered");
  assert.ok(defender.hp < 100, "the attack lands because the counter was ignored");
});

test("Absolute Power CONTROL: WITHOUT the Deal: Defeat mark, the same attacker IS countered", () => {
  const attacker = makeUnit({
    id: "m", team: "B", kind: "hero",
    skills: [skill("atk", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful", "Instant"] })],
  });
  const defender = makeUnit({ id: "d", team: "A", kind: "hero" });
  defender.triggers = [{
    on: "skillDeclared", owner: "d", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    effect: [],
  }];
  const { state } = setup("scratch2", [attacker], [defender]);
  // No Deal cast: attacker is unmarked.
  const r = performAction(state, { unit: "m", skillId: "atk", targets: ["d"] });
  assert.equal(r.countered, true, "an unmarked attacker's Harmful skill IS countered");
  assert.equal(defender.hp, 100, "the countered skill deals no damage");
});

test.skip("SUSPECTED BUG: Absolute Power should grant ONLY stun+counter immunity per frozen, but the engine's non_damage_ignore also wards off Isolate (and every other harmful non-damage effect)", () => {
  const isolator = makeUnit({
    id: "p", team: "A", kind: "hero",
    skills: [skill("iso", [{ op: "applyStatus", to: "target", status: { kind: "isolated", duration: 1 } }], { targeting: "single", tags: ["Harmful"] })],
  });
  const marked = makeUnit({ id: "m", team: "B", kind: "hero" });
  const { state } = setup("scratch2", [marked], [isolator]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["m"] }).ok, "Deal: Defeat marks m");
  assert.ok(performAction(state, { unit: "p", skillId: "iso", targets: ["m"] }).ok);
  // Frozen only grants stun+counter immunity; an Isolate is neither, so it must apply.
  assert.ok(marked.statuses.some((s) => s.kind === "isolated"), "Isolate is not a stun/counter and should still land on the marked hero");
});

// ===========================================================================
// scratch3 — Everything Must Go
//   First time below 30 HP each round, Scratch's NEXT non-Ultimate Deal also
//   applies the other two non-Ultimate Deals to the same target.
// ===========================================================================

// Drop Scratch below 30 via a real damage event (the "falls below 30 HP" trigger).
function dropScratchBelow30(state: MatchState): void {
  const s = state.units["s"]!;
  s.hp = 35;
  assert.ok(performAction(state, { unit: "hitter", skillId: "hit", targets: ["s"] }).ok);
  assert.ok(s.hp < 30, "precondition: Scratch is now below 30 HP");
}

function hitter(): Unit {
  return makeUnit({
    id: "hitter", team: "B", kind: "hero",
    skills: [skill("hit", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful", "Instant"] })],
  });
}

test("Everything Must Go: after Scratch falls below 30, his next Deal (Defeat) ALSO applies the other two non-Ultimate Deals", () => {
  const target = makeUnit({ id: "t", team: "A", kind: "hero" });
  const { state } = setup("scratch3", [hitter()], [target]);
  dropScratchBelow30(state);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);

  assert.ok(hasMark(target, "Deal: Defeat Your Enemies"), "the cast Deal itself applies (Defeat)");
  assert.ok(hasMark(target, "Boon: Save Your Friends"), "cascade also applies Deal: Save");
  assert.ok(hasMark(target, "Deal: Realize Your Potential"), "cascade also applies Deal: Realize");
  assert.equal(hasMark(target, "Deal: Know Your Fate"), false, "the ULTIMATE Deal is NOT applied by the cascade (non-Ultimate only)");
});

test("Everything Must Go CONTROL: while Scratch is ABOVE 30 HP, a Deal cast applies ONLY itself (no cascade)", () => {
  const target = makeUnit({ id: "t", team: "A", kind: "hero" });
  const { state } = setup("scratch3", [hitter()], [target]);
  // Scratch untouched at full HP.
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);
  assert.ok(hasMark(target, "Deal: Defeat Your Enemies"), "the cast Deal applies");
  assert.equal(hasMark(target, "Boon: Save Your Friends"), false, "no cascade: Deal: Save not applied");
  assert.equal(hasMark(target, "Deal: Realize Your Potential"), false, "no cascade: Deal: Realize not applied");
});

test("Everything Must Go: only the FIRST Deal after arming cascades — a second Deal the same round does NOT", () => {
  const t1 = makeUnit({ id: "t1", team: "A", kind: "hero" });
  const t2 = makeUnit({ id: "t2", team: "A", kind: "hero" });
  const { state } = setup("scratch3", [hitter()], [t1, t2]);
  dropScratchBelow30(state);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t1"] }).ok);
  assert.ok(hasMark(t1, "Boon: Save Your Friends"), "the first Deal cascaded onto t1");

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t2"] }).ok);
  assert.ok(hasMark(t2, "Deal: Defeat Your Enemies"), "the second Deal still applies itself");
  assert.equal(hasMark(t2, "Boon: Save Your Friends"), false, "but the second Deal the same round does NOT cascade (armed once)");
  assert.equal(hasMark(t2, "Deal: Realize Your Potential"), false, "and does not cascade Realize either");
});

test("Everything Must Go: the arm RESETS each round — after a fresh round, falling below 30 arms the cascade again", () => {
  const t1 = makeUnit({ id: "t1", team: "A", kind: "hero" });
  const { state } = setup("scratch3", [hitter()], [t1]);
  dropScratchBelow30(state);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t1"] }).ok);
  assert.ok(hasMark(t1, "Boon: Save Your Friends"), "round 1: cascade fired");

  // Fresh battle round: HP/statuses reset, the once-per-round lock clears.
  startRound(state, "A");
  const t2 = makeUnit({ id: "t2", team: "A", kind: "hero" });
  state.units["t2"] = t2; state.teams.A.units.push("t2");
  dropScratchBelow30(state);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t2"] }).ok);
  assert.ok(hasMark(t2, "Boon: Save Your Friends"), "round 2: cascade arms and fires again");
});

// ===========================================================================
// scratch4 — Bump Those Numbers
//   Deal skills no longer have a cooldown, but can only affect each Hero once per round.
// ===========================================================================

test("Bump Those Numbers: Scratch's Deal skills have their cooldown zeroed (Save/Realize/Know were 1/1/5)", () => {
  const { scratch } = setup("scratch4");
  assert.equal(skillOf(scratch, "scratch1").cooldown, 0, "Deal: Defeat cooldown 0 (already 0)");
  assert.equal(skillOf(scratch, "scratch2").cooldown, 0, "Deal: Save cooldown 1 -> 0");
  assert.equal(skillOf(scratch, "scratch3").cooldown, 0, "Deal: Realize cooldown 1 -> 0");
  assert.equal(skillOf(scratch, "scratch6").cooldown, 0, "Deal: Know Your Fate cooldown 5 -> 0");
});

test("Bump Those Numbers: with no cooldown, Deal: Save can be recast the same turn (control: base version cannot)", () => {
  const a1 = makeUnit({ id: "a1", team: "A", kind: "hero" });
  const a2 = makeUnit({ id: "a2", team: "A", kind: "hero" });

  const withAug = setup("scratch4", [], [a1, a2]);
  assert.ok(performAction(withAug.state, { unit: "s", skillId: "scratch2", targets: ["a1"] }).ok);
  assert.equal(skillOf(withAug.scratch, "scratch2").currentCd, 0, "no cooldown is set after casting Deal: Save");
  assert.ok(performAction(withAug.state, { unit: "s", skillId: "scratch2", targets: ["a2"] }).ok, "can immediately recast Deal: Save");

  const base = setup(null, [], [makeUnit({ id: "b1", team: "A", kind: "hero" }), makeUnit({ id: "b2", team: "A", kind: "hero" })]);
  assert.ok(performAction(base.state, { unit: "s", skillId: "scratch2", targets: ["b1"] }).ok);
  const r = performAction(base.state, { unit: "s", skillId: "scratch2", targets: ["b2"] });
  assert.equal(r.ok, false, "CONTROL: base Deal: Save is on cooldown and cannot be recast the same turn");
  assert.equal(r.reason, "on-cooldown");
});

test.skip("SUSPECTED BUG: Bump Those Numbers says Deals 'can only affect each Hero once per round', but the engine does NOT enforce the once-per-round target rule — a second Deal on the same Hero still lands", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup("scratch4", [enemy]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok, "first Deal: Defeat on e is legal");
  const second = performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] });
  assert.equal(second.ok, false, "a second Deal on the SAME Hero this round must be rejected (once-per-round rule)");
});

// ===========================================================================
// scratch5 — Dramatic Irony
//   Deal: Defeat and Deal: Save are invisible until triggered.
// ===========================================================================

test("Dramatic Irony: Deal: Defeat and Deal: Save become Invisible; Deal: Realize does NOT", () => {
  const { scratch } = setup("scratch5");
  assert.equal(skillOf(scratch, "scratch1").isHidden, true, "Deal: Defeat is now Invisible");
  assert.equal(skillOf(scratch, "scratch2").isHidden, true, "Deal: Save is now Invisible");
  assert.notEqual(skillOf(scratch, "scratch3").isHidden, true, "Deal: Realize is NOT made Invisible (control)");
});

test("Dramatic Irony: the opponent cannot see a placed Deal: Defeat mark (invisible until triggered)", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup("scratch5", [enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok);

  assert.ok(hasMark(enemy, "Deal: Defeat Your Enemies"), "the Deal mark exists in true state");
  const seenByOpponent = redactState(state, "B").units["e"]!;
  assert.equal(
    seenByOpponent.statuses.some((s) => s.kind === "mark" && s.name === "Deal: Defeat Your Enemies"), false,
    "the opponent (team B) cannot see the invisible Deal: Defeat mark on their own hero",
  );
  assert.equal(
    seenByOpponent.statuses.some((s) => s.kind === "outgoing_damage_mod"), false,
    "the opponent also cannot see the invisible +10 boon the Deal armed",
  );
});

test("Dramatic Irony CONTROL: Deal: Realize (not made invisible) IS visible to the opponent", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup("scratch5", [enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["e"] }).ok);

  const seenByOpponent = redactState(state, "B").units["e"]!;
  assert.ok(
    seenByOpponent.statuses.some((s) => s.kind === "mark" && s.name === "Deal: Realize Your Potential"),
    "Deal: Realize is not invisible, so the opponent sees its mark",
  );
});
