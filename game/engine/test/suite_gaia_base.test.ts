import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { performAction, startRound } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// ADVERSARIAL, SPEC-DERIVED suite for Gaia Worldsoul's BASE kit.
// The oracle is the FROZEN PROSE (content/frozen/skills.json), transcribed here:
//
//   gaia0 Yggdrasil's Bounty (passive): "At the start of the game, Gaia creates
//         two Seedling minions."
//   gaia1 Sprout Seedling: "Creates a Seedling minion. Maximum 3."  (cost 1 generic)
//   gaia2 Worldfist: "Deals 10 damage to one enemy, increased by 5 for each time
//         Channel Earth has been used this battle."  (cost 1 earth)
//   gaia3 Channel Vitality: "Gaia heals target ally for 10 HP. For the rest of the
//         turn, if any of Gaia's minions act, that ally will be healed for 10 HP."
//         (cost 1 earth, cooldown 1)
//   gaia4 Rampart: "Gaia gains 20 permanent Shield, increased by 5 for each time
//         Channel Earth has been used this battle."  (cost 1 earth, cooldown 2)
//   gaia5 Worldmarch: "All active Seedling minions become Worldsprout minions
//         permanently."  (cost 2 earth, cooldown 6)
//
// Gaia's element is EARTH: specific cost is paid from the earth pool.
// "Channel Earth" is driven through the real in-kit mechanism — a Seedling's own
// "Channel Earth" action (seedling1), which records a Channel Earth use on Gaia.
// ---------------------------------------------------------------------------

const GAIA = "g";

function fund(state: MatchState): void {
  state.teams.A.energy = { generic: 40, earth: 40 };
}

function minionsNamed(state: MatchState, team: "A" | "B", name: string): Unit[] {
  return state.teams[team].units
    .map((id) => state.units[id]!)
    .filter((u) => u.kind === "minion" && u.name === name);
}

/** A Gaia + one vanilla enemy state, with Gaia's two Seedlings summoned by the passive. */
function seededState(extraAllies: Unit[] = [], extraEnemies: Unit[] = []): { state: MatchState; gaia: Unit } {
  const gaia = loadHero(heroById("gaia"), "A", GAIA);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([gaia, ...extraAllies], [enemy, ...extraEnemies]);
  startRound(state, "A"); // fires Yggdrasil's Bounty → 2 Seedlings; resets hp/cd
  fund(state);
  return { state, gaia };
}

/** Drive one real "Channel Earth" use by making a Gaia Seedling perform its channel action. */
function channelEarthOnce(state: MatchState): void {
  const seed = minionsNamed(state, "A", "Seedling")[0];
  assert.ok(seed, "expected a live Seedling to drive Channel Earth");
  const res = performAction(state, { unit: seed!.id, skillId: "seedling1", targets: [] });
  assert.ok(res.ok, `Seedling Channel Earth should resolve (got ${res.reason ?? "?"})`);
}

// =========================================================================== //
//  gaia0 — Yggdrasil's Bounty (passive): two Seedlings at start of battle
// =========================================================================== //

test("gaia0 Yggdrasil's Bounty: start of battle creates exactly two Seedlings", () => {
  const gaia = loadHero(heroById("gaia"), "A", GAIA);
  const state = makeState([gaia], [makeUnit({ id: "e", team: "B" })]);

  // Control: before the battle begins, Gaia has no minions.
  assert.equal(minionsNamed(state, "A", "Seedling").length, 0, "no Seedlings before round start");

  startRound(state, "A");

  const seedlings = minionsNamed(state, "A", "Seedling");
  assert.equal(seedlings.length, 2, "exactly two Seedlings at start of battle");
  for (const s of seedlings) {
    assert.equal(s.kind, "minion");
    assert.equal(s.summoner, GAIA, "Seedlings are Gaia's own summons");
    assert.equal(s.maxHp, 25, "Seedling max HP per template");
    assert.equal(s.team, "A", "Seedlings join Gaia's team");
  }
});

test("gaia0: the two Seedlings are re-created each fresh battle (start of round)", () => {
  const { state } = seededState();
  assert.equal(minionsNamed(state, "A", "Seedling").length, 2, "battle 1: two Seedlings");

  // A new fresh battle clears the field and the passive re-summons two.
  startRound(state, "A");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 2, "battle 2: freshly two Seedlings, not four");
});

// =========================================================================== //
//  gaia1 — Sprout Seedling: create one Seedling, maximum 3
// =========================================================================== //

test("gaia1 Sprout Seedling: creates one Seedling and pays 1 generic", () => {
  const gaia = loadHero(heroById("gaia"), "A", GAIA);
  const state = makeState([gaia], [makeUnit({ id: "e", team: "B" })]);
  // No passive summon here (no startRound) — isolate gaia1's own creation.
  state.teams.A.energy = { generic: 40, earth: 40 };

  assert.equal(minionsNamed(state, "A", "Seedling").length, 0, "start from zero Seedlings");
  const res = performAction(state, { unit: GAIA, skillId: "gaia1", targets: [] });
  assert.ok(res.ok, "Sprout Seedling should resolve");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 1, "exactly one Seedling created");
  assert.equal(state.teams.A.energy.generic, 39, "Sprout Seedling costs 1 generic");
});

test("gaia1: Maximum 3 — a third Seedling is allowed, a fourth is not", () => {
  const { state } = seededState(); // starts with 2 Seedlings from the passive
  assert.equal(minionsNamed(state, "A", "Seedling").length, 2, "two to begin with");

  const r3 = performAction(state, { unit: GAIA, skillId: "gaia1", targets: [] });
  assert.ok(r3.ok, "third Seedling cast resolves");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 3, "now at the cap of 3");

  // Casting again while at the cap creates NO new Seedling (frozen: "Maximum 3").
  const genBefore = state.teams.A.energy.generic!;
  const r4 = performAction(state, { unit: GAIA, skillId: "gaia1", targets: [] });
  assert.ok(r4.ok, "the cast itself still resolves (cost is paid)");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 3, "still 3 — no fourth Seedling");
  assert.equal(state.teams.A.energy.generic, genBefore - 1, "the over-cap cast still spent its generic");
});

test("gaia1: cannot cast without energy (control on cost)", () => {
  const gaia = loadHero(heroById("gaia"), "A", GAIA);
  const state = makeState([gaia], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 0, earth: 0 };
  const res = performAction(state, { unit: GAIA, skillId: "gaia1", targets: [] });
  assert.equal(res.ok, false, "no generic → cannot Sprout Seedling");
  assert.equal(res.reason, "insufficient-energy");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 0, "no Seedling created on a failed cast");
});

// =========================================================================== //
//  gaia2 — Worldfist: 10 damage +5 per Channel Earth used this battle
// =========================================================================== //

test("gaia2 Worldfist: base is exactly 10 damage with no Channel Earth used", () => {
  const { state } = seededState();
  const enemy = state.units["e"]!;
  assert.equal(enemy.hp, 100);

  const res = performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.ok(res.ok, "Worldfist should resolve");
  assert.equal(enemy.hp, 90, "10 damage at 0 Channel Earth uses");
  assert.equal(state.teams.A.energy.earth, 39, "Worldfist costs 1 earth");
});

test("gaia2: damage rises by exactly 5 for each Channel Earth used this battle", () => {
  const { state } = seededState();
  const enemy = state.units["e"]!;

  // 0 uses → 10
  enemy.hp = 100;
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(enemy.hp, 90, "0 uses → 10 damage");

  // 1 use → 15
  channelEarthOnce(state);
  enemy.hp = 100;
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(enemy.hp, 85, "1 use → 15 damage (+5)");

  // 2 uses → 20
  channelEarthOnce(state);
  enemy.hp = 100;
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(enemy.hp, 80, "2 uses → 20 damage (+5 each)");
});

test("gaia2: hits only the chosen enemy, not other units (control on targeting)", () => {
  const { state } = seededState([], [makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 })]);
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(state.units["e"]!.hp, 90, "targeted enemy takes 10");
  assert.equal(state.units["e2"]!.hp, 100, "the other enemy is untouched");
});

// =========================================================================== //
//  gaia3 — Channel Vitality: heal 10 now; +10 per Gaia-minion action this turn
// =========================================================================== //

test("gaia3 Channel Vitality: heals the target ally for 10 immediately", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  const { state } = seededState([ally]);
  state.units["al"]!.hp = 50; // startRound reset hp to max; re-wound the ally

  const res = performAction(state, { unit: GAIA, skillId: "gaia3", targets: ["al"] });
  assert.ok(res.ok, "Channel Vitality should resolve");
  assert.equal(state.units["al"]!.hp, 60, "immediate 10 HP heal");
  assert.equal(state.teams.A.energy.earth, 39, "Channel Vitality costs 1 earth");
});

test("gaia3: for the rest of the turn, each Gaia-minion action heals that ally 10", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  const { state } = seededState([ally]);
  state.units["al"]!.hp = 50;

  performAction(state, { unit: GAIA, skillId: "gaia3", targets: ["al"] });
  assert.equal(state.units["al"]!.hp, 60, "immediate heal");

  channelEarthOnce(state); // a Gaia Seedling acts
  assert.equal(state.units["al"]!.hp, 70, "the marked ally heals another 10 when Gaia's minion acts");

  channelEarthOnce(state); // a second Gaia-minion action
  assert.equal(state.units["al"]!.hp, 80, "each Gaia-minion action heals the marked ally 10");
});

test("gaia3: only the healed ally benefits — an unmarked ally does not", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  const other = makeUnit({ id: "al2", team: "A", hp: 50, maxHp: 100 });
  const { state } = seededState([ally, other]);
  state.units["al"]!.hp = 50;
  state.units["al2"]!.hp = 50;

  performAction(state, { unit: GAIA, skillId: "gaia3", targets: ["al"] });
  channelEarthOnce(state);
  assert.equal(state.units["al"]!.hp, 70, "targeted ally: 50 → 60 (cast) → 70 (minion act)");
  assert.equal(state.units["al2"]!.hp, 50, "the un-targeted ally is never healed");
});

test("gaia3: only GAIA's own minions trigger the follow-up heal (control on source)", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  // A minion that belongs to an ally, NOT summoned by Gaia.
  const foreign = makeUnit({ id: "fm", team: "A", kind: "minion", summoner: "al" });
  const { state } = seededState([ally, foreign]);
  state.units["al"]!.hp = 50;

  performAction(state, { unit: GAIA, skillId: "gaia3", targets: ["al"] });
  assert.equal(state.units["al"]!.hp, 60, "immediate heal only");

  emit(state, { type: "skillUsed", caster: "fm", skillId: "x", targets: [], tags: [] });
  assert.equal(state.units["al"]!.hp, 60, "a non-Gaia minion acting does NOT heal the marked ally");
});

test("gaia3: the heal window closes at the end of Gaia's turn", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100 });
  const { state } = seededState([ally]);
  state.units["al"]!.hp = 50;

  performAction(state, { unit: GAIA, skillId: "gaia3", targets: ["al"] });
  assert.equal(state.units["al"]!.hp, 60, "immediate heal");

  emit(state, { type: "turnEnd", team: "A" }); // "for the rest of the turn" ends here

  channelEarthOnce(state);
  assert.equal(state.units["al"]!.hp, 60, "after the turn ends, Gaia-minion actions no longer heal");
});

// =========================================================================== //
//  gaia4 — Rampart: 20 permanent Shield, +5 per Channel Earth used this battle
// =========================================================================== //

test("gaia4 Rampart: grants 20 permanent Shield at 0 Channel Earth uses", () => {
  const { state, gaia } = seededState();
  assert.equal(gaia.shields.length, 0, "no shield to begin with");

  const res = performAction(state, { unit: GAIA, skillId: "gaia4", targets: [] });
  assert.ok(res.ok, "Rampart should resolve");
  const total = gaia.shields.reduce((t, s) => t + s.amount, 0);
  assert.equal(total, 20, "20 Shield at base");
  assert.ok(gaia.shields.every((s) => s.duration === null), "the Shield is permanent (no duration)");
  assert.equal(state.teams.A.energy.earth, 39, "Rampart costs 1 earth");
});

test("gaia4: Shield is 20 + 5 per Channel Earth used (one use → 25)", () => {
  const { state, gaia } = seededState();
  channelEarthOnce(state); // 1 use
  performAction(state, { unit: GAIA, skillId: "gaia4", targets: [] });
  const total = gaia.shields.reduce((t, s) => t + s.amount, 0);
  assert.equal(total, 25, "1 Channel Earth use → 20 + 5 = 25 Shield");
});

test("gaia4: two Channel Earth uses → 30 Shield (+5 each)", () => {
  const { state, gaia } = seededState();
  channelEarthOnce(state);
  channelEarthOnce(state);
  performAction(state, { unit: GAIA, skillId: "gaia4", targets: [] });
  const total = gaia.shields.reduce((t, s) => t + s.amount, 0);
  assert.equal(total, 30, "2 Channel Earth uses → 20 + 10 = 30 Shield");
});

test("gaia4: only Gaia gains the Shield (control on self-target)", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 });
  const { state, gaia } = seededState([ally]);
  performAction(state, { unit: GAIA, skillId: "gaia4", targets: [] });
  assert.equal(gaia.shields.reduce((t, s) => t + s.amount, 0), 20, "Gaia shielded");
  assert.equal(state.units["al"]!.shields.length, 0, "the ally gains no Shield");
});

// =========================================================================== //
//  gaia5 — Worldmarch: all active Seedlings become Worldsprout minions
// =========================================================================== //

test("gaia5 Worldmarch: every active Seedling becomes a Worldsprout", () => {
  const { state } = seededState(); // 2 Seedlings
  assert.equal(minionsNamed(state, "A", "Seedling").length, 2);
  assert.equal(minionsNamed(state, "A", "Worldsprout").length, 0);

  const res = performAction(state, { unit: GAIA, skillId: "gaia5", targets: [] });
  assert.ok(res.ok, "Worldmarch should resolve");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 0, "no Seedlings remain");
  const sprouts = minionsNamed(state, "A", "Worldsprout");
  assert.equal(sprouts.length, 2, "both became Worldsprouts");
  for (const s of sprouts) {
    assert.equal(s.maxHp, 40, "transformed to Worldsprout template (40 HP)");
    assert.ok((s.skills ?? []).some((k) => k.id === "worldsprout1"), "has Worldsprout skills");
  }
  assert.equal(state.teams.A.energy.earth, 38, "Worldmarch costs 2 earth");
});

test("gaia5: transforms exactly the Seedling count (three Seedlings → three Worldsprouts)", () => {
  const { state } = seededState();
  performAction(state, { unit: GAIA, skillId: "gaia1", targets: [] }); // 2 → 3 Seedlings
  assert.equal(minionsNamed(state, "A", "Seedling").length, 3);

  performAction(state, { unit: GAIA, skillId: "gaia5", targets: [] });
  assert.equal(minionsNamed(state, "A", "Worldsprout").length, 3, "all three Seedlings converted");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 0);
});

test("gaia5: only Seedlings convert — other minions are untouched", () => {
  // A non-Seedling ally minion and an enemy Seedling must survive Worldmarch unchanged.
  // Add them AFTER seededState (startRound clears the field, so pre-seeded minions would be wiped).
  const { state } = seededState();
  const bystander = makeUnit({ id: "mush", team: "A", kind: "minion", name: "Mushroom", summoner: GAIA, hp: 20, maxHp: 20 });
  const enemyMin = makeUnit({ id: "em", team: "B", kind: "minion", name: "Seedling", summoner: "e", hp: 25, maxHp: 25 });
  state.units["mush"] = bystander;
  state.teams.A.units.push("mush");
  state.units["em"] = enemyMin;
  state.teams.B.units.push("em");

  performAction(state, { unit: GAIA, skillId: "gaia5", targets: [] });

  assert.equal(state.units["mush"]!.name, "Mushroom", "a non-Seedling ally minion is not transformed");
  assert.equal(state.units["em"]!.name, "Seedling", "an ENEMY Seedling is not affected (allies only)");
  assert.equal(minionsNamed(state, "A", "Worldsprout").length, 2, "only Gaia's own Seedlings converted");
});
