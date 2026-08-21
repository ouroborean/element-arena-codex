import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { performAction, startRound } from "../src/scheduler.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { getMinionTemplate } from "../src/minions.ts";
import type { MatchState, Unit } from "../src/types.ts";

// gaia3's custom `buffMinionMaxHp` mutates the SHARED, module-global minion
// template (tmpl.maxHp += delta), so repeated applyAugment calls in one process
// accumulate onto the template and would leak into other tests/files. Snapshot
// the pristine (pre-augment) template HP at load and restore it around every
// HP-sensitive test so each observes a single, clean +10 application.
const PRISTINE_SEEDLING_HP = getMinionTemplate("Seedling")?.maxHp ?? 25;
const PRISTINE_WORLDSPROUT_HP = getMinionTemplate("Worldsprout")?.maxHp ?? 40;
function resetMinionTemplates(): void {
  const s = getMinionTemplate("Seedling");
  if (s) s.maxHp = PRISTINE_SEEDLING_HP;
  const w = getMinionTemplate("Worldsprout");
  if (w) w.maxHp = PRISTINE_WORLDSPROUT_HP;
}
after(resetMinionTemplates); // leave templates pristine for other suites in a full run

// ===========================================================================
// ADVERSARIAL, SPEC-DERIVED AUGMENT suite for GAIA WORLDSOUL.
// The FROZEN augment prose (content/frozen/augments.json) is the sole oracle:
//
//  gaia1 Yggdrasil's Guidance:
//    "At the start of the game, Gaia creates a Worldsprout minion instead of a
//     Seedling."
//  gaia2 Earthen Aid:
//    "Channel Earth heals a random ally for 10 HP"
//  gaia3 Stonepod Seedlings:
//    "Gaia's minions are created with 10 more maximum HP."
//  gaia4 Destructive Divergence:
//    "Each time Channel Vitality is triggered, Gaia gains a stack of Channel
//     Earth."
//  gaia5 Soul Channeling:
//    "Gaia now starts the round with 3 Seedlings"
//
// Frozen BASE canon relied on (content/frozen/skills.json):
//  - gaia0 Yggdrasil's Bounty (passive): "At the start of the game, Gaia creates
//    two Seedling minions."  (round-start summon of TWO Seedlings)
//  - gaia1 Sprout Seedling: "Creates a Seedling minion. Maximum 3." (1 generic)
//  - gaia2 Worldfist: "Deals 10 damage to one enemy, increased by 5 for each
//    time Channel Earth has been used this battle." (1 earth)
//  - gaia3 Channel Vitality: heals target ally 10; +10 per Gaia-minion act. (1 earth, cd 1)
//  - gaia5 Worldmarch: "All active Seedling minions become Worldsprout minions
//    permanently." (2 earth)
//  - seedling1 Channel Earth (a Seedling's own action): "Gaia gains Elemental
//    Essence and 1 permanent stack of Channel Earth."
//  Frozen minion HP (content/frozen/minions.json): Seedling 25, Worldsprout 40.
//
// Gaia's element is EARTH: specific costs are paid from the earth pool.
// ===========================================================================

const GAIA = "g";

function fund(state: MatchState): void {
  state.teams.A.energy = { generic: 40, earth: 40 };
}

function minionsNamed(state: MatchState, team: "A" | "B", name: string): Unit[] {
  return state.teams[team].units
    .map((id) => state.units[id]!)
    .filter((u) => u.kind === "minion" && u.name === name);
}

function teamTotalHp(state: MatchState, team: "A" | "B"): number {
  return state.teams[team].units.reduce((t, id) => t + state.units[id]!.hp, 0);
}

/** Sum of Channel Earth stack magnitudes on a unit — what Worldfist/Rampart read. */
function channelEarthStacks(u: Unit): number {
  return u.statuses
    .filter((s) => s.kind === "stack" && s.name === "Channel Earth")
    .reduce((t, s) => t + (s.magnitude ?? 0), 0);
}

/** A Seedling drives its own "Channel Earth" action (seedling1). */
function channelEarthOnce(state: MatchState): void {
  const seed = minionsNamed(state, "A", "Seedling")[0];
  assert.ok(seed, "expected a live Seedling to drive Channel Earth");
  const res = performAction(state, { unit: seed!.id, skillId: "seedling1", targets: [] });
  assert.ok(res.ok, `Seedling Channel Earth should resolve (got ${res.reason ?? "?"})`);
}

function baseGaia(augId: string | null, extraAllies: Unit[] = []): { state: MatchState; gaia: Unit } {
  const gaia = loadHero(heroById("gaia"), "A", GAIA);
  if (augId) applyAugment(gaia, augmentById(augId)!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([gaia, ...extraAllies], [enemy]);
  return { state, gaia };
}

// =========================================================================== //
//  gaia1 — Yggdrasil's Guidance: a Worldsprout instead of a Seedling at start
// =========================================================================== //

test("gaia1: round start yields exactly one Seedling AND one Worldsprout (swap of one)", () => {
  const { state } = baseGaia("gaia1");
  startRound(state, "A");

  assert.equal(minionsNamed(state, "A", "Seedling").length, 1, "one Seedling remains");
  const sprouts = minionsNamed(state, "A", "Worldsprout");
  assert.equal(sprouts.length, 1, "the other Seedling is replaced by a Worldsprout");
  // Total minions still 2 — a swap, not an addition.
  const allMin = state.teams.A.units.map((id) => state.units[id]!).filter((u) => u.kind === "minion");
  assert.equal(allMin.length, 2, "still exactly two minions at start (swap, not extra)");
  // The Worldsprout is Gaia's own summon on her team.
  assert.equal(sprouts[0]!.summoner, GAIA, "Worldsprout is Gaia's summon");
  assert.equal(sprouts[0]!.team, "A", "Worldsprout joins Gaia's team");
});

test("gaia1 CONTROL: without the augment, round start makes two Seedlings and no Worldsprout", () => {
  const { state } = baseGaia(null);
  startRound(state, "A");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 2, "base passive: two Seedlings");
  assert.equal(minionsNamed(state, "A", "Worldsprout").length, 0, "base passive: no Worldsprout");
});

// =========================================================================== //
//  gaia2 — Earthen Aid: Channel Earth heals a random ally for 10 HP
// =========================================================================== //

test("gaia2: a Seedling's Channel Earth heals a random ally for exactly 10 HP", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 });
  const { state } = baseGaia("gaia2", [ally]);
  startRound(state, "A"); // 2 Seedlings via base passive; resets hp
  fund(state);
  // Wound EVERY team-A unit by 30 so whichever random ally is chosen, +10 lands fully.
  for (const id of state.teams.A.units) {
    const u = state.units[id]!;
    u.hp = Math.max(1, u.maxHp - 30);
  }
  const before = teamTotalHp(state, "A");

  channelEarthOnce(state);

  assert.equal(teamTotalHp(state, "A") - before, 10, "exactly 10 HP healed across the allied team (one random ally)");
});

test("gaia2 CONTROL: without the augment, Channel Earth heals nobody", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 100, maxHp: 100 });
  const { state } = baseGaia(null, [ally]);
  startRound(state, "A");
  fund(state);
  for (const id of state.teams.A.units) {
    const u = state.units[id]!;
    u.hp = Math.max(1, u.maxHp - 30);
  }
  const before = teamTotalHp(state, "A");
  channelEarthOnce(state);
  assert.equal(teamTotalHp(state, "A") - before, 0, "base Channel Earth adds no heal");
});

test("gaia2 CONTROL: the heal targets an ALLY, never an enemy", () => {
  const { state } = baseGaia("gaia2");
  startRound(state, "A");
  fund(state);
  state.units["e"]!.hp = 50; // a wounded enemy that must NOT be healed
  channelEarthOnce(state);
  assert.equal(state.units["e"]!.hp, 50, "an enemy is never the 'random ally' healed");
});

// =========================================================================== //
//  gaia3 — Stonepod Seedlings: Gaia's minions created with +10 max HP
// =========================================================================== //

test("gaia3: passively-summoned Seedlings are created with +10 max HP (25 → 35), at full", () => {
  resetMinionTemplates();
  const { state } = baseGaia("gaia3");
  startRound(state, "A");
  const seeds = minionsNamed(state, "A", "Seedling");
  assert.equal(seeds.length, 2, "two Seedlings from the passive");
  for (const s of seeds) {
    assert.equal(s.maxHp, 35, "Seedling max HP is 25 + 10");
    assert.equal(s.hp, 35, "created at full (new max)");
  }
});

test("gaia3: Sprout Seedling also creates a +10 Seedling (creation-path coverage)", () => {
  resetMinionTemplates();
  const { state } = baseGaia("gaia3");
  startRound(state, "A");
  fund(state);
  performAction(state, { unit: GAIA, skillId: "gaia1", targets: [] }); // Sprout Seedling → 3rd Seedling
  const seeds = minionsNamed(state, "A", "Seedling");
  assert.equal(seeds.length, 3, "third Seedling created");
  for (const s of seeds) assert.equal(s.maxHp, 35, "Sprout-Seedling Seedling is also 25 + 10");
});

test("gaia3: Worldmarch-transformed Worldsprouts are +10 too (40 → 50)", () => {
  resetMinionTemplates();
  const { state } = baseGaia("gaia3");
  startRound(state, "A");
  fund(state);
  performAction(state, { unit: GAIA, skillId: "gaia5", targets: [] }); // Worldmarch: Seedlings → Worldsprouts
  const sprouts = minionsNamed(state, "A", "Worldsprout");
  assert.equal(sprouts.length, 2, "both Seedlings transformed");
  for (const s of sprouts) {
    assert.equal(s.maxHp, 50, "Worldsprout max HP is 40 + 10");
    assert.equal(s.hp, 50, "transformed at full (new max)");
  }
});

test("gaia3 CONTROL: without the augment, minions use base template HP (Seedling 25, Worldsprout 40)", () => {
  resetMinionTemplates();
  // Frozen minion HP (content/frozen/minions.json): Seedling 25, Worldsprout 40.
  assert.equal(PRISTINE_SEEDLING_HP, 25, "frozen Seedling template HP");
  assert.equal(PRISTINE_WORLDSPROUT_HP, 40, "frozen Worldsprout template HP");
  const { state } = baseGaia(null);
  startRound(state, "A");
  fund(state);
  for (const s of minionsNamed(state, "A", "Seedling")) assert.equal(s.maxHp, 25, "base Seedling max HP");
  performAction(state, { unit: GAIA, skillId: "gaia5", targets: [] });
  for (const s of minionsNamed(state, "A", "Worldsprout")) assert.equal(s.maxHp, 40, "base Worldsprout max HP");
});

// =========================================================================== //
//  gaia4 — Destructive Divergence: each Channel Vitality use → +1 Channel Earth
// =========================================================================== //

test("gaia4: casting Channel Vitality grants Gaia one Channel Earth stack", () => {
  const { state, gaia } = baseGaia("gaia4");
  startRound(state, "A");
  fund(state);
  assert.equal(channelEarthStacks(gaia), 0, "no Channel Earth stacks to begin with");

  const res = performAction(state, { unit: GAIA, skillId: "gaia3", targets: [GAIA] });
  assert.ok(res.ok, "Channel Vitality should resolve");
  assert.equal(channelEarthStacks(gaia), 1, "one Channel Earth stack gained from the cast");
});

test("gaia4: the gained Channel Earth stack scales Worldfist by +5 (10 → 15)", () => {
  const { state, gaia } = baseGaia("gaia4");
  startRound(state, "A");
  fund(state);
  performAction(state, { unit: GAIA, skillId: "gaia3", targets: [GAIA] }); // +1 Channel Earth
  const enemy = state.units["e"]!;
  enemy.hp = 100;
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(enemy.hp, 85, "Worldfist deals 10 + 5 (one Channel Earth stack)");
  assert.equal(channelEarthStacks(gaia), 1, "still exactly one stack (Worldfist does not consume it)");
});

test("gaia4: 'each time' — a second Channel Vitality use grants a second stack (→ Worldfist 20)", () => {
  const { state, gaia } = baseGaia("gaia4");
  startRound(state, "A");
  fund(state);
  performAction(state, { unit: GAIA, skillId: "gaia3", targets: [GAIA] });
  assert.equal(channelEarthStacks(gaia), 1, "first cast → 1 stack");
  // Channel Vitality has cooldown 1; clear it to represent a later, legal re-use.
  const cv = (gaia.skills ?? []).find((s) => s.id === "gaia3")!;
  cv.currentCd = 0;
  performAction(state, { unit: GAIA, skillId: "gaia3", targets: [GAIA] });
  assert.equal(channelEarthStacks(gaia), 2, "second cast → 2 stacks (each time)");

  const enemy = state.units["e"]!;
  enemy.hp = 100;
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(enemy.hp, 80, "Worldfist deals 10 + 5 + 5 (two Channel Earth stacks)");
});

test("gaia4 CONTROL: without the augment, Channel Vitality grants no Channel Earth stack", () => {
  const { state, gaia } = baseGaia(null);
  startRound(state, "A");
  fund(state);
  performAction(state, { unit: GAIA, skillId: "gaia3", targets: [GAIA] });
  assert.equal(channelEarthStacks(gaia), 0, "base Channel Vitality does not touch Channel Earth");
  const enemy = state.units["e"]!;
  enemy.hp = 100;
  performAction(state, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(enemy.hp, 90, "Worldfist stays at base 10 damage");
});

// =========================================================================== //
//  gaia5 — Soul Channeling: start the round with 3 Seedlings
// =========================================================================== //

test("gaia5: round start yields exactly three Seedlings", () => {
  const { state } = baseGaia("gaia5");
  startRound(state, "A");
  const seeds = minionsNamed(state, "A", "Seedling");
  assert.equal(seeds.length, 3, "three Seedlings at round start");
  assert.equal(minionsNamed(state, "A", "Worldsprout").length, 0, "no Worldsprouts");
  for (const s of seeds) {
    assert.equal(s.summoner, GAIA, "each is Gaia's summon");
    assert.equal(s.team, "A", "each joins Gaia's team");
  }
});

test("gaia5 CONTROL: without the augment, round start makes only two Seedlings", () => {
  const { state } = baseGaia(null);
  startRound(state, "A");
  assert.equal(minionsNamed(state, "A", "Seedling").length, 2, "base passive: two Seedlings, not three");
});
