import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startTurn, startRound } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { stackCount } from "../src/status.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, SPEC-DERIVED AUGMENT suite for GALAZAX, the Coming Storm.
// The FROZEN augment prose (content/frozen/augments.json) is the sole oracle:
//
//  galazax1 "Twin Storms":
//    "Galazax can now Channel up to 2 separate copies of The Skies Darken."
//  galazax2 "Chain Lightning":
//    "Lightning Strikes now deals 10 damage to the primary target and 5 to all
//     other enemies, and becomes Piercing."
//  galazax3 "The Voice Above":
//    "The Heavens Speak now costs [65] less and no longer cancels Channeled
//     skills."   ([65] = Generic energy.)
//  galazax4 "Deafening Silence":
//    "Thunder Deafens has its cooldown reduced by 1, but it no longer causes
//     Galazax to ignore damage."
//  galazax5 "Looming Grudge":
//    "A random enemy Hero starts each round with 3 stacks of The Storm Builds."
//
// Relevant base prose (content/frozen/skills.json), so each augment is tested
// as a DELTA against the unaugmented behaviour:
//  galazax1 The Sky Darkens (Channel, cd 1): "Galazax deals 5 Piercing damage
//     to all enemies each turn. Cannot be used while active."
//  galazax2 Lightning Strikes: "Galazax deals 10 damage to target enemy and 5
//     damage to a random enemy." (NORMAL damage.)
//  galazax4 The Heavens Speak (cost generic 1 + storm 1): consumes Storm Builds
//     for damage; base DOES interrupt Channeling.
//  galazax5 Thunder Deafens (cd 3, self): "Galazax becomes untargetable and
//     ignores all damage for 1 turn. Using this skill does not interrupt
//     Channeling."
// ============================================================================

const STORM = "The Storm Builds";

function giveEnergy(state: MatchState, team: "A" | "B" = "A"): void {
  state.teams[team].energy = { generic: 40, storm: 40 };
}
function stormStacks(u: Unit): number {
  return stackCount(u, STORM);
}
function isChanneling(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "channeling");
}
function channelCount(u: Unit): number {
  return u.statuses.filter((s) => s.kind === "channeling").length;
}
// Put the unit into a "Channeling The Sky Darkens" state without driving the whole channel (setup only).
function seedChannel(u: Unit): void {
  u.statuses.push({ kind: "channeling", name: "galazax1", channelTargets: [], duration: null, appliedBy: u.id, appliedTurn: 0 });
}
// Fetch a hero's live skill instance (to read cooldown / reset it to isolate a non-cooldown gate).
function sk(u: Unit, id: string) {
  return (u.skills ?? []).find((s) => s.id === id)!;
}
function resetCd(u: Unit, id: string): void {
  sk(u, id).currentCd = 0;
}
function makeG(augId?: string, id: string = "g"): Unit {
  const g = loadHero(heroById("galazax"), "A", id);
  if (augId) applyAugment(g, augmentById(augId)!);
  return g;
}

// --------------------------------------------------------------------------- //
//  galazax1 — Twin Storms: "Channel up to 2 separate copies of The Skies Darken"
// --------------------------------------------------------------------------- //

test("galazax1 c1: with Twin Storms a SECOND copy of The Sky Darkens can be Channeled (base blocks it)", () => {
  // Augmented: two concurrent copies are permitted.
  const g = makeG("galazax1");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  const r1 = performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(r1.ok, true, "first copy casts");
  assert.equal(channelCount(g), 1, "one channel live");
  resetCd(g, "galazax1"); // isolate the not-already-channeling gate from the 1-turn cooldown

  const r2 = performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(r2.ok, true, "Twin Storms allows a SECOND concurrent copy");
  assert.equal(channelCount(g), 2, "two separate copies are now channeling");
});

test("galazax1 c1 control: WITHOUT Twin Storms, a second copy is blocked ('Cannot be used while active')", () => {
  const g = makeG(); // base — no augment
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  assert.equal(performAction(state, { unit: "g", skillId: "galazax1", targets: [] }).ok, true, "first cast ok");
  resetCd(g, "galazax1"); // fresh cooldown so only the requires-gate can block
  const r2 = performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(r2.ok, false, "base cannot recast while already channeling");
  assert.equal(r2.reason, "requirements-not-met", "blocked by the single-copy gate");
  assert.equal(channelCount(g), 1, "still only one channel");
});

test("galazax1 c2: 'up to 2' — a THIRD copy is blocked", () => {
  const g = makeG("galazax1");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  resetCd(g, "galazax1");
  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(channelCount(g), 2, "two copies established");
  resetCd(g, "galazax1");

  const r3 = performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(r3.ok, false, "a third copy exceeds the cap of 2");
  assert.equal(r3.reason, "requirements-not-met", "capped at 2 concurrent copies");
  assert.equal(channelCount(g), 2, "still exactly two copies");
});

test("galazax1 c3: two SEPARATE copies each deal their 5 — 10 damage per turn while both channel", () => {
  const g = makeG("galazax1");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(e.hp, 95, "copy 1's immediate tick = 5");
  resetCd(g, "galazax1");
  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(e.hp, 90, "copy 2's immediate tick = another 5 (two separate copies both fire)");

  // On Galazax's next turn BOTH copies re-run ("each turn"): 5 + 5 = 10.
  endTurn(state); // A -> B
  endTurn(state); // B -> A
  startTurn(state); // Galazax's turn: both channels re-tick
  assert.equal(e.hp, 80, "both copies ticked -> 10 damage this turn");
});

test("galazax1 c3 control: a SINGLE copy ticks only 5 per turn (the doubling needs the 2nd copy)", () => {
  const g = makeG("galazax1");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] }); // ONE copy only
  assert.equal(e.hp, 95, "immediate 5");
  assert.equal(channelCount(g), 1, "just one copy");

  endTurn(state); // A -> B
  endTurn(state); // B -> A
  startTurn(state);
  assert.equal(e.hp, 90, "one copy -> only 5 this turn (contrast: 10 with two copies)");
});

// --------------------------------------------------------------------------- //
//  galazax2 — Chain Lightning: "10 to the primary target and 5 to all other
//  enemies, and becomes Piercing"
// --------------------------------------------------------------------------- //

test("galazax2 c1+c2: 10 to the primary target and 5 to EVERY other enemy", () => {
  const g = makeG("galazax2");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2, e3]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e1"] });
  assert.equal(e1.hp, 90, "primary target takes 10");
  assert.equal(e2.hp, 95, "every OTHER enemy takes 5");
  assert.equal(e3.hp, 95, "every OTHER enemy takes 5");
  assert.equal(g.hp, 100, "Galazax (an ally) is not an 'enemy' and takes nothing");
});

test("galazax2 c2 adversarial: with a LONE enemy the total is exactly 10 (not the base 15)", () => {
  // Base Lightning Strikes fires 5 at a 'random enemy' which, alone, is the target -> 15 total.
  // Chain Lightning's 5 goes to "all OTHER enemies" — with none, the lone primary takes only its 10.
  const g = makeG("galazax2");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] });
  assert.equal(e.hp, 90, "10 to primary; no 'other enemy' exists to take the 5");
});

test("galazax2 c2 control: WITHOUT the augment a lone enemy takes the base 15", () => {
  const g = makeG(); // base
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] });
  assert.equal(e.hp, 85, "base = 10 (target) + 5 (random = the lone enemy) = 15");
});

test("galazax2 c3: becomes Piercing — ignores Damage Reduction on primary AND others", () => {
  const g = makeG("galazax2");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 4, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 4, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e1, e2]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e1"] });
  assert.equal(e1.hp, 90, "Piercing bypasses the 4 DR on the primary -> full 10 (normal would leave 94)");
  assert.equal(e2.hp, 95, "Piercing bypasses the 4 DR on the other enemy -> full 5 (normal would leave 96)");
});

test("galazax2 c3 control: WITHOUT the augment Lightning Strikes is NORMAL — DR applies", () => {
  const g = makeG(); // base
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 3, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] });
  // (10-3) + (5-3) = 7 + 2 = 9 landed on the lone enemy.
  assert.equal(e.hp, 91, "normal base damage is reduced by DR on each hit");
});

// --------------------------------------------------------------------------- //
//  galazax3 — The Voice Above: "The Heavens Speak now costs [65] less and no
//  longer cancels Channeled skills"  ([65] = Generic energy)
// --------------------------------------------------------------------------- //

test("galazax3 c1: The Heavens Speak costs 1 less Generic — castable on 1 Storm alone", () => {
  const g = makeG("galazax3");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  state.teams.A.energy = { generic: 0, storm: 1 }; // covers augmented cost (storm 1 only), NOT the base cost

  const r = performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(r.ok, true, "usable — the Generic part of the cost was removed");
  assert.equal(state.teams.A.energy.storm, 0, "the 1 Storm (specific) was still charged");
  assert.equal(state.teams.A.energy.generic, 0, "no Generic was charged (0 available, 0 needed)");
});

test("galazax3 c1 control: WITHOUT the augment, 1 Storm alone is insufficient (base needs Generic too)", () => {
  const g = makeG(); // base
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  state.teams.A.energy = { generic: 0, storm: 1 };

  const r = performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(r.ok, false, "base cost is generic 1 + storm 1 — cannot pay the generic");
  assert.equal(r.reason, "insufficient-energy", "the missing 1 Generic blocks the cast");
  assert.equal(e.hp, 100, "and nothing resolved");
});

test("galazax3 c1 precise: exactly 1 Generic less is charged (0 Generic + 1 Storm)", () => {
  const g = makeG("galazax3");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  state.teams.A.energy = { generic: 5, storm: 5 };

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(state.teams.A.energy.generic, 5, "augmented: 0 Generic charged");
  assert.equal(state.teams.A.energy.storm, 4, "augmented: 1 Storm charged");

  // Control: the base skill charges 1 Generic + 1 Storm from the same pool.
  const gb = makeG(undefined, "gb");
  const eb = makeUnit({ id: "eb", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const sb = makeState([gb], [eb]);
  sb.teams.A.energy = { generic: 5, storm: 5 };
  performAction(sb, { unit: "gb", skillId: "galazax4", targets: ["eb"] });
  assert.equal(sb.teams.A.energy.generic, 4, "base: 1 Generic charged (the [65] the augment removes)");
  assert.equal(sb.teams.A.energy.storm, 4, "base: 1 Storm charged");
});

test("galazax3 c2: The Heavens Speak no longer cancels a Channeled skill", () => {
  const g = makeG("galazax3");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);
  seedChannel(g); // Galazax is Channeling The Sky Darkens

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(isChanneling(g), true, "the channel survives — Voice Above stops the cancel");
  assert.ok(e.hp < 100, "and The Heavens Speak still resolved (dealt damage)");
});

test("galazax3 c2 control: WITHOUT the augment, The Heavens Speak cancels the channel", () => {
  const g = makeG(); // base
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);
  seedChannel(g);

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(isChanneling(g), false, "base The Heavens Speak interrupts Channeling");
});

// --------------------------------------------------------------------------- //
//  galazax4 — Deafening Silence: "Thunder Deafens has its cooldown reduced by 1,
//  but it no longer causes Galazax to ignore damage"
// --------------------------------------------------------------------------- //

test("galazax4 c1: Thunder Deafens' cooldown is reduced by 1 (3 -> 2)", () => {
  const g = makeG("galazax4");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.equal(sk(g, "galazax5").currentCd, 2, "augmented cooldown is 2");

  // Control: base Thunder Deafens goes on cooldown 3.
  const gb = makeG(undefined, "gb");
  const sb = makeState([gb], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  giveEnergy(sb);
  performAction(sb, { unit: "gb", skillId: "galazax5", targets: [] });
  assert.equal(sk(gb, "galazax5").currentCd, 3, "base cooldown is 3");
});

test("galazax4 c2: still becomes untargetable, but NO damage_ignore is applied", () => {
  const g = makeG("galazax4");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  const unt = g.statuses.find((s) => s.kind === "untargetable");
  assert.ok(unt, "untargetable is still granted (only the ignore-damage half is removed)");
  assert.equal(unt?.duration, 1, "for 1 turn");
  assert.equal(g.statuses.some((s) => s.kind === "damage_ignore"), false, "NO damage_ignore — Galazax no longer ignores damage");
});

test("galazax4 c2 control: WITHOUT the augment, base Thunder Deafens grants damage_ignore", () => {
  const g = makeG(); // base
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.ok(g.statuses.some((s) => s.kind === "damage_ignore"), "base grants damage_ignore");
  assert.ok(g.statuses.some((s) => s.kind === "untargetable"), "base grants untargetable");
});

test("galazax4 c2 behavioral: a DoT deals its damage now (base would ignore it)", () => {
  const g = makeG("galazax4");
  // An enemy-applied DoT ticks via applyDamage (bypasses targeting), so it probes damage_ignore, not untargetable.
  g.statuses.push({ kind: "dot", name: "Poison", magnitude: 10, dtype: "affliction", duration: null, appliedBy: "e", appliedTurn: 0 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] }); // no damage_ignore granted
  endTurn(state); // A -> B
  endTurn(state); // B's turn ends -> the enemy DoT ticks; nothing to void it now
  assert.equal(g.hp, 90, "the 10 DoT landed — damage is no longer ignored");
});

test("galazax4 c2 behavioral control: WITHOUT the augment the same DoT is ignored", () => {
  const g = makeG(); // base
  g.statuses.push({ kind: "dot", name: "Poison", magnitude: 10, dtype: "affliction", duration: null, appliedBy: "e", appliedTurn: 0 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] }); // base grants damage_ignore
  endTurn(state); // A -> B
  endTurn(state); // B's turn ends -> DoT ticks but damage_ignore voids it
  assert.equal(g.hp, 100, "base ignores all damage — the DoT dealt nothing");
});

test("galazax4 guard: the augment keeps 'does not interrupt Channeling'", () => {
  // Not an augment clause, but Deafening Silence re-authors the whole skill; guard that the base
  // 'Using this skill does not interrupt Channeling' property survived the rewrite.
  const g = makeG("galazax4");
  seedChannel(g);
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.equal(isChanneling(g), true, "Thunder Deafens still does not interrupt the channel");
});

// --------------------------------------------------------------------------- //
//  galazax5 — Looming Grudge: "A random enemy Hero starts each round with 3
//  stacks of The Storm Builds"
// --------------------------------------------------------------------------- //

test("galazax5 c1: at round start a random enemy Hero gains 3 stacks of The Storm Builds", () => {
  const g = makeG("galazax5");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);

  startRound(state); // fires the roundStart trigger
  assert.equal(stormStacks(e), 3, "the lone enemy Hero starts the round with exactly 3 stacks");
  assert.equal(stormStacks(g), 0, "the stacks land on an ENEMY, never on Galazax himself");
});

test("galazax5 c1 control: WITHOUT the augment no stacks appear at round start", () => {
  const g = makeG(); // base
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);

  startRound(state);
  assert.equal(stormStacks(e), 0, "no Looming Grudge -> the enemy starts clean");
});

test("galazax5 clause: only a Hero is eligible — an enemy minion is skipped", () => {
  const g = makeG("galazax5");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const m = makeUnit({ id: "m", team: "B", kind: "minion", hp: 30, maxHp: 30, summoner: "someHero" });
  const state = makeState([g], [e]);
  // register the minion on team B alongside the hero
  state.units["m"] = m;
  state.teams.B.units.push("m");

  startRound(state);
  assert.equal(stormStacks(e), 3, "the only eligible enemy Hero got the 3 stacks");
  assert.equal(stormStacks(m), 0, "the enemy MINION is not a 'Hero' and is skipped");
});

test("galazax5 clause: exactly ONE random enemy Hero is chosen (3 total across the enemy team)", () => {
  const g = makeG("galazax5");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);

  startRound(state);
  const total = stormStacks(e1) + stormStacks(e2);
  assert.equal(total, 3, "exactly 3 stacks total — 'A random enemy Hero' (singular), not all of them");
  // and they are concentrated on one hero, not split.
  const each = [stormStacks(e1), stormStacks(e2)].sort((a, b) => a - b);
  assert.deepEqual(each, [0, 3], "one hero gets all 3, the other gets none");
});
