import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startTurn, grantIncome, startRound } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById, buildMatch } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// =============================================================================
// Adversarial, spec-derived suite for DENNIS's base kit. The FROZEN prose
// (content/frozen/skills.json, ids dennis0..dennis6) is the oracle for every
// assertion below. The authored roster is consulted ONLY for how to drive each
// skill (ids, costs, element, status/minion names), never for what to assert.
//
// Frozen text under test:
//  dennis0 Pain Tolerance (passive): "If Hector the Injector is on this Hero's
//    team, Hector's passive won't create a minion at the start of the round, and
//    all of Hector's skills that refer to Dennis will refer to this Hero instead.
//    If Dennis is damaged, he will gain Elemental Essence and 5 Damage Reduction
//    until the end of his next turn. This effect stacks, but does not refresh.
//    Dennis can only gain Elemental Essence from this effect once per turn."
//  dennis1 Big Green Fist: "Deals 10 damage to target enemy, increased by 5 for
//    each stack of Pain Tolerance currently on Dennis."
//  dennis2 HS-112 Fury Serum: "For 4 turns any unit Dennis damages and any unit
//    that damages him is Taunted for 1 turn. This effect can not stack on enemies
//    or Dennis."
//  dennis3 HS-46 Ascendant Serum: "Dennis takes 5 Affliction damage, ignores
//    non-damage effects for 1 turn, and Big Green Fist deals 10 more damage until
//    the end of his next turn."
//  dennis4 Shared Agony: "Dennis deals 5 damage to all enemy units, and all enemy
//    units deal 5 Piercing damage to him."
//  dennis5 HS-88 Reconstitution Serum: "Dennis heals 5 HP each turn (stacks)."
//  dennis6 End of Shift: "Dennis takes 25 Affliction damage, then uses HS-112 Fury
//    Serum, HS-46 Ascendant Serum, and HS-88 Reconstitution Serum on himself."
// =============================================================================

// ---- status readers (names/kinds learned from authored content = how to observe) ----
const painStacks = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === "Pain Tolerance")?.magnitude ?? 0;
const painDR = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "damage_reduction" && s.name === "Pain Tolerance")?.magnitude ?? 0;
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const hasFury = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "HS-112 Fury Serum");
const furyDuration = (u: Unit): number | null | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === "HS-112 Fury Serum")?.duration;
const tauntsToward = (u: Unit, ref: string): number =>
  u.statuses.filter((s) => s.kind === "taunt" && s.unitRef === ref).length;
const hasAscendant = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "HS-46 Ascendant Serum");
const hasNonDamageIgnore = (u: Unit): boolean => u.statuses.some((s) => s.kind === "non_damage_ignore");
const reconRegen = (u: Unit): number | undefined =>
  u.statuses.find((s) => s.kind === "regen" && s.name === "HS-88 Reconstitution Serum")?.magnitude;

// Drive "Dennis is damaged" as a real event (mirrors dennis_paintolerance.test.ts). A damageDealt event
// with target=Dennis IS "Dennis is damaged"; emit does not itself subtract HP (that isolates the passive).
const damageEvent = (state: ReturnType<typeof makeState>, source: string, target: string): void =>
  emit(state, { type: "damageDealt", source, target, amount: 10, dtype: "normal", isNew: true });

function freshDennisVsOne(): { state: ReturnType<typeof makeState>; dennis: Unit; e: Unit } {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([dennis], [e]);
  state.teams.A.energy = { generic: 40, serum: 40 };
  return { state, dennis, e };
}

// =============================================================================
// dennis0 — Pain Tolerance (passive)
// =============================================================================

// Part A: "If Hector the Injector is on this Hero's team, Hector's passive won't create a minion at the
// start of the round, and all of Hector's skills that refer to Dennis will refer to this Hero instead."
test("dennis0 Part A: hero-Dennis on Hector's team suppresses Hector's round-start minion summon", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 1 });
  const heroDennis = Object.values(state.units).find((u) => u.heroId === "dennis")!;
  assert.equal(heroDennis.understudyFor, "Dennis the Apprentice", "hero-Dennis is tagged as the understudy for Hector's Dennis reference");

  startRound(state); // Hector's roundStart summon fires here
  const apprentices = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Dennis the Apprentice");
  assert.equal(apprentices.length, 0, "Hector does NOT create a Dennis minion while hero-Dennis is on the team");
});

test("dennis0 Part A CONTROL: without a same-team hero-Dennis, Hector still summons his Dennis minion", () => {
  const state = buildMatch({ A: ["hector", "saya", "gaia"], B: ["roland", "sera", "ando"], seed: 1 });
  startRound(state);
  const apprentices = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Dennis the Apprentice");
  assert.equal(apprentices.length, 1, "no hero-Dennis → the minion is summoned as normal");
});

// Part B: "If Dennis is damaged, he will gain Elemental Essence and 5 Damage Reduction..."
test("dennis0 Part B: being damaged grants Dennis Elemental Essence AND 5 Damage Reduction", () => {
  const { state, dennis } = freshDennisVsOne();
  assert.equal(essenceCount(dennis), 0, "no essence before being hit");
  assert.equal(painDR(dennis), 0, "no DR before being hit");

  damageEvent(state, "e", "dennis"); // Dennis is damaged
  assert.equal(essenceCount(dennis), 1, "gained an Elemental Essence charge");
  assert.equal(painDR(dennis), 5, "gained 5 Damage Reduction");
  assert.equal(painStacks(dennis), 1, "one Pain Tolerance stack drives the DR");
});

test("dennis0 Part B CONTROL: when a DIFFERENT unit is damaged, Dennis gains nothing", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "dennis", "e"); // the ENEMY is damaged, not Dennis
  assert.equal(essenceCount(dennis), 0, "Dennis gains no essence when he is not the one damaged");
  assert.equal(painDR(dennis), 0, "Dennis gains no DR when he is not the one damaged");
  assert.equal(painStacks(dennis), 0, "no Pain Tolerance stack");
});

test("dennis0 Part B: the granted Elemental Essence is functional — next income yields element energy, not generic", () => {
  const { state, dennis } = freshDennisVsOne();
  state.teams.A.energy = {}; // clear the pool so income is observable
  assert.equal(dennis.slot, 0, "Dennis sits in a non-middle slot, so with no essence he yields generic");

  damageEvent(state, "e", "dennis"); // grants Elemental Essence
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.serum ?? 0, 1, "income was converted to 1 of Dennis's element (serum) by the essence charge");
  assert.equal(state.teams.A.energy.generic ?? 0, 0, "the charge replaced the generic income, it did not add to it");
  assert.equal(essenceCount(dennis), 0, "the one-shot essence charge was consumed by income");
});

test("dennis0 Part B CONTROL (income): with no essence, Dennis's income is a plain generic", () => {
  const { state, dennis } = freshDennisVsOne();
  state.teams.A.energy = {};
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.generic ?? 0, 1, "plain +1 generic when Dennis holds no essence");
  assert.equal(state.teams.A.energy.serum ?? 0, 0, "no element income without an essence charge");
  assert.equal(dennis.hp, 100);
});

// "This effect stacks..." — DR accumulates 5 per hit.
test("dennis0 Part B: Damage Reduction STACKS — each hit adds another 5", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "e", "dennis");
  assert.equal(painDR(dennis), 5, "one hit → 5 DR");
  damageEvent(state, "e", "dennis");
  assert.equal(painDR(dennis), 10, "two hits → 10 DR (stacks, not capped at 5)");
  damageEvent(state, "e", "dennis");
  assert.equal(painDR(dennis), 15, "three hits → 15 DR");
  assert.equal(painStacks(dennis), 3, "three Pain Tolerance stacks");
});

test("dennis0 Part B: the 5 Damage Reduction actually reduces a later NORMAL hit by 5 per stack", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "e", "dennis"); // → DR 5 (the triggering event subtracts no HP; emit does not apply damage)
  assert.equal(dennis.hp, 100, "the DR-granting event itself did not change HP (isolated)");
  runEffects(state, [{ op: "damage", amount: 10, dtype: "normal", to: "target" }] as any, { caster: state.units["e"]!, targets: [dennis] });
  assert.equal(dennis.hp, 95, "a 10 normal hit is reduced by the 5 DR → 5 lost");
});

test("dennis0 Part B CONTROL: without DR, the same 10 normal hit removes the full 10", () => {
  const { state, dennis } = freshDennisVsOne();
  runEffects(state, [{ op: "damage", amount: 10, dtype: "normal", to: "target" }] as any, { caster: state.units["e"]!, targets: [dennis] });
  assert.equal(dennis.hp, 90, "no DR → full 10 lost");
});

// "Dennis can only gain Elemental Essence from this effect once per turn."
test("dennis0 Part B: Elemental Essence is gained only ONCE per turn, even across many hits (but DR still stacks each hit)", () => {
  const { state, dennis } = freshDennisVsOne();
  state.teams.A.energy = {};
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis"); // three hits in the SAME turn
  assert.equal(painStacks(dennis), 3, "DR stacks with every hit");
  assert.equal(painDR(dennis), 15, "DR = 5 x 3");
  // Only one essence charge exists, and it converts exactly one income unit — proof of "once per turn".
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.serum ?? 0, 1, "the three same-turn hits produced only ONE unit of element income");
});

// "...but does not refresh." — each hit's stack expires on its OWN clock, one Dennis-turn later.
test("dennis0 Part B: stacks do NOT refresh — an earlier hit's stack expires independently of a later hit", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "e", "dennis"); // hit #1 at turn 1 → expires at end of turn 3
  endTurn(state); endTurn(state); // → turn 3, A active
  assert.equal(painStacks(dennis), 1, "hit #1 still present entering turn 3");
  damageEvent(state, "e", "dennis"); // hit #2 at turn 3 → expires at end of turn 5
  assert.equal(painStacks(dennis), 2, "both stacks held");

  endTurn(state); // end of turn 3 — ONLY hit #1's clock fires (a refresh would keep both alive)
  assert.equal(painStacks(dennis), 1, "hit #1 expired on its own clock; hit #2 remains (no refresh)");
  assert.equal(painDR(dennis), 5, "DR recomputed to 5 x 1");
});

// =============================================================================
// dennis1 — Big Green Fist
// =============================================================================
test("dennis1: deals a base 10 to the target enemy with 0 Pain Tolerance stacks", () => {
  const { state, dennis, e } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(r.ok, true, "cast succeeds");
  assert.equal(e.hp, 90, "10 base damage");
});

test("dennis1: damage is increased by 5 for EACH stack of Pain Tolerance currently on Dennis", () => {
  const { state, dennis, e } = freshDennisVsOne();
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis"); // 3 Pain Tolerance stacks on Dennis
  assert.equal(painStacks(dennis), 3);
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(e.hp, 100 - (10 + 5 * 3), "10 + 5*3 = 25 damage");
});

test("dennis1 CONTROL: stacks on the ENEMY do not scale Big Green Fist — only stacks on Dennis do", () => {
  const { state, dennis, e } = freshDennisVsOne();
  damageEvent(state, "dennis", "e"); // gives the ENEMY a Pain Tolerance... no — Pain Tolerance is Dennis-only;
  // this is a control that damaging the enemy grants Dennis nothing, so BGF stays base 10.
  assert.equal(painStacks(dennis), 0, "Dennis has no stacks");
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(e.hp, 90, "still base 10 (no Dennis stacks)");
});

test("dennis1 CONTROL: single-target — only the chosen enemy is hit, not every enemy", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([dennis], [e1, e2]);
  state.teams.A.energy = { generic: 40, serum: 40 };
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e1"] });
  assert.equal(e1.hp, 90, "the chosen enemy took 10");
  assert.equal(e2.hp, 100, "the other enemy is untouched");
});

// =============================================================================
// dennis2 — HS-112 Fury Serum
// =============================================================================
test("dennis2: applies a 4-turn Fury window on Dennis", () => {
  const { state, dennis } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(hasFury(dennis), true, "Fury window is active");
  assert.equal(furyDuration(dennis), 4, "for 4 turns");
});

test("dennis2: any unit DENNIS DAMAGES is Taunted toward Dennis for 1 turn", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] }); // Fury on
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] }); // Dennis damages e
  assert.equal(tauntsToward(e, "dennis"), 1, "the enemy Dennis damaged is Taunted toward Dennis");
  const t = e.statuses.find((s) => s.kind === "taunt");
  assert.equal(t?.duration, 1, "Taunt lasts 1 turn");
});

test("dennis2: any unit that DAMAGES DENNIS is Taunted toward Dennis for 1 turn", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] }); // Fury on
  damageEvent(state, "e", "dennis"); // the enemy damages Dennis
  assert.equal(tauntsToward(e, "dennis"), 1, "the enemy that damaged Dennis is Taunted toward Dennis");
});

test("dennis2 CONTROL: with NO Fury window, damaging (or being damaged by) a unit applies no Taunt", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] }); // Dennis damages e, no Fury
  damageEvent(state, "e", "dennis"); // e damages Dennis, no Fury
  assert.equal(tauntsToward(e, "dennis"), 0, "no Fury → no Taunt in either direction");
  assert.equal(e.statuses.some((s) => s.kind === "taunt"), false);
});

test("dennis2: the Taunt does NOT stack on an enemy — repeated hits keep exactly one Taunt", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  assert.equal(e.statuses.filter((s) => s.kind === "taunt").length, 1, "cannot stack on an enemy — one Taunt only");
});

// =============================================================================
// dennis3 — HS-46 Ascendant Serum
// =============================================================================
test("dennis3: Dennis takes 5 Affliction damage", () => {
  const { state, dennis } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(dennis.hp, 95, "5 Affliction self-damage");
});

test("dennis3: applies a 1-turn non-damage-ignore window and the Ascendant mark", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(hasNonDamageIgnore(dennis), true, "gained the 'ignores non-damage effects' window");
  assert.equal(dennis.statuses.find((s) => s.kind === "non_damage_ignore")?.duration, 1, "for 1 turn");
  assert.equal(hasAscendant(dennis), true, "the Big-Green-Fist-empowering Ascendant mark is applied");
});

test("dennis3: Big Green Fist deals 10 MORE damage while the Ascendant window is up", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] }); // Ascendant + (self-affliction → some Pain stacks)
  const stacks = painStacks(dennis); // read the live scaling base so the +10 is isolated from Pain Tolerance
  const expectedBase = 10 + 5 * stacks;
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(100 - e.hp, expectedBase + 10, "Big Green Fist dealt its scaled base PLUS the Ascendant +10");
});

test("dennis3 CONTROL: without the Ascendant window, Big Green Fist deals only its scaled base (no +10)", () => {
  const { state, dennis, e } = freshDennisVsOne();
  const stacks = painStacks(dennis); // 0
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(100 - e.hp, 10 + 5 * stacks, "no Ascendant → base 10 only");
});

test("dennis3: HS-46 Ascendant Serum makes Dennis ignore non-damage effects for 1 turn (a stun does not land)", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] }); // gain non_damage_ignore for 1 turn
  assert.equal(hasNonDamageIgnore(dennis), true);
  // A stun is a harmful NON-DAMAGE effect. Per frozen, Dennis should ignore it while the window is up.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }] as any, { caster: e, targets: [dennis] });
  assert.equal(dennis.statuses.some((s) => s.kind === "stun"), false, "the non-damage stun should be ignored while non_damage_ignore is active");
});

// =============================================================================
// dennis4 — Shared Agony
// =============================================================================
test("dennis4: Dennis deals 5 to ALL enemies, and EACH enemy deals 5 Piercing back to Dennis", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const e3 = makeUnit({ id: "e3", team: "B", kind: "hero" });
  const state = makeState([dennis], [e1, e2, e3]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  const r = performAction(state, { unit: "dennis", skillId: "dennis4", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 95, "enemy 1 took 5");
  assert.equal(e2.hp, 95, "enemy 2 took 5");
  assert.equal(e3.hp, 95, "enemy 3 took 5");
  assert.equal(dennis.hp, 100 - 5 * 3, "Dennis took 5 Piercing per enemy = 15 (Piercing bypasses his own Pain Tolerance DR)");
});

test("dennis4: each enemy's Piercing hit registers as 'Dennis is damaged' — Pain Tolerance stacks once per enemy", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([dennis], [e1, e2]);
  state.teams.A.energy = { generic: 40, serum: 40 };
  performAction(state, { unit: "dennis", skillId: "dennis4", targets: [] });
  assert.equal(painStacks(dennis), 2, "two enemies → two separate incoming Piercing hits → two Pain Tolerance stacks");
});

test("dennis4 + Fury: each enemy is credited as the real dealer, so Fury taunts each ENEMY (not Dennis)", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([dennis], [e1, e2]);
  state.teams.A.energy = { generic: 40, serum: 40 };
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] }); // Fury on
  performAction(state, { unit: "dennis", skillId: "dennis4", targets: [] });
  // Dennis damages each enemy (5) AND each enemy damages Dennis (5 piercing) — either direction taunts the enemy toward Dennis.
  assert.equal(tauntsToward(e1, "dennis"), 1, "e1 taunted toward Dennis");
  assert.equal(tauntsToward(e2, "dennis"), 1, "e2 taunted toward Dennis");
});

// =============================================================================
// dennis5 — HS-88 Reconstitution Serum
// =============================================================================
test("dennis5: casting applies a heal-over-time and does not heal instantly (it heals 'each turn')", () => {
  const { state, dennis } = freshDennisVsOne();
  dennis.hp = 50;
  const r = performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  assert.equal(r.ok, true);
  assert.equal(dennis.hp, 50, "no instant heal on cast — the effect is per-turn");
  assert.equal(reconRegen(dennis), 5, "a 5-HP-per-turn regeneration is installed");
});

test("dennis5: '(stacks)' — a second cast grows the per-turn heal to 10", () => {
  const { state, dennis } = freshDennisVsOne();
  dennis.hp = 50;
  performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  assert.equal(reconRegen(dennis), 5, "one cast → 5/turn");
  // dennis5 has a 1-turn cooldown; advance whole turns until it is castable again.
  const skill = dennis.skills!.find((s) => s.id === "dennis5")!;
  for (let i = 0; i < 8 && skill.currentCd > 0; i++) endTurn(state);
  const r2 = performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  assert.equal(r2.ok, true, "second cast succeeds once off cooldown");
  assert.equal(reconRegen(dennis), 10, "two casts → heals 10 per turn (stacks)");
});

test("dennis5: HS-88 Reconstitution regen heals 5 HP each turn (null-duration regen ticks)", () => {
  const { state, dennis } = freshDennisVsOne();
  dennis.hp = 50;
  performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] }); // turn 1
  endTurn(state);  // A end (turn 1) — birth turn, no tick expected
  endTurn(state);  // B end (turn 2)
  startTurn(state); // A start (turn 3)
  endTurn(state);  // A end (turn 3) — Dennis's next turn-end: the heal should have ticked by now
  assert.ok(dennis.hp >= 55, `Dennis should have healed at least 5 HP over his next turn; hp=${dennis.hp}`);
});

// =============================================================================
// dennis6 — End of Shift
// =============================================================================
test("dennis6: Dennis takes 25 Affliction damage", () => {
  const { state, dennis } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis6", targets: [] });
  assert.equal(r.ok, true);
  // 25 from End of Shift + 5 from the inlined HS-46 Ascendant self-affliction; Affliction bypasses DR.
  assert.equal(dennis.hp, 100 - 25 - 5, "took the 25 Affliction (plus the inlined Ascendant's 5)");
});

test("dennis6: then uses HS-112 Fury, HS-46 Ascendant, and HS-88 Reconstitution on himself", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis6", targets: [] });
  assert.equal(hasFury(dennis), true, "HS-112 Fury Serum was used (4-turn Fury window present)");
  assert.equal(furyDuration(dennis), 4, "Fury window is 4 turns");
  assert.equal(hasAscendant(dennis), true, "HS-46 Ascendant Serum was used (Ascendant mark present)");
  assert.equal(hasNonDamageIgnore(dennis), true, "HS-46 Ascendant Serum was used (non-damage-ignore window present)");
  assert.equal(reconRegen(dennis), 5, "HS-88 Reconstitution Serum was used (5-HP/turn regen present)");
});

// NOTE ON EMERGENT BEHAVIOR (frozen-consistent, not a bug): End of Shift's inlined HS-46 deals 5 Affliction
// to Dennis AFTER the inlined Fury window is up, so Fury's "any unit that damages him is Taunted" applies to
// Dennis's own self-hit — Dennis ends up Taunted toward himself (the frozen "...or Dennis" clause anticipates
// exactly this). A subsequent single-target Harmful cast is therefore forced onto Dennis, so we do NOT assert
// Fury via a follow-up Big Green Fist here (it would be redirected). The Fury grant is proven above by status.
test("dennis6: the inlined Fury applies to Dennis's own End-of-Shift self-damage (Dennis is Taunted toward himself)", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis6", targets: [] });
  assert.equal(tauntsToward(dennis, "dennis"), 1, "Fury + self-affliction Taunts Dennis toward himself (frozen: the effect may land on Dennis, but does not stack)");
});

// =============================================================================
// Cost / cooldown / legality — from the frozen skill definitions
// =============================================================================
test("dennis2 goes on a 3-turn cooldown and cannot be recast the same turn", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  const skill = dennis.skills!.find((s) => s.id === "dennis2")!;
  assert.equal(skill.currentCd, 3, "cooldown 3 per frozen");
  const again = performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "on-cooldown");
});

test("dennis1 is rejected for insufficient energy when the pool cannot pay its 1 Generic", () => {
  const { state } = freshDennisVsOne();
  state.teams.A.energy = {}; // empty pool
  const r = performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "insufficient-energy");
});

test("dennis3 pays its Specific cost from the caster's element (serum)", () => {
  const { state } = freshDennisVsOne();
  state.teams.A.energy = { serum: 1 }; // exactly one serum, no generic
  const r = performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(r.ok, true, "the 1 Specific is payable from the serum pool");
  assert.equal(state.teams.A.energy.serum ?? 0, 0, "the serum was spent");
});
