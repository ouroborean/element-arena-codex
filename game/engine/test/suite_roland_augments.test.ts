import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================================
// Adversarial, SPEC-DERIVED AUGMENT suite for Geolord ROLAND.
// The FROZEN augment prose (content/frozen/augments.json) is the SOLE oracle for WHAT each
// augment must do. Authored/generated content is read only to learn HOW to drive (ids, costs,
// which base skill each augment touches, minion/status names).
//
// Frozen text under test (augment id -> display_name -> prose):
//   roland1 Ricochet Rumble:     "Boulder minions are created with 60 HP."
//   roland2 Bedrock Bident:      "Earth Pillar marks an additional random enemy each time it is used."
//   roland3 Stone Speaks To Stone: "Stoneform now lasts 1 additional turn, and while affected by it,
//                                    Boulders deal double damage when launched with Strength From The Earth."
//   roland4 Sediment Shotgun:    "Boulders are now created with 25 less HP. If Roland destroys a Boulder
//                                    with Strength From The Earth, he deals 25 Piercing damage to all enemies."
//   roland5 Rockslide:           "Form Stone now creates two Boulders at a time."
//
// Relevant frozen BASE prose (content/frozen/skills.json), used to know the baseline these modify:
//   roland1 Strength From The Earth: "Targets an enemy or Boulder, dealing 15 damage ... (+10 with Living
//     Stone). If the target is a Boulder, it will launch at a random enemy, dealing its remaining health
//     in damage before being destroyed. If there is a character Marked by Earth Pillar, the launched
//     Boulder will prioritize targeting that character."
//   roland2 Earth Pillar: "Deals 20 damage to target enemy and marks them with an Earth Pillar for
//     Roland's next two turns...."
//   roland3 Form Stone: "Creates a Boulder minion."  (Boulder base HP = 50, per frozen minions.json)
//   roland4 Stoneform: "Roland gains 15 points of Damage Reduction for 1 turn...."
// NOTE: augment ids (roland1..5) share the string namespace with SKILL ids (roland1..5) but are
// DIFFERENT objects. performAction uses the SKILL ids: roland1=Strength From The Earth,
// roland2=Earth Pillar, roland3=Form Stone, roland4=Stoneform, roland5=Fissure.
// ===========================================================================================

const has = (u: Unit, kind: string, name?: string) =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const boulders = (st: MatchState) =>
  Object.values(st.units).filter(
    (u) => u.kind === "minion" && u.name === "Boulder" && u.team === "A" && u.alive,
  );

function roland(id = "a1"): Unit {
  return loadHero(heroById("roland"), "A", id);
}

/** A plain enemy hero with a 20-damage Harmful skill (so real damage/shield paths run). */
function enemy(id: string, hp = 100): Unit {
  return makeUnit({
    id,
    team: "B",
    hp,
    maxHp: hp,
    name: `Enemy ${id}`,
    skills: [
      skill("zap", [{ op: "damage", amount: 20, dtype: "normal", to: "target", id: "zap.hit" }], {
        targeting: "single",
        tags: ["Harmful", "Instant"],
        cost: { generic: 0, specific: 0 },
      }),
    ],
  });
}

/** Roland's Specific cost is paid in `earth`; fund both teams generously. */
function fund(st: MatchState) {
  st.teams.A.energy = { generic: 40, earth: 40 };
  st.teams.B.energy = { generic: 40, fire: 40 };
}

const earthPillarMarks = (st: MatchState) =>
  Object.values(st.units).filter((u) => u.team === "B" && has(u, "mark", "Earth Pillar"));

// --------------------------------------------------------------------------------------------- //
// roland1 — Ricochet Rumble : "Boulder minions are created with 60 HP."
// --------------------------------------------------------------------------------------------- //

test("roland1: Form Stone now creates a Boulder with 60 HP (control: unaugmented Roland's is 50)", () => {
  // Augmented.
  const r = roland();
  applyAugment(r, augmentById("roland1")!);
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  const res = performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone
  assert.ok(res.ok, "Form Stone succeeds");
  const bs = boulders(st);
  assert.equal(bs.length, 1, "exactly one Boulder is created");
  assert.equal(bs[0]!.hp, 60, "the Boulder is created with 60 HP (Ricochet Rumble)");
  assert.equal(bs[0]!.maxHp, 60, "and its maxHp is 60 too");

  // Control: no augment -> frozen baseline of 50.
  const r2 = roland("a1");
  const st2 = makeState([r2], [enemy("e1")]);
  fund(st2);
  performAction(st2, { unit: "a1", skillId: "roland3", targets: [] });
  assert.equal(boulders(st2)[0]!.hp, 50, "without Ricochet Rumble a Boulder has the baseline 50 HP");
});

test("roland1: a 60-HP Boulder launched by Strength From The Earth deals its remaining 45 (60 - 15)", () => {
  const r = roland();
  applyAugment(r, augmentById("roland1")!);
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone -> 60-HP Boulder
  const b = boulders(st)[0]!;
  assert.equal(b.hp, 60, "precondition: 60-HP Boulder");

  // No Living Stone: self-hit is 15 -> 45 remaining -> launches 45 at the lone enemy.
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] });
  assert.equal(e.hp, 100 - 45, "the launched 60-HP Boulder deals its remaining health (60 - 15 = 45)");
  assert.equal(boulders(st).length, 0, "the Boulder is destroyed after launching");
});

// --------------------------------------------------------------------------------------------- //
// roland2 — Bedrock Bident : "Earth Pillar marks an additional random enemy each time it is used."
// --------------------------------------------------------------------------------------------- //

test("roland2: Earth Pillar marks its target AND one additional enemy (2 enemies marked; the extra takes no damage)", () => {
  const r = roland();
  applyAugment(r, augmentById("roland2")!);
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([r, ally], [e1, e2]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] }); // Earth Pillar on e1

  assert.equal(e1.hp, 80, "the primary target takes the base 20 damage");
  assert.ok(has(e1, "mark", "Earth Pillar"), "the primary target is marked (base)");
  assert.ok(has(e2, "mark", "Earth Pillar"), "an ADDITIONAL enemy is also marked");
  assert.equal(earthPillarMarks(st).length, 2, "exactly two enemies bear the Earth Pillar mark");
  assert.equal(e2.hp, 100, "the additional-mark clause only marks — it deals no damage to that enemy");
  assert.ok(!has(ally, "mark", "Earth Pillar"), "the additional mark lands on an ENEMY, never an ally");
  assert.ok(!has(r, "mark", "Earth Pillar"), "and never on Roland himself");
});

test("roland2 control: without the augment, Earth Pillar marks ONLY its target", () => {
  const r = roland();
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([r], [e1, e2]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] });
  assert.ok(has(e1, "mark", "Earth Pillar"), "the target is marked");
  assert.ok(!has(e2, "mark", "Earth Pillar"), "no additional enemy is marked without Bedrock Bident");
  assert.equal(earthPillarMarks(st).length, 1, "exactly one enemy marked (baseline)");
});

// --------------------------------------------------------------------------------------------- //
// roland3 — Stone Speaks To Stone :
//   "Stoneform now lasts 1 additional turn, and while affected by it, Boulders deal double damage
//    when launched with Strength From The Earth."
// --------------------------------------------------------------------------------------------- //

test("roland3 clause 1: Stoneform's Damage Reduction now lasts 2 turns (control: baseline 1)", () => {
  // Augmented.
  const r = roland();
  applyAugment(r, augmentById("roland3")!);
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland4", targets: [] }); // Stoneform
  const dr = r.statuses.find((s) => s.kind === "damage_reduction")!;
  assert.ok(dr, "Roland gains Damage Reduction");
  assert.equal(dr.magnitude, 15, "still 15 points of Damage Reduction");
  assert.equal(dr.duration, 2, "Stone Speaks To Stone extends the duration to 2 (1 additional turn)");

  // Control: baseline duration is 1 turn.
  const r2 = roland();
  const st2 = makeState([r2], [enemy("e1")]);
  fund(st2);
  performAction(st2, { unit: "a1", skillId: "roland4", targets: [] });
  const dr2 = r2.statuses.find((s) => s.kind === "damage_reduction")!;
  assert.equal(dr2.duration, 1, "baseline Stoneform Damage Reduction lasts only 1 turn");
});

test("roland3 clause 1 (behavioural): the DR survives one MORE of Roland's turn-ends than baseline", () => {
  const r = roland();
  applyAugment(r, augmentById("roland3")!);
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland4", targets: [] }); // Stoneform (DR dur 2)

  endTurn(st); // A ends turn 1 (birth turn -> no tick). active B, turn 2
  endTurn(st); // B ends turn 2 -> enemy turn, no tick. active A, turn 3
  endTurn(st); // A ends turn 3 -> tick (2 -> 1). Baseline (dur 1) would EXPIRE here.
  assert.ok(has(r, "damage_reduction"), "with the augment the DR is still present where baseline would have expired");

  endTurn(st); // B ends turn 4 -> no tick. active A, turn 5
  endTurn(st); // A ends turn 5 -> tick (1 -> 0) -> expires
  assert.ok(!has(r, "damage_reduction"), "the extended DR expires one Roland-turn later");
});

test("roland3 clause 2: while affected by Stoneform a launched Boulder deals DOUBLE its remaining HP", () => {
  // Positive: Stoneform active -> double launch.
  const r = roland();
  applyAugment(r, augmentById("roland3")!);
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland4", targets: [] }); // Stoneform -> Roland is affected
  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone -> 50-HP Boulder (roland3 aug does not touch Form Stone)
  const b = boulders(st)[0]!;
  assert.equal(b.hp, 50, "precondition: a baseline 50-HP Boulder");

  // No Living Stone: self-hit 15 -> 35 remaining -> DOUBLED launch = 70 at the lone enemy.
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] });
  assert.equal(e.hp, 100 - 70, "while affected by Stoneform, the launch deals DOUBLE the remaining 35 = 70");
  assert.equal(boulders(st).length, 0, "the Boulder is still destroyed");
});

test("roland3 clause 2 control: WITHOUT Stoneform active, the same launch deals the single remaining 35", () => {
  const r = roland();
  applyAugment(r, augmentById("roland3")!); // augment applied, but Roland is NOT affected by Stoneform
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone -> 50-HP Boulder
  const b = boulders(st)[0]!;
  assert.ok(!has(r, "mark", "Stoneform"), "precondition: Roland is not affected by Stoneform");

  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] });
  assert.equal(e.hp, 100 - 35, "no doubling without Stoneform: launch deals the single remaining 35");
});

// --------------------------------------------------------------------------------------------- //
// roland4 — Sediment Shotgun :
//   "Boulders are now created with 25 less HP. If Roland destroys a Boulder with Strength From The
//    Earth, he deals 25 Piercing damage to all enemies."
// --------------------------------------------------------------------------------------------- //

test("roland4 clause 1: Boulders are now created with 25 HP (50 - 25) (control: 50)", () => {
  const r = roland();
  applyAugment(r, augmentById("roland4")!);
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone
  assert.equal(boulders(st)[0]!.hp, 25, "Boulders are created with 25 less HP than the 50 baseline");

  const r2 = roland();
  const st2 = makeState([r2], [enemy("e1")]);
  fund(st2);
  performAction(st2, { unit: "a1", skillId: "roland3", targets: [] });
  assert.equal(boulders(st2)[0]!.hp, 50, "control: baseline Boulder is 50 HP");
});

test("roland4 clause 2: destroying a Boulder with Strength From The Earth deals 25 Piercing to ALL enemies", () => {
  const r = roland();
  applyAugment(r, augmentById("roland4")!);
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  // Mark e1 with Earth Pillar so the launch target is deterministic (frozen: launch prioritizes the marked one).
  e1.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  const st = makeState([r], [e1, e2]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone -> 25-HP Boulder
  const b = boulders(st)[0]!;
  assert.equal(b.hp, 25, "precondition: 25-HP Boulder");

  // SFTE on the Boulder: self-hit 15 -> 10 remaining -> launch 10 at Earth-Pillar-marked e1 -> Boulder destroyed
  //   -> the augment fires 25 Piercing at EVERY enemy.
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] });
  assert.equal(boulders(st).length, 0, "the Boulder was destroyed by the launch");
  assert.equal(e1.hp, 100 - 10 - 25, "e1: 10 launch (prioritised via Earth Pillar) + 25 Piercing = 35 total");
  assert.equal(e2.hp, 100 - 25, "e2: took the 25 Piercing shotgun even though the launch missed it");
});

test("roland4 clause 2 control: Strength From The Earth on an ENEMY (no Boulder destroyed) deals NO 25 Piercing", () => {
  const r = roland();
  applyAugment(r, augmentById("roland4")!);
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([r], [e1, e2]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland1", targets: ["e1"] }); // SFTE straight at an enemy, no Boulder
  assert.equal(e1.hp, 85, "e1 takes only the base 15 (no Living Stone)");
  assert.equal(e2.hp, 100, "no Boulder was destroyed -> no 25 Piercing to the rest of the enemy team");
});

test("roland4: the shotgun damage is genuinely PIERCING — it lands in full through Damage Reduction", () => {
  // Frozen calls it "25 Piercing damage". In this engine Piercing bypasses Damage Reduction, so an
  // enemy holding DR still takes the full 25 (a `normal` 25 would be reduced). This confirms the
  // damage type, not just the amount.
  const r = roland();
  applyAugment(r, augmentById("roland4")!);
  const e1 = enemy("e1"); // launch target
  const e2 = enemy("e2"); // holds Damage Reduction
  e1.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 })); // force launch onto e1
  e2.statuses.push(status("damage_reduction", { magnitude: 15, duration: null }));
  const st = makeState([r], [e1, e2]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // 25-HP Boulder
  const b = boulders(st)[0]!;
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] }); // destroy -> 25 Piercing all

  assert.equal(e2.hp, 75, "Piercing ignores the 15 DR and removes the full 25 (a normal hit would leave 90)");
});

// --------------------------------------------------------------------------------------------- //
// roland5 — Rockslide : "Form Stone now creates two Boulders at a time."
// --------------------------------------------------------------------------------------------- //

test("roland5: Form Stone now creates TWO Boulders (control: one)", () => {
  const r = roland();
  applyAugment(r, augmentById("roland5")!);
  const st = makeState([r], [enemy("e1")]);
  fund(st);

  const res = performAction(st, { unit: "a1", skillId: "roland3", targets: [] });
  assert.ok(res.ok, "Form Stone succeeds");
  const bs = boulders(st);
  assert.equal(bs.length, 2, "Rockslide makes Form Stone create two Boulders at a time");
  assert.equal(bs[0]!.hp, 50, "each Boulder has the baseline 50 HP (Rockslide changes count, not HP)");
  assert.equal(bs[1]!.hp, 50, "both Boulders are 50 HP");

  // Control: baseline creates exactly one.
  const r2 = roland();
  const st2 = makeState([r2], [enemy("e1")]);
  fund(st2);
  performAction(st2, { unit: "a1", skillId: "roland3", targets: [] });
  assert.equal(boulders(st2).length, 1, "without Rockslide, Form Stone creates a single Boulder");
});
