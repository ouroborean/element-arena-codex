import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import type { MatchState, Unit } from "../src/types.ts";

// =============================================================================
// Adversarial, spec-derived suite for Taryn's AUGMENTS. Every assertion is
// derived from the FROZEN augment prose (content/frozen/augments.json), NOT the
// implementation. Taryn's element is Holy; Specific costs are paid in holy.
//
//   taryn1 Inspiring Sweep: "Inspiring Thrust now targets all enemies but has an
//     additional 1 turn cooldown."  (Inspiring Thrust = the taryn3 skill.)
//   taryn2 Unbreakable Protector: "Protector of the Song now also triggers when
//     Taryn is stunned or countered."  (Protector of the Song = the taryn0 passive:
//     reflected-to-Taryn -> 10 DR (1 turn) + Elemental Essence.)
//   taryn3 Eternal Service: "Taryn's Strategic skills cannot be stunned."
//     (Strategic skills = Stalwart Shield = taryn4 and Radiant Glory = taryn5.)
//   taryn4 Mine is the Verse: "Allies affected by Refrain reflect harmful they
//     receive to Taryn."  (Refrain = the taryn2 skill; its ally branch marks the
//     ally 'Refrain'.)
//   taryn5 Hers is the Glory: "Refrain will now target a random ally when used on
//     an enemy, or a random enemy when used on an ally."
//
// NOTE ON SKILL vs AUGMENT IDS: the augment ids (taryn1..taryn5) collide by name
// with the skill ids. The frozen augment prose names the skills by their display
// names, which map to skill ids: Inspiring Thrust=taryn3, Protector of the
// Song=taryn0, Refrain=taryn2, Stalwart Shield=taryn4, Radiant Glory=taryn5.
// =============================================================================

// Synthetic skills — drive attacks/statuses without coupling to another hero's kit.
const harmSkill = (id: string, amount: number) =>
  skill(id, [{ op: "damage", amount, to: "target", id: `${id}.d` }], {
    tags: ["Harmful"], element: "fire", cost: { generic: 0, specific: 0 }, targeting: "single",
  });
const helpSkill = (id: string) =>
  skill(id, [{ op: "heal", amount: 1, to: "self", id: `${id}.h` }], {
    tags: ["Helpful"], element: "fire", cost: { generic: 0, specific: 0 }, targeting: "self",
  });
// An enemy skill that lands an (unscoped) stun on its target — used to actually stun Taryn.
const stunSkill = (id: string) =>
  skill(id, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 }, id: `${id}.s` }], {
    tags: ["Harmful"], element: "fire", cost: { generic: 0, specific: 0 }, targeting: "single",
  });

interface Board { taryn: Unit; ally: Unit; enemy: Unit; enemy2: Unit; state: MatchState; }

function board(augIds: string[] = [], allyHp = 100): Board {
  const taryn = loadHero(heroById("taryn"), "A", "taryn");
  for (const id of augIds) applyAugment(taryn, augmentById(id)!);
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: allyHp, maxHp: 100,
    skills: [harmSkill("ahit", 10), helpSkill("aheal")] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [harmSkill("ehit", 30), helpSkill("eheal"), stunSkill("estun")] });
  const enemy2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [harmSkill("e2hit", 30)] });
  const state = makeState([taryn, ally], [enemy, enemy2]);
  state.teams.A.energy = { generic: 40, holy: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { taryn, ally, enemy, enemy2, state };
}

const rewarded = (u: Unit): boolean =>
  u.statuses.some((s) => s.kind === "damage_reduction" && s.magnitude === 10 && s.duration === 1) &&
  u.statuses.some((s) => s.kind === "elemental_essence");

const t3 = (taryn: Unit) => (taryn.skills ?? []).find((s) => s.id === "taryn3")!;
const hasRefrainMark = (u: Unit) => u.statuses.some((s) => s.kind === "mark" && s.name === "Refrain");
const hasStun = (u: Unit) => u.statuses.some((s) => s.kind === "stun");

// ============================================================================
// taryn1 — Inspiring Sweep: "Inspiring Thrust now targets all enemies but has an
// additional 1 turn cooldown."
// ============================================================================

test("Inspiring Sweep: Inspiring Thrust (taryn3) now hits EVERY enemy for its full 20", () => {
  const { ally, enemy, enemy2, state } = board(["taryn1"]);
  const r = performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(r.ok, true, "cast succeeds");
  assert.equal(enemy.hp, 80, "the chosen enemy takes 20");
  assert.equal(enemy2.hp, 80, "the OTHER enemy also takes 20 — it now fans across all enemies");
  assert.equal(ally.hp, 100, "no friendly fire");
});

test("Inspiring Sweep control: WITHOUT the augment, Inspiring Thrust hits only the single chosen enemy", () => {
  const { enemy, enemy2, state } = board([]);
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(enemy.hp, 80, "chosen enemy takes 20");
  assert.equal(enemy2.hp, 100, "the other enemy is untouched — base is single-target");
});

test("Inspiring Sweep: the additional 1-turn cooldown makes it un-recastable next action (base was 0-CD)", () => {
  const { taryn, state } = board(["taryn1"]);
  const first = performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(first.ok, true);
  assert.equal(t3(taryn).currentCd, 1, "cooldown is now 1 (base 0 + additional 1)");
  const again = performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(again.ok, false, "cannot immediately recast");
  assert.equal(again.reason, "on-cooldown");
});

test("Inspiring Sweep control: WITHOUT the augment, Inspiring Thrust stays 0-CD and IS recastable", () => {
  const { taryn, state } = board([]);
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(t3(taryn).currentCd, 0, "base cooldown stays 0");
  const again = performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(again.ok, true, "can recast immediately (control for the +1 cooldown)");
});

// ============================================================================
// taryn2 — Unbreakable Protector: "Protector of the Song now also triggers when
// Taryn is stunned or countered." Base reward: 10 DR (1 turn) + Elemental Essence.
// ============================================================================

test("Unbreakable Protector: Taryn being STUNNED grants the Protector reward (10 DR 1t + Essence)", () => {
  const { taryn, state } = board(["taryn2"]);
  assert.ok(!rewarded(taryn), "no reward before the stun");
  performAction(state, { unit: "e", skillId: "estun", targets: ["taryn"] }); // enemy stuns Taryn
  assert.ok(hasStun(taryn), "Taryn is actually stunned");
  assert.ok(rewarded(taryn), "Protector now also fires on being stunned");
});

test("Unbreakable Protector: Taryn being COUNTERED grants the Protector reward", () => {
  const { taryn, state } = board(["taryn2"]);
  emit(state, { type: "counterFired", counterer: "e", caster: "taryn", skillId: "x" });
  assert.ok(rewarded(taryn), "Protector now also fires when Taryn's skill is countered");
});

test("Unbreakable Protector control: WITHOUT the augment, a stun grants NO Protector reward", () => {
  const { taryn, state } = board([]);
  performAction(state, { unit: "e", skillId: "estun", targets: ["taryn"] });
  assert.ok(hasStun(taryn), "Taryn is stunned");
  assert.ok(!rewarded(taryn), "base Protector does NOT reward on a stun");
});

test("Unbreakable Protector control: WITHOUT the augment, a counter grants NO Protector reward", () => {
  const { taryn, state } = board([]);
  emit(state, { type: "counterFired", counterer: "e", caster: "taryn", skillId: "x" });
  assert.ok(!rewarded(taryn), "base Protector does NOT reward on a counter");
});

test("Unbreakable Protector control: a counter against SOMEONE ELSE does not reward Taryn", () => {
  const { taryn, state } = board(["taryn2"]);
  emit(state, { type: "counterFired", counterer: "e", caster: "a2", skillId: "x" }); // ally was countered, not Taryn
  assert.ok(!rewarded(taryn), "only Taryn's OWN skill being countered rewards him");
});

test("Unbreakable Protector: the base reflect entry point still rewards (augment ADDS, not replaces)", () => {
  const { taryn, state } = board(["taryn2"]);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "a2", to: "taryn" });
  assert.ok(rewarded(taryn), "reflected-to-Taryn still triggers Protector");
});

// ============================================================================
// taryn3 — Eternal Service: "Taryn's Strategic skills cannot be stunned."
// Strategic skills = Stalwart Shield (taryn4) and Radiant Glory (taryn5).
// ============================================================================

test("Eternal Service: while Taryn is stunned, his Strategic skills (Stalwart Shield, Radiant Glory) still cast", () => {
  const { taryn, state } = board(["taryn3"]);
  taryn.statuses.push(status("stun", { duration: 1 })); // an unscoped stun that would normally block everything
  const shield = performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["taryn"] });
  assert.equal(shield.ok, true, "Stalwart Shield (Strategic) is castable while stunned");
  const glory = performAction(state, { unit: "taryn", skillId: "taryn5", targets: ["taryn"] });
  assert.equal(glory.ok, true, "Radiant Glory (Strategic) is castable while stunned");
});

test("Eternal Service: NON-Strategic skills are still stunned (Banner, Refrain, Inspiring Thrust blocked)", () => {
  const { taryn, state } = board(["taryn3"]);
  taryn.statuses.push(status("stun", { duration: 1 }));
  for (const id of ["taryn1", "taryn2", "taryn3"]) {
    const r = performAction(state, { unit: "taryn", skillId: id, targets: ["e"] });
    assert.equal(r.ok, false, `${id} (non-Strategic) is still stunned`);
    assert.equal(r.reason, "stunned", `${id} rejected specifically for the stun`);
  }
});

test("Eternal Service control: WITHOUT the augment, the same stun blocks the Strategic skills too", () => {
  const { taryn, state } = board([]);
  taryn.statuses.push(status("stun", { duration: 1 }));
  const shield = performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["taryn"] });
  assert.equal(shield.ok, false, "base Stalwart Shield IS stunnable");
  assert.equal(shield.reason, "stunned");
  const glory = performAction(state, { unit: "taryn", skillId: "taryn5", targets: ["taryn"] });
  assert.equal(glory.ok, false, "base Radiant Glory IS stunnable");
});

// ============================================================================
// taryn4 — Mine is the Verse: "Allies affected by Refrain reflect harmful they
// receive to Taryn." (Refrain's ally branch marks the ally 'Refrain'.)
// ============================================================================

test("Mine is the Verse: a Refrain-marked ally reflects an incoming harmful skill onto Taryn", () => {
  const { taryn, ally, state } = board(["taryn4"]);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] }); // Refrain on the ally -> 'Refrain' mark
  assert.ok(hasRefrainMark(ally), "the ally is affected by Refrain");
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] }); // enemy attacks the marked ally
  assert.equal(ally.hp, 100, "the ally is NOT hit — the harm was reflected off it");
  assert.ok(taryn.hp < 100, "Taryn absorbed the reflected harmful skill instead");
});

test("Mine is the Verse control: an ally NOT affected by Refrain takes the harm normally", () => {
  const { taryn, ally, state } = board(["taryn4"]);
  assert.ok(!hasRefrainMark(ally), "no Refrain on the ally");
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(ally.hp, 70, "unmarked ally takes its own 30 damage");
  assert.equal(taryn.hp, 100, "Taryn is not pulled in");
});

test("Mine is the Verse control: WITHOUT the augment, a Refrain-marked ally still takes the harm", () => {
  const { taryn, ally, state } = board([]);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] }); // marks the ally, but no reflect augment
  assert.ok(hasRefrainMark(ally), "ally is Refrain-marked");
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(ally.hp, 70, "without the augment the mark does NOT reflect — ally is hit");
  assert.equal(taryn.hp, 100, "Taryn uninvolved");
});

// ============================================================================
// taryn5 — Hers is the Glory: "Refrain will now target a random ally when used on
// an enemy, or a random enemy when used on an ally."
// ============================================================================

test("Hers is the Glory: Refrain used on an ENEMY also marks a random ally with Refrain (plus the base enemy stun)", () => {
  const { taryn, ally, enemy, state } = board(["taryn5"]);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["e"] }); // used ON an enemy
  assert.ok(hasStun(enemy), "the chosen enemy is still stunned (base enemy branch)");
  const marked = [taryn, ally].filter(hasRefrainMark).length;
  assert.equal(marked, 1, "exactly one random ally gains the Refrain (ally-branch) mark");
});

test("Hers is the Glory control: WITHOUT the augment, Refrain on an enemy marks NO ally", () => {
  const { taryn, ally, enemy, state } = board([]);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["e"] });
  assert.ok(hasStun(enemy), "enemy still stunned");
  assert.equal([taryn, ally].filter(hasRefrainMark).length, 0, "no ally is marked without the augment");
});

test("Hers is the Glory: Refrain used on an ALLY also stuns a random enemy's harmful skills (plus the base ally mark)", () => {
  const { ally, enemy, enemy2, state } = board(["taryn5"]);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] }); // used ON an ally
  assert.ok(hasRefrainMark(ally), "the chosen ally is still Refrain-marked (base ally branch)");
  assert.equal([enemy, enemy2].filter(hasStun).length, 1, "exactly one random enemy is stunned");
});

test("Hers is the Glory control: WITHOUT the augment, Refrain on an ally stuns NO enemy", () => {
  const { ally, enemy, enemy2, state } = board([]);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] });
  assert.ok(hasRefrainMark(ally), "ally marked");
  assert.equal([enemy, enemy2].filter(hasStun).length, 0, "no enemy is stunned without the augment");
});
