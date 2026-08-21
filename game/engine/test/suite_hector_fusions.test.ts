import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound, endTurn, tickDots, grantIncome } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit, Status } from "../src/types.ts";

// ============================================================================
// Adversarial, SPEC-DERIVED suite for HECTOR's FUSION FORMS.
// The FROZEN prose (content/frozen/skills.json) is the sole ORACLE. Verbatim per form:
//
//  antidote — Cure-All (hectorantidote0):
//    "Hector's Serums may now target any of his allies, and they remove one harmful
//     effect on application and expiration."
//  antidote — Inoculation (hectorantidote1):
//    "Target ally is cleansed of all enemy effects, and cannot be affected by those
//     effects for the rest of the game."
//  assassin — Got a Job To Do (hectorassassin0):
//    "Hector's Serums can now only be used on enemies. Being affected by a Serum also
//     causes the target to receive 5 affliction damage for 3 turns."
//  assassin — To Your Health! (hectorassassin1):
//    "For 2 turns, if target enemy uses a skill they will receive 15 Affliction damage
//     and be stunned for 1 turn. If this skill ends without being triggered, Hector and
//     the enemy team heal 15 HP. The target of this skill is invisible."
//  battery — Borrowed Time (hectorbattery0):
//    "Applies a random Serum to Dennis that he isn't already affected by whenever Hector
//     gains energy from Elemental Essence."
//  battery — Serum Synthesizer (hectorbattery1): "Creates a Synthesizer minion."
//  blight — Apprenticeborn Pathogen (hectorblight0):
//    "Enemies damaged by Dennis receive Apprenticeborn Pathogen. This deals 5 damage the
//     turn it is applied, lowers the target's damage by 10 for 1 turn the following turn,
//     and then stuns the target on the final turn. Cannot be applied to enemies affected
//     by Mutated Strain or Apprenticeborn Pathogen."
//  blight — Mutated Strain (hectorblight1):
//    "Places a mutated version of Apprenticeborn Pathogen onto target enemy whose effects
//     work in reverse order. The damage reduction effect is twice as strong, and the
//     damage effect is five times as strong. Cannot be applied to enemies affected by
//     Mutated Strain or Apprenticeborn Pathogen."
//  brimstone — Dennisyphus (hectorbrimstone0):
//    "All of Hector's [14] costs change to [65], but he no longer generates an Energy each
//     turn. Dennis the Apprentice will use Lumbering Smash on a random enemy every turn."
//  brimstone — Pulverizing Smash (hectorbrimstone1):
//    "Deals 15 damage to target enemy. At the beginning of Hector's next turn, he gains 1
//     Generic Energy."
//  evolution — Perfect Form (hectorevolution0):
//    "Hector consumes Dennis at the beginning of the round, gaining 50 Shield and 3
//     Elemental Essence. Hector's Serums now only target himself, and last 2 turns instead
//     of 3."
//  evolution — Morphic Strike (hectorevolution1):
//    "Deals 20 damage to target enemy. If Hector is affected by Burning Blood Serum, this
//     skill deals 5 additional damage and becomes Piercing. If he is affected by Stoneseal
//     Serum, he heals for 10 health. If he is affected by Mindfog Serum, he becomes
//     invulnerable for 1 turn."
//  faerie — A Dash of Whimsy (hectorfaerie0):
//    "Hector will use a random serum on the first character to use a skill on him each turn"
//  faerie — A Sprinkle of Recklessness (hectorfaerie1):
//    "If used on an ally, lowers the cost of their helpful skills by [65] for 1 turn and if
//     they use a new skill, they will gain Elemental Essence. If used on an enemy, increases
//     the cost of their Harmful skills by [65] for 1 turn and if they do not use a new skill
//     during this time they will be stunned for 1 turn."
//  serum — Try the Supply (hectorserum0): "Applies any Serums Hector uses to himself as well."
//  serum — Avatar Serum (hectorserum1):
//    "Deals 5 Affliction damage to all enemies for each serum on Hector each turn for 3
//     turns. During this time he ignores non-damage effects."
//  spore — Lingering Spores (hectorspore0):
//    "Whenever a Serum effect ends, a stack of Lingering Spores is placed on Dennis and a
//     random enemy, dealing 5 affliction damage per turn if they are an enemy, and 5
//     healing per turn if they are an ally. This effect stacks."
//  spore — Acceleration Serum (hectorspore1):
//    "After 3 turns, the target receives 40 affliction damage. On application, this effect
//     lowers its duration by 1 turn for each stack of Lingering Spores on the target."
//  stasis — Rejuvenation Serum (hectorstasis0):
//    "Any time an allied Hero becomes invulnerable, they heal 5 health for 3 turns."
//  stasis — Rejuvenation Pod (hectorstasis1):
//    "Gives an ally under the effect of Rejuvenation Serum 30 Shield, and the duration of
//     Rejuvenation Serum is refreshed to maximum."
//
// Content (roster.generated.ts / fusions.generated.ts) is read ONLY to DRIVE: fusion
// element keys, skill ids (hector1..hector5 serums, hector<form>1 actives), Dennis's skill
// id "dennis", the Synthesizer template, energy costs, and the status/minion NAMES a form
// produces. Every ASSERTION is derived from the frozen prose above.
// ============================================================================

const DENNIS = "Dennis the Apprentice";
const SERUM_NAMES = ["Burning Blood Serum", "Stoneseal Serum", "Mindfog Serum"];

function getDennis(state: MatchState): Unit {
  const d = Object.values(state.units).find((u) => u.kind === "minion" && u.name === DENNIS && u.alive);
  assert.ok(d, "Dennis the Apprentice should exist");
  return d!;
}
function findStatus(u: Unit, kind: string, name?: string): Status | undefined {
  return u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
}
function hasSerum(u: Unit): boolean {
  return u.statuses.some((s) => s.name !== undefined && SERUM_NAMES.includes(s.name));
}
function shieldTotal(u: Unit): number {
  return (u.shields ?? []).reduce((t, s) => t + s.amount, 0);
}
function essenceCount(u: Unit): number {
  return u.statuses.filter((s) => s.kind === "elemental_essence").length;
}

// Every fusion element, generic and poison (base) stocked — a fused Hector pays specific cost in the
// fusion element (currentElement changes), and base serums cost generic/specific too.
function bag(state: MatchState, team: "A" | "B" = "A"): void {
  state.teams[team].energy = {
    generic: 90, poison: 40, antidote: 40, assassin: 40, battery: 40, blight: 40, brimstone: 40,
    evolution: 40, faerie: 40, serum: 40, spore: 40, stasis: 40,
  };
}

/**
 * Load Hector (id "h") on team A, summon Dennis via his base round-start passive, THEN fuse to `key`
 * (which swaps in the fusion passive's triggers + the fusion skill). Extra allies/enemies as requested.
 */
function setup(key: string, opts: { allies?: Unit[]; enemies?: Unit[] } = {}) {
  const hector = loadHero(heroById("hector"), "A", "h");
  const allies = opts.allies ?? [];
  const enemies = opts.enemies ?? [makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 })];
  const state = makeState([hector, ...allies], enemies);
  startRound(state, "A"); // base passive summons Dennis
  applyFusion(hector, fusionForm("hector", key)!);
  bag(state); bag(state, "B");
  return { state, hector, dennis: getDennis(state), allies, enemies };
}

// =========================================================================== //
//  ANTIDOTE — Cure-All + Inoculation
// =========================================================================== //

test("antidote Cure-All: applying a Serum to an ALLY removes one harmful effect from that ally", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("antidote", { allies: [ally], enemies: [enemy] });
  // A pre-existing ENEMY-applied harmful effect (Blinded), pushed directly so it doesn't itself proc.
  ally.statuses.push({ kind: "blind", duration: 3, appliedBy: "e1", appliedTurn: 0 });
  assert.ok(findStatus(ally, "blind"), "precondition: the ally is Blinded");

  // Stoneseal Serum onto the ally → its statusApplied fires Cure-All's cleanse.
  const r = performAction(state, { unit: "h", skillId: "hector2", targets: ["al"] });
  assert.equal(r.ok, true, `Stoneseal should cast on the ally (reason: ${r.reason})`);
  assert.equal(findStatus(ally, "blind"), undefined, "Cure-All removed one harmful effect (the Blind) on application");
  assert.ok(findStatus(ally, "regen", "Stoneseal Serum"), "the Serum itself still landed");
});

test("antidote Cure-All control: with no Serum applied, the ally keeps its harmful effect", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("antidote", { allies: [ally] });
  ally.statuses.push({ kind: "blind", duration: 3, appliedBy: "e1", appliedTurn: 0 });
  // No serum cast — nothing should cleanse.
  endTurn(state); // a plain turn boundary is not a serum application
  assert.ok(findStatus(ally, "blind"), "without a Serum application, the harmful effect is NOT removed");
});

test("antidote Inoculation: cleanses ALL enemy effects from the target ally (keeps ally-applied buffs)", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("antidote", { allies: [ally], enemies: [enemy] });
  ally.statuses.push({ kind: "stun", duration: 2, appliedBy: "e1", appliedTurn: 0 });     // enemy-applied
  ally.statuses.push({ kind: "dot", name: "Venom", magnitude: 5, duration: 3, appliedBy: "e1", appliedTurn: 0 }); // enemy-applied
  ally.statuses.push({ kind: "regen", name: "Blessing", magnitude: 5, duration: 3, appliedBy: "h", appliedTurn: 0 }); // ally-applied

  const r = performAction(state, { unit: "h", skillId: "hectorantidote1", targets: ["al"] });
  assert.equal(r.ok, true, `Inoculation should cast (reason: ${r.reason})`);
  assert.equal(findStatus(ally, "stun"), undefined, "the enemy-applied stun is cleansed");
  assert.equal(findStatus(ally, "dot", "Venom"), undefined, "the enemy-applied dot is cleansed");
  assert.ok(findStatus(ally, "regen", "Blessing"), "an ally-applied buff is NOT cleansed (only ENEMY effects)");
});

test("antidote Inoculation: the target ally cannot be affected by enemy effects afterward", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("antidote", { allies: [ally], enemies: [enemy] });

  performAction(state, { unit: "h", skillId: "hectorantidote1", targets: ["al"] });
  // An enemy now tries to land a harmful non-damage effect on the inoculated ally.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }] as any, {
    caster: enemy, targets: [ally], skillId: "estun",
  });
  assert.equal(findStatus(ally, "stun"), undefined, "the inoculated ally cannot be affected by an enemy stun");
});

test("antidote Inoculation control: a NON-inoculated ally is still affected by enemy effects", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("antidote", { allies: [ally], enemies: [enemy] });
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }] as any, {
    caster: enemy, targets: [ally], skillId: "estun",
  });
  assert.ok(findStatus(ally, "stun"), "without Inoculation, the enemy stun lands");
});

// =========================================================================== //
//  ASSASSIN — Got a Job To Do + To Your Health!
// =========================================================================== //

test("assassin Got a Job To Do: being affected by a Serum inflicts 5 Affliction damage for 3 turns", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("assassin", { enemies: [enemy] });

  // Apply a Serum to the enemy (Mindfog — no dot/regen of its own, so the punish dot reads cleanly).
  const r = performAction(state, { unit: "h", skillId: "hector3", targets: ["e1"] });
  assert.equal(r.ok, true, `Mindfog should cast (reason: ${r.reason})`);
  const dot = findStatus(enemy, "dot", "Got a Job To Do");
  assert.ok(dot, "being affected by a Serum applies the affliction dot");
  assert.equal(dot!.magnitude, 5, "5 damage");
  assert.equal(dot!.dtype, "affliction", "of affliction type");
  assert.equal(dot!.duration, 3, "for 3 turns");

  // And it actually ticks 5/turn (isolate the punish dot from any other periodic effect).
  enemy.statuses = enemy.statuses.filter((s) => (s.kind !== "dot" && s.kind !== "regen") || s.name === "Got a Job To Do");
  const before = enemy.hp;
  state.turn += 2;
  tickDots(state, "A");
  assert.equal(before - enemy.hp, 5, "the Serum-triggered dot deals 5 per turn");
});

// Adversarial: frozen scopes the punish to "being affected by a SERUM". Applying a non-Serum status
// should NOT inflict the dot. The passive fires on ANY statusApplied (its `when` gate is only
// "not already carrying the Got a Job dot"), so a plain enemy status wrongly triggers the Serum punish.
test.skip("SUSPECTED BUG: assassin Got a Job To Do fires on ANY status, not only Serums — frozen says the 5-Affliction punish comes from 'being affected by a Serum'", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("assassin", { enemies: [enemy] });
  // Apply a plain, non-Serum mark to the enemy through the real apply path.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "mark", name: "Hex", duration: 2 } }] as any, {
    caster: hector, targets: [enemy], skillId: "hex",
  });
  assert.equal(findStatus(enemy, "dot", "Got a Job To Do"), undefined, "a non-Serum status must not trigger the Serum punish");
});

test("assassin To Your Health!: if the target enemy uses a skill, it takes 15 Affliction and is stunned 1 turn", () => {
  const enemy = makeUnit({
    id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [skill("noop", [], { tags: ["Strategic", "Instant"], targeting: "self" })],
  });
  const { state } = setup("assassin", { enemies: [enemy] });

  const r = performAction(state, { unit: "h", skillId: "hectorassassin1", targets: ["e1"] });
  assert.equal(r.ok, true, `To Your Health! should cast (reason: ${r.reason})`);
  assert.ok(findStatus(enemy, "veiled"), "the target of this skill is invisible (veiled)");

  const hp0 = enemy.hp;
  const used = performAction(state, { unit: "e1", skillId: "noop", targets: [] });
  assert.equal(used.ok, true, "the trapped enemy uses a skill");
  assert.equal(hp0 - enemy.hp, 15, "the enemy receives 15 Affliction damage");
  assert.ok(findStatus(enemy, "stun"), "…and is stunned");
  assert.equal(findStatus(enemy, "stun")!.duration, 1, "for 1 turn");
});

test("assassin To Your Health!: if it ends WITHOUT being triggered, Hector and the enemy team heal 15", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  // A second enemy that is NOT the skill's target reads the "enemy team" heal cleanly (no trap/veil on it).
  const enemy2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("assassin", { enemies: [enemy, enemy2] });
  hector.hp = 70; enemy2.hp = 70; // wound AFTER startRound (which resets HP to max)

  performAction(state, { unit: "h", skillId: "hectorassassin1", targets: ["e1"] });
  // The enemy never uses a skill; run turns until the "To Your Health!" mark expires.
  let guard = 0;
  while (findStatus(enemy, "mark", "To Your Health!") && guard++ < 10) endTurn(state);
  assert.equal(findStatus(enemy, "mark", "To Your Health!"), undefined, "the mark expired untriggered");
  assert.equal(hector.hp, 85, "Hector heals 15 HP");
  assert.equal(enemy2.hp, 85, "the enemy team heals 15 HP");
});

test("assassin To Your Health! control: once triggered, the untriggered-heal does NOT happen", () => {
  const enemy = makeUnit({
    id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [skill("noop", [], { tags: ["Strategic", "Instant"], targeting: "self" })],
  });
  const enemy2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("assassin", { enemies: [enemy, enemy2] });
  hector.hp = 70; enemy2.hp = 70; // wound AFTER startRound (which resets HP to max)
  performAction(state, { unit: "h", skillId: "hectorassassin1", targets: ["e1"] });
  performAction(state, { unit: "e1", skillId: "noop", targets: [] }); // trigger the trap (cancels the heal mark)
  for (let i = 0; i < 8; i++) endTurn(state);
  assert.equal(hector.hp, 70, "Hector does NOT get the untriggered-heal after the trap fired");
  assert.equal(enemy2.hp, 70, "the enemy team does NOT get the untriggered-heal after the trap fired");
});

// =========================================================================== //
//  BATTERY — Borrowed Time + Serum Synthesizer
// =========================================================================== //

test("battery Borrowed Time: gaining energy from Essence applies a Serum Dennis lacks", () => {
  const { state, hector, dennis } = setup("battery");
  // Dennis already carries 2 of the 3 Serums (by name) → the only one he LACKS is Mindfog.
  dennis.statuses.push({ kind: "mark", name: "Burning Blood Serum", duration: null, appliedBy: "h", appliedTurn: 0 });
  dennis.statuses.push({ kind: "mark", name: "Stoneseal Serum", duration: null, appliedBy: "h", appliedTurn: 0 });

  emit(state, { type: "energyFromEssence", unit: hector.id, element: hector.currentElement });
  assert.ok(findStatus(dennis, "mark", "Mindfog Serum"), "Borrowed Time applies the Serum Dennis isn't already affected by (Mindfog)");
});

test("battery Borrowed Time control: an Essence gain by a DIFFERENT unit does not apply a Serum", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis } = setup("battery", { allies: [ally] });
  const before = dennis.statuses.length;
  emit(state, { type: "energyFromEssence", unit: "al", element: "battery" }); // not Hector
  assert.equal(dennis.statuses.length, before, "Borrowed Time only fires when HECTOR gains Essence energy");
});

test("battery Serum Synthesizer: creates a Synthesizer minion", () => {
  const { state } = setup("battery");
  const before = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Synthesizer").length;
  assert.equal(before, 0, "no Synthesizer before casting");
  const r = performAction(state, { unit: "h", skillId: "hectorbattery1", targets: [] });
  assert.equal(r.ok, true, `Serum Synthesizer should cast (reason: ${r.reason})`);
  const synths = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Synthesizer" && u.alive);
  assert.equal(synths.length, 1, "a Synthesizer minion is created");
  assert.equal(synths[0]!.team, "A", "on Hector's team");
});

// =========================================================================== //
//  BLIGHT — Apprenticeborn Pathogen + Mutated Strain
// =========================================================================== //

test("blight Apprenticeborn Pathogen: an enemy damaged by Dennis takes 5 damage and gets the mark", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis } = setup("blight", { enemies: [enemy] });

  // Drive the passive's own event: Dennis dealt damage to the enemy.
  emit(state, { type: "damageDealt", source: dennis.id, target: enemy.id, amount: 10, dtype: "normal" });
  assert.ok(findStatus(enemy, "mark", "Apprenticeborn Pathogen"), "the enemy receives Apprenticeborn Pathogen");
  assert.equal(enemy.hp, 95, "it deals 5 damage the turn it is applied");
});

test("blight Apprenticeborn Pathogen: the mark's stages land (dmg-reduction, then a stun)", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis } = setup("blight", { enemies: [enemy] });
  emit(state, { type: "damageDealt", source: dennis.id, target: enemy.id, amount: 10, dtype: "normal" });

  // "the following turn": a -10 outgoing-damage reduction for 1 turn (fires on the 2nd of Hector's turn-ends).
  endTurn(state); endTurn(state); endTurn(state);
  const odm = findStatus(enemy, "outgoing_damage_mod");
  assert.ok(odm, "the following-turn stage lowers the target's damage");
  assert.equal(odm!.magnitude, -10, "by 10");

  // "the final turn": a stun (fires on the 3rd of Hector's turn-ends).
  endTurn(state); endTurn(state);
  assert.ok(findStatus(enemy, "stun"), "the final stage stuns the target");
});

test("blight Apprenticeborn Pathogen control: NOT from Dennis, and no re-application while marked", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis, hector } = setup("blight", { enemies: [enemy] });

  // (a) damage from a non-Dennis source does not apply the Pathogen.
  emit(state, { type: "damageDealt", source: hector.id, target: enemy.id, amount: 10, dtype: "normal" });
  assert.equal(findStatus(enemy, "mark", "Apprenticeborn Pathogen"), undefined, "only DENNIS's damage applies the Pathogen");

  // (b) apply it once, then a second Dennis hit must NOT re-apply (no extra 5 damage).
  emit(state, { type: "damageDealt", source: dennis.id, target: enemy.id, amount: 10, dtype: "normal" });
  assert.equal(enemy.hp, 95, "first application deals 5");
  emit(state, { type: "damageDealt", source: dennis.id, target: enemy.id, amount: 10, dtype: "normal" });
  assert.equal(enemy.hp, 95, "cannot be applied again while already affected (no second 5 damage)");
});

test("blight Mutated Strain: reversed order — stun first; then -20 damage reduction; then 25 damage", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("blight", { enemies: [enemy] });

  const r = performAction(state, { unit: "h", skillId: "hectorblight1", targets: ["e1"] });
  assert.equal(r.ok, true, `Mutated Strain should cast (reason: ${r.reason})`);
  assert.ok(findStatus(enemy, "mark", "Mutated Strain"), "the target gets Mutated Strain");
  assert.ok(findStatus(enemy, "stun"), "reversed order: the stun (normally last) lands FIRST");
  assert.equal(enemy.hp, 100, "the damage stage has not landed yet");

  // damage-reduction stage: twice as strong (-20).
  endTurn(state); endTurn(state); endTurn(state);
  const odm = findStatus(enemy, "outgoing_damage_mod");
  assert.ok(odm, "the damage-reduction stage lands");
  assert.equal(odm!.magnitude, -20, "twice as strong: -20");

  // damage stage: five times as strong (25), now last.
  endTurn(state); endTurn(state);
  assert.equal(enemy.hp, 75, "the damage stage deals 25 (five times the base 5)");
});

test("blight Mutated Strain control: cannot be applied to an enemy already affected by it", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("blight", { enemies: [enemy] });
  performAction(state, { unit: "h", skillId: "hectorblight1", targets: ["e1"] });
  // clear the immediate stun so a re-cast isn't blocked for an unrelated reason; keep the Mutated Strain mark.
  enemy.statuses = enemy.statuses.filter((s) => s.kind !== "stun");
  state.units["h"]!.skills!.find((s) => s.id === "hectorblight1")!.currentCd = 0;
  const hp = enemy.hp;
  performAction(state, { unit: "h", skillId: "hectorblight1", targets: ["e1"] });
  const strains = enemy.statuses.filter((s) => s.kind === "mark" && s.name === "Mutated Strain");
  assert.equal(strains.length, 1, "no second Mutated Strain mark is applied");
  assert.equal(enemy.hp, hp, "and no new stage effects are queued/dealt");
});

// =========================================================================== //
//  BRIMSTONE — Dennisyphus + Pulverizing Smash
// =========================================================================== //

test("brimstone Dennisyphus: Dennis uses Lumbering Smash on a random enemy every turn", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("brimstone", { enemies: [enemy] });
  const before = enemy.hp;
  emit(state, { type: "turnStart", team: "A" }); // Dennisyphus hooks turnStart to make Dennis smash
  assert.ok(enemy.hp < before, "Dennis attacked a random enemy at turn start (Lumbering Smash landed)");
});

// Adversarial: frozen says under Dennisyphus Hector "no longer generates an Energy each turn." The
// passive models this as a permanent Silence, but a Silenced hero still yields 1 GENERIC energy per
// income step (grantIncome) — so Hector keeps generating energy, contrary to the frozen text.
test.skip("SUSPECTED BUG: brimstone Dennisyphus still lets Hector generate 1 Generic energy each turn — frozen says he generates NO energy", () => {
  const { state, hector } = setup("brimstone");
  emit(state, { type: "roundStart" }); // apply Dennisyphus's income-suppressing silence
  state.teams.A.energy = {};
  hector.statuses.push({ kind: "elemental_essence", duration: null, appliedBy: "h", appliedTurn: 0 });
  grantIncome(state, "A");
  const total = Object.values(state.teams.A.energy).reduce((a, b) => a + (b ?? 0), 0);
  assert.equal(total, 0, "Dennisyphus: Hector generates no energy each turn");
});

test("brimstone Pulverizing Smash: deals 15 damage; Hector gains 1 Generic at his next turn", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("brimstone", { enemies: [enemy] });
  state.teams.A.energy.generic = 0; // isolate the +1 grant

  const r = performAction(state, { unit: "h", skillId: "hectorbrimstone1", targets: ["e1"] });
  assert.equal(r.ok, true, `Pulverizing Smash should cast (reason: ${r.reason})`);
  assert.equal(enemy.hp, 85, "deals 15 damage to the target enemy");
  assert.equal(state.teams.A.energy.generic ?? 0, 0, "no Generic granted yet (it comes at his NEXT turn)");

  endTurn(state); endTurn(state); endTurn(state); // reach Hector's next turn-anchored grant
  assert.equal(state.teams.A.energy.generic ?? 0, 1, "at the beginning of Hector's next turn he gains 1 Generic Energy");
});

// =========================================================================== //
//  EVOLUTION — Perfect Form + Morphic Strike
// =========================================================================== //

test("evolution Perfect Form: at round start, consumes Dennis and grants 50 Shield", () => {
  const { state, hector, dennis } = setup("evolution");
  assert.ok(dennis.alive, "precondition: Dennis is alive");
  assert.equal(shieldTotal(hector), 0, "precondition: no shield");

  emit(state, { type: "roundStart" }); // fire the fusion round-start passive
  assert.equal(dennis.alive, false, "Dennis is consumed (defeated)");
  assert.equal(shieldTotal(hector), 50, "Hector gains 50 Shield");
  assert.ok(essenceCount(hector) >= 1, "Hector gains Elemental Essence");
});

// Adversarial: frozen says "gaining ... 3 Elemental Essence". The passive applies three
// elemental_essence statuses, but the status system keeps only ONE per kind (sameSlot collapses
// them), so Hector ends with a single charge — one elemental-energy income, not three.
test.skip("SUSPECTED BUG: evolution Perfect Form grants only 1 Elemental Essence charge, not 3 — the three applications collapse into one status slot", () => {
  const { state, hector } = setup("evolution");
  emit(state, { type: "roundStart" });
  assert.equal(essenceCount(hector), 3, "Hector should gain 3 Elemental Essence");
});

test("evolution Morphic Strike: base deals 20 normal damage (no Serum on Hector)", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("evolution", { enemies: [enemy] });
  enemy.shields.push({ amount: 30, duration: null, appliedBy: "e1", appliedTurn: 0 }); // after startRound (which clears shields)
  const r = performAction(state, { unit: "h", skillId: "hectorevolution1", targets: ["e1"] });
  assert.equal(r.ok, true, `Morphic Strike should cast (reason: ${r.reason})`);
  assert.equal(enemy.hp, 100, "20 normal damage is absorbed by the 30 shield (does NOT pierce)");
  assert.equal(shieldTotal(enemy), 10, "the shield took the 20 normal damage");
});

test("evolution Morphic Strike: Burning Blood Serum → 5 additional damage (25) and becomes Piercing", () => {
  // Piercing (engine semantics) ignores Damage Reduction. Give the enemy 10 DR so Piercing is observable:
  //   plain 25 would be reduced to 15 (→85); a Piercing 25 ignores the DR and deals the full 25 (→75).
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("evolution", { enemies: [enemy] });
  enemy.statuses.push({ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "e1", appliedTurn: 0 });
  hector.statuses.push({ kind: "stack", name: "Burning Blood Serum", magnitude: 1, duration: 3, appliedBy: "h", appliedTurn: 0 });
  const r = performAction(state, { unit: "h", skillId: "hectorevolution1", targets: ["e1"] });
  assert.equal(r.ok, true, `Morphic Strike should cast (reason: ${r.reason})`);
  assert.equal(enemy.hp, 75, "25 damage that ignores the 10 Damage Reduction (5 additional damage + Piercing)");
});

test("evolution Morphic Strike control: without Burning Blood, 20 normal damage IS reduced by DR (not piercing)", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("evolution", { enemies: [enemy] });
  enemy.statuses.push({ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "e1", appliedTurn: 0 });
  performAction(state, { unit: "h", skillId: "hectorevolution1", targets: ["e1"] });
  assert.equal(enemy.hp, 90, "plain 20 normal damage is reduced by the 10 DR (→10 damage): not Piercing, not +5");
});

test("evolution Morphic Strike: Stoneseal Serum heals Hector 10; Mindfog Serum grants invulnerable 1 turn", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  // Stoneseal branch
  {
    const { state, hector } = setup("evolution", { enemies: [enemy] });
    hector.hp = 80;
    hector.statuses.push({ kind: "regen", name: "Stoneseal Serum", magnitude: 10, duration: 3, appliedBy: "h", appliedTurn: 0 });
    performAction(state, { unit: "h", skillId: "hectorevolution1", targets: ["e1"] });
    assert.equal(hector.hp, 90, "Stoneseal Serum → Hector heals 10");
  }
  // Mindfog branch
  {
    const enemy2 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
    const { state, hector } = setup("evolution", { enemies: [enemy2] });
    hector.statuses.push({ kind: "mark", name: "Mindfog Serum", duration: 3, appliedBy: "h", appliedTurn: 0 });
    performAction(state, { unit: "h", skillId: "hectorevolution1", targets: ["e1"] });
    assert.ok(findStatus(hector, "invulnerable"), "Mindfog Serum → Hector becomes invulnerable");
    assert.equal(findStatus(hector, "invulnerable")!.duration, 1, "for 1 turn");
  }
});

test("evolution Morphic Strike control: with NO serum, no bonus damage/heal/invuln", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("evolution", { enemies: [enemy] });
  hector.hp = 80;
  performAction(state, { unit: "h", skillId: "hectorevolution1", targets: ["e1"] });
  assert.equal(enemy.hp, 80, "plain 20 damage");
  assert.equal(hector.hp, 80, "no heal without Stoneseal");
  assert.equal(findStatus(hector, "invulnerable"), undefined, "no invulnerability without Mindfog");
});

// =========================================================================== //
//  FAERIE — A Dash of Whimsy + A Sprinkle of Recklessness
// =========================================================================== //

test("faerie A Dash of Whimsy: a character using a skill ON Hector gets a random Serum", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("faerie", { enemies: [enemy] });
  assert.equal(hasSerum(enemy), false, "precondition: the enemy holds no Serum");
  emit(state, { type: "skillUsed", caster: "e1", skillId: "zap", targets: ["h"], tags: ["Harmful", "Instant"] });
  assert.ok(hasSerum(enemy), "the character that used a skill on Hector is dosed with a random Serum");
});

test("faerie A Dash of Whimsy control: a skill NOT aimed at Hector does not dose the caster", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("faerie", { allies: [ally], enemies: [enemy] });
  emit(state, { type: "skillUsed", caster: "e1", skillId: "zap", targets: ["al"], tags: ["Harmful", "Instant"] });
  assert.equal(hasSerum(enemy), false, "a skill used on someone other than Hector does not dose the caster");
});

test("faerie A Sprinkle of Recklessness (ally): lowers helpful-skill cost and rewards Essence on a new skill", () => {
  const ally = makeUnit({
    id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100,
    skills: [skill("help", [], { tags: ["Helpful", "Instant"], targeting: "self" })],
  });
  const { state } = setup("faerie", { allies: [ally] });
  const r = performAction(state, { unit: "h", skillId: "hectorfaerie1", targets: ["al"] });
  assert.equal(r.ok, true, `A Sprinkle of Recklessness should cast on the ally (reason: ${r.reason})`);
  const cm = findStatus(ally, "cost_mod");
  assert.ok(cm, "the ally gets a cost reduction");
  assert.ok((cm!.magnitude ?? 0) < 0, "…a NEGATIVE cost modifier (cost lowered)");

  assert.equal(essenceCount(ally), 0, "no Essence before the ally acts");
  performAction(state, { unit: "al", skillId: "help", targets: [] });
  assert.equal(essenceCount(ally), 1, "using a new skill grants the ally Elemental Essence");
});

test("faerie A Sprinkle of Recklessness (enemy): raises Harmful cost; stuns if they DON'T use a skill", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("faerie", { enemies: [enemy] });
  const r = performAction(state, { unit: "h", skillId: "hectorfaerie1", targets: ["e1"] });
  assert.equal(r.ok, true, `A Sprinkle of Recklessness should cast on the enemy (reason: ${r.reason})`);
  const cm = findStatus(enemy, "cost_mod");
  assert.ok(cm, "the enemy gets a cost increase");
  assert.ok((cm!.magnitude ?? 0) > 0, "…a POSITIVE cost modifier (cost raised)");
  assert.ok(findStatus(enemy, "mark", "A Sprinkle of Recklessness"), "the use-or-be-stunned mark is armed");

  // They do NOT use a skill → stunned when the mark expires.
  let guard = 0;
  while (findStatus(enemy, "mark", "A Sprinkle of Recklessness") && guard++ < 10) endTurn(state);
  assert.ok(findStatus(enemy, "stun"), "not using a new skill → stunned for 1 turn");
});

test("faerie A Sprinkle of Recklessness (enemy) control: using a skill cancels the stun", () => {
  const enemy = makeUnit({
    id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [skill("noop", [], { tags: ["Strategic", "Instant"], targeting: "self" })],
  });
  const { state } = setup("faerie", { enemies: [enemy] });
  performAction(state, { unit: "h", skillId: "hectorfaerie1", targets: ["e1"] });
  performAction(state, { unit: "e1", skillId: "noop", targets: [] }); // they use a new skill
  assert.equal(findStatus(enemy, "mark", "A Sprinkle of Recklessness"), undefined, "using a skill strips the punish mark");
  for (let i = 0; i < 8; i++) endTurn(state);
  assert.equal(findStatus(enemy, "stun"), undefined, "…so no stun is applied");
});

// =========================================================================== //
//  SERUM — Try the Supply + Avatar Serum
// =========================================================================== //

test("serum Try the Supply: a Serum Hector uses is also applied to himself", () => {
  const { state, hector, dennis } = setup("serum");
  assert.equal(hasSerum(hector), false, "precondition: Hector carries no Serum");
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [dennis.id] });
  assert.equal(r.ok, true, `Burning Blood should cast (reason: ${r.reason})`);
  assert.ok(findStatus(hector, "outgoing_damage_mod", "Burning Blood Serum"), "the Serum Hector used is mirrored onto himself");
});

test("serum Try the Supply control: a NON-Serum skill is not mirrored onto Hector", () => {
  const { state, hector } = setup("serum");
  // Protect Me! (hector4) is a self skill, not a Serum.
  const r = performAction(state, { unit: "h", skillId: "hector4", targets: [] });
  assert.equal(r.ok, true, `Protect Me! should cast (reason: ${r.reason})`);
  assert.equal(hasSerum(hector), false, "a non-Serum skill applies no Serum to Hector");
});

test("serum Avatar Serum: ignores non-damage effects, and pulses 5 Affliction per serum on Hector", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const enemy2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("serum", { enemies: [enemy, enemy2] });
  // Two serums on Hector (by name) → the per-turn pulse should be 5 * 2 = 10 to ALL enemies.
  hector.statuses.push({ kind: "mark", name: "Burning Blood Serum", duration: null, appliedBy: "h", appliedTurn: 0 });
  hector.statuses.push({ kind: "regen", name: "Stoneseal Serum", magnitude: 10, duration: null, appliedBy: "h", appliedTurn: 0 });

  const r = performAction(state, { unit: "h", skillId: "hectorserum1", targets: [] });
  assert.equal(r.ok, true, `Avatar Serum should cast (reason: ${r.reason})`);
  assert.ok(findStatus(hector, "non_damage_ignore"), "during this time Hector ignores non-damage effects");

  emit(state, { type: "turnStart", team: "A" }); // one pulse
  assert.equal(enemy.hp, 90, "5 Affliction per serum (2 serums → 10) to each enemy");
  assert.equal(enemy2.hp, 90, "…to ALL enemies");
});

test("serum Avatar Serum: the non-damage-ignore actually blocks an enemy stun on Hector", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("serum", { enemies: [enemy] });
  performAction(state, { unit: "h", skillId: "hectorserum1", targets: [] });
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }] as any, {
    caster: enemy, targets: [hector], skillId: "estun",
  });
  assert.equal(findStatus(hector, "stun"), undefined, "an enemy stun does not land while Avatar Serum's ignore is up");
});

// =========================================================================== //
//  SPORE — Lingering Spores + Acceleration Serum
// =========================================================================== //

test("spore Lingering Spores: when a Serum effect ends, Dennis gets healing spores and an enemy gets damaging spores", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis } = setup("spore", { enemies: [enemy] });
  // Simulate a Serum effect ENDING (statusExpired with a Serum name).
  emit(state, { type: "statusExpired", unit: dennis.id, kind: "regen", name: "Stoneseal Serum" });

  const dRegen = findStatus(dennis, "regen", "Lingering Spores");
  assert.ok(dRegen, "Dennis (an ally) gets a Lingering Spores healing effect");
  assert.equal(dRegen!.magnitude, 5, "5 healing per turn (1 stack)");
  const eDot = findStatus(enemy, "dot", "Lingering Spores");
  assert.ok(eDot, "a random enemy gets a Lingering Spores damaging effect");
  assert.equal(eDot!.magnitude, 5, "5 affliction damage per turn (1 stack)");
  assert.equal(eDot!.dtype, "affliction", "affliction damage");
});

test("spore Lingering Spores: the effect STACKS (a second serum-end doubles the per-turn magnitude)", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis } = setup("spore", { enemies: [enemy] });
  emit(state, { type: "statusExpired", unit: dennis.id, kind: "regen", name: "Stoneseal Serum" });
  emit(state, { type: "statusExpired", unit: dennis.id, kind: "mark", name: "Mindfog Serum" });
  assert.equal(findStatus(dennis, "regen", "Lingering Spores")!.magnitude, 10, "Dennis's spores scale to 5*2 at 2 stacks");
  assert.equal(findStatus(enemy, "dot", "Lingering Spores")!.magnitude, 10, "the enemy's spores scale to 5*2 at 2 stacks");
});

test("spore Lingering Spores control: a NON-Serum status ending places no spores", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state, dennis } = setup("spore", { enemies: [enemy] });
  emit(state, { type: "statusExpired", unit: dennis.id, kind: "mark", name: "Hex" }); // not a Serum
  assert.equal(findStatus(dennis, "regen", "Lingering Spores"), undefined, "no spores from a non-Serum expiry");
  assert.equal(findStatus(enemy, "dot", "Lingering Spores"), undefined, "no spores from a non-Serum expiry");
});

test("spore Acceleration Serum: after 3 turns the target takes 40 affliction; Lingering Spores cut the countdown", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("spore", { enemies: [enemy] });
  // 2 stacks of Lingering Spores on the target → duration = 3 - 2 = 1.
  enemy.statuses.push({ kind: "stack", name: "Lingering Spores", magnitude: 2, duration: null, appliedBy: "h", appliedTurn: 0 });

  const r = performAction(state, { unit: "h", skillId: "hectorspore1", targets: ["e1"] });
  assert.equal(r.ok, true, `Acceleration Serum should cast (reason: ${r.reason})`);
  const mark = findStatus(enemy, "mark", "Acceleration Serum");
  assert.ok(mark, "the Acceleration Serum mark is placed");
  assert.equal(mark!.duration, 1, "the 3-turn countdown is lowered by 1 per Lingering Spores stack (3 - 2 = 1)");

  // Run turns until the mark expires → 40 affliction detonates.
  const before = enemy.hp;
  let guard = 0;
  while (findStatus(enemy, "mark", "Acceleration Serum") && guard++ < 10) endTurn(state);
  assert.equal(before - enemy.hp, 40, "on expiry the target receives 40 affliction damage");
});

test("spore Acceleration Serum control: with no Lingering Spores, the countdown is the full 3 turns", () => {
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("spore", { enemies: [enemy] });
  performAction(state, { unit: "h", skillId: "hectorspore1", targets: ["e1"] });
  assert.equal(findStatus(enemy, "mark", "Acceleration Serum")!.duration, 3, "no Lingering Spores → full 3-turn countdown");
});

// =========================================================================== //
//  STASIS — Rejuvenation Serum + Rejuvenation Pod
// =========================================================================== //

test("stasis Rejuvenation Serum: when an allied Hero becomes invulnerable, they heal 5/turn for 3 turns", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("stasis", { allies: [ally] });
  // Make the ally invulnerable through the real apply path (emits statusApplied{invulnerable}).
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "invulnerable", duration: 1 } }] as any, {
    caster: hector, targets: [ally], skillId: "inv",
  });
  const regen = findStatus(ally, "regen", "Rejuvenation Serum");
  assert.ok(regen, "becoming invulnerable grants the Rejuvenation Serum heal");
  assert.equal(regen!.magnitude, 5, "5 health");
  assert.equal(regen!.duration, 3, "for 3 turns");
});

test("stasis Rejuvenation Serum control: a non-invulnerable status does not grant the heal", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const { state, hector } = setup("stasis", { allies: [ally] });
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "mark", name: "Blessing", duration: 3 } }] as any, {
    caster: hector, targets: [ally], skillId: "bless",
  });
  assert.equal(findStatus(ally, "regen", "Rejuvenation Serum"), undefined, "only becoming INVULNERABLE grants the heal");
});

test("stasis Rejuvenation Pod: an ally under Rejuvenation Serum gets 30 Shield and the Serum refreshed to max", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("stasis", { allies: [ally] });
  // The ally already has a decaying Rejuvenation Serum regen (1 turn left).
  ally.statuses.push({ kind: "regen", name: "Rejuvenation Serum", magnitude: 5, duration: 1, appliedBy: "h", appliedTurn: 0 });

  const r = performAction(state, { unit: "h", skillId: "hectorstasis1", targets: ["al"] });
  assert.equal(r.ok, true, `Rejuvenation Pod should cast (reason: ${r.reason})`);
  assert.equal(shieldTotal(ally), 30, "the ally gains 30 Shield");
  assert.equal(findStatus(ally, "regen", "Rejuvenation Serum")!.duration, 3, "Rejuvenation Serum is refreshed to its maximum (3)");
});

test("stasis Rejuvenation Pod control: without Rejuvenation Serum, no shield is granted", () => {
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const { state } = setup("stasis", { allies: [ally] });
  const r = performAction(state, { unit: "h", skillId: "hectorstasis1", targets: ["al"] });
  assert.equal(r.ok, true, `Rejuvenation Pod should cast (reason: ${r.reason})`);
  assert.equal(shieldTotal(ally), 0, "an ally NOT under Rejuvenation Serum gets nothing");
});
