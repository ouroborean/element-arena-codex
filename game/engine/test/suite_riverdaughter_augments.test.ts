import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + triggers + augment customs
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// =====================================================================================================
// The River Daughter — AUGMENTS behavioral suite, derived from the FROZEN PROSE (content/frozen/augments.json).
// The frozen text is the oracle; authored/generated content was consulted only to learn how to DRIVE
// (augment ids, which base skill each touches, status/mark names).
//
//  riverdaughter1 Crushing Depths : "Enemies who have been stunned by Undertow take 10 affliction damage
//                                     each turn for the rest of the game."
//  riverdaughter2 Balm            : "When Soothe expires, it will attempt to jump to an ally that doesn't
//                                     currently have it."
//  riverdaughter3 Trickster Clone : "If River Clone expires without being triggered, it will attempt to jump
//                                     to an ally that doesn't currently have it."
//  riverdaughter4 Restorative Retreat : "River Daughter heals 20 health for 2 turns when she uses Dive."
//  riverdaughter5 River Within    : "Whenever River Clone is triggered, River Daughter casts Ripple."
//
// Base-kit facts used as scaffolding (frozen skills.json riverdaughter1..5, proven by suite_riverdaughter_base):
//  - Ripple (riverdaughter1): 10 dmg to the enemy team; primes Undertow to stun its target next turn.
//  - Undertow (riverdaughter2): 20 dmg to one enemy (stuns only when Ripple-primed).
//  - River Clone (riverdaughter3): installs an invisible counter (a "River Clone" mark on the target enemy)
//    that counters the first harmful skill that enemy uses.
//  - Soothe (riverdaughter4): 10/turn regen for 2 turns on an ally (status kind "regen", name "Soothe").
//  - Dive (riverdaughter5): self-invulnerable 1 turn; next turn upgrades Ripple/Undertow/River Clone.
//  River Daughter's Specific cost is paid from the Water pool.
// =====================================================================================================

/** Pay pools: plenty of Generic + Water so a legal cast is never energy-starved unless a test says so. */
const fullPay = () => ({ generic: 40, water: 40 });

/** A synthetic enemy attack (0 cost) used to drive counters. */
const attack = (dmg: number) =>
  skill("atk", [{ op: "damage", amount: dmg, to: "target" }], { tags: ["Harmful", "Instant"], cooldown: 0 });
/** A synthetic enemy Helpful (self-targeted, 0 cost) — must NOT be countered by River Clone. */
const helpfulSelf = () => skill("bless", [], { tags: ["Helpful", "Instant"], targeting: "self", cooldown: 0 });

type S = Unit["statuses"][number];
const regenOf = (u: Unit, name: string): S | undefined => u.statuses.find((s) => s.kind === "regen" && s.name === name);
const dotOf = (u: Unit, name: string): S | undefined => u.statuses.find((s) => s.kind === "dot" && s.name === name);
const stunOf = (u: Unit): S | undefined => u.statuses.find((s) => s.kind === "stun");
const cloneMark = (u: Unit): S | undefined => u.statuses.find((s) => s.kind === "mark" && s.name === "River Clone");
const sootheHolders = (units: Unit[]) => units.filter((u) => !!regenOf(u, "Soothe"));

/** Advance whole turns (endTurn hands over + ticks dots/durations/scheduled/expiries). */
function advance(state: ReturnType<typeof makeState>, n: number): void {
  for (let i = 0; i < n; i++) endTurn(state);
}

/** River Daughter (+ optional augment) with a chosen number of allies/enemies, energy pre-paid. */
function setup(opts: { augment?: string; allies?: number; enemies?: number } = {}) {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  if (opts.augment) applyAugment(rd, augmentById(opts.augment)!);
  const aUnits: Unit[] = [rd];
  const allies: Unit[] = [];
  for (let i = 0; i < (opts.allies ?? 0); i++) {
    const a = makeUnit({ id: `a${i + 2}`, team: "A", name: `Ally${i + 1}`, hp: 100, maxHp: 100 });
    allies.push(a);
    aUnits.push(a);
  }
  const enemies: Unit[] = [];
  for (let i = 0; i < (opts.enemies ?? 1); i++) {
    enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", name: `Enemy${i + 1}`, hp: 100, maxHp: 100 }));
  }
  const state = makeState(aUnits, enemies);
  state.teams.A.energy = fullPay();
  return { state, rd, allies, enemies };
}

/** Drive the base Ripple->Undertow stun combo (River Daughter's only stun path). Leaves state on RD's turn. */
function stunFirstEnemy(state: ReturnType<typeof makeState>): void {
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple primes the stun
  advance(state, 2); // hand A->B->A; the primed Undertow lands on River Daughter's following turn
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // Undertow: 20 dmg + stun
}

// -----------------------------------------------------------------------------------------------------
// riverdaughter1 — Crushing Depths: "Enemies who have been stunned by Undertow take 10 affliction damage
// each turn for the rest of the game."
// -----------------------------------------------------------------------------------------------------
test("Crushing Depths: an Undertow-stun attaches a permanent 10 affliction damage-over-time to the stunned enemy", () => {
  const { state, enemies } = setup({ augment: "riverdaughter1", enemies: 1 });
  stunFirstEnemy(state);
  const e1 = enemies[0]!;
  assert.ok(stunOf(e1), "the Ripple-primed Undertow stunned the enemy");
  const dot = dotOf(e1, "Crushing Depths");
  assert.ok(dot, "a 'Crushing Depths' damage-over-time is attached to the stunned enemy");
  assert.equal(dot!.magnitude, 10, "it deals 10 per turn");
  assert.equal(dot!.dtype, "affliction", "the damage is Affliction");
  assert.equal(dot!.duration, null, "'for the rest of the game' = a non-expiring (permanent) effect");
});

test("Crushing Depths deals 10 EACH TURN and keeps ticking for many turns (the rest of the game)", () => {
  const { state, enemies } = setup({ augment: "riverdaughter1", enemies: 1 });
  stunFirstEnemy(state);
  const e1 = enemies[0]!;
  const afterCast = e1.hp; // 100 - 10 (Ripple) - 20 (Undertow) = 70
  assert.equal(afterCast, 70, "Ripple(10) + Undertow(20) already dealt 30; the DoT has not ticked yet");
  advance(state, 3); // reach River Daughter's next turn-end -> one DoT tick
  assert.equal(e1.hp, afterCast - 20, "two ticks (apply-turn + next): 20 affliction damage");
  advance(state, 2); // next River Daughter turn-end -> another tick
  assert.equal(e1.hp, afterCast - 30, "another tick: 10 more");
  advance(state, 2);
  assert.equal(e1.hp, afterCast - 40, "another tick: still 10 (the DoT did not expire after a couple turns)");
});

test("Crushing Depths damage is Affliction — it bypasses a Shield (deals HP damage through it)", () => {
  const { state, enemies } = setup({ augment: "riverdaughter1", enemies: 1 });
  stunFirstEnemy(state);
  const e1 = enemies[0]!;
  assert.ok(dotOf(e1, "Crushing Depths"), "the DoT is installed");
  e1.shields.push({ amount: 50, duration: null, appliedBy: "x", appliedTurn: 0 });
  const hpBefore = e1.hp;
  const shieldBefore = e1.shields.reduce((n, s) => n + s.amount, 0);
  advance(state, 3); // one DoT tick while shielded
  assert.equal(e1.hp, hpBefore - 20, "the affliction damage (two ticks, 20) went straight to HP");
  assert.equal(e1.shields.reduce((n, s) => n + s.amount, 0), shieldBefore, "the Shield was not touched (affliction bypasses it)");
});

test("Crushing Depths does NOT fire when Undertow does not stun (no Ripple prime -> no stun -> no DoT)", () => {
  const { state, enemies } = setup({ augment: "riverdaughter1", enemies: 1 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // plain Undertow, unprimed
  assert.equal(r.ok, true);
  const e1 = enemies[0]!;
  assert.equal(stunOf(e1), undefined, "no stun without a preceding Ripple");
  assert.equal(dotOf(e1, "Crushing Depths"), undefined, "and therefore no Crushing Depths DoT ('stunned BY Undertow' is required)");
  assert.equal(e1.hp, 80, "only Undertow's own 20 damage landed");
});

test("Crushing Depths marks ONLY the stunned enemy — a non-stunned enemy takes no DoT", () => {
  const { state, enemies } = setup({ augment: "riverdaughter1", enemies: 2 });
  stunFirstEnemy(state); // Undertow (single target) stuns e1 only; Ripple hit both for 10
  const [e1, e2] = enemies as [Unit, Unit];
  assert.ok(stunOf(e1), "e1 is stunned");
  assert.equal(stunOf(e2), undefined, "e2 was hit by Ripple but not stunned by the single-target Undertow");
  assert.ok(dotOf(e1, "Crushing Depths"), "e1 carries the DoT");
  assert.equal(dotOf(e2, "Crushing Depths"), undefined, "e2 carries no DoT");
  const e2Hp = e2.hp; // 90 (Ripple only)
  advance(state, 3);
  assert.equal(e2.hp, e2Hp, "e2 takes no per-turn affliction damage (never stunned by Undertow)");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter2 — Balm: "When Soothe expires, it will attempt to jump to an ally that doesn't currently
// have it."
// -----------------------------------------------------------------------------------------------------
test("Balm: when Soothe expires it JUMPS to an ally (the regen is preserved on the team, not lost)", () => {
  const { state, rd, allies } = setup({ augment: "riverdaughter2", allies: 2, enemies: 1 });
  const [a2] = allies as [Unit, Unit];
  a2.hp = 70; // 60..99: keeps this about the jump, not Essence
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] }); // Soothe onto a2 only
  assert.equal(sootheHolders([rd, ...allies]).length, 1, "exactly a2 holds Soothe at the start");
  advance(state, 5); // Soothe (10/2) expires at River Daughter's second following turn-end
  const holders = sootheHolders([rd, ...allies]);
  assert.equal(holders.length, 1, "Soothe survived the expiry by jumping — still exactly one holder on the team");
  assert.equal(!!regenOf(holders[0]!, "Soothe"), true);
  assert.equal(holders[0]!.id === "a2", false, "it jumped to a DIFFERENT ally (a2 no longer holds it)");
});

test("Balm control: WITHOUT the augment, an expiring Soothe simply vanishes (no jump)", () => {
  const { state, rd, allies } = setup({ allies: 2, enemies: 1 }); // no augment
  const [a2] = allies as [Unit, Unit];
  a2.hp = 70;
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  advance(state, 5);
  assert.equal(sootheHolders([rd, ...allies]).length, 0, "with no Balm, Soothe is gone after it expires (it did not jump)");
});

test("Balm: the jump targets an ally that does NOT already have Soothe (it never piles onto a holder)", () => {
  // rd + a2 + a3, all team A. a3 already holds a MARKER Soothe (magnitude 7, permanent) and rd holds one too,
  // so the only ally lacking Soothe once a2's expires is a2 itself -> the jump must land on a2, leaving the
  // pre-existing holders untouched (an over-eager reapply would refresh a holder's magnitude to 10).
  const { state, rd, allies } = setup({ augment: "riverdaughter2", allies: 2, enemies: 1 });
  const [a2, a3] = allies as [Unit, Unit];
  const marker = (u: Unit) => u.statuses.push({ kind: "regen", name: "Soothe", magnitude: 7, duration: null, appliedBy: "rd", appliedTurn: 0 } as S);
  marker(rd);
  marker(a3);
  a2.statuses.push({ kind: "regen", name: "Soothe", magnitude: 10, duration: 2, appliedBy: "rd", appliedTurn: 1 } as S);
  advance(state, 5); // a2's finite Soothe expires; the permanent markers never do
  assert.equal(regenOf(rd, "Soothe")?.magnitude, 7, "rd's existing Soothe was not overwritten (it already had it)");
  assert.equal(regenOf(a3, "Soothe")?.magnitude, 7, "a3's existing Soothe was not overwritten (it already had it)");
  assert.equal(regenOf(a2, "Soothe")?.magnitude, 10, "the jump landed on a2, the only ally that lacked Soothe");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter3 — Trickster Clone: "If River Clone expires without being triggered, it will attempt to
// jump to an ally that doesn't currently have it."
// -----------------------------------------------------------------------------------------------------
test("Trickster Clone: a River Clone mark that expires unused JUMPS onto an ally that lacks it", () => {
  const { state, rd, allies, enemies } = setup({ augment: "riverdaughter3", allies: 2, enemies: 1 });
  const e1 = enemies[0]!;
  // A River Clone counter that is never triggered lapses naturally -> statusExpired.
  e1.statuses.push({ kind: "mark", name: "River Clone", duration: 1, appliedBy: "rd", appliedTurn: 1 } as S);
  advance(state, 3); // the finite mark expires at River Daughter's following turn-end
  assert.equal(cloneMark(e1), undefined, "the mark is gone from the enemy (it expired)");
  const allyHolders = [rd, ...allies].filter((u) => !!cloneMark(u));
  assert.equal(allyHolders.length, 1, "the expiring River Clone jumped to exactly one ally");
});

test("Trickster Clone: the jump goes to the ally WITHOUT the mark, not one that already carries it", () => {
  // a2 and a3 already carry a (permanent) River Clone mark; rd does not. When a fresh mark expires unused,
  // rd is the only ally lacking it, so the jump must land on rd.
  const { state, rd, allies, enemies } = setup({ augment: "riverdaughter3", allies: 2, enemies: 1 });
  const [a2, a3] = allies as [Unit, Unit];
  a2.statuses.push({ kind: "mark", name: "River Clone", duration: null, appliedBy: "rd", appliedTurn: 0 } as S);
  a3.statuses.push({ kind: "mark", name: "River Clone", duration: null, appliedBy: "rd", appliedTurn: 0 } as S);
  enemies[0]!.statuses.push({ kind: "mark", name: "River Clone", duration: 1, appliedBy: "rd", appliedTurn: 1 } as S);
  advance(state, 3);
  assert.ok(cloneMark(rd), "the jump landed on rd, the only ally that lacked the mark");
  assert.ok(cloneMark(a2), "a2 still carries its mark (not disturbed)");
  assert.ok(cloneMark(a3), "a3 still carries its mark (not disturbed)");
});

test("Trickster Clone control: a River Clone that IS triggered (its counter fires) does NOT jump", () => {
  // Frozen gates the jump on "expires WITHOUT being triggered". A real counter consumes the mark by explicit
  // removal (statusLost), not natural expiry (statusExpired) — so no jump.
  const { state, rd, allies } = setup({ augment: "riverdaughter3", allies: 1, enemies: 1 });
  const enemy = state.units["e1"]!;
  enemy.skills = [attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] }); // arm River Clone on e1
  const r = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] }); // enemy's harmful skill -> countered
  assert.equal(r.countered, true, "the River Clone counter fired (it WAS triggered)");
  const allyHolders = [rd, ...allies].filter((u) => !!cloneMark(u));
  assert.equal(allyHolders.length, 0, "a triggered River Clone does not jump to an ally");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter4 — Restorative Retreat: "River Daughter heals 20 health for 2 turns when she uses Dive."
// -----------------------------------------------------------------------------------------------------
test("Restorative Retreat: using Dive grants River Daughter a 20/turn heal-over-time for 2 turns", () => {
  const { state, rd } = setup({ augment: "riverdaughter4", enemies: 1 });
  rd.hp = 50;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] }); // Dive
  assert.equal(r.ok, true, "Dive cast succeeds");
  const reg = regenOf(rd, "Restorative Retreat");
  assert.ok(reg, "River Daughter gains a Restorative Retreat regen");
  assert.equal(reg!.magnitude, 20, "20 health per turn");
  assert.equal(reg!.duration, 2, "for 2 turns");
  assert.equal(rd.hp, 50, "the cast itself does not heal (it is a heal-over-time)");
});

test("Restorative Retreat actually heals 20 per turn for exactly two ticks (then stops)", () => {
  const { state, rd } = setup({ augment: "riverdaughter4", enemies: 1 });
  rd.hp = 50;
  performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] });
  advance(state, 3); // first River Daughter turn-end tick
  assert.equal(rd.hp, 90, "both ticks land in the first advance (apply-turn + next): +40 (50 -> 90)");
  advance(state, 2); // second tick
  assert.equal(rd.hp, 90, "second tick: +20 (70 -> 90)");
  advance(state, 2); // no third tick — the buff lasted only 2 turns
  assert.equal(rd.hp, 90, "no further healing after 2 turns");
});

test("Restorative Retreat control: WITHOUT the augment, Dive grants no such heal-over-time", () => {
  const { state, rd } = setup({ enemies: 1 }); // no augment
  rd.hp = 50;
  performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] });
  assert.equal(regenOf(rd, "Restorative Retreat"), undefined, "base Dive adds no Restorative Retreat regen");
  advance(state, 5);
  assert.equal(rd.hp, 50, "and River Daughter is not healed");
});

test("Restorative Retreat control: the heal is tied to Dive — a different skill does not grant it", () => {
  const { state, rd } = setup({ augment: "riverdaughter4", enemies: 1 });
  rd.hp = 50;
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple, not Dive
  assert.equal(regenOf(rd, "Restorative Retreat"), undefined, "'when she uses Dive' — Ripple must not grant the heal");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter5 — River Within: "Whenever River Clone is triggered, River Daughter casts Ripple."
// -----------------------------------------------------------------------------------------------------
// SUSPECTED BUG: River Within's trigger gates on sameUnit[eventSource, self]. For a counterFired event
// `eventSource` resolves to the COUNTERED ATTACKER (the enemy `caster`), not the counterer — so the gate
// (enemy == River Daughter) never holds and the reactive Ripple never casts. The sibling passive Healing
// Tears' counter-half correctly uses sameUnit[eventCounterer, self]. The frozen prose says a triggered
// River Clone MUST cast Ripple (10 to the enemy team); the engine deals nothing. Assertions preserved.
test("River Within: a triggered River Clone makes River Daughter cast Ripple (10 to the enemy team)", () => {
  const { state, enemies } = setup({ augment: "riverdaughter5", allies: 1, enemies: 2 });
  const [e1, e2] = enemies as [Unit, Unit];
  e1.skills = [attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] }); // arm River Clone on e1
  const r = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] }); // e1's harmful skill -> countered
  assert.equal(r.countered, true, "the River Clone counter fired (River Clone WAS triggered)");
  // Frozen: on that trigger, River Daughter casts Ripple, which deals 10 to the WHOLE enemy team.
  assert.equal(e1.hp, 90, "the reactive Ripple hit e1 for 10");
  assert.equal(e2.hp, 90, "the reactive Ripple hit the rest of the enemy team for 10");
});

test("River Within control: with no counter, no reactive Ripple fires (the enemy team is untouched)", () => {
  const { state, enemies } = setup({ augment: "riverdaughter5", allies: 1, enemies: 2 });
  const [e1, e2] = enemies as [Unit, Unit];
  e1.skills = [helpfulSelf()];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] }); // arm River Clone on e1
  const r = performAction(state, { unit: "e1", skillId: "bless", targets: [] }); // Helpful — never countered
  assert.notEqual(r.countered, true, "a Helpful skill does not trigger River Clone");
  assert.equal(e1.hp, 100, "no counter -> no reactive Ripple -> e1 unharmed");
  assert.equal(e2.hp, 100, "and e2 unharmed");
});
