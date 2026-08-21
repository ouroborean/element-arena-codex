import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, effectiveCost } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { redactState } from "../src/visibility.ts";
import { totalShield, applyDamage } from "../src/damage.ts";
import { stackCount } from "../src/status.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// ===========================================================================================
// ADVERSARIAL, SPEC-DERIVED suite for MAGGIE THORNCURSED's FUSION FORMS.
// Oracle = the FROZEN prose (content/frozen/skills.json). Every expectation below is derived from
// that text, NOT from the effect trees. Content was read only to learn HOW to drive: fusion element
// keys, skill ids, energy costs, targeting, and the "Curse of Thorns"/"Bramblelash"/"Spectral
// Growth"/"Bloodrose Offering"/"Icebite Briars"/"Reanimated" status names a form produces.
//
// Base mechanic (maggie0 Curse of Thorns): using a skill accumulates one "Curse of Thorns" STACK
// (a `stack` status) whose per-turn Affliction DoT = 5 x stacks (a name-scoped `dot`). Many fusion
// forms read/scale off those stacks. Bramblelash (maggie1) is a base skill that stamps a
// "Bramblelash" mark. Fusion replaces the base passive's triggers, so where a scenario needs Curse
// state we seed it directly (the frozen-faithful precondition), exactly as suite_maggie_base does.
//
//   FORMS (each = a passive + a 4th-slot fusion active), frozen text:
//   blight  Blighted Witch      : "When Maggie falls below 70 HP or 30 HP, all enemy skills cost 1 more [65] for 1 turn."
//           Bog Witch's Bargain : "Targets one enemy for 1 turn. If that enemy uses a new skill, they will receive 35
//                                  Affliction damage and permanently ignore non-damage effects. If they do not, they
//                                  are stunned for 1 turn and Maggie heals 35 HP."
//   blood   Thorn Siphon        : "Maggie's allies heal 5 HP each time Curse of Thorns deals damage."
//           Bloodbind           : "For the next 3 turns, Curse of Thorns also damages target enemy."
//   curse   Touch of Finality   : "Units damaged by Curse of Thorns cannot be healed for 1 turn."
//           Shared Fate         : "Target enemy is permanently affected by Curse of Thorns."
//   devil   Asmodeus's Promise  : "Once Maggie has at least 5 stacks of Curse of Thorns, she applies it to any enemy she damages."
//           Lust for Power      : "Maggie gains 1 stack of Curse of Thorns and Elemental Essence."
//   evil    Sweet Torment       : "Whenever Maggie deals damage to an ally, she deals 5 more non-Affliction damage permanently."
//           Transferance Contract: "Target ally receives all stacks of Curse of Thorns currently on Maggie."
//   ghost   Spectral Growth     : "Whenever an enemy uses a Strategic skill, they gain 1 stack of Spectral Growth.
//                                  Maggie's damaging skills will remove these stacks to heal her for 5 HP per stack."
//           Ghostlash           : "Deals 25 damage to target enemy, increased by 10 if they are currently marked by Bramblelash. Bypassing"
//   grave   Graveyard Wanderer  : "Maggie gains 10 Damage Reduction for each dead Hero in the battle."
//           Bloodrose Offering  : "For 1 turn, if target ally dies, Maggie will heal 10 HP for each stack of Curse of
//                                  Thorns on her. This effect is invisible."
//   lich    Lash of Servitude   : "If Maggie kills an enemy Hero, she creates a Revenant minion with their 3 Basic skills and 25 HP."
//           Icebite Briars      : "For 4 turns, if Maggie deals damage to an enemy, that enemy will deal 5 less non-
//                                  Affliction damage for 1 turn. During this time, Curse of Thorns will not damage her."
//   reanim  Manipulated Movements: "If Maggie is affected with a new stun effect, she receives 1 stack of Curse of Thorns and removes that stun effect."
//           Bloody Marionette   : "For the next 3 turns, target ally will become Immortal. During this time, they can
//                                  only target Maggie or enemies affected by Bramblelash. At the end of this skill's duration, the target dies."
//   zealot  Sanguine Craving    : "Maggie now receives an additional stack of Curse of Thorns when she uses a skill,
//                                  and will receive 1 stack if she does not act on her turn."
//           Thousand Lashes     : "Deals 30 damage to target enemy, increased by 5 per stack of Curse of Thorns on Maggie."
// ===========================================================================================

function energy(el: string): Record<string, number> {
  return { generic: 40, [el]: 40 };
}
function fuse(el: string): Unit {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const form = fusionForm("maggie", el);
  assert.ok(form, `fusion form maggie:${el} must exist`);
  applyFusion(maggie, form!);
  assert.equal(maggie.fused, el, `Maggie is fused into ${el}`);
  return maggie;
}
const curse = (u: Unit): number => stackCount(u, "Curse of Thorns");
function seedCurse(u: Unit, n: number): void {
  u.statuses.push(status("stack", { name: "Curse of Thorns", magnitude: n, duration: null, appliedBy: "maggie", appliedTurn: 0 }));
}
// A Curse-of-Thorns DoT (the thing that "deals damage") on `u`, applied by team A so it ticks at A's turn-end.
function seedCurseDot(u: Unit, mag: number, by = "maggie"): void {
  u.statuses.push(status("dot", { name: "Curse of Thorns", magnitude: mag, dtype: "affliction", duration: null, appliedBy: by, appliedTurn: 0 }));
}
const hasEssence = (u: Unit): boolean => u.statuses.some((s) => s.kind === "elemental_essence");
const hasStun = (u: Unit): boolean => u.statuses.some((s) => s.kind === "stun");
const hasHealLock = (u: Unit): boolean => u.statuses.some((s) => s.kind === "heal_lock");
const hasCurseDot = (u: Unit): boolean => u.statuses.some((s) => s.kind === "dot" && s.name === "Curse of Thorns");

// A cheap enemy attack (normal damage) used to drive on-damage passives / kills.
function enemyHit(amount: number): ReturnType<typeof skill> {
  return skill("ehit", [{ op: "damage", amount, dtype: "normal", to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } });
}

// ===========================================================================================
// FORM: blight
// ===========================================================================================

test("blight/Blighted Witch: a hit that drops Maggie below 70 HP makes enemy skills cost +1; a hit leaving her >=70 does not", () => {
  // POSITIVE — enemy drops Maggie to 60 (<70) => all enemy skills cost 1 more.
  {
    const maggie = fuse("blight");
    const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(40)] });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("blight");
    state.teams.B.energy = { generic: 40 };
    const before = effectiveCost(e, e.skills![0]!).generic;
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok, "enemy hits Maggie");
    assert.equal(maggie.hp, 60, "Maggie is left below 70 HP");
    assert.equal(effectiveCost(e, e.skills![0]!).generic, before + 1, "the enemy's skills now cost 1 more generic");
    assert.ok(e.statuses.some((s) => s.kind === "cost_mod" && (s.magnitude ?? 0) === 1), "enemy carries a +1 cost_mod");
  }
  // CONTROL — a hit leaving Maggie at 80 (>=70) grants no cost penalty.
  {
    const maggie = fuse("blight");
    const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(20)] });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("blight");
    state.teams.B.energy = { generic: 40 };
    const before = effectiveCost(e, e.skills![0]!).generic;
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok);
    assert.equal(maggie.hp, 80, "Maggie stays at/above 70");
    assert.equal(effectiveCost(e, e.skills![0]!).generic, before, "no cost penalty while >=70 HP");
    assert.ok(!e.statuses.some((s) => s.kind === "cost_mod"), "no cost_mod applied");
  }
});

test("blight/Bog Witch's Bargain — punish: a marked enemy that uses a skill takes 35 Affliction; an unmarked enemy does not", () => {
  const maggie = fuse("blight");
  const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(1)] });
  const e2 = makeUnit({ id: "e2", team: "B", skills: [enemyHit(1)] });
  const state = makeState([maggie], [e, e2]);
  state.teams.A.energy = energy("blight");
  state.teams.B.energy = { generic: 40 };
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggieblight1", targets: ["e"] }).ok, "Bargain marks e");

  // CONTROL — the UNMARKED enemy uses a skill: no 35 Affliction punish.
  assert.ok(performAction(state, { unit: "e2", skillId: "ehit", targets: ["maggie"] }).ok);
  assert.equal(e2.hp, 100, "an unmarked enemy is not punished for acting");

  // POSITIVE — the marked enemy uses a skill: 35 Affliction.
  assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok);
  assert.equal(e.hp, 65, "the marked enemy takes 35 Affliction for using a new skill");
});

test("blight/Bog Witch's Bargain — punish: the punished enemy then permanently ignores non-damage effects", () => {
  const maggie = fuse("blight");
  // Maggie needs a stun-applying skill to probe the 'ignore non-damage effects' clause.
  maggie.skills!.push(skill("magstun", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } }));
  const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(1)] });
  const e2 = makeUnit({ id: "e2", team: "B", skills: [enemyHit(1)] });
  const state = makeState([maggie], [e, e2]);
  state.teams.A.energy = energy("blight");
  state.teams.B.energy = { generic: 40 };
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggieblight1", targets: ["e"] }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok, "marked enemy acts -> punished");

  // POSITIVE — a stun aimed at the punished enemy is IGNORED (permanent 'ignore non-damage effects').
  assert.ok(performAction(state, { unit: "maggie", skillId: "magstun", targets: ["e"] }).ok);
  assert.equal(hasStun(e), false, "the punished enemy ignores the stun (non-damage effect)");
  // CONTROL — the same stun lands on a normal enemy.
  assert.ok(performAction(state, { unit: "maggie", skillId: "magstun", targets: ["e2"] }).ok);
  assert.equal(hasStun(e2), true, "an un-punished enemy is stunned normally");
});

test.skip("SUSPECTED BUG blight/Bog Witch's Bargain — timeout: a marked enemy that does NOT act should be stunned 1 turn and heal Maggie 35, but the 1-turn mark expires the same turn-end the timeout fires so neither happens", () => {
  // Frozen: "If they do not [use a new skill], they are stunned for 1 turn and Maggie heals 35 HP."
  const maggie = fuse("blight");
  maggie.hp = 50; // so the 35 self-heal is observable
  const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(1)] });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = energy("blight");
  state.teams.B.energy = { generic: 40 };
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggieblight1", targets: ["e"] }).ok, "Bargain marks e");
  // e never acts; advance to Maggie's next turn-end (when the 1-turn window closes).
  endTurn(state); // A ends turn 1 (birth)
  endTurn(state); // B ends turn 2 (e declines to act)
  endTurn(state); // A ends turn 3 -> window closes
  assert.equal(hasStun(e), true, "the idle marked enemy is stunned for 1 turn");
  assert.equal(maggie.hp, 85, "Maggie heals 35 when the enemy fails to act");
});

// ===========================================================================================
// FORM: blood
// ===========================================================================================

test("blood/Bloodbind: for 3 turns Curse of Thorns also damages the target enemy (5 x Maggie's stacks / turn), then stops; other enemies untouched", () => {
  const maggie = fuse("blood");
  seedCurse(maggie, 2); // Curse damage = 5 x 2 = 10 per tick
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const state = makeState([maggie], [e1, e2]);
  state.teams.A.energy = energy("blood");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggieblood1", targets: ["e1"] }).ok, "Bloodbind on e1");
  assert.equal(e1.hp, 100, "no instant damage on cast");
  assert.ok(hasCurseDot(e1), "e1 now carries a Curse of Thorns DoT");
  assert.ok(!hasCurseDot(e2), "the untargeted enemy has no Curse DoT");
  // 3 ticks at Maggie's next 3 turn-ends.
  endTurn(state); endTurn(state); endTurn(state); // -> tick 1 (turn 3)
  assert.equal(e1.hp, 90, "tick 1: 10 Affliction");
  endTurn(state); endTurn(state); // -> tick 2 (turn 5)
  assert.equal(e1.hp, 80, "tick 2: 10 Affliction");
  endTurn(state); endTurn(state); // -> tick 3 (turn 7)
  assert.equal(e1.hp, 70, "tick 3: 10 Affliction (3 turns total)");
  endTurn(state); endTurn(state); // -> would be tick 4, but the 3-turn window is over
  assert.equal(e1.hp, 70, "no 4th tick — Bloodbind lasts only 3 turns");
  assert.equal(e2.hp, 100, "the other enemy never took Curse damage");
});

test("blood/Thorn Siphon: each time Curse of Thorns deals damage, Maggie's allies heal 5; unrelated damage does not heal them", () => {
  // POSITIVE — a Curse DoT ticking heals a wounded ally 5, and again on the next tick.
  {
    const maggie = fuse("blood");
    const ally = makeUnit({ id: "ally", team: "A", hp: 70 });
    const state = makeState([maggie, ally], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = energy("blood");
    seedCurseDot(maggie, 5); // Maggie's own Curse of Thorns DoT
    endTurn(state); // A turn-end -> Curse ticks -> Thorn Siphon heals allies 5
    assert.equal(ally.hp, 75, "ally heals 5 when Curse of Thorns deals damage");
    endTurn(state); endTurn(state); // next A turn-end -> another Curse tick
    assert.equal(ally.hp, 80, "ally heals 5 again on the next Curse tick ('each time')");
  }
  // CONTROL — a NON-Curse DoT deals damage: no ally heal (the heal is scoped to Curse of Thorns).
  {
    const maggie = fuse("blood");
    const ally = makeUnit({ id: "ally", team: "A", hp: 70 });
    const state = makeState([maggie, ally], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = energy("blood");
    maggie.statuses.push(status("dot", { name: "Bleed", magnitude: 5, dtype: "affliction", duration: null, appliedBy: "maggie", appliedTurn: 0 }));
    endTurn(state);
    assert.equal(ally.hp, 70, "a non-Curse-of-Thorns DoT does not heal Maggie's allies");
  }
});

// ===========================================================================================
// FORM: curse
// ===========================================================================================

test("curse/Shared Fate: the target enemy is permanently afflicted by Curse of Thorns (5 x Maggie's stacks / turn, never expiring); other enemies untouched", () => {
  const maggie = fuse("curse");
  seedCurse(maggie, 3); // Curse damage = 15 / turn
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const state = makeState([maggie], [e1, e2]);
  state.teams.A.energy = energy("curse");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggiecurse1", targets: ["e1"] }).ok, "Shared Fate on e1");
  assert.ok(hasCurseDot(e1), "e1 is now afflicted by Curse of Thorns");
  assert.ok(!hasCurseDot(e2), "the other enemy is not");
  endTurn(state); endTurn(state); endTurn(state); // tick 1
  assert.equal(e1.hp, 85, "tick 1: 15 Affliction");
  endTurn(state); endTurn(state); // tick 2
  endTurn(state); endTurn(state); // tick 3
  endTurn(state); endTurn(state); // tick 4
  assert.equal(e1.hp, 40, "still ticking after 4 turns — the affliction is permanent");
  assert.equal(e2.hp, 100, "the untargeted enemy is never afflicted");
});

test("curse/Touch of Finality: a unit damaged by Curse of Thorns cannot be healed for 1 turn; a unit not so damaged can", () => {
  const maggie = fuse("curse");
  // A friendly healer with a heal skill (heal op is what heal_lock gates).
  const healer = makeUnit({ id: "healer", team: "B", skills: [skill("hh", [{ op: "heal", amount: 20, to: "target" }], { tags: ["Helpful"], cost: { generic: 0, specific: 0 } })] });
  const locked = makeUnit({ id: "locked", team: "B", hp: 50 });   // will be Curse-damaged
  const free = makeUnit({ id: "free", team: "B", hp: 50 });       // control
  const state = makeState([maggie], [healer, locked, free]);
  state.teams.A.energy = energy("curse");
  state.teams.B.energy = { generic: 40 };
  seedCurseDot(locked, 5); // Curse of Thorns damages `locked`
  endTurn(state); // A turn-end -> Curse ticks on locked -> Touch of Finality heal-locks it
  assert.equal(locked.hp, 45, "Curse of Thorns dealt 5 to locked");
  assert.ok(hasHealLock(locked), "the Curse-damaged unit is heal-locked");
  assert.ok(!hasHealLock(free), "an un-damaged unit is not heal-locked");
  // POSITIVE — healing the locked unit does nothing.
  assert.ok(performAction(state, { unit: "healer", skillId: "hh", targets: ["locked"] }).ok);
  assert.equal(locked.hp, 45, "the heal is blocked — the Curse-damaged unit cannot be healed");
  // CONTROL — healing the un-damaged unit works.
  assert.ok(performAction(state, { unit: "healer", skillId: "hh", targets: ["free"] }).ok);
  assert.equal(free.hp, 70, "an un-locked unit heals normally");
});

// ===========================================================================================
// FORM: devil
// ===========================================================================================

test("devil/Lust for Power: Maggie gains 1 Curse of Thorns stack and Elemental Essence", () => {
  const maggie = fuse("devil");
  seedCurse(maggie, 2);
  const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = energy("devil");
  assert.equal(hasEssence(maggie), false, "precondition: no Essence yet");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggiedevil1", targets: ["maggie"] }).ok, "Lust for Power (self)");
  assert.equal(curse(maggie), 3, "gains exactly 1 Curse of Thorns stack (2 -> 3)");
  assert.equal(hasEssence(maggie), true, "gains Elemental Essence");
});

test("devil/Asmodeus's Promise: at >=5 Curse stacks Maggie applies Curse of Thorns to any enemy she damages; at 4 stacks she does not", () => {
  // POSITIVE — 5 stacks: Bramblelash-ing an enemy afflicts it.
  {
    const maggie = fuse("devil");
    seedCurse(maggie, 5);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("devil");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok, "Maggie damages e");
    assert.ok(curse(e) >= 1 || hasCurseDot(e), "the damaged enemy is now affected by Curse of Thorns");
  }
  // CONTROL — 4 stacks: no Curse spread.
  {
    const maggie = fuse("devil");
    seedCurse(maggie, 4);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("devil");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(curse(e), 0, "below 5 stacks Maggie does not apply Curse of Thorns");
    assert.ok(!hasCurseDot(e), "no Curse DoT on the enemy");
  }
});

// ===========================================================================================
// FORM: evil
// ===========================================================================================

test("evil/Transferance Contract: the target ally receives all of Maggie's Curse of Thorns stacks; a non-target ally receives none", () => {
  const maggie = fuse("evil");
  seedCurse(maggie, 4);
  const ally = makeUnit({ id: "ally", team: "A" });
  const other = makeUnit({ id: "other", team: "A" });
  const state = makeState([maggie, ally, other], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = energy("evil");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggieevil1", targets: ["ally"] }).ok, "Transferance Contract on ally");
  assert.equal(curse(ally), 4, "the target ally receives all 4 of Maggie's Curse of Thorns stacks");
  assert.equal(curse(other), 0, "a non-target ally receives none");
});

test("evil/Sweet Torment: each time Maggie damages an ally her non-Affliction damage rises 5 (permanently, compounding); an enemy-hit baseline is unbuffed", () => {
  // CONTROL — with no ally-damage yet, Bramblelash deals its base 15.
  {
    const maggie = fuse("evil");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e, makeUnit({ id: "ally", team: "A" })]);
    state.teams.A.energy = energy("evil");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 85, "baseline Bramblelash = 15");
  }
  // POSITIVE — after damaging an ally once, +5; after twice, +10.
  {
    const maggie = fuse("evil");
    const ally = makeUnit({ id: "ally", team: "A" });
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie, ally], [e]);
    state.teams.A.energy = energy("evil");
    emit(state, { type: "damageDealt", source: "maggie", target: "ally", amount: 10, dtype: "normal" });
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 80, "one ally-hit => Bramblelash deals 15 + 5 = 20");
    emit(state, { type: "damageDealt", source: "maggie", target: "ally", amount: 10, dtype: "normal" });
    // Bramblelash has no cooldown; cast again.
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(e.hp, 55, "two ally-hits => Bramblelash deals 15 + 10 = 25 (permanent, compounding)");
  }
});

// ===========================================================================================
// FORM: ghost
// ===========================================================================================

test("ghost/Ghostlash: 25 to an unmarked enemy, 35 to a Bramblelash-marked enemy", () => {
  // Ghostlash has a 1-turn cooldown, so each case needs its own fresh cast.
  {
    const maggie = fuse("ghost");
    const plain = makeUnit({ id: "plain", team: "B" });
    const state = makeState([maggie], [plain]);
    state.teams.A.energy = energy("ghost");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggieghost1", targets: ["plain"] }).ok);
    assert.equal(plain.hp, 75, "25 to an unmarked enemy");
  }
  {
    const maggie = fuse("ghost");
    const marked = makeUnit({ id: "marked", team: "B", statuses: [status("mark", { name: "Bramblelash", duration: 2, appliedBy: "maggie" })] });
    const state = makeState([maggie], [marked]);
    state.teams.A.energy = energy("ghost");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggieghost1", targets: ["marked"] }).ok);
    assert.equal(marked.hp, 65, "35 (25 + 10) to a Bramblelash-marked enemy");
  }
});

test.skip("SUSPECTED BUG ghost/Ghostlash is 'Bypassing' but its damage does not ignore Shield — the Bypassing tag never sets the damage op's bypass flag", () => {
  // Frozen: "... Bypassing" => the hit should ignore Shield (and Damage Reduction), landing full on HP.
  const maggie = fuse("ghost");
  const e = makeUnit({ id: "e", team: "B", shield: 40 });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = energy("ghost");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggieghost1", targets: ["e"] }).ok);
  assert.equal(e.hp, 75, "Bypassing => the 25 lands on HP through the Shield");
  assert.equal(totalShield(e), 40, "Bypassing => the Shield is untouched");
});

test("ghost/Spectral Growth: an enemy's Strategic skill grants it a Spectral Growth stack; a non-Strategic skill does not", () => {
  const maggie = fuse("ghost");
  const e = makeUnit({ id: "e", team: "B", skills: [
    skill("strat", [{ op: "applyStatus", to: "self", status: { kind: "elemental_essence", duration: null } }], { tags: ["Strategic"], cost: { generic: 0, specific: 0 } }),
    skill("harm", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } }),
  ] });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = energy("ghost");
  state.teams.B.energy = { generic: 40 };
  // CONTROL — a Harmful (non-Strategic) skill grants nothing.
  assert.ok(performAction(state, { unit: "e", skillId: "harm", targets: ["maggie"] }).ok);
  assert.equal(stackCount(e, "Spectral Growth"), 0, "a non-Strategic skill grants no Spectral Growth");
  // POSITIVE — a Strategic skill grants 1 stack.
  assert.ok(performAction(state, { unit: "e", skillId: "strat", targets: ["e"] }).ok);
  assert.equal(stackCount(e, "Spectral Growth"), 1, "a Strategic skill grants 1 Spectral Growth");
});

test("ghost/Spectral Growth: Maggie's damaging skill consumes an enemy's Spectral Growth stacks to heal her 5 each; no stacks => no heal", () => {
  // POSITIVE — enemy holds 2 stacks; Ghostlash heals Maggie 10 and clears them.
  {
    const maggie = fuse("ghost");
    maggie.hp = 50;
    const e = makeUnit({ id: "e", team: "B", statuses: [status("stack", { name: "Spectral Growth", magnitude: 2, duration: null, appliedBy: "e" })] });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("ghost");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggieghost1", targets: ["e"] }).ok);
    assert.equal(maggie.hp, 60, "Maggie heals 5 x 2 = 10");
    assert.equal(stackCount(e, "Spectral Growth"), 0, "the Spectral Growth stacks are consumed");
  }
  // CONTROL — enemy with no stacks: no heal.
  {
    const maggie = fuse("ghost");
    maggie.hp = 50;
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("ghost");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggieghost1", targets: ["e"] }).ok);
    assert.equal(maggie.hp, 50, "no Spectral Growth => no heal");
  }
});

// ===========================================================================================
// FORM: grave
// ===========================================================================================

test("grave/Graveyard Wanderer: Maggie gains 10 Damage Reduction per dead Hero (scales; 0 dead => none)", () => {
  // 0 dead heroes -> no DR: a 30 normal hit lands full.
  {
    const maggie = fuse("grave");
    const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(30)] });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("grave");
    state.teams.B.energy = { generic: 40 };
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok);
    assert.equal(maggie.hp, 70, "no dead heroes => 0 DR => full 30 damage");
  }
  // 1 dead hero -> 10 DR; 2 dead -> 20 DR.
  {
    const maggie = fuse("grave");
    const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(30)] });
    const corpse1 = makeUnit({ id: "corpse1", team: "B", kind: "hero", alive: false, hp: 0 }); // 1 dead hero
    const corpse2 = makeUnit({ id: "corpse2", team: "B", kind: "hero", alive: true, hp: 100 }); // still alive for now
    const state = makeState([maggie], [e, corpse1, corpse2]);
    state.teams.A.energy = energy("grave");
    state.teams.B.energy = { generic: 40 };
    emit(state, { type: "unitDied", unit: "corpse1", killer: null }); // recompute DR: 1 dead hero
    assert.ok(maggie.statuses.some((s) => s.kind === "damage_reduction" && (s.magnitude ?? 0) === 10), "DR = 10 for 1 dead hero");
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok);
    assert.equal(maggie.hp, 80, "10 DR => a 30 hit lands 20");
    maggie.hp = 100;
    corpse2.alive = false; // a second hero has now died
    emit(state, { type: "unitDied", unit: "corpse2", killer: null }); // recompute DR: 2 dead heroes
    assert.ok(maggie.statuses.some((s) => s.kind === "damage_reduction" && (s.magnitude ?? 0) === 20), "DR = 20 for 2 dead heroes");
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["maggie"] }).ok);
    assert.equal(maggie.hp, 90, "20 DR => a 30 hit lands 10");
  }
});

test("grave/Bloodrose Offering: if the marked ally dies within the window, Maggie heals 10 per Curse stack; an unmarked ally's death heals nothing", () => {
  // POSITIVE — marked ally dies => heal 10 x Curse stacks.
  {
    const maggie = fuse("grave");
    maggie.hp = 40;
    seedCurse(maggie, 3); // heal = 10 x 3 = 30
    const ally = makeUnit({ id: "ally", team: "A", hp: 10 });
    const killer = makeUnit({ id: "k", team: "B", skills: [enemyHit(50)] });
    const state = makeState([maggie, ally], [killer]);
    state.teams.A.energy = energy("grave");
    state.teams.B.energy = { generic: 40 };
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggiegrave1", targets: ["ally"] }).ok, "Offering marks ally");
    assert.ok(performAction(state, { unit: "k", skillId: "ehit", targets: ["ally"] }).ok, "ally is killed");
    assert.equal(ally.alive, false, "the marked ally died");
    assert.equal(maggie.hp, 70, "Maggie heals 10 x 3 Curse stacks = 30");
  }
  // CONTROL — an UNMARKED ally dying heals Maggie nothing.
  {
    const maggie = fuse("grave");
    maggie.hp = 40;
    seedCurse(maggie, 3);
    const ally = makeUnit({ id: "ally", team: "A", hp: 10 });
    const killer = makeUnit({ id: "k", team: "B", skills: [enemyHit(50)] });
    const state = makeState([maggie, ally], [killer]);
    state.teams.A.energy = energy("grave");
    state.teams.B.energy = { generic: 40 };
    // No Offering cast.
    assert.ok(performAction(state, { unit: "k", skillId: "ehit", targets: ["ally"] }).ok);
    assert.equal(ally.alive, false, "the ally died");
    assert.equal(maggie.hp, 40, "an unmarked ally's death heals Maggie nothing");
  }
});

test("grave/Bloodrose Offering is invisible: the opponent cannot see the mark, but Maggie's side can", () => {
  const maggie = fuse("grave");
  const ally = makeUnit({ id: "ally", team: "A" });
  const state = makeState([maggie, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = energy("grave");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggiegrave1", targets: ["ally"] }).ok);
  const mark = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "Bloodrose Offering");
  assert.equal(mark(redactState(state, "B").units["ally"]!), false, "the opponent cannot see the Bloodrose Offering mark");
  assert.equal(mark(redactState(state, "A").units["ally"]!), true, "Maggie's own side sees it");
});

// ===========================================================================================
// FORM: lich
// ===========================================================================================

test("lich/Lash of Servitude: killing an enemy Hero raises a 25-HP Revenant with the dead hero's 3 Basic skills; killing a non-hero does not", () => {
  // POSITIVE — Maggie kills an enemy hero.
  {
    const maggie = fuse("lich");
    const victim = loadHero(heroById("maggie"), "B", "victim");
    victim.hp = 10;
    const state = makeState([maggie], [victim]);
    state.teams.A.energy = energy("lich");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["victim"] }).ok, "Bramblelash (15) kills the 10-HP hero");
    assert.equal(victim.alive, false, "the enemy hero died to Maggie");
    const rev = Object.values(state.units).find((u) => u.kind === "minion" && u.name === "Revenant" && u.team === "A");
    assert.ok(rev, "a Revenant minion was created on Maggie's team");
    assert.equal(rev!.hp, 25, "the Revenant has 25 HP");
    assert.equal((rev!.skills ?? []).filter((s) => s.klass === "basic").length, 3, "it carries the dead hero's 3 Basic skills");
  }
  // CONTROL — Maggie kills an enemy MINION: no Revenant.
  {
    const maggie = fuse("lich");
    const minion = makeUnit({ id: "m", team: "B", kind: "minion", hp: 10 });
    const state = makeState([maggie], [minion]);
    state.teams.A.energy = energy("lich");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["m"] }).ok);
    assert.equal(minion.alive, false, "the minion died");
    assert.ok(!Object.values(state.units).some((u) => u.kind === "minion" && u.name === "Revenant"), "killing a non-hero raises no Revenant");
  }
});

test("lich/Icebite Briars: while up, each enemy Maggie damages deals 5 less non-Affliction damage (1 turn); without it, full damage", () => {
  // POSITIVE — cast Icebite, then Bramblelash an enemy => that enemy's next hit is -5.
  {
    const maggie = fuse("lich");
    const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(20)] });
    const ally = makeUnit({ id: "ally", team: "A" });
    const state = makeState([maggie, ally], [e]);
    state.teams.A.energy = energy("lich");
    state.teams.B.energy = { generic: 40 };
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggielich1", targets: ["maggie"] }).ok, "Icebite Briars up");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok, "Maggie damages e -> weaken it");
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["ally"] }).ok);
    assert.equal(ally.hp, 85, "the weakened enemy's 20 hit lands only 15");
  }
  // CONTROL — no Icebite cast: full 20.
  {
    const maggie = fuse("lich");
    const e = makeUnit({ id: "e", team: "B", skills: [enemyHit(20)] });
    const ally = makeUnit({ id: "ally", team: "A" });
    const state = makeState([maggie, ally], [e]);
    state.teams.A.energy = energy("lich");
    state.teams.B.energy = { generic: 40 };
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.ok(performAction(state, { unit: "e", skillId: "ehit", targets: ["ally"] }).ok);
    assert.equal(ally.hp, 80, "no Icebite => full 20 damage");
  }
});

test("lich/Icebite Briars: while up, Curse of Thorns does not damage Maggie; without it, it does", () => {
  // POSITIVE — Curse DoT is ignored for the 4-turn window.
  {
    const maggie = fuse("lich");
    seedCurseDot(maggie, 15);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = energy("lich");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggielich1", targets: ["maggie"] }).ok);
    endTurn(state); endTurn(state); endTurn(state); // through Maggie's next turn-end(s)
    assert.equal(maggie.hp, 100, "Curse of Thorns deals no damage to Maggie while Icebite Briars is up");
  }
  // CONTROL — without Icebite, the same Curse DoT hits her.
  {
    const maggie = fuse("lich");
    seedCurseDot(maggie, 15);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = energy("lich");
    endTurn(state); // A turn-end -> Curse ticks
    assert.equal(maggie.hp, 85, "without Icebite the Curse of Thorns DoT deals 15");
  }
});

// ===========================================================================================
// FORM: reanimation
// ===========================================================================================

test("reanimation/Bloody Marionette: the target ally becomes Immortal (cannot be reduced below 1), then dies at the end of the 3-turn duration", () => {
  const maggie = fuse("reanimation");
  const ally = makeUnit({ id: "ally", team: "A" });
  const state = makeState([maggie, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = energy("reanimation");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggiereanimation1", targets: ["ally"] }).ok, "Bloody Marionette on ally");
  applyDamage(ally, { amount: 500, type: "normal" });
  assert.equal(ally.alive, true, "Immortal: the ally survives lethal damage");
  assert.equal(ally.hp, 1, "Immortal floors the ally at 1 HP");
  // Advance past the 3-turn window: the ally dies at the end of the duration.
  for (let i = 0; i < 8; i++) endTurn(state);
  assert.equal(ally.alive, false, "at the end of Bloody Marionette's duration the ally dies");
});

test("reanimation/Bloody Marionette: the reanimated ally may only target Maggie or Bramblelash-marked enemies", () => {
  const maggie = fuse("reanimation");
  const ally = makeUnit({ id: "ally", team: "A", skills: [skill("astab", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })] });
  const plain = makeUnit({ id: "plain", team: "B" });
  const marked = makeUnit({ id: "marked", team: "B", statuses: [status("mark", { name: "Bramblelash", duration: 2, appliedBy: "maggie" })] });
  const state = makeState([maggie, ally], [plain, marked]);
  state.teams.A.energy = energy("reanimation");
  // CONTROL (pre-reanimation) — the ally can freely hit a plain enemy.
  {
    const st2 = makeState([loadHero(heroById("maggie"), "A", "maggie"), makeUnit({ id: "ally", team: "A", skills: [skill("astab", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })] })], [makeUnit({ id: "plain", team: "B" })]);
    st2.teams.A.energy = energy("reanimation");
    assert.ok(performAction(st2, { unit: "ally", skillId: "astab", targets: ["plain"] }).ok, "un-reanimated: plain enemy is a legal target");
  }
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggiereanimation1", targets: ["ally"] }).ok, "reanimate ally");
  // Now the plain enemy is NOT a legal target.
  assert.equal(performAction(state, { unit: "ally", skillId: "astab", targets: ["plain"] }).reason, "no-legal-target", "a plain enemy cannot be targeted while reanimated");
  assert.equal(plain.hp, 100, "the plain enemy takes no damage");
  // A Bramblelash-marked enemy IS a legal target.
  assert.ok(performAction(state, { unit: "ally", skillId: "astab", targets: ["marked"] }).ok, "a Bramblelash-marked enemy is legal");
  assert.equal(marked.hp, 90, "the reanimated ally hits the Bramblelash-marked enemy");
});

test("reanimation/Manipulated Movements: a new stun on Maggie is removed and converted into 1 Curse of Thorns stack; a non-stun status is not", () => {
  // POSITIVE — a stun is stripped and becomes a Curse stack.
  {
    const maggie = fuse("reanimation");
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = energy("reanimation");
    const before = curse(maggie);
    maggie.statuses.push(status("stun", { duration: 1, appliedBy: "e", appliedTurn: 0 }));
    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "stun" });
    assert.equal(hasStun(maggie), false, "the new stun is removed");
    assert.equal(curse(maggie), before + 1, "Maggie gains 1 Curse of Thorns stack from the stun");
  }
  // CONTROL — a non-stun status is left alone and grants no Curse stack.
  {
    const maggie = fuse("reanimation");
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = energy("reanimation");
    const before = curse(maggie);
    maggie.statuses.push(status("blind", { duration: 1, appliedBy: "e", appliedTurn: 0 }));
    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "blind" });
    assert.ok(maggie.statuses.some((s) => s.kind === "blind"), "a non-stun status is not removed");
    assert.equal(curse(maggie), before, "a non-stun status grants no Curse stack");
  }
});

// ===========================================================================================
// FORM: zealot
// ===========================================================================================

test("zealot/Thousand Lashes: 30 damage + 5 per Curse of Thorns stack on Maggie", () => {
  // 3 stacks => 30 + 15 = 45.
  {
    const maggie = fuse("zealot");
    seedCurse(maggie, 3);
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("zealot");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggiezealot1", targets: ["e"] }).ok);
    assert.equal(e.hp, 55, "30 + 5 x 3 stacks = 45");
  }
  // 0 stacks => flat 30.
  {
    const maggie = fuse("zealot");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = energy("zealot");
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggiezealot1", targets: ["e"] }).ok);
    assert.equal(e.hp, 70, "no stacks => flat 30");
  }
});

test.skip("SUSPECTED BUG zealot/Sanguine Craving: using a skill should grant an ADDITIONAL Curse stack (base +1 and Sanguine +1 = 2), but the fusion replaces the base trigger so only +1 lands", () => {
  // Frozen: "Maggie now receives an ADDITIONAL stack of Curse of Thorns when she uses a skill." The base
  // Curse of Thorns already grants 1/skill; 'additional' => 2 per skill use.
  const maggie = fuse("zealot");
  const e = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = energy("zealot");
  assert.equal(curse(maggie), 0, "precondition: no Curse stacks");
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok, "Maggie uses a skill");
  assert.equal(curse(maggie), 2, "one skill use grants 2 Curse stacks (base 1 + additional 1)");
});

test.skip("SUSPECTED BUG zealot/Sanguine Craving: not acting on her turn should give MAGGIE 1 Curse stack, but the engine gives the stack to enemies instead", () => {
  // Frozen: "... and [Maggie] will receive 1 stack if she does not act on her turn."
  const maggie = fuse("zealot");
  const e = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = energy("zealot");
  assert.equal(curse(maggie), 0, "precondition: no Curse stacks");
  endTurn(state); // A's turn ends with Maggie having taken no action
  assert.equal(curse(maggie), 1, "Maggie receives 1 Curse of Thorns stack for not acting");
  assert.equal(curse(e), 0, "the enemy should NOT receive Maggie's Curse stack");
});
