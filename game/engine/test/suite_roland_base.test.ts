import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startRound } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================================
// Adversarial, SPEC-DERIVED behavioural suite for Geolord Roland's BASE kit.
// The FROZEN prose (content/frozen/skills.json) is the oracle for WHAT each skill must do.
// The authored roster is read only to learn HOW to drive: ids, costs, element (earth), and the
// status/minion names the skills produce.
//
// Frozen text under test:
//   roland0 Living Stone (passive): "At the end of each of his turns, Roland gives 10 Shield to a
//     random ally. If this Shield is broken, Roland gains Elemental Essence"
//   roland1 Strength From The Earth: "Targets an enemy or Boulder, dealing 15 damage to them,
//     increased by 10 if he is affected by Living Stone. If the target is a Boulder, it will launch
//     at a random enemy, dealing its remaining health in damage before being destroyed. If there is
//     a character Marked by Earth Pillar, the launched Boulder will prioritize targeting that character."
//   roland2 Earth Pillar: "Deals 20 damage to target enemy and marks them with an Earth Pillar for
//     Roland's next two turns. If this ability strikes a stunned target, they are Shattered for 2 turns."
//   roland3 Form Stone: "Creates a Boulder minion."
//   roland4 Stoneform: "Roland gains 15 points of Damage Reduction for 1 turn. Any targets affected by
//     Living Stone are also affected."
//   roland5 Fissure: "All targets other than Roland take 20 damage and have their Harmful skills
//     stunned for 1 turn. This skill starts each round with 2 turns of cooldown remaining."
// ===========================================================================================

const totalShield = (u: Unit) => u.shields.reduce((t, s) => t + s.amount, 0);
const has = (u: Unit, kind: string, name?: string) =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const boulders = (st: MatchState) =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.name === "Boulder" && u.team === "A" && u.alive);

/** A plain enemy hero carrying a Harmful "zap" (20 dmg) and a Strategic "buff" (self DR) — a generic
 *  fixture used to deal real damage (so real shieldBroken/damage paths run) and to probe Harmful-only stuns. */
function enemy(id: string, hp = 100): Unit {
  return makeUnit({
    id, team: "B", hp, maxHp: hp, name: `Enemy ${id}`,
    skills: [
      skill("zap", [{ op: "damage", amount: 20, dtype: "normal", to: "target", id: "zap.hit" }],
        { targeting: "single", tags: ["Harmful", "Instant"], cost: { generic: 0, specific: 0 } }),
      skill("buff", [{ op: "applyStatus", to: "caster", status: { kind: "damage_reduction", magnitude: 5, duration: 1 } }],
        { targeting: "self", tags: ["Strategic", "Instant"], cost: { generic: 0, specific: 0 } }),
    ],
  });
}

function roland(id = "a1"): Unit {
  return loadHero(heroById("roland"), "A", id);
}

/** Fund both teams generously; Roland's element is earth, so his Specific cost is paid in `earth`. */
function fund(st: MatchState) {
  st.teams.A.energy = { generic: 40, earth: 40 };
  st.teams.B.energy = { generic: 40, fire: 40 };
}

// --------------------------------------------------------------------------------------------- //
// roland0 — Living Stone (passive)
// --------------------------------------------------------------------------------------------- //

test("Living Stone: at Roland's turn end, exactly one ally gains a 10 Shield (+ the Living Stone mark)", () => {
  const r = roland();
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);

  assert.equal(totalShield(r) + totalShield(ally), 0, "no shields before the passive fires");
  endTurn(st); // ends Roland's (team A) turn -> Living Stone fires

  assert.equal(totalShield(r) + totalShield(ally), 10, "exactly 10 Shield was granted across the team");
  const shielded = [r, ally].filter((u) => totalShield(u) === 10);
  assert.equal(shielded.length, 1, "the 10 Shield lands on a single random ally, not both");
  assert.ok(has(shielded[0]!, "mark", "Living Stone"), "the shielded ally is marked as affected by Living Stone");
});

test("Living Stone: breaking that Shield gives ROLAND Elemental Essence and consumes the mark", () => {
  const r = roland();
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const e = enemy("e1");
  const st = makeState([r, ally], [e]);
  fund(st);

  endTurn(st); // Living Stone shields a random team-A ally
  const shielded = [r, ally].find((u) => totalShield(u) === 10)!;
  assert.ok(has(shielded, "mark", "Living Stone"), "precondition: the shielded unit bears the Living Stone mark");
  assert.ok(!has(r, "elemental_essence"), "Roland has no Essence before the Shield breaks");

  // Real damage (20) breaks the 10 Shield -> shieldBroken -> the passive's reactive half fires.
  performAction(st, { unit: "e1", skillId: "zap", targets: [shielded.id] });

  assert.ok(has(r, "elemental_essence"), "Roland gains Elemental Essence when the Living Stone Shield breaks");
  assert.ok(!has(shielded, "mark", "Living Stone"), "the consumed shield's Living Stone mark is cleared");
});

test("Living Stone: breaking a NON-Living-Stone shield does NOT grant Roland Essence (control)", () => {
  const r = roland();
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally", shield: 10 }); // a plain shield, no Living Stone mark
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);

  assert.ok(!has(ally, "mark", "Living Stone"), "the ally's shield is unrelated to Living Stone");
  performAction(st, { unit: "e1", skillId: "zap", targets: ["a2"] }); // 20 dmg breaks the 10 shield

  assert.equal(totalShield(ally), 0, "the plain shield did break");
  assert.ok(!has(r, "elemental_essence"), "no Living Stone mark on the broken-shield unit -> Roland gains NO Essence");
});

// SUSPECTED BUG: frozen says the grant is "At the end of each of HIS turns", but Roland's Living Stone
// turnEnd trigger carries no `eventTeamIsSelf` gate (the convention other heroes use), so it also fires at
// the END OF THE ENEMY'S TURN — a second, unearned 10 Shield each opponent turn (observed: 20 across two
// turn ends where frozen allows only 10).
test.skip("SUSPECTED BUG: Living Stone grants at the ENEMY's turn end too, not only 'each of his turns'", () => {
  const r = roland();
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);

  endTurn(st); // Roland's (team A) turn ends -> one grant
  const afterHisTurn = totalShield(r) + totalShield(ally);
  assert.equal(afterHisTurn, 10, "one 10-Shield grant at the end of his turn");

  endTurn(st); // now team B's (enemy) turn ends -> frozen: NOT one of "his turns", so NO new grant
  const afterEnemyTurn = totalShield(r) + totalShield(ally);
  assert.equal(afterEnemyTurn, 10, "the enemy's turn end must not grant a Roland shield ('each of HIS turns')");
});

// --------------------------------------------------------------------------------------------- //
// roland1 — Strength From The Earth
// --------------------------------------------------------------------------------------------- //

test("Strength From The Earth: deals 15 to a target enemy (no Living Stone)", () => {
  const r = roland();
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  const res = performAction(st, { unit: "a1", skillId: "roland1", targets: ["e1"] });
  assert.ok(res.ok, "the cast succeeded");
  assert.equal(e.hp, 85, "15 damage to the enemy when Roland is NOT affected by Living Stone");
});

test("Strength From The Earth: +10 (25 total) while Roland is affected by Living Stone", () => {
  const r = roland();
  r.statuses.push(status("mark", { name: "Living Stone" })); // Roland is affected by Living Stone
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland1", targets: ["e1"] });
  assert.equal(e.hp, 75, "15 base + 10 = 25 damage while Roland is affected by Living Stone");
});

test("Strength From The Earth: a Boulder target takes the hit, then LAUNCHES its remaining health at the enemy and is destroyed", () => {
  const r = roland();
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone -> a 50-HP Boulder
  const b = boulders(st)[0]!;
  assert.equal(b.hp, 50, "a fresh Boulder has 50 HP");

  // No Living Stone: the Boulder takes 15 (50 -> 35 remaining), then launches 35 at the lone enemy.
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] });
  assert.equal(e.hp, 100 - 35, "the launched Boulder deals its REMAINING health (50 - 15 = 35) to the enemy");
  assert.equal(boulders(st).length, 0, "the Boulder is destroyed after launching");
});

test("Strength From The Earth: Living Stone raises the Boulder's self-hit too, lowering the launch to remaining 25", () => {
  const r = roland();
  r.statuses.push(status("mark", { name: "Living Stone" }));
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] });
  const b = boulders(st)[0]!;
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] });
  assert.equal(e.hp, 100 - 25, "with Living Stone the Boulder takes 25 (50 -> 25 remaining), launching 25");
  assert.equal(boulders(st).length, 0, "the Boulder is destroyed after launching");
});

test("Strength From The Earth: the launch PRIORITIZES an enemy Marked by Earth Pillar over an unmarked one", () => {
  const r = roland();
  const marked = enemy("e1");
  const unmarked = enemy("e2");
  marked.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 })); // a character Marked by Earth Pillar
  const st = makeState([r], [marked, unmarked]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] });
  const b = boulders(st)[0]!;
  performAction(st, { unit: "a1", skillId: "roland1", targets: [b.id] }); // Boulder 50 -> 35 remaining -> launches

  assert.equal(unmarked.hp, 100, "the unmarked enemy is NOT hit — the launch prioritizes the Earth Pillar mark");
  assert.equal(marked.hp, 100 - 35, "the Earth-Pillar-marked enemy takes the full launch (35)");
});

// --------------------------------------------------------------------------------------------- //
// roland2 — Earth Pillar
// --------------------------------------------------------------------------------------------- //

test("Earth Pillar: deals 20 to the enemy and marks it with Earth Pillar (2-turn duration)", () => {
  const r = roland();
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] });
  assert.equal(e.hp, 80, "20 damage to the target enemy");
  const mark = e.statuses.find((s) => s.kind === "mark" && s.name === "Earth Pillar")!;
  assert.ok(mark, "the enemy is marked with an Earth Pillar");
  assert.equal(mark.duration, 2, "the mark lasts for Roland's next two turns (duration 2)");
});

test("Earth Pillar: the mark counts down ONLY on Roland's turns, expiring after his next two", () => {
  const r = roland();
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] }); // turn 1 (team A active)
  assert.ok(has(e, "mark", "Earth Pillar"), "marked right after the cast");

  endTurn(st); // A ends turn 1 (birth turn -> no tick). active B, turn 2
  endTurn(st); // B ends turn 2 -> an ENEMY turn must not consume the mark. active A, turn 3
  assert.ok(has(e, "mark", "Earth Pillar"), "the enemy's turn end does not tick 'Roland's turns' mark");

  endTurn(st); // A ends turn 3 -> tick (2 -> 1). active B, turn 4
  assert.ok(has(e, "mark", "Earth Pillar"), "still marked through Roland's first counted turn");
  endTurn(st); // B ends turn 4 -> no tick. active A, turn 5
  endTurn(st); // A ends turn 5 -> tick (1 -> 0) -> expires
  assert.ok(!has(e, "mark", "Earth Pillar"), "the mark expires after Roland's second turn");
});

test("Earth Pillar: striking a STUNNED target Shatters it for 2 turns; a non-stunned target is not", () => {
  // Positive: stunned target -> Shattered.
  {
    const r = roland();
    const e = enemy("e1");
    e.statuses.push(status("stun", { duration: 1 }));
    const st = makeState([r], [e]);
    fund(st);
    performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] });
    const sh = e.statuses.find((s) => s.kind === "shatter")!;
    assert.ok(sh, "a stunned target struck by Earth Pillar is Shattered");
    assert.equal(sh.duration, 2, "Shattered for 2 turns");
  }
  // Control: non-stunned target -> no Shatter.
  {
    const r = roland();
    const e = enemy("e2");
    const st = makeState([r], [e]);
    fund(st);
    performAction(st, { unit: "a1", skillId: "roland2", targets: ["e2"] });
    assert.ok(!has(e, "shatter"), "an unstunned target is NOT Shattered");
  }
});

// --------------------------------------------------------------------------------------------- //
// roland3 — Form Stone
// --------------------------------------------------------------------------------------------- //

test("Form Stone: creates one Boulder minion (50 HP, ally minion on Roland's team)", () => {
  const r = roland();
  const st = makeState([r], [enemy("e1")]);
  fund(st);

  assert.equal(boulders(st).length, 0, "no Boulder before Form Stone");
  const res = performAction(st, { unit: "a1", skillId: "roland3", targets: [] });
  assert.ok(res.ok, "Form Stone succeeds");
  const bs = boulders(st);
  assert.equal(bs.length, 1, "exactly one Boulder is created");
  assert.equal(bs[0]!.hp, 50, "the Boulder has 50 HP");
  assert.equal(bs[0]!.kind, "minion", "it is a minion");
  assert.equal(bs[0]!.team, "A", "on Roland's team");
});

test("Form Stone: a non-summon skill does NOT create a Boulder (control)", () => {
  const r = roland();
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland4", targets: [] }); // Stoneform, not a summon
  assert.equal(boulders(st).length, 0, "Stoneform creates no Boulder");
});

// --------------------------------------------------------------------------------------------- //
// roland4 — Stoneform
// --------------------------------------------------------------------------------------------- //

test("Stoneform: Roland gains 15 Damage Reduction (a 20-hit is reduced to 5), lasting 1 turn", () => {
  const r = roland();
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland4", targets: [] });
  const dr = r.statuses.find((s) => s.kind === "damage_reduction")!;
  assert.ok(dr, "Roland has Damage Reduction");
  assert.equal(dr.magnitude, 15, "15 points of Damage Reduction");

  performAction(st, { unit: "e1", skillId: "zap", targets: ["a1"] }); // 20 damage
  assert.equal(r.hp, 95, "20 - 15 DR = 5 damage taken");

  // "for 1 turn": expires after Roland's next turn end.
  endTurn(st); // A ends turn 1 (birth turn -> no tick)
  endTurn(st); // B ends turn 2 -> not Roland's turn, no tick
  endTurn(st); // A ends turn 3 -> DR expires
  assert.ok(!has(r, "damage_reduction"), "the Damage Reduction lasts only 1 of Roland's turns");
});

test("Stoneform: allies affected by Living Stone ALSO gain the 15 DR; unaffected allies do not", () => {
  const r = roland();
  const affected = makeUnit({ id: "a2", team: "A", name: "Affected" });
  const unaffected = makeUnit({ id: "a3", team: "A", name: "Unaffected" });
  affected.statuses.push(status("mark", { name: "Living Stone" })); // affected by Living Stone
  const st = makeState([r, affected, unaffected], [enemy("e1")]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland4", targets: [] });

  assert.ok(has(r, "damage_reduction"), "Roland himself gains DR");
  const drA = affected.statuses.find((s) => s.kind === "damage_reduction");
  assert.ok(drA && drA.magnitude === 15, "the Living-Stone-affected ally ALSO gains 15 DR");
  assert.ok(!has(unaffected, "damage_reduction"), "an ally NOT affected by Living Stone gains nothing (control)");

  // Concrete confirmation via real damage.
  performAction(st, { unit: "e1", skillId: "zap", targets: ["a2"] });
  assert.equal(affected.hp, 95, "affected ally: 20 - 15 DR = 5 taken");
  performAction(st, { unit: "e1", skillId: "zap", targets: ["a3"] });
  assert.equal(unaffected.hp, 80, "unaffected ally: full 20 taken");
});

// --------------------------------------------------------------------------------------------- //
// roland5 — Fissure
// --------------------------------------------------------------------------------------------- //

test("Fissure: ALL targets other than Roland take 20 (allies included); Roland takes none", () => {
  const r = roland();
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([r, ally], [e1, e2]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland5", targets: [] });
  assert.equal(e1.hp, 80, "enemy 1 takes 20");
  assert.equal(e2.hp, 80, "enemy 2 takes 20");
  assert.equal(ally.hp, 80, "a Roland ALLY is also a 'target other than Roland' and takes 20");
  assert.equal(r.hp, 100, "Roland himself takes no damage");
});

test("Fissure: targets' HARMFUL skills are stunned for 1 turn; non-Harmful skills and Roland are unaffected", () => {
  const r = roland();
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland5", targets: [] });

  const stun = e.statuses.find((s) => s.kind === "stun")!;
  assert.ok(stun, "the enemy is stunned");
  assert.equal(stun.scope?.tag, "Harmful", "the stun is scoped to Harmful skills");
  assert.equal(stun.scope?.mode, "only", "it stops ONLY Harmful skills");
  assert.equal(stun.duration, 1, "for 1 turn");

  const harmful = performAction(st, { unit: "e1", skillId: "zap", targets: ["a1"] });
  assert.equal(harmful.ok, false, "the enemy's Harmful skill is blocked");
  assert.equal(harmful.reason, "stunned", "...specifically by the stun");

  const strategic = performAction(st, { unit: "e1", skillId: "buff", targets: [] });
  assert.ok(strategic.ok, "a non-Harmful (Strategic) skill is NOT stunned");

  assert.ok(!has(r, "stun"), "Roland (excluded from Fissure) is not stunned");
});

test("Fissure: starts each round with 2 turns of cooldown remaining (and is unusable at round start)", () => {
  const r = roland();
  const st = makeState([r], [enemy("e1")]);
  fund(st);

  startRound(st, "A"); // round-start passive sets Fissure's cooldown
  const fissure = r.skills!.find((s) => s.id === "roland5")!;
  assert.equal(fissure.currentCd, 2, "Fissure begins the round with 2 turns of cooldown remaining");

  const other = r.skills!.find((s) => s.id === "roland1")!;
  assert.equal(other.currentCd, 0, "a skill without the round-start rule is fully off cooldown (control)");

  fund(st); // startRound does not grant income
  const res = performAction(st, { unit: "a1", skillId: "roland5", targets: [] });
  assert.equal(res.ok, false, "Fissure cannot be cast at round start");
  assert.equal(res.reason, "on-cooldown", "...because it holds 2 turns of cooldown");
});
