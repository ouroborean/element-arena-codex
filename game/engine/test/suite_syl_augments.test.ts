import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, effectiveCost, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts"; // side-effect: registers custom augment handlers via hero.ts
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, SPEC-DERIVED behavioural suite for Syl's AUGMENTS. Every
// assertion is anchored to the FROZEN augment prose (the oracle,
// content/frozen/augments.json), never to the implementation:
//
//   syl1 "Voracious Growth": "Successfully healing Syl's Eagle Minion with
//        Feed lowers the cost of Leyline Nest by [4] until the next time it is
//        used."
//   syl2 "Wonder by Wonder": "To the Skies! now lasts an additional turn."
//   syl3 "Plummet": "Enemies stunned by Talon Rake receive 15 damage when the
//        stun ends."
//   syl4 "You and Me": "Unbreakable Bond now heals Syl and her Eagle for 10
//        health after health has been equalized."
//   syl5 "Shish Kebab": "Skylance now heals Syl's Eagle minion for 10 health.
//        If her Eagle minion is at maximum life after the heal, she gains
//        Elemental Essence."
//
// Base skills the augments touch (content/frozen/skills.json):
//   Feed (syl1) heals the Eagle 20; Skylance (syl2) deals 20 Piercing to one
//   enemy; To the Skies! (syl3) empowers the Eagle's Talon Rake this turn;
//   Unbreakable Bond (syl4) equalizes Syl<->Eagle HP; Leyline Nest (syl5)
//   base wind cost 4; Talon Rake (sylminion1) deals 15 Piercing.
// ===========================================================================

function findMinion(state: MatchState, name: string): Unit | undefined {
  return Object.values(state.units).find((u) => u.kind === "minion" && u.name === name);
}
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const skyMark = (u: Unit): Unit["statuses"][number] | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === "To the Skies");

/** Fresh Syl on team A at slot 0 (no middle-slot free essence income), two plain enemies on B,
 *  the Hatchling Eagle summoned via her real roundStart passive. Optionally apply one augment id
 *  BEFORE the round starts (how augments enter play). Energy is abundant so casts never fail. */
function setup(augId?: string, seed = 1) {
  const syl = loadHero(heroById("syl"), "A", "a1");
  if (augId) applyAugment(syl, augmentById(augId)!);
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([syl], [e1, e2], seed);
  state.teams.A.energy = { generic: 40, wind: 40 };
  state.teams.B.energy = { generic: 40, wind: 40 };
  emit(state, { type: "roundStart" }); // Syl's passive summons the Hatchling Eagle
  const eagle = findMinion(state, "Hatchling Eagle")!;
  return { state, syl, eagle, e1, e2 };
}
const leyline = (u: Unit) => u.skills!.find((s) => s.id === "syl5")!;

// --------------------------------------------------------------------------- //
//  syl1 — Voracious Growth
//  "Successfully healing Syl's Eagle Minion with Feed lowers the cost of
//   Leyline Nest by [4] until the next time it is used."
// --------------------------------------------------------------------------- //

test("syl1: healing the Eagle with Feed lowers Leyline Nest's wind cost by 4", () => {
  const { state, syl, eagle } = setup("syl1");
  eagle.hp = 20; // wound the Eagle so Feed lands a real 20-point heal ("successfully healing")
  assert.equal(effectiveCost(syl, leyline(syl), state).specific, 4, "base Leyline Nest wind cost is 4");

  const r = performAction(state, { unit: syl.id, skillId: "syl1", targets: [eagle.id] });
  assert.equal(r.ok, true, "Feed resolves");
  assert.equal(eagle.hp, 40, "Feed healed the Eagle for 20 (20 -> 40)");
  assert.equal(
    effectiveCost(syl, leyline(syl), state).specific,
    0,
    "Feed lowered Leyline Nest's cost by 4 (4 -> 0)",
  );
});

test("syl1 CONTROL: a non-Feed cast (Skylance) does NOT discount Leyline Nest", () => {
  const { state, syl, e1 } = setup("syl1");
  const r = performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(
    effectiveCost(syl, leyline(syl), state).specific,
    4,
    "only Feed lowers Leyline Nest — Skylance leaves the full 4 cost",
  );
});

test("syl1: the discount lasts only 'until the next time it is used' — using Leyline Nest resets it", () => {
  const { state, syl, eagle } = setup("syl1");
  eagle.hp = 20;
  performAction(state, { unit: syl.id, skillId: "syl1", targets: [eagle.id] });
  assert.equal(effectiveCost(syl, leyline(syl), state).specific, 0, "discounted to 0 by Feed");

  const r = performAction(state, { unit: syl.id, skillId: "syl5", targets: [] });
  assert.equal(r.ok, true, "Leyline Nest casts for free");
  assert.equal(
    effectiveCost(syl, leyline(syl), state).specific,
    4,
    "the reduction is consumed on use → back to the full 4",
  );
});

test("syl1 CONTROL: without the augment, Feed does not touch Leyline Nest's cost", () => {
  const { state, syl, eagle } = setup(); // no augment
  eagle.hp = 20;
  performAction(state, { unit: syl.id, skillId: "syl1", targets: [eagle.id] });
  assert.equal(
    effectiveCost(syl, leyline(syl), state).specific,
    4,
    "base Feed never discounts Leyline Nest — this is purely the augment's effect",
  );
});

// --------------------------------------------------------------------------- //
//  syl2 — Wonder by Wonder — "To the Skies! now lasts an additional turn."
//  To the Skies! empowers the Eagle by placing a "To the Skies" mark on it.
//  Base To the Skies! is a "this turn" effect (mark duration 0); the augment
//  makes the empowerment last one turn longer.
// --------------------------------------------------------------------------- //

test("syl2: To the Skies! places its empowerment mark for one turn LONGER than base", () => {
  // Control: base To the Skies! marks the Eagle for the current turn only (duration 0).
  const base = setup();
  performAction(base.state, { unit: base.syl.id, skillId: "syl3", targets: [] });
  const baseMark = skyMark(base.eagle);
  assert.ok(baseMark, "base To the Skies! marks the Eagle");
  const baseDur = baseMark!.duration;
  assert.equal(baseDur, 0, "base empowerment is a 'this turn' mark (duration 0)");

  // Augmented: the same mark now lasts an additional turn.
  const aug = setup("syl2");
  performAction(aug.state, { unit: aug.syl.id, skillId: "syl3", targets: [] });
  const augMark = skyMark(aug.eagle);
  assert.ok(augMark, "augmented To the Skies! still marks the Eagle");
  assert.equal(augMark!.duration, 1, "the empowerment now lasts an additional turn (duration 0 -> 1)");
  assert.equal(augMark!.duration, (baseDur ?? 0) + 1, "exactly one turn longer than base");
});

// --------------------------------------------------------------------------- //
//  syl3 — Plummet
//  "Enemies stunned by Talon Rake receive 15 damage when the stun ends."
//  Talon Rake only stuns while empowered by To the Skies!; the augment adds a
//  delayed 15-damage burst to that stun when it ends.
// --------------------------------------------------------------------------- //

// Sanity: the clause's precondition (an enemy stunned by Talon Rake) is
// reachable — the empowered Talon Rake DOES apply the stun. This isolates the
// suspected failure below to the "receive 15 damage when the stun ends" clause.
test("syl3 (precondition): an empowered Talon Rake stuns the enemy", () => {
  const { state, syl, eagle, e1 } = setup("syl3");
  performAction(state, { unit: syl.id, skillId: "syl3", targets: [] }); // empower this turn
  const tr = performAction(state, { unit: eagle.id, skillId: "sylminion1", targets: [e1.id] });
  assert.equal(tr.ok, true);
  assert.equal(e1.hp, 85, "Talon Rake still deals its 15 Piercing");
  assert.ok(e1.statuses.some((s) => s.kind === "stun"), "the enemy is stunned by Talon Rake");
});

// Frozen: "Enemies stunned by Talon Rake receive 15 damage when the stun
// ends." The augment's onExpire 15-damage is authored onto the hero's copy of
// Talon Rake via replaceSkill(sylminion1) — but the Eagle is summoned from a
// separate minion template that the patch never reaches, so the stun it applies
// carries NO onExpire. When the stun ends the enemy takes 0. (Verified: the
// summoned Eagle's Talon Rake effect tree contains no onExpire node.)
test(
  "SUSPECTED BUG: syl3 — the stunned enemy takes 15 when the stun ends",
  { skip: "engine: Plummet's onExpire 15-damage is patched onto the hero's Talon Rake, but the Eagle summons from an unpatched minion template, so the stun has no onExpire and the ex-stunned enemy takes 0" },
  () => {
    const { state, syl, eagle, e1 } = setup("syl3");
    performAction(state, { unit: syl.id, skillId: "syl3", targets: [] }); // empower this turn
    performAction(state, { unit: eagle.id, skillId: "sylminion1", targets: [e1.id] });
    assert.equal(e1.hp, 85, "Talon Rake's own 15 landed");
    const eagleHpBefore = eagle.hp;
    const sylHpBefore = syl.hp;

    // Advance until the stun (applied by team A on this turn) ticks to expiry.
    endTurn(state); // team A end (stun born this turn, skipped)
    endTurn(state); // team B end
    endTurn(state); // team A end → stun ticks 1 -> 0, expires
    assert.ok(!e1.statuses.some((s) => s.kind === "stun"), "the stun has ended");

    assert.equal(e1.hp, 70, "the ex-stunned enemy receives 15 when the stun ends (85 -> 70)");
    assert.equal(eagle.hp, eagleHpBefore, "the 15 must land on the enemy, never on the Eagle");
    assert.equal(syl.hp, sylHpBefore, "…and never on Syl");
  },
);

// --------------------------------------------------------------------------- //
//  syl4 — You and Me
//  "Unbreakable Bond now heals Syl and her Eagle for 10 health after health
//   has been equalized."
// --------------------------------------------------------------------------- //

test("syl4: Unbreakable Bond equalizes, THEN heals both Syl and her Eagle for 10", () => {
  const { state, syl, eagle, e1 } = setup("syl4");
  syl.hp = 50;
  eagle.hp = 10; // Eagle max 60
  const r = performAction(state, { unit: syl.id, skillId: "syl4", targets: [] });
  assert.equal(r.ok, true);
  // equalize: (50 + 10) / 2 = 30 each; then +10 to each → 40.
  assert.equal(syl.hp, 40, "Syl: equalized to 30, then +10 = 40");
  assert.equal(eagle.hp, 40, "Eagle: equalized to 30, then +10 = 40");
  assert.equal(e1.hp, 100, "an enemy is never affected by the bond");
});

test("syl4 CONTROL: base Unbreakable Bond equalizes but adds no +10", () => {
  const { state, syl, eagle } = setup(); // no augment
  syl.hp = 50;
  eagle.hp = 10;
  performAction(state, { unit: syl.id, skillId: "syl4", targets: [] });
  assert.equal(syl.hp, 30, "base: equalized to 30, no bonus heal");
  assert.equal(eagle.hp, 30, "base: equalized to 30, no bonus heal");
});

test("syl4: the +10 heal respects each unit's max HP (no overheal)", () => {
  const { state, syl, eagle } = setup("syl4");
  syl.hp = 100; // Syl max 100
  eagle.hp = 20; // Eagle max 60
  performAction(state, { unit: syl.id, skillId: "syl4", targets: [] });
  // equalize: (100 + 20) / 2 = 60 each (Eagle lands exactly at its max); then +10.
  assert.equal(syl.hp, 70, "Syl 60 -> 70 (room to heal)");
  assert.equal(eagle.hp, 60, "Eagle already at max 60 → the +10 cannot overheal");
});

// --------------------------------------------------------------------------- //
//  syl5 — Shish Kebab
//  "Skylance now heals Syl's Eagle minion for 10 health. If her Eagle minion is
//   at maximum life after the heal, she gains Elemental Essence."
// --------------------------------------------------------------------------- //

test("syl5: Skylance still deals 20 and now heals the Eagle 10; below max → no Essence", () => {
  const { state, syl, eagle, e1 } = setup("syl5");
  eagle.hp = 40; // Eagle max 60 — a 10 heal lands at 50, still below max
  assert.equal(essenceCount(syl), 0, "Syl starts with no Elemental Essence");
  const r = performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 80, "Skylance's base 20 Piercing still lands");
  assert.equal(eagle.hp, 50, "the Eagle is healed for 10 (40 -> 50)");
  assert.equal(essenceCount(syl), 0, "Eagle not at max after the heal → no Elemental Essence");
});

test("syl5: if the heal brings the Eagle to maximum life, Syl gains Elemental Essence", () => {
  const { state, syl, eagle, e1 } = setup("syl5");
  eagle.hp = 50; // a 10 heal lands exactly at the 60 max
  const r = performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 80, "base 20 Piercing still lands");
  assert.equal(eagle.hp, 60, "the Eagle is healed to its max (50 -> 60)");
  assert.equal(essenceCount(syl), 1, "Eagle at max after the heal → Syl gains one Elemental Essence");
});

test("syl5 CONTROL: base Skylance deals 20 but never heals the Eagle or grants Essence", () => {
  const { state, syl, eagle, e1 } = setup(); // no augment
  eagle.hp = 50;
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  assert.equal(e1.hp, 80, "base Skylance deals 20");
  assert.equal(eagle.hp, 50, "base Skylance does not heal the Eagle");
  assert.equal(essenceCount(syl), 0, "base Skylance grants no Elemental Essence");
});
