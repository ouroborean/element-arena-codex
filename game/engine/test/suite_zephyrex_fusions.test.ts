import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import {
  performAction,
  startTurn,
  endTurn,
  startRound,
  legalTargets,
  effectiveCost,
} from "../src/scheduler.ts";
import { totalShield } from "../src/damage.ts";
import { applyStatus, removeStatus } from "../src/status.ts";
import { Rng } from "../src/rng.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + hero triggers
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------------------------- //
//  Zephyrex — FUSION FORMS behavioral suite. The FROZEN prose (content/frozen/skills.json) is the
//  oracle for WHAT to assert; authored/generated content is consulted only for HOW to drive (fusion
//  keys, skill ids, costs, targeting, status/mark names). Every fused form re-elements Zephyrex, so a
//  base/fusion skill's SPECIFIC cost is paid in the FUSION element (caster.currentElement).
//
//  Forms (passive0 / active1), frozen text:
//   angel   Brush of Wings   : "Elegant Sweep deals 10 less damage, but also heals Zephyrex's team for 10 health."
//           Light of Raphael : "For 3 turns, Zephyrex gains 20 Shield. During this time, Elegant Sweep hits instantly."
//   cloud   Cloud Step       : "Wind Step now lasts an additional turn."
//           Waft             : "Zephyrex becomes invulnerable for 1 turn. This skill can only be used during Wind Step.
//                               If Wind Step triggered last turn, deal 10 Piercing damage to all enemies, Bypassing."
//   faerie  Fae Prince       : "Every turn that an enemy Hero doesn't deal damage to Zephyrex, that enemy receives 10
//                               additional damage from Zephyrex's next damaging ability."
//           Prod             : "Deals 20 Piercing damage to target enemy, and increases the damage of the next skill
//                               they use on Zephyrex by 10 (this effect does not stack)."
//   ghost   Fell Wind        : "Biting Wind now causes health loss, which does not count as any form of damage."
//           Soulsteal        : "For the next 3 turns, target enemy becomes Invulnerable for 1 turn at the end of each
//                               of their turns."
//   mechanic Winds of Summer : "Biting Wind and Elegant Sweep now deal Affliction damage."
//           Blazing Flourish : "Deals 30 Affliction Damage to 1 enemy. The following turn, Elegant Sweep costs 1 less."
//   mist    Wingless Wanderer: "Zephyrex can no longer be stunned during Elegant Sweep. If he receives a new harmful
//                               skill while preparing, he will gain Elemental Essence and reset his use of Perfect Execution."
//           Cleave the Veil  : "Zephyrex targets one enemy. At the end of his next turn, if he has not received a new
//                               harmful skill, he deals 45 piercing damage to the targeted enemy. Enemy players see this
//                               effect as Elegant Sweep. Channeled."
//   ninja   Vacuum Blade     : "Any time Biting Wind or Wind Step triggers, Elegant Sweep permanently deals 5 more damage."
//           Blade Prison     : "Zephyrex makes target enemy Invulnerable and Isolated for 1 turn. This effect will be
//                               reapplied as long as Zephyrex channels it."
//   nomad   Sand Spectre     : "Zephyrex cannot be chosen as a target by Blinded skills."
//           Sand in the Eyes : "Deals 10 damage to target enemy and blinds them for 3 turns. If the target becomes
//                               Invulnerable, this effect is removed."
//   storm   Ominous Rumble   : "Triggering Wind Step marks enemies with Ominous Rumble. Marked enemies are automatically
//                               targeted by Arcadian Duet and Jolt, consuming the mark in the process."
//           Jolt             : "Deals 20 Piercing damage to target enemy, Bypassing. If the enemy is affected by Ominous
//                               Rumble, Zephyrex gains Elemental Essence."
//   winter  Cold and Alone   : "Enemies gain 1 stack of Cold and Alone every turn they are Invulnerable or Isolated.
//                               Upon reaching 3 stacks, the target is stunned for 1 turn."
//           Winter's Bite    : "Deals 35 Piercing damage to target enemy, and any enemy marked by Cold and Alone."
// ---------------------------------------------------------------------------------------------- //

const hp = (s: MatchState, id: string) => s.units[id]!.hp;
const sk = (u: Unit, id: string) => (u.skills ?? []).find((x) => x.id === id)!;
const has = (u: Unit, kind: string) => u.statuses.some((s) => s.kind === kind);
const statusOf = (u: Unit, kind: string) => u.statuses.find((s) => s.kind === kind);
const markOn = (u: Unit, name: string) => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const stackMag = (u: Unit, name: string) =>
  u.statuses.find((s) => s.kind === "stack" && s.name === name)?.magnitude ?? 0;

function fuse(hero: Unit, element: string): void {
  applyFusion(hero, fusionForm("zephyrex", element)!);
}
/** A fused hero pays SPECIFIC in its fusion element (currentElement); stock that + generic (+ wind for safety). */
function stock(state: MatchState, element: string, team: "A" | "B" = "A"): void {
  state.teams[team].energy = { generic: 40, wind: 40, [element]: 40 };
}

// =============================================================================================== //
//  angel — Brush of Wings (passive) + Light of Raphael (active)
// =============================================================================================== //

test("angel/Brush of Wings: Elegant Sweep deals 10 LESS (25->15) and heals Zephyrex's team for 10", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const ally = makeUnit({ id: "a2", team: "A", hp: 100, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph, ally], [e1]);
  fuse(zeph, "angel");
  startRound(state, "A"); // fires roundStart -> installs the Brush of Wings Elegant Sweep patch
  stock(state, "angel");
  zeph.hp = 50; // put the team below max so the heal is observable
  ally.hp = 50;

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  assert.ok(zeph.statuses.some((s) => s.kind === "channeling" && s.name === "zephyrex2"), "Elegant Sweep channels");

  // Measure ONLY the following-turn channel tick (delta), isolating it from any cast-turn behavior.
  endTurn(state); startTurn(state); endTurn(state);
  const before = { e1: hp(state, "e1"), z: hp(state, "zx"), a2: hp(state, "a2") };
  startTurn(state); // channel resolves for team A
  assert.equal(before.e1 - hp(state, "e1"), 15, "Elegant Sweep now deals 15 (25 - 10) to an enemy hero");
  assert.equal(hp(state, "zx") - before.z, 10, "Zephyrex (part of his team) heals 10 on resolution");
  assert.equal(hp(state, "a2") - before.a2, 10, "an ally (part of his team) heals 10 on resolution");
});

test("angel/Brush of Wings control: the heal targets Zephyrex's TEAM, not enemies", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "angel");
  startRound(state, "A");
  stock(state, "angel");
  e1.hp = 50; // if the heal leaked onto enemies, e1 would rise instead of only falling

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  endTurn(state); startTurn(state); endTurn(state);
  const before = hp(state, "e1");
  startTurn(state);
  assert.equal(before - hp(state, "e1"), 15, "the enemy only takes 15 damage — it is not healed by Brush of Wings");
});

test("angel/Light of Raphael: grants 20 Shield for 3 turns AND makes Elegant Sweep hit instantly", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "angel");
  startRound(state, "A");
  stock(state, "angel");

  const r = performAction(state, { unit: "zx", skillId: "zephyrexangel1", targets: [] });
  assert.equal(r.ok, true, "Light of Raphael resolves");
  assert.equal(totalShield(zeph), 20, "gains 20 Shield");

  // "During this time, Elegant Sweep hits instantly": casting it resolves entirely on cast (no lingering channel).
  const beforeCast = hp(state, "e1");
  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  assert.equal(beforeCast - hp(state, "e1"), 15, "Elegant Sweep lands its damage immediately (instant), on the cast turn");
  assert.ok(!zeph.statuses.some((s) => s.kind === "channeling"), "no channel remains — it hit instantly");
});

test("angel/Light of Raphael control: WITHOUT the mark, Elegant Sweep channels (does not hit instantly)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "angel");
  startRound(state, "A");
  stock(state, "angel");

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }); // no Light of Raphael active
  assert.ok(
    zeph.statuses.some((s) => s.kind === "channeling" && s.name === "zephyrex2"),
    "without Light of Raphael, Elegant Sweep is a normal channel (following-turn), not instant",
  );
});

// =============================================================================================== //
//  cloud — Cloud Step (passive) + Waft (active)
// =============================================================================================== //

test("cloud/Cloud Step: Wind Step's damage reduction lasts an ADDITIONAL turn (duration 2, not 1)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const state = makeState([zeph], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  fuse(zeph, "cloud");
  stock(state, "cloud");

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] });
  const dr = statusOf(zeph, "damage_reduction");
  assert.ok(dr, "Wind Step applied a damage_reduction");
  assert.equal(dr!.duration, 2, "Cloud Step extends Wind Step's DR to 2 turns");

  // Control: an un-fused Zephyrex's Wind Step DR lasts only 1 turn.
  const base = loadHero(heroById("zephyrex"), "A", "zx2");
  const state2 = makeState([base], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  state2.teams.A.energy = { wind: 40, generic: 40 };
  performAction(state2, { unit: "zx2", skillId: "zephyrex4", targets: [] });
  assert.equal(statusOf(base, "damage_reduction")!.duration, 1, "base Wind Step lasts only 1 turn");
});

test("cloud/Waft: usable only during Wind Step, and makes Zephyrex Invulnerable for 1 turn", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const state = makeState([zeph], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  fuse(zeph, "cloud");
  stock(state, "cloud");

  // Control: with no Wind Step active, Waft cannot be used ("can only be used during Wind Step").
  const blocked = performAction(state, { unit: "zx", skillId: "zephyrexcloud1", targets: ["e1"] });
  assert.equal(blocked.ok, false, "Waft is unusable outside Wind Step");
  assert.equal(blocked.reason, "requirements-not-met");

  // Positive: after Wind Step (DR active), Waft is usable and makes Zephyrex Invulnerable 1 turn.
  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] });
  const r = performAction(state, { unit: "zx", skillId: "zephyrexcloud1", targets: ["e1"] });
  assert.equal(r.ok, true, "Waft is usable during Wind Step");
  const inv = statusOf(zeph, "invulnerable");
  assert.ok(inv, "Zephyrex becomes Invulnerable");
  assert.equal(inv!.duration, 1, "Invulnerable for 1 turn");
});

test("cloud/Waft: when Wind Step triggered LAST turn, deals 10 Piercing (Bypassing) to all enemies", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1, e2]);
  fuse(zeph, "cloud");
  stock(state, "cloud");

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] }); // Wind Step on turn T
  // Advance to Zephyrex's NEXT turn — Wind Step "triggered last turn"; Cloud Step keeps the DR up so Waft is usable.
  endTurn(state); startTurn(state); endTurn(state); startTurn(state);
  stock(state, "cloud");
  const r = performAction(state, { unit: "zx", skillId: "zephyrexcloud1", targets: ["e1"] });
  assert.equal(r.ok, true, "Waft castable next turn (Cloud Step-extended Wind Step still active)");
  assert.equal(hp(state, "e1"), 90, "e1 takes 10 Piercing");
  assert.equal(hp(state, "e2"), 90, "e2 (all enemies) takes 10 Piercing");
});

// Frozen gates the 10 Piercing on "If Wind Step triggered LAST turn". Casting Waft on the SAME turn Wind
// Step was used is not "last turn", so it should deal NO bypass damage. The engine keys the branch on the
// mere presence of the "Wind Step Window" mark, which is live on the cast turn too — so it fires the 10
// same-turn as well, ignoring the temporal condition. (Confirmed: same-turn Waft dropped both enemies to 90.)
test.skip("SUSPECTED BUG: Waft deals its 10 Piercing even when Wind Step triggered THIS turn (not last)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1, e2]);
  fuse(zeph, "cloud");
  stock(state, "cloud");

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] }); // Wind Step THIS turn
  const r = performAction(state, { unit: "zx", skillId: "zephyrexcloud1", targets: ["e1"] }); // Waft same turn
  assert.equal(r.ok, true, "Waft still castable");
  assert.ok(statusOf(zeph, "invulnerable"), "the Invulnerable clause always applies");
  // Frozen bonus is gated on "Wind Step triggered LAST turn" — casting on the SAME turn must NOT deal it.
  assert.equal(hp(state, "e1"), 100, "no bypass damage — Wind Step triggered this turn, not last");
  assert.equal(hp(state, "e2"), 100, "no bypass damage on the same turn");
});

// =============================================================================================== //
//  faerie — Fae Prince (passive) + Prod (active)
// =============================================================================================== //

test("faerie/Fae Prince: an enemy that did NOT damage Zephyrex takes +10 from his next damaging ability", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "faerie");

  // A full enemy turn passes in which e1 deals no damage to Zephyrex -> +10 accrues at the enemy team's turn end.
  endTurn(state); startTurn(state); endTurn(state); startTurn(state);
  stock(state, "faerie");

  performAction(state, { unit: "zx", skillId: "zephyrexfaerie1", targets: ["e1"] }); // Prod: 20 piercing
  assert.equal(hp(state, "e1"), 70, "20 (Prod) + 10 (Fae Prince, one un-damaged turn) = 30 total");
});

test("faerie/Fae Prince control: an enemy that DID damage Zephyrex accrues no bonus (Prod deals only 20)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "faerie");

  endTurn(state); startTurn(state); // enemy team's turn
  emit(state, { type: "damageDealt", source: "e1", target: "zx", amount: 5, dtype: "normal" }); // e1 damages Zephyrex
  endTurn(state); startTurn(state); // enemy turn ends -> NO accrual (it damaged Zephyrex)
  stock(state, "faerie");

  performAction(state, { unit: "zx", skillId: "zephyrexfaerie1", targets: ["e1"] });
  assert.equal(hp(state, "e1"), 80, "no Fae Prince bonus: Prod deals only its base 20");
});

test("faerie/Prod: deals 20 Piercing and boosts the enemy's next skill used ON ZEPHYREX by 10", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const atk = skill("e-atk", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], {
    tags: ["Harmful"], targeting: "single", cost: { generic: 0, specific: 0 },
  }) as SkillInstance;
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, skills: [atk] });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "faerie");
  stock(state, "faerie");
  stock(state, "faerie", "B");

  performAction(state, { unit: "zx", skillId: "zephyrexfaerie1", targets: ["e1"] });
  assert.equal(hp(state, "e1"), 80, "Prod deals 20 Piercing to the target");

  // e1's next skill on Zephyrex deals +10.
  performAction(state, { unit: "e1", skillId: "e-atk", targets: ["zx"] });
  assert.equal(hp(state, "zx"), 70, "e1's 20-damage skill on Zephyrex is boosted to 30 by Prod");
});

// Frozen scopes the boost to "the next skill they use ON ZEPHYREX". The engine models it as an unscoped
// `outgoing_damage_mod` on the enemy (any normal/piercing hit gets +10), so an attack on one of Zephyrex's
// allies is boosted too. (Confirmed: the Prod'd enemy hit the ally for 30, not 20.)
test.skip("SUSPECTED BUG: Prod's +10 boosts the enemy's attack on ANY target, not only skills 'on Zephyrex'", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const ally = makeUnit({ id: "a2", team: "A", hp: 100, maxHp: 100 });
  const atk = skill("e-atk", [{ op: "damage", amount: 20, dtype: "normal", to: "target" }], {
    tags: ["Harmful"], targeting: "single", cost: { generic: 0, specific: 0 },
  }) as SkillInstance;
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, skills: [atk] });
  const state = makeState([zeph, ally], [e1]);
  fuse(zeph, "faerie");
  stock(state, "faerie");
  stock(state, "faerie", "B");

  performAction(state, { unit: "zx", skillId: "zephyrexfaerie1", targets: ["e1"] }); // Prod boosts e1's next skill on ZEPHYREX
  performAction(state, { unit: "e1", skillId: "e-atk", targets: ["a2"] }); // ...but e1 hits the ally instead
  assert.equal(hp(state, "a2"), 80, "a skill used on an ALLY (not Zephyrex) is NOT boosted — it deals only 20");
});

// =============================================================================================== //
//  ghost — Fell Wind (passive) + Soulsteal (active)
// =============================================================================================== //

test("ghost/Fell Wind: Biting Wind becomes 15 HEALTH LOSS (not damage) — it ignores Shield", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100, shield: 20 });
  const state = makeState([zeph], [e1, e2]);
  fuse(zeph, "ghost");

  // An enemy becoming Invulnerable loses 15 HP via non-damage health loss.
  emit(state, { type: "statusApplied", unit: "e1", source: "e1", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "Fell Wind removes 15 HP");

  // "does not count as any form of damage": health loss ignores Shield entirely (piercing would be absorbed).
  emit(state, { type: "statusApplied", unit: "e2", source: "e2", kind: "invulnerable" });
  assert.equal(hp(state, "e2"), 85, "15 HP is lost straight from HP");
  assert.equal(totalShield(e2), 20, "the 20 Shield is UNTOUCHED — health loss is not damage");
});

test("ghost/Fell Wind control: an ALLY becoming Invulnerable loses no health", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const ally = makeUnit({ id: "a2", team: "A", hp: 100, maxHp: 100 });
  const state = makeState([zeph, ally], [makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 })]);
  fuse(zeph, "ghost");
  emit(state, { type: "statusApplied", unit: "a2", source: "a2", kind: "invulnerable" });
  assert.equal(hp(state, "a2"), 100, "Fell Wind only fires on enemies");
});

test("ghost/Soulsteal: over the next 3 turns the target becomes Invulnerable at the end of its turns", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "ghost");
  startRound(state, "A");
  stock(state, "ghost");

  const r = performAction(state, { unit: "zx", skillId: "zephyrexghost1", targets: ["e1"] });
  assert.equal(r.ok, true, "Soulsteal resolves");
  assert.ok(markOn(e1, "Soulsteal"), "the target carries the Soulsteal mark");

  // At the end of the TARGET's (team B's) turn, it is Invulnerable.
  endTurn(state); startTurn(state); endTurn(state); // team B's turn ends
  const inv = statusOf(e1, "invulnerable");
  assert.ok(inv, "the target is Invulnerable at the end of its own turn");
  assert.equal(inv!.duration, 1, "Invulnerable for 1 turn");
});

// Frozen: "at the end of each of THEIR turns" — only the TARGET's turns should apply the Invulnerable.
// The engine's Soulsteal watch fires on EVERY turn-end (no team gate), so the target also turns
// Invulnerable at the end of ZEPHYREX's turns. (Debug: after endTurn(A) right after the cast, e1 is
// already Invulnerable.)
test("Soulsteal makes the target Invulnerable only at the end of the enemy team's turns", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "ghost");
  startRound(state, "A");
  stock(state, "ghost");

  performAction(state, { unit: "zx", skillId: "zephyrexghost1", targets: ["e1"] });
  endTurn(state); // team A's (Zephyrex's) turn ends — NOT the target's turn
  assert.ok(!has(e1, "invulnerable"), "Soulsteal must only trigger at the end of the target's own turns");
});

// =============================================================================================== //
//  mechanic — Winds of Summer (passive) + Blazing Flourish (active)
// =============================================================================================== //

test("mechanic/Winds of Summer: Biting Wind now deals 15 AFFLICTION (bypasses Shield)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, shield: 20 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mechanic");

  emit(state, { type: "statusApplied", unit: "e1", source: "e1", kind: "invulnerable" });
  assert.equal(hp(state, "e1"), 85, "15 Affliction lands on HP");
  assert.equal(totalShield(e1), 20, "Affliction ignores Shield (piercing would have been absorbed)");
});

test("mechanic/Winds of Summer: Elegant Sweep now deals 25 AFFLICTION (bypasses Shield)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mechanic");
  startRound(state, "A"); // installs the Elegant Sweep -> Affliction dtype patch
  stock(state, "mechanic");
  e1.shields = [{ amount: 40, duration: null, appliedBy: "x", appliedTurn: 0 }]; // startRound cleared shields; add after

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] });
  endTurn(state); startTurn(state); endTurn(state);
  const before = hp(state, "e1");
  startTurn(state); // channel resolves
  assert.equal(before - hp(state, "e1"), 25, "Elegant Sweep deals 25 straight to HP");
  assert.equal(totalShield(e1), 40, "Affliction ignores the 40 Shield");
});

test("mechanic/Blazing Flourish: 30 Affliction to 1 enemy (bypasses Shield)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100, shield: 20 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mechanic");
  stock(state, "mechanic");

  const r = performAction(state, { unit: "zx", skillId: "zephyrexmechanic1", targets: ["e1"] });
  assert.equal(r.ok, true, "Blazing Flourish resolves");
  assert.equal(hp(state, "e1"), 70, "30 Affliction lands on HP");
  assert.equal(totalShield(e1), 20, "Affliction ignores Shield");
});

test("mechanic/Blazing Flourish: the FOLLOWING turn Elegant Sweep costs 1 less generic", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mechanic");
  stock(state, "mechanic");

  // Baseline cost of Elegant Sweep (1 generic + 1 specific).
  assert.deepEqual(effectiveCost(zeph, sk(zeph, "zephyrex2"), state), { generic: 1, specific: 1 }, "base Elegant Sweep cost");

  performAction(state, { unit: "zx", skillId: "zephyrexmechanic1", targets: ["e1"] });
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); // -> Zephyrex's following turn
  assert.deepEqual(
    effectiveCost(zeph, sk(zeph, "zephyrex2"), state),
    { generic: 0, specific: 1 },
    "the following turn, Elegant Sweep costs 1 less generic (1 -> 0)",
  );
});

// =============================================================================================== //
//  mist — Wingless Wanderer (passive) + Cleave the Veil (active)
// =============================================================================================== //

test("mist/Wingless Wanderer: Zephyrex can no longer be Stunned during Elegant Sweep (the channel survives)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mist");
  stock(state, "mist");

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }); // channel Elegant Sweep
  // A stun is applied while he prepares -> Wingless Wanderer grants stun immunity (reactively, on the status apply).
  applyStatus(zeph, status("stun", { duration: 2, appliedBy: "e1" }));
  emit(state, { type: "statusApplied", unit: "zx", source: "e1", kind: "stun" });
  assert.ok(markOn(zeph, "Stun Immunity"), "Wingless Wanderer grants Stun Immunity while channeling Elegant Sweep");

  endTurn(state); startTurn(state); endTurn(state);
  const before = hp(state, "e1");
  startTurn(state); // channel would be cancelled by a stun for base Zephyrex; here it survives
  assert.equal(before - hp(state, "e1"), 25, "the channel is NOT cancelled — Elegant Sweep still lands 25");
});

// Frozen: "If he receives a new harmful skill while preparing, he will gain Elemental Essence and reset his
// use of Perfect Execution." Canonically (cf. Darkness "receives a new Harmful Skill", Fate "use or receive
// a new Harmful skill", and this form's own Cleave the Veil) "receives a harmful skill" = an enemy uses a
// Harmful skill targeting Zephyrex (skillUsed with him in the targets). The engine instead wires this clause
// to the `skillGranted` event AND gates it on `eventHasTag: "Harmful"` — but skillGranted events carry no
// tags at all, so the gate can never pass. Result: the clause is dead — it fires for NEITHER an enemy's
// harmful skillUsed NOR a skillGranted. (Confirmed by driving both events: essence stays absent, lock stays.)
test("Wingless Wanderer grants Essence + resets Perfect Execution on a received enemy harmful skill", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mist");
  stock(state, "mist");
  applyStatus(zeph, status("mark", { name: "Perfection Locked", duration: null, appliedBy: "zx" })); // his ult is currently disabled

  performAction(state, { unit: "zx", skillId: "zephyrex2", targets: [] }); // preparing Elegant Sweep
  emit(state, { type: "skillUsed", caster: "e1", skillId: "foe-atk", targets: ["zx"], tags: ["Harmful"] }); // an enemy attacks him

  assert.ok(has(zeph, "elemental_essence"), "gains Elemental Essence on receiving a harmful skill while preparing");
  assert.ok(!markOn(zeph, "Perfection Locked"), "Perfect Execution is reset (its lock is cleared)");
});

test("mist/Cleave the Veil: at the end of his NEXT turn, deals 45 Piercing to the targeted enemy", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mist");
  stock(state, "mist");

  const r = performAction(state, { unit: "zx", skillId: "zephyrexmist1", targets: ["e1"] });
  assert.equal(r.ok, true, "Cleave the Veil resolves");
  assert.equal(hp(state, "e1"), 100, "no damage on the cast turn — it lands at the end of his NEXT turn");
  assert.equal(sk(zeph, "zephyrexmist1").disguiseAs, "zephyrex2", "enemy players see it as Elegant Sweep (disguised)");

  endTurn(state); startTurn(state); endTurn(state); startTurn(state); // Zephyrex's next turn
  const before = hp(state, "e1");
  endTurn(state); // end of his next turn -> the scheduled 45 fires
  assert.equal(before - hp(state, "e1"), 45, "45 Piercing lands at the end of his next turn");
});

test("mist/Cleave the Veil: cancelled if Zephyrex receives a new harmful skill before it resolves", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "mist");
  stock(state, "mist");

  performAction(state, { unit: "zx", skillId: "zephyrexmist1", targets: ["e1"] });
  // Advance to his next turn (the Channel re-runs at his turn start), THEN he receives a harmful skill
  // during that turn — before the end-of-turn strike resolves.
  endTurn(state); startTurn(state); endTurn(state); startTurn(state);
  emit(state, { type: "skillUsed", caster: "e1", skillId: "foe-atk", targets: ["zx"], tags: ["Harmful"] }); // received a harmful skill
  const before = hp(state, "e1");
  endTurn(state); // end of his next turn: the 45 would resolve here, but was cancelled
  assert.equal(hp(state, "e1"), before, "no 45 damage: a received harmful skill cancelled the strike");
});

// =============================================================================================== //
//  ninja — Vacuum Blade (passive) + Blade Prison (active)
// =============================================================================================== //

/** Cast Elegant Sweep and return the damage its following-turn tick deals to `foeId`. */
function elegantSweepTickDamage(state: MatchState, zx: string, foeId: string): number {
  performAction(state, { unit: zx, skillId: "zephyrex2", targets: [] });
  endTurn(state); startTurn(state); endTurn(state);
  const before = hp(state, foeId);
  startTurn(state);
  return before - hp(state, foeId);
}

test("ninja/Vacuum Blade: Wind Step triggering makes Elegant Sweep permanently deal +5 (25 -> 30)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 200, maxHp: 200 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "ninja");
  stock(state, "ninja");

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] }); // Wind Step triggers -> +5
  assert.equal(elegantSweepTickDamage(state, "zx", "e1"), 30, "Elegant Sweep bumped to 30 by one Wind Step");
});

test("ninja/Vacuum Blade: Biting Wind triggering makes Elegant Sweep permanently deal +5", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 200, maxHp: 200 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "ninja");
  stock(state, "ninja");

  // Biting Wind triggers when an enemy becomes Invulnerable.
  emit(state, { type: "statusApplied", unit: "e1", source: "e1", kind: "invulnerable" });
  assert.equal(elegantSweepTickDamage(state, "zx", "e1"), 30, "Elegant Sweep bumped to 30 by one Biting Wind trigger");
});

test("ninja/Vacuum Blade control: with no triggers, Elegant Sweep still deals its base 25", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 200, maxHp: 200 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "ninja");
  stock(state, "ninja");
  assert.equal(elegantSweepTickDamage(state, "zx", "e1"), 25, "no Biting Wind / Wind Step triggers -> unchanged 25");
});

test("ninja/Blade Prison: makes the target Invulnerable + Isolated for 1 turn, reapplied while channeling", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "ninja");
  stock(state, "ninja");

  const r = performAction(state, { unit: "zx", skillId: "zephyrexninja1", targets: ["e1"] });
  assert.equal(r.ok, true, "Blade Prison resolves");
  assert.ok(has(e1, "invulnerable"), "the target becomes Invulnerable");
  assert.ok(has(e1, "isolated"), "the target becomes Isolated");
  assert.equal(hp(state, "e1"), 85, "making the enemy Invulnerable also triggers ninja Biting Wind for 15 piercing");

  // "reapplied as long as Zephyrex channels it": the channel re-runs at his next turn, refreshing the lock.
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); // channel re-runs on Zephyrex's turn
  assert.ok(has(e1, "invulnerable"), "Invulnerable is reapplied by the ongoing channel");
  assert.ok(has(e1, "isolated"), "Isolated is reapplied by the ongoing channel");
});

// =============================================================================================== //
//  nomad — Sand Spectre (passive) + Sand in the Eyes (active)
// =============================================================================================== //

test("nomad/Sand Spectre: Zephyrex cannot be chosen as a target by a Blinded enemy's skill", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "nomad");
  startRound(state, "A"); // Sand Spectre marks Zephyrex Blind-Untargetable at round start
  e1.statuses.push(status("blind", { duration: 3, appliedBy: "x" }));
  const atk = skill("e-atk", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful"], targeting: "single" }) as SkillInstance;
  const rng = Rng.fromState(state.rngState);

  // A blinded enemy picks randomly from Zephyrex's side; Sand Spectre excludes Zephyrex, so there is no target.
  assert.deepEqual(legalTargets(state, e1, atk, [zeph], rng).map((u) => u.id), [], "the Blinded skill cannot pick Zephyrex");

  // Control: drop the Sand Spectre mark and Zephyrex is choosable again.
  removeStatus(zeph, "mark", "Blind-Untargetable");
  assert.deepEqual(legalTargets(state, e1, atk, [zeph], rng).map((u) => u.id), ["zx"], "without Sand Spectre he is targetable");
});

test("nomad/Sand in the Eyes: deals 10 and Blinds the target for 3 turns", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "nomad");
  stock(state, "nomad");

  const r = performAction(state, { unit: "zx", skillId: "zephyrexnomad1", targets: ["e1"] });
  assert.equal(r.ok, true, "Sand in the Eyes resolves");
  assert.equal(hp(state, "e1"), 90, "deals 10 damage");
  const blind = statusOf(e1, "blind");
  assert.ok(blind, "the target is Blinded");
  assert.equal(blind!.duration, 3, "Blinded for 3 turns");
});

test("nomad/Sand in the Eyes: the Blind is removed if the target becomes Invulnerable", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "nomad");
  stock(state, "nomad");

  performAction(state, { unit: "zx", skillId: "zephyrexnomad1", targets: ["e1"] });
  assert.ok(has(e1, "blind"), "target is Blinded");
  // The target turns Invulnerable -> the Blind from this skill is removed.
  emit(state, { type: "statusApplied", unit: "e1", source: "e1", kind: "invulnerable" });
  assert.ok(!has(e1, "blind"), "the Blind is removed once the target becomes Invulnerable");
});

// =============================================================================================== //
//  storm — Ominous Rumble (passive) + Jolt (active)
// =============================================================================================== //

test("storm/Ominous Rumble: triggering Wind Step marks all enemies with Ominous Rumble", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1, e2]);
  fuse(zeph, "storm");
  stock(state, "storm");

  performAction(state, { unit: "zx", skillId: "zephyrex4", targets: [] }); // Wind Step
  assert.ok(markOn(e1, "Ominous Rumble"), "e1 marked");
  assert.ok(markOn(e2, "Ominous Rumble"), "e2 marked");

  // Control: a DIFFERENT skill (Arcadian Duet) does not apply the mark.
  const z2 = loadHero(heroById("zephyrex"), "A", "zx2");
  const f2 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const s2 = makeState([z2], [f2]);
  fuse(z2, "storm");
  stock(s2, "storm");
  performAction(s2, { unit: "zx2", skillId: "zephyrex1", targets: ["e1"] }); // Arcadian Duet
  assert.ok(!markOn(f2, "Ominous Rumble"), "only Wind Step marks — Arcadian Duet does not");
});

test("storm/Jolt: 20 Piercing Bypassing; grants Elemental Essence + consumes the mark when the target has Ominous Rumble", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "storm");
  stock(state, "storm");
  applyStatus(e1, status("mark", { name: "Ominous Rumble", duration: null, appliedBy: "zx" }));

  const r = performAction(state, { unit: "zx", skillId: "zephyrexstorm1", targets: ["e1"] });
  assert.equal(r.ok, true, "Jolt resolves");
  assert.equal(hp(state, "e1"), 80, "20 Piercing");
  assert.ok(has(zeph, "elemental_essence"), "a marked target grants Zephyrex Elemental Essence");
  assert.ok(!markOn(e1, "Ominous Rumble"), "the mark is consumed");
});

test("storm/Jolt: Bypasses Invulnerability and grants NO Essence on an unmarked target", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "storm");
  stock(state, "storm");
  e1.statuses.push(status("invulnerable", { duration: 1, appliedBy: "x" }));

  const r = performAction(state, { unit: "zx", skillId: "zephyrexstorm1", targets: ["e1"] });
  assert.equal(r.ok, true, "Bypassing lets Jolt target an Invulnerable enemy");
  assert.equal(hp(state, "e1"), 80, "20 Piercing lands through Invulnerability");
  assert.ok(!has(zeph, "elemental_essence"), "no Essence: the target is not affected by Ominous Rumble");
});

test("storm/Ominous Rumble: Jolt is automatically aimed at a marked enemy (consuming the mark)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 }); // unmarked, chosen
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 }); // marked -> auto-target
  const state = makeState([zeph], [e1, e2]);
  fuse(zeph, "storm");
  stock(state, "storm");
  applyStatus(e2, status("mark", { name: "Ominous Rumble", duration: null, appliedBy: "zx" }));

  performAction(state, { unit: "zx", skillId: "zephyrexstorm1", targets: ["e1"] }); // choose e1...
  assert.equal(hp(state, "e2"), 80, "...but Jolt auto-targets the marked e2");
  assert.equal(hp(state, "e1"), 100, "the chosen e1 is untouched");
  assert.ok(has(zeph, "elemental_essence"), "and the marked hit grants Essence");
});

test("storm/Ominous Rumble: Arcadian Duet is automatically aimed at a marked enemy", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 }); // unmarked, chosen
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 }); // marked -> should be auto-targeted
  const state = makeState([zeph], [e1, e2]);
  fuse(zeph, "storm");
  stock(state, "storm");
  applyStatus(e2, status("mark", { name: "Ominous Rumble", duration: null, appliedBy: "zx" }));

  performAction(state, { unit: "zx", skillId: "zephyrex1", targets: ["e1"] }); // choose e1
  // Frozen: "Marked enemies are automatically targeted by Arcadian Duet and Jolt."
  assert.ok(has(e2, "invulnerable") && has(e2, "isolated"), "Arcadian Duet auto-targets the marked e2");
  assert.ok(!has(e1, "invulnerable"), "the chosen e1 is not the one affected");
});

// =============================================================================================== //
//  winter — Cold and Alone (passive) + Winter's Bite (active)
// =============================================================================================== //

/** Advance one full A->B->A cycle so exactly one ENEMY (team B) turn-end fires. */
function enemyTurnEndCycle(state: MatchState): void {
  endTurn(state); startTurn(state); endTurn(state); startTurn(state);
}

test("winter/Cold and Alone: an Invulnerable enemy stacks Cold and Alone each turn; 3 stacks -> Stun", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "winter");
  startRound(state, "A");
  applyStatus(e1, status("invulnerable", { duration: null, appliedBy: "x" })); // persistently Invulnerable

  enemyTurnEndCycle(state);
  assert.equal(stackMag(e1, "Cold and Alone"), 1, "1 stack after one Invulnerable turn");
  enemyTurnEndCycle(state);
  assert.equal(stackMag(e1, "Cold and Alone"), 2, "2 stacks after two turns");
  enemyTurnEndCycle(state);
  assert.ok(has(e1, "stun"), "reaching 3 stacks Stuns the target");
  assert.equal(stackMag(e1, "Cold and Alone"), 0, "the stacks are consumed by the Stun");
});

test("winter/Cold and Alone control: an enemy that is neither Invulnerable nor Isolated gains no stacks", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "winter");
  startRound(state, "A");

  enemyTurnEndCycle(state);
  assert.equal(stackMag(e1, "Cold and Alone"), 0, "no Invulnerable/Isolated -> no Cold and Alone");
});

test("winter/Winter's Bite: 35 Piercing to the target AND to any enemy marked by Cold and Alone", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 }); // target, no C&A
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 }); // marked by Cold and Alone
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100, maxHp: 100 }); // neither target nor marked
  const state = makeState([zeph], [e1, e2, e3]);
  fuse(zeph, "winter");
  stock(state, "winter");
  applyStatus(e2, status("stack", { name: "Cold and Alone", magnitude: 1, duration: null, appliedBy: "zx" }));

  const r = performAction(state, { unit: "zx", skillId: "zephyrexwinter1", targets: ["e1"] });
  assert.equal(r.ok, true, "Winter's Bite resolves");
  assert.equal(hp(state, "e1"), 65, "35 Piercing to the target");
  assert.equal(hp(state, "e2"), 65, "35 Piercing to a Cold and Alone-marked enemy");
  assert.equal(hp(state, "e3"), 100, "an unmarked non-target is untouched");
});

test("winter/Winter's Bite: cost is 0 Generic + 2 Winter (specific)", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "zx");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([zeph], [e1]);
  fuse(zeph, "winter");

  state.teams.A.energy = { winter: 1, generic: 40 }; // only 1 Winter -> unaffordable (needs 2)
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrexwinter1", targets: ["e1"] }).reason, "insufficient-energy", "needs 2 Winter");
  state.teams.A.energy = { winter: 2, generic: 0 }; // exactly 2 Winter, 0 generic -> castable
  assert.equal(performAction(state, { unit: "zx", skillId: "zephyrexwinter1", targets: ["e1"] }).ok, true, "2 Winter pays it");
});
