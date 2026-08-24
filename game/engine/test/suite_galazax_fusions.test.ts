import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performAction, endTurn, startTurn } from "../src/scheduler.ts";
import { fusionForm, FUSIONS } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers custom handlers via hero.ts
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { stackCount } from "../src/status.ts";
import type { MatchState, Unit } from "../src/types.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED suite for GALAZAX's FUSION FORM.
//
// IMPORTANT STRUCTURAL FACT (spec-derived, from content/frozen/characters.json):
//   Galazax, the Coming Storm is authored with  "starts_fused": true,
//   "can_fuse": false,  "fusion_skills": {},  element = "storm".  Like Aramao and
//   Dennis, Galazax has NO menu of ~7 elemental fusion variants; he is PERMANENTLY
//   fused into a single Storm form. That one form's passive + active skills ARE his
//   fusion kit:
//     - fusion passive : galazax0  "The Storm Builds"
//     - fusion actives : galazax1 .. galazax6
//   (The generated FUSIONS table therefore contains ZERO "galazax" forms; there is
//   nothing to applyFusion() into. loadHero() already yields the fused Storm kit.)
//
// Section 0 pins that spec fact as an executable guard. Sections 1..7 then treat
// Galazax's single permanent Storm form as THE fusion form and verify its passive +
// every active against the FROZEN prose (content/frozen/skills.json), the sole
// oracle. Authored/generated content is consulted ONLY for how to drive (ids,
// costs, element, status names), never for what to assert.
//
// Frozen text under test (verbatim from content/frozen/skills.json):
//  galazax0 The Storm Builds (passive):
//    "Galazax's damaging skills apply a stack of The Storm Builds. Galazax gains
//     Elemental Essence if he uses a skill while Channeling."
//  galazax1 The Sky Darkens (Channel):
//    "Galazax deals 5 Piercing damage to all enemies each turn. Cannot be used
//     while active."
//  galazax2 Lightning Strikes:
//    "Galazax deals 10 damage to target enemy and 5 damage to a random enemy."
//  galazax3 Pressure Rises:
//    "Galazax moves all stacks of The Storm Builds from target enemy to himself. If
//     2 or more stacks are removed, this deals 5 Piercing damage to the target. If 4
//     or more stacks are removed, stun the target for 1 turn. Using this skill does
//     not interrupt Channeling."
//  galazax4 The Heavens Speak:
//    "Consumes all stacks of The Storm Builds on Galazax, dealing 10 damage to
//     target enemy, increased by 5 for each stack and applying that many stacks of
//     The Storm Builds to the target."
//  galazax5 Thunder Deafens:
//    "Galazax becomes untargetable and ignores all damage for 1 turn. Using this
//     skill does not interrupt Channeling."
//  galazax6 The Vortex Consumes:
//    "Galazax deals 15 Piercing damage to all enemies each turn for 3 turns. This
//     skill applies an extra stack of The Storm Builds to all targets. To use this
//     skill, Galazax must consume 10 stacks of The Storm Builds from himself and
//     must be Channeling The Sky Darkens."
//
// Galazax's element is Storm; specific costs are paid in Storm energy.
// "The Storm Builds" is a { kind:"stack", name:"The Storm Builds" } resource;
// Elemental Essence is a { kind:"elemental_essence" } status; the sustained cast of
// The Sky Darkens is a { kind:"channeling" } status.
// =============================================================================

const STORM = "The Storm Builds";

function fund(state: MatchState, team: "A" | "B" = "A"): void {
  state.teams[team].energy = { generic: 40, storm: 40 };
}
function stormStacks(u: Unit): number {
  return stackCount(u, STORM);
}
function essenceCount(u: Unit): number {
  return u.statuses.filter((s) => s.kind === "elemental_essence").length;
}
function hasEssence(u: Unit): boolean {
  return essenceCount(u) > 0;
}
function isChanneling(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "channeling");
}
function isStunned(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "stun");
}
// Setup-only: push a raw "The Storm Builds" resource onto a unit.
function seedStorm(u: Unit, n: number): void {
  u.statuses.push({ kind: "stack", name: STORM, magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0 });
}
// Setup-only: put the unit into a "Channeling The Sky Darkens" state without driving the full channel.
function seedChannel(u: Unit): void {
  u.statuses.push({ kind: "channeling", name: "galazax1", channelTargets: [], duration: null, appliedBy: u.id, appliedTurn: 0 });
}
// A plain enemy probe attack (10 normal to its target), off cooldown.
const vHit = () =>
  skill("vhit", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" });

// =============================================================================
// Section 0 — SPEC GUARD: Galazax is permanently fused and has NO elemental forms.
// Oracle: frozen characters.json (starts_fused:true, can_fuse:false, fusion_skills:{}).
// The engine's generated fusion table must therefore expose ZERO "galazax" forms.
// =============================================================================

test("galazax SPEC: the frozen roster marks Galazax permanently fused / non-fusing (Storm form)", () => {
  const chars = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../content/frozen/characters.json", import.meta.url)), "utf8"),
  ) as any;
  const arr: any[] = Array.isArray(chars) ? chars : Object.values(chars);
  const gz = arr.find((c) => c.id === "galazax");
  assert.ok(gz, "Galazax is in the frozen roster");
  assert.equal(gz.starts_fused, true, "frozen: Galazax starts fused");
  assert.equal(gz.can_fuse, false, "frozen: Galazax cannot fuse into other elements");
  assert.equal(gz.element.name, "storm", "frozen: Galazax's permanent form is the Storm element");
  assert.deepEqual(gz.fusion_skills, {}, "frozen: Galazax has no menu of elemental fusion variants");
  assert.deepEqual(
    gz.base_skill_ids,
    ["galazax0", "galazax1", "galazax2", "galazax3", "galazax4", "galazax5", "galazax6"],
    "frozen: the permanent Storm kit is galazax0 (passive) + galazax1..6 (actives)",
  );
});

test("galazax SPEC: no elemental fusion FORMS exist for Galazax (nothing to applyFusion into)", () => {
  const galazaxForms = FUSIONS.filter((f) => f.hero === "galazax");
  assert.equal(galazaxForms.length, 0, "the generated fusion table contains no Galazax forms");
  const allKeys = [...new Set(FUSIONS.map((f) => f.key))];
  assert.ok(allKeys.includes("storm"), "the 'storm' key exists (other heroes fuse INTO Galazax's element)");
  for (const key of allKeys) {
    assert.equal(fusionForm("galazax", key), undefined, `Galazax must have no '${key}' fusion form`);
  }
});

test("galazax SPEC: loadHero yields the already-fused Storm kit (element storm, actives galazax1..6)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  assert.equal(g.currentElement, "storm", "Galazax is in his Storm form from the start");
  assert.deepEqual(
    (g.skills ?? []).map((s) => s.id),
    ["galazax1", "galazax2", "galazax3", "galazax4", "galazax5", "galazax6"],
    "the fused active kit — galazax0 is the passive (installed as a trigger, not a slot)",
  );
});

// =============================================================================
// Section 1 — FUSION PASSIVE: galazax0 "The Storm Builds"
//  Clause A: "Galazax's damaging skills apply a stack of The Storm Builds."
//  Clause B: "Galazax gains Elemental Essence if he uses a skill while Channeling."
// =============================================================================

test("galazax0 clause A: a single-hit damaging skill applies exactly one Storm Builds stack to the enemy it damaged", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  // The Sky Darkens' immediate tick = one 5-Piercing hit on the lone enemy.
  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(e.hp, 95, "5 Piercing landed");
  assert.equal(stormStacks(e), 1, "the damaged enemy gains one Storm Builds stack");
  assert.equal(stormStacks(g), 0, "the stack lands on the damaged ENEMY, not on Galazax");
});

test("galazax0 clause A: an AoE damaging skill stacks Storm Builds on EACH enemy it damages", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(stormStacks(e1), 1, "each damaged enemy gains a stack");
  assert.equal(stormStacks(e2), 1, "each damaged enemy gains a stack");
});

test("galazax0 clause A: a MULTI-HIT damaging skill stacks per damage instance (galazax2 on a lone enemy -> 2)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  // Lightning Strikes: 10 (target) + 5 (random = the only enemy) = two damage instances on the same enemy.
  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] });
  assert.equal(e.hp, 85, "10 + 5 = 15 landed on the lone enemy");
  assert.equal(stormStacks(e), 2, "each of the two damaging hits applies one Storm Builds stack");
});

test("galazax0 clause A CONTROL: a NON-damaging skill applies no Storm Builds stack", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  // Thunder Deafens is a Strategic self-buff and deals no damage.
  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.equal(stormStacks(e), 0, "no damage dealt -> no stack applied");
  assert.equal(e.hp, 100, "and the enemy took no damage");
});

// DESIGN RULING (resolved): galazax3 "moves ALL stacks" is FINAL — the target ends emptied (0), even though
// its own 5 Piercing fires the unconditional "damaging skills apply a stack" passive. The move's wipe is
// ordered after the passive stack, so it clears that fresh stack too. Consistent with the four base/fusion
// tests that assert the target ends at 0.
test("galazax3's Piercing does NOT leave a Storm Builds stack — 'moves ALL stacks' empties the target (0)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 3); // 3 >= 2 -> the 5 Piercing branch fires
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(e.hp, 95, "3 (>=2) stacks removed -> 5 Piercing landed on the target");
  assert.equal(stormStacks(g), 3, "the 3 moved stacks are now on Galazax");
  assert.equal(stormStacks(e), 0, "'moves ALL stacks' is final: the target is emptied, clearing even the fresh passive stack");
});

test("galazax0 clause B: using a skill WHILE Channeling grants Elemental Essence", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);
  seedChannel(g); // Galazax is Channeling The Sky Darkens
  assert.equal(hasEssence(g), false, "precondition: no Essence yet");

  // Thunder Deafens does not interrupt Channeling, so the channel is live when the skill is used.
  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.equal(hasEssence(g), true, "a skill used while Channeling grants Elemental Essence");
  assert.equal(isChanneling(g), true, "the channel was not interrupted");
});

test("galazax0 clause B CONTROL: using a skill while NOT Channeling grants no Essence", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);
  assert.equal(isChanneling(g), false, "precondition: not Channeling");

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.equal(hasEssence(g), false, "not Channeling -> no Elemental Essence");
});

test("galazax0 clause B end-to-end: a REAL channel from The Sky Darkens grants Essence on the next skill", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] }); // installs the channel
  assert.equal(isChanneling(g), true, "The Sky Darkens is now channeling");
  g.statuses = g.statuses.filter((s) => s.kind !== "elemental_essence"); // clear so the next grant is unambiguous

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] }); // Pressure Rises does not interrupt
  assert.equal(hasEssence(g), true, "a skill used during the live channel grants Elemental Essence");
});

test("galazax0 grants Essence when a channel-BREAKING skill is used WHILE channeling (state read at declaration)", () => {
  // "Galazax gains Elemental Essence if he uses a skill while Channeling." At the instant Lightning
  // Strikes is used, Galazax IS channeling, so the Essence should be granted even though the same
  // skill then interrupts the channel.
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);
  seedChannel(g);
  g.statuses = g.statuses.filter((s) => s.kind !== "elemental_essence");

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] }); // ordinary skill -> interrupts channel
  assert.equal(isChanneling(g), false, "Lightning Strikes broke the channel");
  assert.equal(hasEssence(g), true, "but he was Channeling at the moment of use -> Elemental Essence granted");
});

// =============================================================================
// Section 2 — FUSION ACTIVE: galazax1 "The Sky Darkens" (Channel)
//  "Galazax deals 5 Piercing damage to all enemies each turn. Cannot be used while active."
// =============================================================================

test("galazax1: immediate cast deals 5 Piercing to ALL enemies and establishes a sustained channel", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(e1.hp, 95, "5 to each enemy");
  assert.equal(e2.hp, 95, "5 to each enemy");
  assert.equal(isChanneling(g), true, "and it is now a sustained channel");
});

test("galazax1: the 5 is PIERCING — it ignores Damage Reduction", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 4, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(e.hp, 95, "Piercing bypasses the 4 DR -> full 5 landed (normal would leave 96)");
});

test("galazax1 'each turn': the channel deals 5 again on Galazax's next turn (and stacks again)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(e.hp, 95, "immediate tick");
  assert.equal(stormStacks(e), 1, "one stack from the first tick");

  endTurn(state); // A -> B
  endTurn(state); // B -> A
  startTurn(state); // Galazax's next turn: the channel re-runs
  assert.equal(e.hp, 90, "the channel dealt 5 again this turn");
  assert.equal(stormStacks(e), 2, "and laid another Storm Builds stack");
});

test("galazax1 'Cannot be used while active': blocked while already Channeling The Sky Darkens", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);
  seedChannel(g); // already channeling galazax1; cooldown fresh so we isolate the not-already-active gate

  const r = performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(r.ok, false, "cannot recast The Sky Darkens while it is active");
  assert.equal(r.reason, "requirements-not-met", "blocked by the not-already-channeling requirement");
  assert.equal(e.hp, 100, "and no extra tick landed");
});

test("galazax1 CONTROL: usable when NOT already channeling", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  const r = performAction(state, { unit: "g", skillId: "galazax1", targets: [] });
  assert.equal(r.ok, true, "The Sky Darkens is castable when not already active");
});

// =============================================================================
// Section 3 — FUSION ACTIVE: galazax2 "Lightning Strikes"
//  "Galazax deals 10 damage to target enemy and 5 damage to a random enemy."
// =============================================================================

test("galazax2: 10 to the explicit target and 5 to a random enemy (15 total across the enemy team)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e1"] });
  const lost1 = 100 - e1.hp;
  const lost2 = 100 - e2.hp;
  assert.equal(lost1 + lost2, 15, "exactly 10 + 5 = 15 total damage dealt");
  assert.ok(lost1 >= 10, "the explicit target took at least its 10");
});

test("galazax2: with a lone enemy both hits land on it -> 15 damage", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] });
  assert.equal(e.hp, 85, "10 (target) + 5 (random = the only enemy) = 15");
});

test("galazax2: damage is NORMAL (not Piercing) — Damage Reduction applies to BOTH hits", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 3, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] });
  // (10-3) + (5-3) = 7 + 2 = 9 landed.
  assert.equal(e.hp, 91, "normal damage reduced by DR on each hit");
});

// =============================================================================
// Section 4 — FUSION ACTIVE: galazax3 "Pressure Rises"
//  "Galazax moves all stacks of The Storm Builds from target enemy to himself. If 2
//   or more stacks are removed, this deals 5 Piercing damage to the target. If 4 or
//   more stacks are removed, stun the target for 1 turn. Using this skill does not
//   interrupt Channeling."
// =============================================================================

test("galazax3: moves ALL Storm Builds from the target to Galazax (target ends at 0)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 3);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(stormStacks(g), 3, "Galazax gains the 3 moved stacks");
});

test("galazax3: moved stacks ADD to Galazax's existing stacks (not overwrite)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedStorm(g, 2); // Galazax already holds 2
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 3);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(stormStacks(g), 5, "2 existing + 3 moved = 5");
});

test("galazax3 '2 or more removed': 5 Piercing to the target, and NOT stunned below 4", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 3);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(e.hp, 95, "3 (>=2) stacks removed -> 5 Piercing landed");
  assert.equal(isStunned(e), false, "3 (<4) stacks removed -> NO stun");
});

test("galazax3: exactly 2 removed still triggers the 5 Piercing (boundary)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 2);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(e.hp, 95, "2 >= 2 -> 5 Piercing");
  assert.equal(stormStacks(g), 2, "both stacks moved to Galazax");
  assert.equal(isStunned(e), false, "2 < 4 -> no stun");
});

test("galazax3: only 1 removed -> NO Piercing and NO stun (the single stack still moves)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 1);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(e.hp, 100, "1 < 2 -> no Piercing damage");
  assert.equal(stormStacks(g), 1, "the single stack still moves to Galazax");
  assert.equal(isStunned(e), false, "no stun");
});

test("galazax3 '4 or more removed': stun the target for 1 turn (plus the 5 Piercing)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vHit()] });
  seedStorm(e, 4);
  const state = makeState([g], [e]);
  fund(state);
  fund(state, "B");

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(stormStacks(g), 4, "all 4 moved to Galazax");
  assert.equal(e.hp, 95, "4 >= 2 -> 5 Piercing also landed");
  assert.equal(isStunned(e), true, "4 >= 4 -> stunned");
  const r = performAction(state, { unit: "e", skillId: "vhit", targets: ["g"] });
  assert.equal(r.reason, "stunned", "the stunned target cannot use a skill");
});

test("galazax3: the 5 Piercing IGNORES Damage Reduction", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  seedStorm(e, 2);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(e.hp, 95, "Piercing ignores the 10 DR -> 5 landed (normal would leave 100)");
});

test("galazax3: does NOT interrupt Channeling (CONTROL: an ordinary skill DOES)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedStorm(e, 2);
  seedChannel(g);
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax3", targets: ["e"] });
  assert.equal(isChanneling(g), true, "Pressure Rises keeps the channel running");

  performAction(state, { unit: "g", skillId: "galazax2", targets: ["e"] }); // no doesNotInterrupt -> breaks it
  assert.equal(isChanneling(g), false, "an ordinary skill interrupts the channel");
});

// =============================================================================
// Section 5 — FUSION ACTIVE: galazax4 "The Heavens Speak"
//  "Consumes all stacks of The Storm Builds on Galazax, dealing 10 damage to target
//   enemy, increased by 5 for each stack and applying that many stacks of The Storm
//   Builds to the target."
// =============================================================================

test("galazax4: with N stacks -> 10 + 5*N damage, consumes Galazax's stacks, applies N to the target", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedStorm(g, 3);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(e.hp, 75, "10 + 5*3 = 25 damage");
  assert.equal(stormStacks(g), 0, "consumes ALL of Galazax's Storm Builds");
  // "applying that many stacks" (N=3) plus the passive's +1 for the damaging hit = 4.
  assert.equal(stormStacks(e), 4, "3 applied by the skill + 1 from the damaging-skill passive");
});

test("galazax4 CONTROL: with 0 stacks -> base 10 damage, target gains only the passive stack", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);
  assert.equal(stormStacks(g), 0, "precondition: no stacks");

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(e.hp, 90, "10 + 5*0 = 10 base damage");
  assert.equal(stormStacks(e), 1, "0 applied by the skill + 1 from the passive");
  assert.equal(stormStacks(g), 0, "still 0");
});

test("galazax4: damage scales with stack count (5 stacks -> 35)", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedStorm(g, 5);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(e.hp, 65, "10 + 5*5 = 35 damage");
  assert.equal(stormStacks(g), 0, "consumed");
});

test("galazax4: the '10 + 5*N' damage is NORMAL (not Piercing) — Damage Reduction applies", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedStorm(g, 2); // 10 + 5*2 = 20 raw
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 4, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax4", targets: ["e"] });
  assert.equal(e.hp, 84, "20 raw - 4 DR = 16 landed (Piercing would leave 80)");
});

// =============================================================================
// Section 6 — FUSION ACTIVE: galazax5 "Thunder Deafens"
//  "Galazax becomes untargetable and ignores all damage for 1 turn. Using this
//   skill does not interrupt Channeling."
// =============================================================================

test("galazax5: applies untargetable + damage_ignore for 1 turn", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  const unt = g.statuses.find((s) => s.kind === "untargetable");
  const ign = g.statuses.find((s) => s.kind === "damage_ignore");
  assert.ok(unt, "Galazax is untargetable");
  assert.equal(unt?.duration, 1, "for 1 turn");
  assert.ok(ign, "Galazax ignores all damage");
  assert.equal(ign?.duration, 1, "for 1 turn");
});

test("galazax5: untargetable — an enemy cannot aim a Harmful skill at Galazax", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vHit()] });
  const state = makeState([g], [e]);
  fund(state);
  fund(state, "B");

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  const r = performAction(state, { unit: "e", skillId: "vhit", targets: ["g"] });
  assert.equal(r.ok, false, "cannot target untargetable Galazax");
  assert.equal(g.hp, 100, "and no damage got through");
});

test("galazax5: ignores all damage — a DoT tick deals nothing while Thunder Deafens is up", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  // An enemy-applied DoT ticks via applyDamage (bypasses targeting), so it exercises damage_ignore.
  g.statuses.push({ kind: "dot", name: "Poison", magnitude: 10, dtype: "affliction", duration: null, appliedBy: "e", appliedTurn: 0 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] }); // g gains damage_ignore (turn 1)
  endTurn(state); // A -> B (damage_ignore born this turn, not yet decremented)
  endTurn(state); // B's turn ends -> the enemy DoT ticks; damage_ignore still up -> voided
  assert.equal(g.hp, 100, "the DoT dealt no damage — all damage ignored");
});

test("galazax5 CONTROL: without Thunder Deafens the same DoT deals its damage", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  g.statuses.push({ kind: "dot", name: "Poison", magnitude: 10, dtype: "affliction", duration: null, appliedBy: "e", appliedTurn: 0 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  endTurn(state); // A -> B
  endTurn(state); // B's turn ends -> DoT ticks, no damage_ignore
  assert.equal(g.hp, 90, "the 10 DoT landed");
});

test("galazax5: does NOT interrupt Channeling", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedChannel(g);
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 })]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax5", targets: [] });
  assert.equal(isChanneling(g), true, "the channel keeps running through Thunder Deafens");
});

// =============================================================================
// Section 7 — FUSION ACTIVE: galazax6 "The Vortex Consumes"
//  "Galazax deals 15 Piercing damage to all enemies each turn for 3 turns. This
//   skill applies an extra stack of The Storm Builds to all targets. To use this
//   skill, Galazax must consume 10 stacks of The Storm Builds from himself and must
//   be Channeling The Sky Darkens."
// =============================================================================

test("galazax6 gate: requires BOTH >=10 Storm Builds AND Channeling The Sky Darkens", () => {
  const mk = () => {
    const g = loadHero(heroById("galazax"), "A", "g");
    const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
    const state = makeState([g], [e]);
    fund(state);
    return { g, e, state };
  };

  let c = mk(); // neither condition
  assert.equal(performAction(c.state, { unit: "g", skillId: "galazax6", targets: [] }).reason, "requirements-not-met",
    "no stacks and no channel -> blocked");

  c = mk(); // stacks but no channel
  seedStorm(c.g, 10);
  assert.equal(performAction(c.state, { unit: "g", skillId: "galazax6", targets: [] }).reason, "requirements-not-met",
    "10 stacks but not Channeling -> blocked");

  c = mk(); // channel but too few stacks
  seedStorm(c.g, 9);
  seedChannel(c.g);
  assert.equal(performAction(c.state, { unit: "g", skillId: "galazax6", targets: [] }).reason, "requirements-not-met",
    "Channeling but only 9 stacks (<10) -> blocked");

  c = mk(); // both satisfied
  seedStorm(c.g, 10);
  seedChannel(c.g);
  assert.equal(performAction(c.state, { unit: "g", skillId: "galazax6", targets: [] }).ok, true,
    "10 stacks AND Channeling The Sky Darkens -> usable");
});

test("galazax6: consumes exactly 10 Storm Builds, deals 15 Piercing to all enemies now, applies an extra stack", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedStorm(g, 12);
  seedChannel(g);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax6", targets: [] });
  assert.equal(stormStacks(g), 2, "consumed exactly 10 (12 - 10)");
  assert.equal(e1.hp, 85, "15 Piercing ignores the 10 DR");
  assert.equal(e2.hp, 85, "15 Piercing to each enemy");
  // "an extra stack" (+1 from the skill) plus the passive's +1 for the damage = 2 per enemy.
  assert.equal(stormStacks(e1), 2, "extra stack (+1) + passive stack (+1)");
  assert.equal(stormStacks(e2), 2, "extra stack (+1) + passive stack (+1)");
});

test("galazax6 'each turn for 3 turns': 15 lands on cast and again on Galazax's next two turns, then stops", () => {
  const g = loadHero(heroById("galazax"), "A", "g");
  seedStorm(g, 10);
  seedChannel(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]);
  fund(state);

  performAction(state, { unit: "g", skillId: "galazax6", targets: [] });
  assert.equal(e.hp, 85, "wave 1 (immediate) = 15");

  endTurn(state); // A(turn1) -> B
  endTurn(state); // B -> A
  endTurn(state); // A(turn3) end -> wave 2 fires
  assert.equal(e.hp, 70, "wave 2 on Galazax's next turn = another 15");

  endTurn(state); // B -> A
  endTurn(state); // A(turn5) end -> wave 3 fires
  assert.equal(e.hp, 55, "wave 3 = another 15 (45 total across 3 turns)");

  endTurn(state); // B -> A
  endTurn(state); // A(turn7) end -> no wave 4
  assert.equal(e.hp, 55, "exactly 3 waves — the effect stops after 3 turns");
});
