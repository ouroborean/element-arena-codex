import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, tickDots } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers consumeShield + keeper triggers + fusion custom fns
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { addShield, totalShield } from "../src/damage.ts";
import type { MatchState, Unit, Status } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";

// ============================================================================
// Keeper of Fables — FUSION FORMS — adversarial, spec-derived behavioral suite.
//
// Oracle = the FROZEN PROSE (content/frozen/skills.json). "Tales to Tell" IS Keeper's
// real Shield pool (addShield/totalShield). Every "attempts to consume N Shield" active
// gates on the pool (+ Chronicle Fragments for crystal) holding >= N.
//
// Each of Keeper's 10 fusion forms replaces the base passive (keeper0 "Tales to Tell")
// with its own passive and inserts one active skill. The frozen text of each:
//
//   apocalypse0 "All Is Lost":      allied hero dies -> +35 Shield on Tales to Tell.
//   apocalypse1 "Tale of a Ruined World": consume 40 Shield -> 25 Affliction to enemy
//                                   team + lower their damage by 5 for 2 turns.
//   aurora0 "Stellar Story":        Keeper successfully consumes Shield -> gains Essence.
//   aurora1 "Colorful Characters":  +20 Shield; 30 if another ally acts this turn; 45 if both.
//   crystal0 "Chronicle Fragments": Shield broken by damage -> 1 Fragment stack (=10 Shield each).
//   crystal1 "The World Mirror":    +60 Shield; costs 1 less per Fragment, all consumed on use.
//   glacier0 "Glacial Pacing":      start +2 cost; each turn for 2 turns -1 cost (perma) + 25 Shield.
//   glacier1 "Iced Shelf":          Keeper + target enemy permanently stunned until a Helpful/Harmful
//                                   skill is used on one of them; ending it for one ends it for all.
//   lich0 "Licherature":            Keeper cannot be healed; Tales grants +10 Shield whenever it activates.
//   lich1 "Tale from Beyond":       consume 25 Shield -> 30 Piercing to target, +10 per dead ally.
//   myth0 "Wise Old Man":           Shield no longer prevents damage to Keeper; on death allies split
//                                   his Shield (rounded up to nearest 5).
//   myth1 "Mentorship":             3 turns, target ally +5 dmg +5 DR; gains Essence on deal/take/stun/
//                                   invuln (each once).
//   night0 "Reading in the Dark":   any Invisible skill used -> +10 Shield.
//   night1 "Tale of Endless Night": for 2 turns, all allied-team skills are Invisible.
//   prism0 "Blinding Reveal":       Tales broken by damage -> attacker Blinded 2 turns.
//   prism1 "Tale of the Coming Dawn":consume 40 Shield -> heal all allies 25.
//   stasis0 "Modernization":        while Shield remains, Keeper ignores indirect from all sources.
//   stasis1 "Tale of a Distant Future": consume 35 Shield -> 5 Affliction to every character forever; stacks.
//   winter0 "Crackling Hearth":     Shield added to Tales -> heal a random allied hero 10.
//   winter1 "A Tale of Joy and Wonder": consume 25 Shield -> for 2 turns, allies gain Essence on a new skill.
// ============================================================================

function fusedKeeper(id: string, element: string): Unit {
  const k = loadHero(heroById("keeper"), "A", id);
  applyFusion(k, fusionForm("keeper", element)!);
  return k;
}
const energyFor = (element: string) => ({ generic: 40, [element]: 40 });
const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const frags = (u: Unit) => u.statuses.find((s) => s.kind === "stack" && s.name === "Chronicle Fragments")?.magnitude ?? 0;
const st = (u: Unit, kind: Status["kind"], name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));

// Land `amount` `dtype` damage from `dealer` onto `target`, running the full mitigation
// pipeline and emitting its events (so shieldBroken/damageDealt reactors fire).
function strike(state: MatchState, dealer: Unit, target: Unit, amount: number, dtype: "normal" | "piercing" | "affliction" | "true" = "normal") {
  const eff: Effect[] = [{ op: "damage", amount, dtype, to: "target" }];
  runEffects(state, eff, { caster: dealer, targets: [target], targeting: "single" });
}

const enemy = (id: string, over: Partial<Unit> = {}) => makeUnit({ id, team: "B", kind: "hero", hp: 100, maxHp: 100, ...over });
const ally = (id: string, over: Partial<Unit> = {}) => makeUnit({ id, team: "A", kind: "hero", hp: 100, maxHp: 100, ...over });

// ###########################################################################
// # apocalypse — "All Is Lost" (passive) + "Tale of a Ruined World" (active)
// ###########################################################################

test("apocalypse0: when an allied hero dies, Tales to Tell gains exactly 35 Shield", () => {
  const k = fusedKeeper("k", "apocalypse");
  const al = ally("al");
  const state = makeState([k, al], [enemy("e")]);
  assert.equal(totalShield(k), 0, "precondition: no Shield");

  emit(state, { type: "unitDied", unit: al.id, killer: "e" });
  assert.equal(totalShield(k), 35, "an allied hero's death banks 35 Shield");
});

test("apocalypse0 CONTROL: an ENEMY hero dying banks nothing (only allies)", () => {
  const k = fusedKeeper("k", "apocalypse");
  const e = enemy("e");
  const state = makeState([k], [e]);
  emit(state, { type: "unitDied", unit: e.id, killer: "k" });
  assert.equal(totalShield(k), 0, "an enemy death is not 'an allied hero dies'");
});

test("apocalypse0 CONTROL: an allied MINION dying banks nothing ('an allied hero')", () => {
  const k = fusedKeeper("k", "apocalypse");
  const m = makeUnit({ id: "m", team: "A", kind: "minion", name: "Pet", summoner: "k" });
  const state = makeState([k, m], [enemy("e")]);
  emit(state, { type: "unitDied", unit: m.id, killer: "e" });
  assert.equal(totalShield(k), 0, "a minion is not a hero");
});

test("apocalypse1: with >=40 Shield, consumes 40 and deals 25 Affliction to the whole enemy team + -5 dmg 2t", () => {
  const k = fusedKeeper("k", "apocalypse");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([k], [e1, e2]);
  state.teams.A.energy = energyFor("apocalypse");
  addShield(k, 50, null, k.id, 0);

  const r = performAction(state, { unit: "k", skillId: "keeperapocalypse1", targets: [] });
  assert.equal(r.ok, true, "cast succeeds");
  assert.equal(e1.hp, 75, "enemy 1 took 25 Affliction (bypasses Shield/DR)");
  assert.equal(e2.hp, 75, "enemy 2 took 25 Affliction");
  assert.equal(totalShield(k), 10, "exactly 40 Shield consumed (50 -> 10)");
  for (const e of [e1, e2]) {
    const mod = st(e, "outgoing_damage_mod");
    assert.ok(mod, `${e.id} has an outgoing damage mod`);
    assert.equal(mod!.magnitude, -5, "their damage is lowered by 5");
    assert.equal(mod!.duration, 2, "for 2 turns");
  }
});

test("apocalypse1 CONTROL: with <40 Shield nothing happens (no damage, no Shield spent, no debuff)", () => {
  const k = fusedKeeper("k", "apocalypse");
  const e1 = enemy("e1");
  const state = makeState([k], [e1]);
  state.teams.A.energy = energyFor("apocalypse");
  addShield(k, 39, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperapocalypse1", targets: [] });
  assert.equal(e1.hp, 100, "39 Shield is not enough to fire");
  assert.equal(totalShield(k), 39, "no Shield consumed");
  assert.equal(st(e1, "outgoing_damage_mod"), undefined, "no damage debuff");
});

test("apocalypse1 CONTROL: allies are not caught by the enemy-team Affliction", () => {
  const k = fusedKeeper("k", "apocalypse");
  const al = ally("al", { hp: 100 });
  const state = makeState([k, al], [enemy("e1")]);
  state.teams.A.energy = energyFor("apocalypse");
  addShield(k, 40, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperapocalypse1", targets: [] });
  assert.equal(al.hp, 100, "an ally is not on the enemy team");
});

// ###########################################################################
// # aurora — "Stellar Story" (passive) + "Colorful Characters" (active)
// ###########################################################################

test("aurora0: consuming Shield from Tales to Tell grants Keeper Elemental Essence", () => {
  const k = fusedKeeper("k", "aurora");
  const state = makeState([k], [enemy("e")]);
  state.teams.A.energy = energyFor("aurora");
  addShield(k, 40, null, k.id, 0);
  assert.equal(hasEssence(k), false, "precondition: no Essence");

  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] }); // Page-turner consumes 25
  assert.equal(totalShield(k), 15, "25 Shield was consumed");
  assert.equal(hasEssence(k), true, "successful consume -> Elemental Essence");
});

test.skip("SUSPECTED BUG aurora0: frozen grants Essence only on a SUCCESSFUL Shield consume, but the trigger fires on ANY skill Keeper uses (skillUsed, ungated on consumption) — Page-turner with <25 Shield consumes nothing yet still grants Essence", () => {
  // Page-turner with < 25 Shield: the skill is used but its consume guard fails, so no Shield is spent.
  // The frozen trigger is "whenever Keeper SUCCESSFULLY CONSUMES Shield" — a no-consume cast must not grant.
  const k = fusedKeeper("k", "aurora");
  const state = makeState([k], [enemy("e")]);
  state.teams.A.energy = energyFor("aurora");
  addShield(k, 10, null, k.id, 0); // < 25

  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(totalShield(k), 10, "no Shield consumed (guard failed)");
  assert.equal(hasEssence(k), false, "no consume -> no Essence");
});

test("aurora1: adds 20 Shield when no other ally has acted this turn", () => {
  const k = fusedKeeper("k", "aurora");
  const state = makeState([k, ally("a1"), ally("a2")], [enemy("e")]);
  state.teams.A.energy = energyFor("aurora");

  performAction(state, { unit: "k", skillId: "keeperaurora1", targets: [] });
  assert.equal(totalShield(k), 20, "base tier: 20 Shield");
});

test("aurora1: increases to 30 when one other ally has acted this turn", () => {
  const k = fusedKeeper("k", "aurora");
  const state = makeState([k, ally("a1"), ally("a2")], [enemy("e")]);
  state.teams.A.energy = energyFor("aurora");
  state.actedThisTurn = ["a1"]; // one other ally acted

  performAction(state, { unit: "k", skillId: "keeperaurora1", targets: [] });
  assert.equal(totalShield(k), 30, "one ally acted -> 30 Shield");
});

test("aurora1: increases to 45 when both allies have acted this turn", () => {
  const k = fusedKeeper("k", "aurora");
  const state = makeState([k, ally("a1"), ally("a2")], [enemy("e")]);
  state.teams.A.energy = energyFor("aurora");
  state.actedThisTurn = ["a1", "a2"]; // both allies acted

  performAction(state, { unit: "k", skillId: "keeperaurora1", targets: [] });
  assert.equal(totalShield(k), 45, "both allies acted -> 45 Shield");
});

// ###########################################################################
// # crystal — "Chronicle Fragments" (passive) + "The World Mirror" (active)
// ###########################################################################

test("crystal0: Shield broken by damage grants a Chronicle Fragments stack", () => {
  const k = fusedKeeper("k", "crystal");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 20, null, k.id, 0);
  assert.equal(frags(k), 0, "precondition: no Fragments");

  strike(state, e, k, 25, "normal"); // breaks the 20 Shield, 5 falls through
  assert.equal(totalShield(k), 0, "Shield fully broken");
  assert.equal(k.hp, 95, "5 damage fell through to HP");
  assert.equal(frags(k), 1, "a broken Shield banks one Chronicle Fragment");
});

test("crystal0 CONTROL: Shield merely dented (not broken) banks no Fragment", () => {
  const k = fusedKeeper("k", "crystal");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 20, null, k.id, 0);

  strike(state, e, k, 10, "normal"); // dents, does not break
  assert.equal(totalShield(k), 10, "Shield survives");
  assert.equal(frags(k), 0, "no break -> no Fragment");
});

test("crystal0: a Chronicle Fragment counts as 10 Shield toward a consume cost", () => {
  // 0 real Shield + 3 Fragments (=30 spendable) pays Page-turner's 25-Shield consume; 2 Fragments (=20) cannot.
  const enough = fusedKeeper("k1", "crystal");
  enough.statuses.push({ kind: "stack", name: "Chronicle Fragments", magnitude: 3, duration: null, appliedBy: "k1", appliedTurn: 0 });
  const e1 = enemy("e1");
  const s1 = makeState([enough], [e1]);
  s1.teams.A.energy = energyFor("crystal");
  performAction(s1, { unit: "k1", skillId: "keeper1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "3 Fragments (=30) cover the 25-Shield cost -> 25 damage");
  assert.equal(frags(enough), 0, "the whole Fragments needed were consumed");

  const short = fusedKeeper("k2", "crystal");
  short.statuses.push({ kind: "stack", name: "Chronicle Fragments", magnitude: 2, duration: null, appliedBy: "k2", appliedTurn: 0 });
  const e2 = enemy("e2");
  const s2 = makeState([short], [e2]);
  s2.teams.A.energy = energyFor("crystal");
  performAction(s2, { unit: "k2", skillId: "keeper1", targets: ["e2"] });
  assert.equal(e2.hp, 100, "2 Fragments (=20) < 25 -> no damage");
  assert.equal(frags(short), 2, "and the Fragments are untouched");
});

test("crystal1: adds 60 Shield, costs 1 less generic per Fragment, and consumes all Fragments", () => {
  const k = fusedKeeper("k", "crystal");
  k.statuses.push({ kind: "stack", name: "Chronicle Fragments", magnitude: 2, duration: null, appliedBy: "k", appliedTurn: 0 });
  const state = makeState([k], [enemy("e")]);
  state.teams.A.energy = { generic: 3, crystal: 0 }; // exactly 5 - 2 Fragments = 3

  const r = performAction(state, { unit: "k", skillId: "keepercrystal1", targets: [] });
  assert.equal(r.ok, true, "3 generic pays the Fragment-discounted cost (5 - 2)");
  assert.equal(totalShield(k), 60, "+60 Shield to Tales to Tell");
  assert.equal(frags(k), 0, "all Fragment stacks consumed on use");
  assert.equal(state.teams.A.energy.generic, 0, "exactly 3 generic spent");
});

test("crystal1 CONTROL: without Fragments the full 5-generic cost applies (3 is insufficient)", () => {
  const k = fusedKeeper("k", "crystal");
  const state = makeState([k], [enemy("e")]);
  state.teams.A.energy = { generic: 3, crystal: 0 };

  const r = performAction(state, { unit: "k", skillId: "keepercrystal1", targets: [] });
  assert.equal(r.ok, false, "no discount -> 3 generic cannot pay 5");
  assert.equal(r.reason, "insufficient-energy");
  assert.equal(totalShield(k), 0, "no Shield added on a failed cast");
});

// ###########################################################################
// # glacier — "Glacial Pacing" (passive) + "Iced Shelf" (active)
// ###########################################################################

test("glacier0: game starts with skill costs raised by 2, then falls 1/turn (perma) + 25 Shield/turn for 2 turns", () => {
  const k = fusedKeeper("k", "glacier");
  const state = makeState([k], [enemy("e")]);

  emit(state, { type: "roundStart" });
  assert.equal(st(k, "cost_mod")?.magnitude, 2, "starts +2 cost");
  assert.equal(totalShield(k), 0, "no Shield yet");

  // Two of Keeper's (team A) turn-ends fire the two scheduled decrements.
  endTurn(state); // A turn-end #1 (schedule not yet due)
  endTurn(state); // B turn-end
  endTurn(state); // A turn-end #2 -> first decrement fires
  assert.equal(st(k, "cost_mod")?.magnitude, 1, "after one turn: +1 cost");
  assert.equal(totalShield(k), 25, "and +25 Shield");

  endTurn(state); // B turn-end
  endTurn(state); // A turn-end #3 -> second decrement fires
  assert.equal(st(k, "cost_mod")?.magnitude, 0, "after two turns: cost penalty fully paid down");
  assert.equal(totalShield(k), 50, "and a second +25 Shield (50 total)");
});

test("glacier0 CONTROL: an un-fused Keeper has no starting cost penalty", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const state = makeState([k], [enemy("e")]);
  emit(state, { type: "roundStart" });
  assert.equal(st(k, "cost_mod"), undefined, "base Keeper carries no Glacial Pacing cost mod");
});

test("glacier1: Keeper AND the target enemy become permanently stunned (Iced Shelf)", () => {
  const k = fusedKeeper("k", "glacier");
  const e = enemy("e");
  const state = makeState([k], [e]);
  state.teams.A.energy = energyFor("glacier");

  performAction(state, { unit: "k", skillId: "keeperglacier1", targets: ["e"] });
  assert.equal(st(k, "stun")?.duration, null, "Keeper is permanently stunned");
  assert.equal(st(e, "stun")?.duration, null, "the target enemy is permanently stunned");
  assert.ok(st(k, "mark", "Iced Shelf"), "Keeper is marked Iced Shelf");
  assert.ok(st(e, "mark", "Iced Shelf"), "the enemy is marked Iced Shelf");
});

test("glacier1: a Helpful/Harmful skill used on one Iced Shelf target ends the stun for ALL of them", () => {
  const k = fusedKeeper("k", "glacier");
  const e = enemy("e");
  const state = makeState([k, ally("a1")], [e]);
  state.teams.A.energy = energyFor("glacier");
  performAction(state, { unit: "k", skillId: "keeperglacier1", targets: ["e"] });
  assert.ok(st(k, "stun") && st(e, "stun"), "both stunned to start");

  // A Harmful skill declared onto the enemy (one of the two targets) ends it for everyone.
  emit(state, { type: "skillDeclared", caster: "a1", skillId: "x", tags: ["Harmful"], targets: [e.id] });
  assert.equal(st(k, "stun"), undefined, "Keeper's stun ended too (ending it for one ends it for all)");
  assert.equal(st(e, "stun"), undefined, "the enemy's stun ended");
});

test("glacier1 CONTROL: a Strategic (non-Helpful/Harmful) skill on a target does NOT end the stun", () => {
  const k = fusedKeeper("k", "glacier");
  const e = enemy("e");
  const state = makeState([k, ally("a1")], [e]);
  state.teams.A.energy = energyFor("glacier");
  performAction(state, { unit: "k", skillId: "keeperglacier1", targets: ["e"] });

  emit(state, { type: "skillDeclared", caster: "a1", skillId: "x", tags: ["Strategic"], targets: [e.id] });
  assert.ok(st(k, "stun"), "Keeper stays stunned — only a Helpful or Harmful skill breaks it");
  assert.ok(st(e, "stun"), "the enemy stays stunned");
});

// ###########################################################################
// # lich — "Licherature" (passive) + "Tale from Beyond" (active)
// ###########################################################################

test("lich0: Keeper may no longer be healed by any source", () => {
  const k = fusedKeeper("k", "lich");
  k.hp = 50;
  const healer = ally("h");
  const state = makeState([k, healer], [enemy("e")]);
  emit(state, { type: "roundStart" }); // installs the heal_lock

  runEffects(state, [{ op: "heal", amount: 30, to: "target" }], { caster: healer, targets: [k], targeting: "single" });
  assert.equal(k.hp, 50, "the heal is blocked — Keeper cannot receive healing");
});

test("lich0 CONTROL: without Licherature the same heal lands", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  k.hp = 50;
  const healer = ally("h");
  const state = makeState([k, healer], [enemy("e")]);

  runEffects(state, [{ op: "heal", amount: 30, to: "target" }], { caster: healer, targets: [k], targeting: "single" });
  assert.equal(k.hp, 80, "a base Keeper heals normally");
});

test("lich0: Tales to Tell grants +10 additional Shield on every Shield grant it receives", () => {
  const k = fusedKeeper("k", "lich");
  const state = makeState([k], [enemy("e")]);
  emit(state, { type: "roundStart" }); // installs the shield_grant_bonus

  addShield(k, 20, null, k.id, 0);
  assert.equal(totalShield(k), 30, "a 20 grant lands as 30 (+10)");
  addShield(k, 5, null, k.id, 0);
  assert.equal(totalShield(k), 45, "and again on the next grant (+10 each activation)");
});

test("lich1: consume 25 Shield -> 30 Piercing to target, increased by 10 per dead ally", () => {
  const noDead = fusedKeeper("k1", "lich");
  const e1 = enemy("e1");
  const s1 = makeState([noDead], [e1]);
  s1.teams.A.energy = energyFor("lich");
  addShield(noDead, 25, null, noDead.id, 0);
  performAction(s1, { unit: "k1", skillId: "keeperlich1", targets: ["e1"] });
  assert.equal(e1.hp, 70, "0 dead allies -> 30 Piercing");
  assert.equal(totalShield(noDead), 0, "25 Shield consumed");

  const withDead = fusedKeeper("k2", "lich");
  const e2 = enemy("e2");
  const dead1 = ally("d1", { alive: false, hp: 0 });
  const dead2 = ally("d2", { alive: false, hp: 0 });
  const s2 = makeState([withDead, dead1, dead2], [e2]);
  s2.teams.A.energy = energyFor("lich");
  addShield(withDead, 25, null, withDead.id, 0);
  performAction(s2, { unit: "k2", skillId: "keeperlich1", targets: ["e2"] });
  assert.equal(e2.hp, 50, "2 dead allies -> 30 + 20 = 50 Piercing");
});

test("lich1 CONTROL: with <25 Shield the strike does not fire", () => {
  const k = fusedKeeper("k", "lich");
  const e = enemy("e");
  const state = makeState([k], [e]);
  state.teams.A.energy = energyFor("lich");
  addShield(k, 24, null, k.id, 0);
  performAction(state, { unit: "k", skillId: "keeperlich1", targets: ["e"] });
  assert.equal(e.hp, 100, "24 Shield is not enough");
  assert.equal(totalShield(k), 24, "no Shield consumed");
});

// ###########################################################################
// # myth — "Wise Old Man" (passive) + "Mentorship" (active)
// ###########################################################################

test("myth0: Keeper's Shield no longer prevents damage to him (falls straight through to HP)", () => {
  const k = fusedKeeper("k", "myth");
  const e = enemy("e");
  const state = makeState([k], [e]);
  emit(state, { type: "roundStart" }); // installs shield_non_absorbing
  addShield(k, 30, null, k.id, 0);

  strike(state, e, k, 20, "normal");
  assert.equal(k.hp, 80, "20 damage hit HP directly");
  assert.equal(totalShield(k), 30, "the Shield pool is untouched (a pure resource now)");
});

test("myth0 CONTROL: a base Keeper's Shield DOES absorb the same hit", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 30, null, k.id, 0);

  strike(state, e, k, 20, "normal");
  assert.equal(k.hp, 100, "HP protected");
  assert.equal(totalShield(k), 10, "Shield absorbed the 20");
});

test("myth0: on Keeper's death allies split his Shield, each share rounded up to the nearest 5", () => {
  const k = fusedKeeper("k", "myth");
  const a1 = ally("a1");
  const a2 = ally("a2");
  const state = makeState([k, a1, a2], [enemy("e")]);
  addShield(k, 45, null, k.id, 0); // 45 / 2 allies = 22.5 -> rounds up to 25

  emit(state, { type: "unitDied", unit: k.id, killer: "e" });
  assert.equal(totalShield(a1), 25, "ally 1 gets ceil(22.5 -> 25) Shield");
  assert.equal(totalShield(a2), 25, "ally 2 gets 25 Shield");
});

test("myth1: target ally gains +5 damage and +5 Damage Reduction for 3 turns", () => {
  const k = fusedKeeper("k", "myth");
  const a1 = ally("a1");
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("myth");

  performAction(state, { unit: "k", skillId: "keepermyth1", targets: ["a1"] });
  const dmg = st(a1, "outgoing_damage_mod");
  const dr = st(a1, "damage_reduction");
  assert.equal(dmg?.magnitude, 5, "+5 outgoing damage");
  assert.equal(dmg?.duration, 3, "for 3 turns");
  assert.equal(dr?.magnitude, 5, "+5 Damage Reduction");
  assert.equal(dr?.duration, 3, "for 3 turns");
});

test("myth1: a Mentored ally gains Elemental Essence when it deals damage", () => {
  const k = fusedKeeper("k", "myth");
  const a1 = ally("a1");
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("myth");
  performAction(state, { unit: "k", skillId: "keepermyth1", targets: ["a1"] });
  assert.equal(hasEssence(a1), false, "no Essence yet");

  emit(state, { type: "damageDealt", source: a1.id, target: "e", amount: 10, dtype: "normal" });
  assert.equal(hasEssence(a1), true, "dealing damage while Mentored grants Essence");
});

test("myth1: a Mentored ally gains Elemental Essence when it is dealt damage", () => {
  const k = fusedKeeper("k", "myth");
  const a1 = ally("a1");
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("myth");
  performAction(state, { unit: "k", skillId: "keepermyth1", targets: ["a1"] });

  emit(state, { type: "damageDealt", source: "e", target: a1.id, amount: 10, dtype: "normal" });
  assert.equal(hasEssence(a1), true, "being dealt damage while Mentored grants Essence");
});

test("myth1 CONTROL: an UN-Mentored ally dealing damage gains no Essence", () => {
  const k = fusedKeeper("k", "myth");
  const a1 = ally("a1");
  const a2 = ally("a2"); // not Mentored
  const state = makeState([k, a1, a2], [enemy("e")]);
  state.teams.A.energy = energyFor("myth");
  performAction(state, { unit: "k", skillId: "keepermyth1", targets: ["a1"] });

  emit(state, { type: "damageDealt", source: a2.id, target: "e", amount: 10, dtype: "normal" });
  assert.equal(hasEssence(a2), false, "the Mentorship grant is scoped to the target ally");
});

// ###########################################################################
// # night — "Reading in the Dark" (passive) + "Tale of Endless Night" (active)
// ###########################################################################

test("night0: any Invisible skill used banks 10 Shield on Tales to Tell", () => {
  const k = fusedKeeper("k", "night");
  const state = makeState([k], [enemy("e")]);

  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [], hidden: true });
  assert.equal(totalShield(k), 10, "an Invisible skill -> +10 Shield");
});

test("night0 CONTROL: a visible skill banks nothing", () => {
  const k = fusedKeeper("k", "night");
  const state = makeState([k], [enemy("e")]);

  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [], hidden: false });
  assert.equal(totalShield(k), 0, "a visible skill grants no Shield");
});

test("night1: for 2 turns the whole allied team's skills are Invisible (cloak), Keeper included", () => {
  const k = fusedKeeper("k", "night");
  const a1 = ally("a1");
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("night");

  performAction(state, { unit: "k", skillId: "keepernight1", targets: [] });
  const kc = st(k, "cloak");
  const ac = st(a1, "cloak");
  assert.ok(kc, "Keeper is cloaked (Invisible)");
  assert.equal(kc!.duration, 2, "for 2 turns");
  assert.ok(ac, "the ally is cloaked too (whole allied team)");
});

test("night1 CONTROL: the enemy team is not made Invisible", () => {
  const k = fusedKeeper("k", "night");
  const e = enemy("e");
  const state = makeState([k], [e]);
  state.teams.A.energy = energyFor("night");

  performAction(state, { unit: "k", skillId: "keepernight1", targets: [] });
  assert.equal(st(e, "cloak"), undefined, "only the allied team is cloaked");
});

// ###########################################################################
// # prism — "Blinding Reveal" (passive) + "Tale of the Coming Dawn" (active)
// ###########################################################################

test("prism0: when Tales to Tell is broken by damage, the attacker is Blinded for 2 turns", () => {
  const k = fusedKeeper("k", "prism");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 20, null, k.id, 0);

  strike(state, e, k, 25, "normal"); // breaks the Shield
  assert.equal(totalShield(k), 0, "Shield broken");
  const b = st(e, "blind");
  assert.ok(b, "the attacker is Blinded");
  assert.equal(b!.duration, 2, "for 2 turns");
});

test("prism0 CONTROL: a hit that does not break the Shield does not Blind", () => {
  const k = fusedKeeper("k", "prism");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 20, null, k.id, 0);

  strike(state, e, k, 10, "normal"); // dents only
  assert.equal(st(e, "blind"), undefined, "no break -> no Blind");
});

test("prism1: consume 40 Shield -> heal all allies (incl. Keeper) 25", () => {
  const k = fusedKeeper("k", "prism");
  k.hp = 50;
  const a1 = ally("a1", { hp: 50 });
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("prism");
  addShield(k, 40, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperprism1", targets: [] });
  assert.equal(k.hp, 75, "Keeper healed 25 (all allies includes self)");
  assert.equal(a1.hp, 75, "the ally healed 25");
  assert.equal(totalShield(k), 0, "40 Shield consumed");
});

test("prism1 CONTROL: with <40 Shield no one is healed and no Shield is spent", () => {
  const k = fusedKeeper("k", "prism");
  k.hp = 50;
  const a1 = ally("a1", { hp: 50 });
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("prism");
  addShield(k, 39, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperprism1", targets: [] });
  assert.equal(a1.hp, 50, "no heal");
  assert.equal(totalShield(k), 39, "no Shield consumed");
});

// ###########################################################################
// # stasis — "Modernization" (passive) + "Tale of a Distant Future" (active)
// ###########################################################################

test("stasis0: while Shield remains, Keeper ignores indirect (Affliction) damage from all sources", () => {
  const k = fusedKeeper("k", "stasis");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 30, null, k.id, 0);
  emit(state, { type: "roundStart" }); // installs the ignore while Shield > 0

  strike(state, e, k, 15, "affliction");
  assert.equal(k.hp, 100, "Affliction (indirect) is ignored while Shielded");
});

test("stasis0 CONTROL: with no Shield, indirect damage lands normally", () => {
  const k = fusedKeeper("k", "stasis");
  const e = enemy("e");
  const state = makeState([k], [e]);
  emit(state, { type: "roundStart" }); // Shield is 0 -> no ignore installed

  strike(state, e, k, 15, "affliction");
  assert.equal(k.hp, 85, "no Shield -> the indirect hit lands");
});

test("stasis0: the protection is 'indirect' only — a direct hit still reaches Keeper", () => {
  const k = fusedKeeper("k", "stasis");
  const e = enemy("e");
  const state = makeState([k], [e]);
  addShield(k, 30, null, k.id, 0);
  emit(state, { type: "roundStart" });

  strike(state, e, k, 40, "normal"); // 30 absorbed, 10 through — direct damage is not ignored
  assert.equal(k.hp, 90, "a direct normal hit is not ignored");
});

test("stasis1: consume 35 Shield -> a permanent 5-Affliction-per-turn tick lands on EVERY character", () => {
  const k = fusedKeeper("k", "stasis");
  const a1 = ally("a1");
  const e1 = enemy("e1");
  const state = makeState([k, a1], [e1]);
  state.teams.A.energy = energyFor("stasis");
  addShield(k, 40, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperstasis1", targets: [] });
  assert.equal(totalShield(k), 5, "35 Shield consumed (40 -> 5)");
  for (const u of [k, a1, e1]) assert.ok(st(u, "dot", "Tale of a Distant Future"), `${u.id} carries the DoT (every character)`);

  // A tick on the applier's (team A) next turn deals 5 to each character.
  state.turn = 2;
  tickDots(state, "A");
  assert.equal(a1.hp, 95, "ally takes 5 Affliction");
  assert.equal(e1.hp, 95, "enemy takes 5 Affliction");
  assert.equal(k.hp, 95, "even Keeper takes 5 (every character)");
});

test("stasis1: Tale of a Distant Future stacks — a second cast accumulates to 10/turn", () => {
  const k = fusedKeeper("k", "stasis");
  const e1 = enemy("e1");
  const state = makeState([k], [e1]);
  state.teams.A.energy = energyFor("stasis");
  addShield(k, 100, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperstasis1", targets: [] });
  const sk = (k.skills ?? []).find((s) => s.id === "keeperstasis1")!;
  sk.currentCd = 0; // clear cooldown to recast this turn
  performAction(state, { unit: "k", skillId: "keeperstasis1", targets: [] });

  state.turn = 2;
  const before = e1.hp;
  tickDots(state, "A");
  assert.equal(before - e1.hp, 10, "two casts stack to 10 Affliction/turn");
});

// ###########################################################################
// # winter — "Crackling Hearth" (passive) + "A Tale of Joy and Wonder" (active)
// ###########################################################################

test.skip("SUSPECTED BUG winter0 (Crackling Hearth): frozen heals a random allied hero 10 whenever Shield is added to Tales to Tell, but this passive is UNIMPLEMENTED — the winter form's only trigger implements winter1's Essence window, and there is no 'shield added' event/hook at all, so no heal fires", () => {
  const k = fusedKeeper("k", "winter");
  const a1 = ally("a1", { hp: 90 });
  const state = makeState([k, a1], [enemy("e")]);

  // Any Shield grant to Keeper's pool should trigger a 10 heal on a random allied hero.
  runEffects(state, [{ op: "grantShield", amount: 20, to: "self" }], { caster: k, self: k, targets: [k], targeting: "self" });
  assert.equal(a1.hp, 100, "the allied hero was healed 10 when Shield was added");
});

test("winter1: consume 25 Shield -> allies are marked, and a marked ally using a skill gains Essence", () => {
  const k = fusedKeeper("k", "winter");
  const a1 = ally("a1");
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("winter");
  addShield(k, 25, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperwinter1", targets: [] });
  assert.equal(totalShield(k), 0, "25 Shield consumed");
  assert.ok(st(a1, "mark", "A Tale of Joy and Wonder"), "the ally is marked for the window");

  emit(state, { type: "skillUsed", caster: a1.id, skillId: "x", targets: [], tags: [] });
  assert.equal(hasEssence(a1), true, "a marked ally using a skill gains Elemental Essence");
});

test("winter1 CONTROL: with <25 Shield nothing is consumed and no ally is marked", () => {
  const k = fusedKeeper("k", "winter");
  const a1 = ally("a1");
  const state = makeState([k, a1], [enemy("e")]);
  state.teams.A.energy = energyFor("winter");
  addShield(k, 24, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeperwinter1", targets: [] });
  assert.equal(totalShield(k), 24, "no Shield consumed");
  assert.equal(st(a1, "mark", "A Tale of Joy and Wonder"), undefined, "no mark applied");

  emit(state, { type: "skillUsed", caster: a1.id, skillId: "x", targets: [], tags: [] });
  assert.equal(hasEssence(a1), false, "an unmarked ally gains no Essence");
});

test("winter1 CONTROL: an unmarked unit (enemy) using a skill grants no Essence", () => {
  const k = fusedKeeper("k", "winter");
  const a1 = ally("a1");
  const e = enemy("e");
  const state = makeState([k, a1], [e]);
  state.teams.A.energy = energyFor("winter");
  addShield(k, 25, null, k.id, 0);
  performAction(state, { unit: "k", skillId: "keeperwinter1", targets: [] });

  emit(state, { type: "skillUsed", caster: e.id, skillId: "x", targets: [], tags: [] });
  assert.equal(hasEssence(e), false, "the enemy is not one of Keeper's allies");
});
