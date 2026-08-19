/**
 * Behavior tests for Mr. Scratch — asserted against the frozen skill PROSE (the oracle).
 * Scratch's kit is a set of "Deals": a buff (positive) plus a punishment that fires if the
 * target uses a new skill, wired to his passive Elemental-Essence economy.
 *
 * Team layout: a1 = scratch, a2 = ayana (has a hero-targeting Helpful heal, Prayer/ayana3),
 * a3 = gommar; enemies b1 = xyris, b2 = laria, b3 = riverdaughter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, shieldTotal, effectiveCost, canUse, legalTargets, performAction, endTurn, startTurn } from "../skillHarness.ts";
import { status } from "../helpers.ts";
import { Rng } from "../../src/rng.ts";

const A = ["scratch", "ayana", "gommar"];
const B = ["xyris", "laria", "riverdaughter"];
/** Count of one-shot Elemental Essence charges on a unit. */
const essence = (u: { statuses: { kind: string }[] }): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const mark = (u: { statuses: { kind: string; name?: string }[] }, name: string): boolean =>
  u.statuses.some((s) => s.kind === "mark" && s.name === name);
/** Give team A plenty of Scratch's Specific (devil) energy so a Specific cost never blocks a cast. */
const fund = (s: ReturnType<typeof battle>) => { s.teams.A.energy.devil = 99; };

// --------------------------------------------------------------------------- //
//  scratch1 — Deal: Defeat Your Enemies
//  "Target Hero deals 10 more non-Affliction damage for 1 turn. If they use a new
//   skill, that Hero will receive 20 Affliction damage."  (cost g1, cd0)
// --------------------------------------------------------------------------- //
test("scratch1 — costs 1 Generic, no cooldown", () => {
  const s = battle(A, B);
  const sk = skillOf(unit(s, "a1"), "scratch1");
  assert.equal(sk.cost.generic, 1);
  assert.equal(sk.cost.specific, 0);
  assert.equal(sk.cooldown, 0);
});

test("scratch1 — grants the target +10 non-Affliction outgoing damage for 1 turn", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "scratch1", targets: ["b1"] });
  const boon = unit(s, "b1").statuses.find((x) => x.kind === "outgoing_damage_mod");
  assert.ok(boon, "target gains an outgoing_damage_mod");
  assert.equal(boon!.magnitude, 10, "+10 damage");
  assert.equal(boon!.duration, 1, "for 1 turn");
  assert.ok(mark(unit(s, "b1"), "Deal: Defeat Your Enemies"), "the Deal mark is laid on the target");
});

test("scratch1 — if the target uses a new skill they take 20 Affliction (and Scratch gains Essence)", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "scratch1", targets: ["b1"] });
  endTurn(s); startTurn(s); // hand over to team B
  const b1 = unit(s, "b1");
  const before = b1.hp;
  performAction(s, { unit: "b1", skillId: "xyris1", targets: ["a1"] }); // b1 uses a new skill (on Scratch)
  assert.equal(before - b1.hp, 20, "the punishment deals 20 Affliction to the offending Hero");
  assert.equal(essence(unit(s, "a1")), 1, "The Devil's Price: Scratch gains Elemental Essence on trigger");
  assert.ok(!mark(b1, "Deal: Defeat Your Enemies"), "the Deal is consumed (fires once)");
});

// --------------------------------------------------------------------------- //
//  scratch0 — The Devil's Price (passive)
//  "Whenever a target triggers one of Scratch's Deal skills, Scratch gains Elemental
//   Essence. When one of his Deal skills expires without being triggered, its target
//   gains Elemental Essence."
// --------------------------------------------------------------------------- //
test("scratch0 — a Deal that EXPIRES untriggered grants ITS TARGET Essence (not Scratch)", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "scratch1", targets: ["b1"] });
  // Let the 1-turn Deal mark lapse without b1 ever using a skill. It ticks at Scratch's
  // (team A) turn-end; check the instant it expires, before B's income consumes the charge.
  endTurn(s); startTurn(s); endTurn(s); startTurn(s); endTurn(s);
  assert.ok(!mark(b1, "Deal: Defeat Your Enemies"), "the Deal has expired");
  assert.equal(essence(b1), 1, "its target gains Elemental Essence on untriggered expiry");
  assert.equal(essence(unit(s, "a1")), 0, "Scratch gains nothing when the Deal was NOT triggered");
});

// --------------------------------------------------------------------------- //
//  scratch2 — Deal: Save Your Friends  (cost g1, cd1)
//  "For 1 turn, target Hero's next Helpful skill will heal its targets for 15 HP and make
//   them Invulnerable for 1 turn. If they use a new skill, this effect will end and that
//   Hero will be permanently Isolated."
// --------------------------------------------------------------------------- //
test("scratch2 — costs 1 Generic, cooldown 1", () => {
  const s = battle(A, B);
  const sk = skillOf(unit(s, "a1"), "scratch2");
  assert.equal(sk.cost.generic, 1);
  assert.equal(sk.cost.specific, 0);
  assert.equal(sk.cooldown, 1);
});

test("scratch2 — boon augments the target's next Helpful skill (+15 heal & Invulnerable 1) and punishes with permanent Isolate", () => {
  const s = battle(A, B);
  const a2 = unit(s, "a2"), a3 = unit(s, "a3");
  performAction(s, { unit: "a1", skillId: "scratch2", targets: ["a2"] });
  assert.ok(mark(a2, "Boon: Save Your Friends"), "the boon mark is laid");
  a3.hp = a3.maxHp - 40;
  // a2 (ayana) casts Prayer (a Helpful heal) on a3: the boon adds +15 heal & Invulnerable to a3,
  // and the "if they use a new skill" clause permanently Isolates a2.
  performAction(s, { unit: "a2", skillId: "ayana3", targets: ["a3"] });
  assert.equal(a3.hp, a3.maxHp - 15, "boon adds 15 healing on top of the Helpful skill's own 10 (60 -> 85)");
  assert.ok(hasStatus(a3, "invulnerable"), "the Helpful skill's target is made Invulnerable");
  const inv = a3.statuses.find((x) => x.kind === "invulnerable");
  assert.equal(inv!.duration, 1, "Invulnerable for 1 turn");
  const iso = a2.statuses.find((x) => x.kind === "isolated");
  assert.ok(iso, "using a new skill Isolates that Hero");
  assert.equal(iso!.duration, null, "permanently Isolated (round-scoped, no duration)");
  assert.ok(!mark(a2, "Boon: Save Your Friends"), "the boon effect ends");
  assert.equal(essence(unit(s, "a1")), 1, "Scratch gains Essence on the trigger");
});

// --------------------------------------------------------------------------- //
//  scratch3 — Deal: Realize Your Potential  (cost s1, cd1)
//  "Until the end of their next turn, Target Hero's skills cost 1 less Specific and 1 less
//   Generic energy. If they use a new skill, they will be stunned for 1 turn."
// --------------------------------------------------------------------------- //
test("scratch3 — costs 1 Specific, cooldown 1", () => {
  const s = battle(A, B); fund(s);
  const sk = skillOf(unit(s, "a1"), "scratch3");
  assert.equal(sk.cost.specific, 1);
  assert.equal(sk.cost.generic, 0);
  assert.equal(sk.cooldown, 1);
});

test("scratch3 — discounts the target's skill cost, then stuns them 1 turn if they act", () => {
  const s = battle(A, B); fund(s);
  const a2 = unit(s, "a2");
  performAction(s, { unit: "a1", skillId: "scratch3", targets: ["a2"] });
  const disc = a2.statuses.find((x) => x.kind === "cost_mod");
  assert.ok(disc, "a cost discount is applied");
  assert.equal(disc!.duration, 1, "until the end of their next turn");
  // ayana3 normally costs g1: with -1 Generic (and -1 Specific) it becomes free.
  const cost = effectiveCost(a2, skillOf(a2, "ayana3"));
  assert.equal(cost.generic, 0, "1 less Generic applied");
  performAction(s, { unit: "a2", skillId: "ayana3", targets: ["a3"] });
  const st = a2.statuses.find((x) => x.kind === "stun");
  assert.ok(st, "using a new skill stuns them");
  assert.equal(st!.duration, 1, "for 1 turn");
  assert.equal(essence(unit(s, "a1")), 1, "Scratch gains Essence on the trigger");
});

// --------------------------------------------------------------------------- //
//  scratch4 — Faustian Bargain  (self, cost g1, cd2)
//  "Scratch's next deal will not apply its positive effect to enemies, and will not apply
//   its Triggered effect to allies."
// --------------------------------------------------------------------------- //
test("scratch4 — costs 1 Generic, cooldown 2, applies a self mark", () => {
  const s = battle(A, B);
  const sk = skillOf(unit(s, "a1"), "scratch4");
  assert.equal(sk.cost.generic, 1);
  assert.equal(sk.cooldown, 2);
  performAction(s, { unit: "a1", skillId: "scratch4" });
  assert.ok(mark(unit(s, "a1"), "Faustian Bargain"), "Faustian arms Scratch's next Deal");
});

test("scratch4 — the next Deal withholds its POSITIVE effect from an enemy target", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "scratch4" });
  performAction(s, { unit: "a1", skillId: "scratch1", targets: ["b1"] });
  const b1 = unit(s, "b1");
  assert.ok(!b1.statuses.some((x) => x.kind === "outgoing_damage_mod"), "no +10 buff is given to the enemy");
  assert.ok(mark(b1, "Deal: Defeat Your Enemies"), "but the Deal (and its punishment) still lands on the enemy");
});

test("scratch4 — the next Deal withholds its TRIGGERED (punishment) effect from an ally target", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "scratch4" });
  performAction(s, { unit: "a1", skillId: "scratch1", targets: ["a2"] });
  const a2 = unit(s, "a2");
  assert.ok(a2.statuses.some((x) => x.kind === "outgoing_damage_mod"), "the positive +10 still applies to the ally");
  const before = a2.hp;
  performAction(s, { unit: "a2", skillId: "ayana3", targets: ["a3"] });
  assert.equal(before - a2.hp, 0, "the 20 Affliction punishment is suppressed against the ally");
});

// --------------------------------------------------------------------------- //
//  scratch5 — Disarming Pitch  (self, cost g1, cd1)
//  "For 1 turn, Scratch gains 10 Shield and any enemy who uses a new skill on him will be
//   marked for 1 turn. Scratch's Deal skills always apply to marked Heroes."
// --------------------------------------------------------------------------- //
test("scratch5 — costs 1 Generic, cooldown 1", () => {
  const s = battle(A, B);
  const sk = skillOf(unit(s, "a1"), "scratch5");
  assert.equal(sk.cost.generic, 1);
  assert.equal(sk.cooldown, 1);
});

test("scratch5 — grants 10 Shield for 1 turn and marks any enemy who uses a skill on Scratch", () => {
  const s = battle(A, B);
  performAction(s, { unit: "a1", skillId: "scratch5" });
  assert.equal(shieldTotal(unit(s, "a1")), 10, "10 Shield");
  const sh = unit(s, "a1").shields[0];
  assert.equal(sh.duration, 1, "for 1 turn");
  assert.ok(mark(unit(s, "a1"), "Disarming Pitch"), "the reactive self-window is open");
  endTurn(s); startTurn(s);
  performAction(s, { unit: "b1", skillId: "xyris1", targets: ["a1"] }); // enemy uses a skill ON Scratch
  const m = unit(s, "b1").statuses.find((x) => x.kind === "mark" && x.name === "Marked");
  assert.ok(m, "the offending enemy is Marked");
  assert.equal(m!.duration, 1, "for 1 turn");
});

test("scratch5 — Scratch's Deal skills may legally target a Marked enemy", () => {
  const s = battle(A, B);
  const b1 = unit(s, "b1");
  b1.statuses.push(status("mark", { name: "Marked", duration: 1 }));
  const legal = legalTargets(s, unit(s, "a1"), skillOf(unit(s, "a1"), "scratch1"), [b1], Rng.fromState(s.rngState));
  assert.ok(legal.some((u) => u.id === "b1"), "the Marked enemy is a legal Deal target");
});

// --------------------------------------------------------------------------- //
//  scratch6 — Deal: Know Your Fate  (ultimate, cost s3, cd5)
//  "For 3 turns, target Hero ignores non-damage effects and their skills have no cost. At
//   the end of this duration, that Hero is killed."
// --------------------------------------------------------------------------- //
test("scratch6 — costs 3 Specific, cooldown 5", () => {
  const s = battle(A, B); fund(s);
  const sk = skillOf(unit(s, "a1"), "scratch6");
  assert.equal(sk.cost.specific, 3);
  assert.equal(sk.cost.generic, 0);
  assert.equal(sk.cooldown, 5);
});

test("scratch6 — for 3 turns the target ignores non-damage effects and pays no cost", () => {
  const s = battle(A, B); fund(s);
  const b1 = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "scratch6", targets: ["b1"] });
  const ndi = b1.statuses.find((x) => x.kind === "non_damage_ignore");
  assert.ok(ndi, "ignores non-damage effects");
  assert.equal(ndi!.duration, 3, "for 3 turns");
  const cost = effectiveCost(b1, skillOf(b1, "xyris1"));
  assert.equal(cost.generic, 0, "their skills have no Generic cost");
  assert.equal(cost.specific, 0, "their skills have no Specific cost");
});

test("scratch6 — at the end of the 3-turn duration the target is killed", () => {
  const s = battle(A, B); fund(s);
  const b1 = unit(s, "b1");
  performAction(s, { unit: "a1", skillId: "scratch6", targets: ["b1"] });
  // Advance three of Scratch's (team A) turn-ends so the mark lapses and its onExpire kills the holder.
  for (let i = 0; i < 6; i++) { endTurn(s); startTurn(s); }
  assert.ok(b1.alive, "still alive before the duration fully elapses");
  endTurn(s);
  assert.equal(b1.alive, false, "the target is killed at the end of the duration");
});
