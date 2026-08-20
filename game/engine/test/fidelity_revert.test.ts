import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, effectiveCost, effectiveTargeting } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { removeStatus } from "../src/status.ts";
import "../content/hero.ts"; // side-effect: registers the fusion custom handlers
import { makeState, makeUnit, skill } from "./helpers.ts";

// Engine-fidelity PR4 — the "temporary self-reverting skill modifier" revert-hook:
//   empowerThornPrick (titania:brimstone) → skill_damage_bonus (+5 initial dmg, DoT untouched) + free cost
//   bannerAffectsAllEnemies (taryn:zealot) → skill_targeting_override (single → all-enemies, auto-reverting)

// --- skill_damage_bonus (empowerThornPrick) ----------------------------------- //

test("skill_damage_bonus adds a flat bonus to the NAMED skill's damage op only", () => {
  const hero = makeUnit({ id: "h", team: "A" });
  hero.statuses.push({ kind: "skill_damage_bonus", skillId: "s1", magnitude: 5, duration: 4, appliedBy: "h", appliedTurn: 0 });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([hero], [enemy]);

  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: hero, targets: [enemy], skillId: "s1" });
  assert.equal(enemy.hp, 85, "s1's hit got +5 (10 → 15)");

  enemy.hp = 100;
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: hero, targets: [enemy], skillId: "s2" });
  assert.equal(enemy.hp, 90, "a different skill id gets no bonus");
});

test("empowerThornPrick: Thorn Prick becomes free + its initial damage is +5 for the window", () => {
  const titania = makeUnit({ id: "t", team: "A" });
  titania.skills = [skill("titania1", [{ op: "damage", amount: 10, to: "target" }], { cost: { generic: 1, specific: 1 }, targeting: "single", tags: ["Harmful"] })];
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([titania], [enemy]);

  runEffects(state, [{ op: "custom", fn: "empowerThornPrick", args: { turns: 4, skillId: "titania1", freeCost: true, bonusInitialDamage: 5 } }], { caster: titania, self: titania, skillId: "titaniabrimstone" });

  assert.deepEqual(effectiveCost(titania, titania.skills[0]!, state), { generic: 0, specific: 0 }, "Thorn Prick costs nothing");
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: titania, targets: [enemy], skillId: "titania1" });
  assert.equal(enemy.hp, 85, "initial damage 10 + 5 = 15");

  // The bonus is a normal duration-bounded status: once it lapses, damage reverts to base.
  removeStatus(titania, "skill_damage_bonus");
  enemy.hp = 100;
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: titania, targets: [enemy], skillId: "titania1" });
  assert.equal(enemy.hp, 90, "after the window, the +5 is gone");
});

// --- skill_targeting_override (bannerAffectsAllEnemies) ------------------------ //

test("bannerAffectsAllEnemies: Banner targets all enemies for the window, then reverts to single-target", () => {
  const taryn = makeUnit({ id: "t", team: "A" });
  taryn.skills = [skill("taryn1", [{ op: "damage", amount: 10, to: "target" }], { cost: { generic: 0, specific: 0 }, targeting: "single", tags: ["Harmful"] })];
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([taryn], [e1, e2]);

  runEffects(state, [{ op: "custom", fn: "bannerAffectsAllEnemies", args: { skillId: "taryn1", turns: 1 } }], { caster: taryn, self: taryn, skillId: "tarynzealot" });
  assert.equal(effectiveTargeting(taryn, taryn.skills[0]!), "all-enemies", "targeting widened for the window");

  performAction(state, { unit: "t", skillId: "taryn1" }); // resolves through the widened targeting → hits both
  assert.equal(e1.hp, 90, "enemy 1 hit");
  assert.equal(e2.hp, 90, "enemy 2 hit (single-target widened to all-enemies)");

  // Auto-revert: once the override lapses (a normal duration-1 status on Taryn), targeting is single again.
  removeStatus(taryn, "skill_targeting_override");
  assert.equal(effectiveTargeting(taryn, taryn.skills[0]!), "single", "reverts to the base single targeting");
});

test("a widened Banner is a real AOE: it is NOT treated as single-target by split_incoming (cross-feature)", () => {
  // Taryn (widened to all-enemies) vs an enemy holding split_incoming; a Cinders-marked ally sits on Taryn's team.
  // ctx.targeting must be the EFFECTIVE (all-enemies) category, so the AOE hit on the holder is not split.
  const taryn = makeUnit({ id: "t", team: "A" });
  taryn.skills = [skill("taryn1", [{ op: "damage", amount: 30, to: "target" }], { cost: { generic: 0, specific: 0 }, targeting: "single", tags: ["Harmful"] })];
  const ally = makeUnit({ id: "a2", team: "A", hp: 100, statuses: [{ kind: "mark", name: "Cinders", duration: null, appliedBy: "j", appliedTurn: 0 }] });
  const jarrik = makeUnit({ id: "j", team: "B", hp: 100, statuses: [{ kind: "split_incoming", name: "Cinders", duration: null, appliedBy: "j", appliedTurn: 0 }] });
  const state = makeState([taryn, ally], [jarrik]);

  runEffects(state, [{ op: "custom", fn: "bannerAffectsAllEnemies", args: { skillId: "taryn1", turns: 1 } }], { caster: taryn, self: taryn, skillId: "tarynzealot" });
  performAction(state, { unit: "t", skillId: "taryn1" });

  assert.equal(jarrik.hp, 70, "the AOE hit on Jarrik is full (not split)");
  assert.equal(ally.hp, 100, "no friendly-fire split share onto Taryn's own Cinders-marked ally");
});
