/**
 * Behavior tests for Hector the Injector — asserted against the frozen skill prose
 * (game/content/frozen/skills.json). Base kit: hector0 (passive) + hector1..hector5.
 * Hector's whole kit revolves around Dennis the Apprentice, the minion summoned each round.
 *
 * Oracle text:
 *  hector0 Dennis the Apprentice: "At the start of each round, Hector summons Dennis the Apprentice.
 *                                  Whenever Hector uses a Serum skill on Dennis, he gains Elemental Essence."
 *  hector1 Burning Blood Serum: "Injects Dennis with Burning Blood Serum, increasing his damage dealt by 10
 *                                for 3 turns. This effect stacks, but Dennis takes 10 damage per turn per stack."
 *  hector2 Stoneseal Serum: "Injects Dennis with Stoneseal Serum, healing him for 10 health per turn for 3 turns,
 *                            but increasing his skill costs by 1 Generic energy."
 *  hector3 Mindfog Serum: "Injects Dennis with Mindfog Serum, increasing his cooldowns by 1 and making him
 *                          ignore stuns and counters for 3 turns. During this time, Lumbering Smash will stun
 *                          its targets non-Strategic skills for 1 turn."
 *  hector4 Protect Me!: "Reflects all harmful skills used on Hector to Dennis for 1 turn. This skill is invisible."
 *  hector5 Serum Overload: "Refreshes the duration of all Serums affecting Dennis to 3 turns, and removes their
 *                           negative effects. If Dennis is dead and he was a minion when he died, he returns to
 *                           life with 50HP."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, canUse, performAction, startTurn, endTurn } from "../skillHarness.ts";
import type { MatchState, Unit } from "../../src/types.ts";

const A = ["hector", "pyrrha", "jarrik"];
const B = ["jarrik", "saya", "keeper"];
const dennisOf = (s: MatchState): Unit =>
  Object.values(s.units).find((u) => u.kind === "minion" && u.team === "A" && u.name === "Dennis the Apprentice")!;
const named = (u: Unit, kind: string, name: string) => u.statuses.find((x) => x.kind === kind && x.name === name);
// Advance the clock to Hector's (team A) NEXT turn-end so his dots/regen tick once
// (the applier's birth turn is skipped by design). Leaves team B active afterwards.
const nextHectorTick = (s: MatchState) => { endTurn(s); startTurn(s); endTurn(s); startTurn(s); endTurn(s); };
// Hand control back to team A so Hector can act.
const backToHector = (s: MatchState) => { endTurn(s); startTurn(s); };

// ---------------------------------------------------------------- passive

test("hector0 — summons Dennis the Apprentice at the start of the round", () => {
  const s = battle(A, B);
  const d = dennisOf(s);
  assert.ok(d, "Dennis exists");
  assert.equal(d.kind, "minion", "Dennis is a minion");
  assert.equal(d.maxHp, 80, "Dennis the Apprentice has 80 max HP");
});

test("hector0 — using a Serum on Dennis grants Hector Elemental Essence", () => {
  const s = battle(A, B);
  const h = unit(s, "a1");
  assert.equal(hasStatus(h, "elemental_essence"), false, "no essence before injecting");
  performAction(s, { unit: "a1", skillId: "hector1", targets: [dennisOf(s).id] });
  assert.ok(hasStatus(h, "elemental_essence"), "injecting a Serum on Dennis grants Elemental Essence");
});

// ---------------------------------------------------------------- hector1 Burning Blood Serum

test("hector1 — +10 damage dealt for 3 turns, and a 10/turn self-dot (1 stack)", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector1", targets: [did] });
  const d = unit(s, did);
  const buff = named(d, "outgoing_damage_mod", "Burning Blood Serum");
  assert.ok(buff && buff.magnitude === 10, "damage dealt increased by 10");
  assert.equal(buff!.duration, 3, "for 3 turns");
  const dot = named(d, "dot", "Burning Blood Serum");
  assert.ok(dot && dot.magnitude === 10, "10 damage per turn per stack (1 stack -> 10)");
  assert.equal(skillOf(unit(s, "a1"), "hector1").currentCd, 2, "cooldown 2");
});

test("hector1 — the self-dot actually deals 10 to Dennis at turn end", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector1", targets: [did] });
  const before = unit(s, did).hp;
  nextHectorTick(s); // Hector (applier) next turn-end ticks his dot on Dennis
  assert.equal(unit(s, did).hp, before - 10, "Dennis loses 10 to the Burning Blood dot");
});

test("hector1 — stacks: a second injection makes it +20 damage and a 20/turn dot", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector1", targets: [did] });
  skillOf(unit(s, "a1"), "hector1").currentCd = 0; // bypass cooldown to stack again this turn
  performAction(s, { unit: "a1", skillId: "hector1", targets: [did] });
  const d = unit(s, did);
  assert.equal(stackMag(d, "Burning Blood Serum"), 2, "two stacks accumulated");
  assert.equal(named(d, "outgoing_damage_mod", "Burning Blood Serum")!.magnitude, 20, "+10 per stack -> +20");
  assert.equal(named(d, "dot", "Burning Blood Serum")!.magnitude, 20, "10/turn per stack -> 20");
});

// ---------------------------------------------------------------- hector2 Stoneseal Serum

test("hector2 — heals Dennis 10/turn for 3 turns but raises his skill costs by 1 Generic", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector2", targets: [did] });
  const d = unit(s, did);
  const regen = named(d, "regen", "Stoneseal Serum");
  assert.ok(regen && regen.magnitude === 10, "heals 10 per turn");
  assert.equal(regen!.duration, 3, "for 3 turns");
  const cm = named(d, "cost_mod", "Stoneseal Serum");
  assert.ok(cm && cm.magnitude === 1, "skill costs increased by 1 Generic energy");
});

test("hector2 — the regen actually heals Dennis 10 at turn end", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  unit(s, did).hp = 50; // give the heal room
  performAction(s, { unit: "a1", skillId: "hector2", targets: [did] });
  nextHectorTick(s);
  assert.equal(unit(s, did).hp, 60, "Dennis heals 10 from Stoneseal");
});

// ---------------------------------------------------------------- hector3 Mindfog Serum

test("hector3 — makes Dennis ignore stuns and counters for 3 turns", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector3", targets: [did] });
  const d = unit(s, did);
  const ndi = d.statuses.find((x) => x.kind === "non_damage_ignore");
  assert.ok(ndi, "ignores stuns (harmful non-damage effects)");
  assert.equal(ndi!.duration, 3, "for 3 turns");
  const unc = d.statuses.find((x) => x.kind === "uncounterable");
  assert.ok(unc && unc.duration === 3, "ignores counters for 3 turns");
  assert.ok(named(d, "mark", "Mindfog Serum"), "carries the Mindfog Serum mark");
});

test("hector3 — during Mindfog, Lumbering Smash stuns the target's non-Strategic skills 1t", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector3", targets: [did] });
  performAction(s, { unit: did, skillId: "dennis", targets: ["b1"] });
  const st = unit(s, "b1").statuses.find((x) => x.kind === "stun");
  assert.ok(st, "Lumbering Smash stuns the target under Mindfog");
  assert.equal(st!.scope?.tag, "Strategic", "keyed on Strategic");
  assert.equal(st!.scope?.mode, "except", "stuns non-Strategic skills");
  assert.equal(st!.duration, 1, "for 1 turn");
  assert.equal(unit(s, "b1").hp, 90, "and still deals its 10 damage");
});

test("hector3 — WITHOUT Mindfog, Lumbering Smash deals 10 and applies no stun", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: did, skillId: "dennis", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 damage");
  assert.equal(unit(s, "b1").statuses.find((x) => x.kind === "stun"), undefined, "no stun without Mindfog");
});

// ---------------------------------------------------------------- hector4 Protect Me!

test("hector4 — harmful skills used on Hector are redirected to Dennis for 1 turn", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector4" }); // self-cast, applies the reflect mark
  assert.ok(named(unit(s, "a1"), "mark", "Protect Me!"), "Protect Me! mark applied to Hector");
  const hHpBefore = unit(s, "a1").hp;
  const dHpBefore = unit(s, did).hp;
  // Enemy jarrik uses Nightwrap-style single-target hit (jarrik1: 10 dmg) on Hector.
  performAction(s, { unit: "b1", skillId: "jarrik1", targets: ["a1"] });
  assert.equal(unit(s, "a1").hp, hHpBefore, "Hector takes no damage — the skill was reflected");
  assert.equal(unit(s, did).hp, dHpBefore - 10, "Dennis takes the reflected 10 damage");
});

// ---------------------------------------------------------------- hector5 Serum Overload

test("hector5 — refreshes Serum durations to 3 and strips their negative effects", () => {
  const s = battle(A, B);
  const did = dennisOf(s).id;
  performAction(s, { unit: "a1", skillId: "hector1", targets: [did] }); // Burning Blood: +10 buff (good) + dot (bad)
  // Age the serum: one Hector turn-end drops its remaining duration below 3.
  nextHectorTick(s);
  const midDur = named(unit(s, did), "outgoing_damage_mod", "Burning Blood Serum")?.duration;
  assert.ok(midDur !== undefined && midDur! < 3, "serum has aged below 3 turns");
  // Return control to A so Hector can act.
  backToHector(s);
  performAction(s, { unit: "a1", skillId: "hector5" });
  const d = unit(s, did);
  assert.equal(named(d, "outgoing_damage_mod", "Burning Blood Serum")!.duration, 3, "buff duration refreshed to 3");
  assert.equal(named(d, "dot", "Burning Blood Serum"), undefined, "the negative self-dot is removed");
  assert.equal(skillOf(unit(s, "a1"), "hector5").currentCd, 3, "cooldown 3");
});

test("hector5 — revives a dead minion Dennis with 50 HP", () => {
  const s = battle(A, B);
  const d0 = dennisOf(s);
  d0.hp = 0;
  d0.alive = false;
  performAction(s, { unit: "a1", skillId: "hector5" });
  const d = dennisOf(s);
  assert.ok(d.alive, "Dennis is revived");
  assert.equal(d.hp, 50, "returns to life with 50 HP");
});
