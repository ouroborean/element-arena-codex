import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { performAction, canUse } from "../src/scheduler.ts";
import { applyDamage } from "../src/damage.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import type { Status, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Adversarial, FROZEN-PROSE-derived suite for Laria's AUGMENTS.
// Oracle = ../content/frozen/augments.json (laria1..laria5). Element: shadow.
//
//  laria1 Darkest Hour: "If the target of Nightwrap has 4 Stacks of Deepening
//    Shadows, they become Invulnerable if they are an ally or Stunned if they
//    are an enemy. Effect lasts 1 turn."
//  laria2 Noble Thief: "If Laria uses Nightwrap on a target without Elemental
//    Essence, she gives them Elemental Essence if they are an ally, and
//    generates a Generic energy if they are an enemy."
//  laria3 Nightblade: "Nightwrap now counts stacks of Deepening Shadows on Laria
//    if she is using it on an enemy."
//  laria4 Nightwalker: "Characters with 3 or more stacks of Deepening Shadows
//    Bypass."
//  laria5 Vanishing Powder: "When a character receives their 3rd stack of
//    Deepening Shadows, they gain the effects of Vanish."
//
// Base Nightwrap (laria1 skill, frozen skills.json): "Deals 10 damage to target
//    enemy or heals target ally 10 HP, increased by 5 for each stack of
//    Deepening Shadows on them. If the target has Elemental Essence, Laria gains
//    Elemental Essence. Places one stack of Deepening Shadows on the target."
// Base Vanish (laria4 skill): "Laria gains 15 Damage Reduction for 3 turns, or
//    until she uses a new skill."
// ---------------------------------------------------------------------------

const DS = "Deepening Shadows";
const dsCount = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === DS)?.magnitude ?? 0;
const dsStatus = (n: number): Status => ({
  kind: "stack", name: DS, magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0,
});
const essence = (): Status => ({
  kind: "elemental_essence", duration: null, appliedBy: "seed", appliedTurn: 0,
});
const drStatus = (n: number): Status => ({
  kind: "damage_reduction", magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0,
});
const hasKind = (u: Unit, kind: string): boolean => u.statuses.some((s) => s.kind === kind);
const statusOf = (u: Unit, kind: string): Status | undefined => u.statuses.find((s) => s.kind === kind);
const vanishDR = (u: Unit): Status | undefined =>
  u.statuses.find((s) => s.kind === "damage_reduction" && s.name === "Vanish");
const hasBypass = (u: Unit): boolean =>
  u.statuses.some((s) => s.kind === "conditional_bypass" && s.name === "Bypass");

const resetNightwrap = (u: Unit): void => {
  u.skills!.find((s) => s.id === "laria1")!.currentCd = 0;
};

function fund(state: ReturnType<typeof makeState>, team: "A" | "B" = "A"): void {
  state.teams[team].energy = { generic: 40, shadow: 40 };
}

// ===========================================================================
// laria1 — Darkest Hour
//   "If the target of Nightwrap has 4 Stacks of Deepening Shadows, they become
//    Invulnerable if they are an ally or Stunned if they are an enemy. Effect
//    lasts 1 turn."
// ===========================================================================

test("laria1 Darkest Hour: an ENEMY at 4+ Deepening Shadows is Stunned (not Invulnerable) for 1 turn", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria1")!);
  const e4 = makeUnit({ id: "e4", team: "B", hp: 100, statuses: [dsStatus(4)] });
  const state = makeState([laria], [e4]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e4"] });
  assert.ok(r.ok, "Nightwrap resolves on the 4-stack enemy");
  assert.ok(dsCount(e4) >= 4, "target holds >=4 Deepening Shadows at the augment check");

  const stun = statusOf(e4, "stun");
  assert.ok(stun, "4-stack ENEMY becomes Stunned");
  assert.equal(stun!.duration, 1, "Stun lasts 1 turn");
  assert.equal(hasKind(e4, "invulnerable"), false, "an enemy is Stunned, NOT made Invulnerable");
});

test("laria1 Darkest Hour: an ALLY at 4+ Deepening Shadows becomes Invulnerable (not Stunned) for 1 turn", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria1")!);
  const a4 = makeUnit({ id: "a4", team: "A", hp: 100, maxHp: 100, statuses: [dsStatus(4)] });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, a4], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a4"] });
  assert.ok(r.ok, "Nightwrap resolves on the 4-stack ally");
  assert.ok(dsCount(a4) >= 4, "ally holds >=4 Deepening Shadows at the augment check");

  const inv = statusOf(a4, "invulnerable");
  assert.ok(inv, "4-stack ALLY becomes Invulnerable");
  assert.equal(inv!.duration, 1, "Invulnerable lasts 1 turn");
  assert.equal(hasKind(a4, "stun"), false, "an ally is Invulnerable, NOT Stunned");
});

test("laria1 Darkest Hour: reaching 4 stacks via Nightwrap's own placed stack triggers (enemy 3 -> 4)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria1")!);
  // Enemy has 3 stacks; Nightwrap places its own +1 -> the target now HAS 4 stacks.
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100, statuses: [dsStatus(3)] });
  const state = makeState([laria], [e3]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e3"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(dsCount(e3), 4, "target has exactly 4 Deepening Shadows (3 seeded + 1 placed)");
  assert.ok(statusOf(e3, "stun"), "target with 4 stacks is Stunned");
});

test("laria1 Darkest Hour: control — a target below 4 stacks gets NEITHER Stun nor Invulnerable", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria1")!);
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100 }); // 0 -> 1 after Nightwrap
  const a2 = makeUnit({ id: "a2", team: "A", hp: 100, maxHp: 100, statuses: [dsStatus(2)] }); // 2 -> 3 after Nightwrap
  const state = makeState([laria, a2], [e0]);
  fund(state);

  const rE = performAction(state, { unit: "la", skillId: "laria1", targets: ["e0"] });
  assert.ok(rE.ok, "Nightwrap resolves on e0");
  assert.equal(dsCount(e0), 1, "enemy only reaches 1 stack");
  assert.equal(hasKind(e0, "stun"), false, "1-stack enemy is NOT Stunned");

  resetNightwrap(laria);
  const rA = performAction(state, { unit: "la", skillId: "laria1", targets: ["a2"] });
  assert.ok(rA.ok, "Nightwrap resolves on a2");
  assert.equal(dsCount(a2), 3, "ally only reaches 3 stacks");
  assert.equal(hasKind(a2, "invulnerable"), false, "3-stack ally is NOT Invulnerable (needs 4)");
});

test("laria1 Darkest Hour: the Stun functionally prevents the enemy from using a skill", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria1")!);
  // Enemy is a real hero (so it owns castable skills) seeded at 4 stacks.
  const foe = loadHero(heroById("laria"), "B", "foe");
  foe.statuses = [dsStatus(4)];
  const state = makeState([laria], [foe]);
  fund(state, "A");
  fund(state, "B");

  const foeNightwrap = foe.skills!.find((s) => s.id === "laria1")!;
  assert.equal(canUse(state, foe, foeNightwrap), true, "before the Stun, the enemy could use Nightwrap");

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["foe"] });
  assert.ok(r.ok, "Nightwrap resolves and Stuns the 4-stack enemy");
  assert.ok(statusOf(foe, "stun"), "enemy is Stunned");

  assert.equal(canUse(state, foe, foeNightwrap), false, "a Stunned enemy cannot use a skill");
  const blocked = performAction(state, { unit: "foe", skillId: "laria1", targets: ["la"] });
  assert.equal(blocked.ok, false, "the Stunned enemy's action is rejected");
  assert.equal(blocked.reason, "stunned", "…with reason 'stunned'");
});

test("laria1 Darkest Hour: the ally's Invulnerable functionally blocks an incoming harmful skill", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria1")!);
  const a4 = makeUnit({ id: "a4", team: "A", hp: 100, maxHp: 100, statuses: [dsStatus(4)] });
  const foe = loadHero(heroById("laria"), "B", "foe");
  const state = makeState([laria, a4], [foe]);
  fund(state, "A");
  fund(state, "B");

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a4"] });
  assert.ok(r.ok, "Nightwrap resolves and makes the 4-stack ally Invulnerable");
  assert.ok(statusOf(a4, "invulnerable"), "ally is Invulnerable");

  // A harmful enemy Nightwrap cannot land on the Invulnerable ally...
  const onInv = performAction(state, { unit: "foe", skillId: "laria1", targets: ["a4"] });
  assert.equal(onInv.ok, false, "harmful skill cannot target the Invulnerable ally");
  assert.equal(a4.hp, 100, "the Invulnerable ally took no damage");

  // ...but the same skill CAN land on a non-Invulnerable team-A member (control).
  const onLaria = performAction(state, { unit: "foe", skillId: "laria1", targets: ["la"] });
  assert.ok(onLaria.ok, "the enemy CAN target the non-Invulnerable Laria");
});

// ===========================================================================
// laria2 — Noble Thief
//   "If Laria uses Nightwrap on a target without Elemental Essence, she gives
//    them Elemental Essence if they are an ally, and generates a Generic energy
//    if they are an enemy."
// ===========================================================================

test("laria2 Noble Thief: Nightwrap on an ALLY without Elemental Essence gives THAT ALLY Elemental Essence", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria2")!);
  // A NON-middle (slot 2), chargeless ally is genuinely WITHOUT Elemental Essence — a middle-slot hero always
  // HAS it (income/glow), so it would take the base "target has essence" branch instead.
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 100, slot: 2 });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, ally], [enemy]);
  fund(state);

  assert.equal(hasKind(ally, "elemental_essence"), false, "ally has no essence beforehand");
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a1"] });
  assert.ok(r.ok, "Nightwrap resolves on the ally");
  assert.equal(hasKind(ally, "elemental_essence"), true, "the ally is GIVEN Elemental Essence");
  // Base branch does not fire (the ally had no essence), so Laria gains none here.
  assert.equal(hasKind(laria, "elemental_essence"), false, "Laria gains no essence from an essence-less ally");
});

test("laria2 Noble Thief: Nightwrap on an ENEMY without Elemental Essence generates 1 Generic energy for Laria's team", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria2")!);
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 }); // no essence
  const state = makeState([laria], [enemy]);
  fund(state); // generic 40; Nightwrap costs 1 generic

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves on the enemy");
  // 40 - 1 (cost) + 1 (Noble Thief generates a Generic) = 40.
  assert.equal(state.teams.A.energy.generic, 40, "net +1 Generic vs the plain cost (a Generic was generated)");
  // The energy went to Laria's team, not the enemy target — enemy gets nothing helpful.
  assert.equal(hasKind(enemy, "elemental_essence"), false, "the enemy is NOT given Elemental Essence");
});

test("laria2 Noble Thief: control — a target that ALREADY HAS Elemental Essence triggers neither branch", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria2")!);
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [essence()] }); // HAS essence
  const state = makeState([laria], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  // Noble Thief does NOT fire (target already has essence): only the plain -1 cost applies.
  assert.equal(state.teams.A.energy.generic, 39, "no extra Generic generated when the enemy already had essence");
  // Base Nightwrap still steals essence for Laria because the target HAD it.
  assert.equal(hasKind(laria, "elemental_essence"), true, "Laria steals essence from an essence-bearing target (base clause)");
});

test("laria2 Noble Thief: control — an ally that ALREADY HAS essence is not re-given it, and no Generic is generated", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria2")!);
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 100, statuses: [essence()] });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, ally], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a1"] });
  assert.ok(r.ok, "Nightwrap resolves on the essence-bearing ally");
  assert.equal(state.teams.A.energy.generic, 39, "ally branch never generates Generic energy");
});

// ===========================================================================
// laria3 — Nightblade
//   "Nightwrap now counts stacks of Deepening Shadows on Laria if she is using
//    it on an enemy."
// ===========================================================================

test("laria3 Nightblade: enemy Nightwrap damage scales on LARIA's Deepening Shadows, not the target's", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  laria.statuses = [dsStatus(2)]; // Laria holds 2 stacks
  applyAugment(laria, augmentById("laria3")!);
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 }); // enemy holds 0 stacks
  const state = makeState([laria], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves on the enemy");
  // 10 + 5 * (Laria's 2 stacks) = 20. If it read the enemy's 0 stacks it would be only 10.
  assert.equal(enemy.hp, 80, "enemy takes 10 + 5*2 = 20 (scaled on Laria's stacks)");
  assert.equal(dsCount(enemy), 1, "the +1 Deepening Shadows on the target is unchanged");
  assert.equal(dsCount(laria), 2, "Laria's own stacks are unchanged by Nightwrap");
});

test("laria3 Nightblade: proof it reads Laria — Laria(1) vs enemy(5) deals 15, not 35", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  laria.statuses = [dsStatus(1)]; // Laria: 1 stack
  applyAugment(laria, augmentById("laria3")!);
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [dsStatus(5)] }); // enemy: 5 stacks
  const state = makeState([laria], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  // 10 + 5 * (Laria's 1) = 15. Reading the enemy's 5 would be 10 + 25 = 35.
  assert.equal(enemy.hp, 85, "damage is 15 (Laria's 1 stack), NOT 35 (enemy's 5 stacks)");
});

test("laria3 Nightblade: the ALLY branch is unchanged — heal still scales on the TARGET's stacks", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  laria.statuses = [dsStatus(3)]; // Laria: 3 stacks (must NOT be read for an ally heal)
  applyAugment(laria, augmentById("laria3")!);
  const ally = makeUnit({ id: "a1", team: "A", hp: 50, maxHp: 100, statuses: [dsStatus(1)] }); // ally: 1 stack
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, ally], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a1"] });
  assert.ok(r.ok, "Nightwrap resolves on the ally");
  // Heal = 10 + 5 * (ally's 1 stack) = 15. Reading Laria's 3 would be 25.
  assert.equal(ally.hp, 65, "ally healed 15 (target's 1 stack), NOT 25 (Laria's 3 stacks)");
});

test("laria3 Nightblade: the essence-steal clause survives the skill rewrite", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria3")!);
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [essence()] });
  const state = makeState([laria], [enemy]);
  fund(state);

  assert.equal(hasKind(laria, "elemental_essence"), false, "Laria has no essence beforehand");
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(hasKind(laria, "elemental_essence"), true, "Laria still steals essence from an essence-bearing target");
});

// ===========================================================================
// laria4 — Nightwalker
//   "Characters with 3 or more stacks of Deepening Shadows Bypass."
//   Bypass = the holder's outgoing damage ignores Damage Reduction (and Shield).
// ===========================================================================

// SUSPECTED BUG: frozen Nightwalker says "Characters with 3 or more stacks of Deepening Shadows Bypass",
// so a character that reaches 3 stacks through normal play (Nightwrap places a Deepening Shadows stack)
// should immediately Bypass. The laria4 augment implements this reactively via an `on: statusApplied`
// trigger, but Nightwrap places the stack with the `addStack` effect op, and `addStack`
// (effects/interpret.ts:566) calls the applyStatus HELPER without emitting a `statusApplied` event — only
// the `applyStatus` EFFECT op (line 535) emits one. So reaching 3 Deepening Shadows via any real
// stack-placing skill never grants the Bypass mark. (Probe: after Nightwrap-on-self to 3 stacks,
// hasBypass=false; manually emitting statusApplied then flips it to true — proving the emission gap is the
// sole cause. The cov test only ever fires the trigger via a hand-rolled emit(), hiding this.)
test("laria4 Nightwalker: reaching 3+ Deepening Shadows via Nightwrap grants Bypass (addStack emits statusApplied)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria4")!);
  laria.statuses = [dsStatus(2)]; // 2 stacks -> not yet Bypassing
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [drStatus(20)] }); // heavy DR
  const state = makeState([laria], [enemy]);
  fund(state);

  assert.equal(hasBypass(laria), false, "at 2 stacks Laria does not Bypass");

  // Push Laria to her 3rd stack via a real stack application (Nightwrap on herself).
  performAction(state, { unit: "la", skillId: "laria1", targets: ["la"] });
  assert.equal(dsCount(laria), 3, "Laria now holds 3 Deepening Shadows");
  assert.equal(hasBypass(laria), true, "reaching 3 stacks grants the Bypass mark");

  // Now her Nightwrap damage ignores the enemy's 20 DR.
  resetNightwrap(laria);
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves on the DR enemy");
  // Base damage 10 (enemy has 0 stacks) — with Bypass it lands in full despite 20 DR.
  assert.equal(enemy.hp, 90, "10 damage Bypasses the 20 DR -> full 10 to HP");
});

test("laria4 Nightwalker: control — a character with only 2 Deepening Shadows does NOT Bypass (DR absorbs the hit)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria4")!);
  laria.statuses = [dsStatus(1)]; // 1 stack
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [drStatus(20)] });
  const state = makeState([laria], [enemy]);
  fund(state);

  // Push Laria to only 2 stacks — below the threshold.
  performAction(state, { unit: "la", skillId: "laria1", targets: ["la"] });
  assert.equal(dsCount(laria), 2, "Laria holds only 2 Deepening Shadows");
  assert.equal(hasBypass(laria), false, "2 stacks -> no Bypass");

  resetNightwrap(laria);
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  // 10 damage fully absorbed by 20 DR -> no HP lost.
  assert.equal(enemy.hp, 100, "without Bypass, the 20 DR fully absorbs the 10 damage");
});

// ===========================================================================
// laria5 — Vanishing Powder
//   "When a character receives their 3rd stack of Deepening Shadows, they gain
//    the effects of Vanish."  (Vanish = 15 Damage Reduction for 3 turns.)
// ===========================================================================

// SUSPECTED BUG: frozen Vanishing Powder says "When a character receives their 3rd stack of Deepening
// Shadows, they gain the effects of Vanish." Nightwrap "Places one stack of Deepening Shadows on the
// target", so placing a character's 3rd stack should grant Vanish (15 DR / 3 turns). The laria5 augment
// keys on `on: statusApplied`, but Nightwrap uses the `addStack` effect op, which never emits a
// `statusApplied` event (effects/interpret.ts:566 vs the applyStatus op at 535). So receiving the 3rd
// Deepening Shadows via a real skill never grants Vanish. (Same root cause as laria4 Nightwalker.)
test("laria5 Vanishing Powder: receiving the 3rd Deepening Shadows via Nightwrap grants Vanish", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria5")!);
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 100, statuses: [dsStatus(2)] });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, ally], [enemy]);
  fund(state);

  assert.equal(vanishDR(ally), undefined, "no Vanish before reaching 3 stacks");
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a1"] });
  assert.ok(r.ok, "Nightwrap places the 3rd stack on the ally");
  assert.equal(dsCount(ally), 3, "ally now holds exactly 3 Deepening Shadows");

  const v = vanishDR(ally);
  assert.ok(v, "the ally gains the effects of Vanish (a 'Vanish' damage_reduction)");
  assert.equal(v!.magnitude, 15, "Vanish grants 15 Damage Reduction");
  assert.equal(v!.duration, 3, "Vanish lasts 3 turns");

  // Functional: a 20 normal hit is reduced by 15 -> only 5 lost.
  applyDamage(ally, { amount: 20, type: "normal", isNew: true });
  assert.equal(ally.hp, 95, "15 Damage Reduction applied to a 20-damage hit -> 5 lost");
});

// SUSPECTED BUG: same root cause as above — Vanishing Powder ("a character receives their 3rd stack")
// should apply to ANY character, enemies included, but Nightwrap's addStack placement emits no
// statusApplied event, so the enemy never gains Vanish on its 3rd stack.
test("laria5 Vanishing Powder: an enemy receiving its 3rd Deepening Shadows via Nightwrap gains Vanish", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria5")!);
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [dsStatus(2)] });
  const state = makeState([laria], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap places the 3rd stack on the enemy");
  assert.equal(dsCount(enemy), 3, "enemy now holds exactly 3 Deepening Shadows");
  const v = vanishDR(enemy);
  assert.ok(v, "the enemy character also gains Vanish");
  assert.equal(v!.magnitude, 15, "15 Damage Reduction");
  assert.equal(v!.duration, 3, "3 turns");
});

test("laria5 Vanishing Powder: control — reaching only the 2nd stack grants NO Vanish", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria5")!);
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 100, statuses: [dsStatus(1)] });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, ally], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(dsCount(ally), 2, "ally only reaches its 2nd stack");
  assert.equal(vanishDR(ally), undefined, "the 2nd stack does NOT grant Vanish (only the 3rd does)");
});

test("laria5 Vanishing Powder: control — a 4th stack (already at 3) does NOT re-grant Vanish", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  applyAugment(laria, augmentById("laria5")!);
  // Ally seeded at 3 (without ever triggering the reactive grant) -> Nightwrap makes it 4.
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 100, statuses: [dsStatus(3)] });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, ally], [enemy]);
  fund(state);

  assert.equal(vanishDR(ally), undefined, "no Vanish present on the seeded 3-stack ally");
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["a1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(dsCount(ally), 4, "ally goes 3 -> 4 stacks (receives its 4th, not its 3rd)");
  assert.equal(vanishDR(ally), undefined, "receiving the 4th stack does NOT grant Vanish");
});
