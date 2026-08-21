import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performAction, endTurn, startTurn, grantIncome, startRound } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { fusionForm, FUSIONS } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById, buildMatch } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED suite for DENNIS's FUSION FORM(S).
//
// IMPORTANT STRUCTURAL FACT (spec-derived, from content/frozen/characters.json):
//   Dennis the Apprentice is authored with  "starts_fused": true, "can_fuse": false,
//   element = "serum".  Unlike every other roster hero, Dennis has NO menu of ~7
//   elemental fusion variants; he is PERMANENTLY fused in a single Serum form. That
//   one form's passive + active skills ARE his fusion kit:
//     - fusion passive : dennis0  "Pain Tolerance"
//     - fusion actives : dennis1..dennis6
//   (The generated FUSIONS table therefore contains zero "dennis" forms — the
//   "serum" fusion KEY that exists there belongs to Hector / Riverdaughter /
//   Titania / Zevkir, not to Dennis.)
//
// Section 0 pins that spec fact as an executable guard. Sections 1..8 then treat
// Dennis's single permanent Serum form as THE fusion form and verify its passive +
// every active against the FROZEN prose (content/frozen/skills.json), the sole
// oracle. Authored/roster content is consulted ONLY for how to drive (ids, costs,
// element, status/minion names), never for what to assert.
//
// Frozen text under test (verbatim):
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

// ---- status readers (names/kinds learned from authored content = how to OBSERVE) ----
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

// "Dennis is damaged" as a real event (mirrors dennis_paintolerance.test.ts). A damageDealt event
// with target=Dennis IS "Dennis is damaged"; emit does not itself subtract HP (that isolates the passive).
const damageEvent = (state: MatchState, source: string, target: string): void =>
  emit(state, { type: "damageDealt", source, target, amount: 10, dtype: "normal", isNew: true });

function freshDennisVsOne(): { state: MatchState; dennis: Unit; e: Unit } {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([dennis], [e]);
  state.teams.A.energy = { generic: 40, serum: 40 };
  return { state, dennis, e };
}
function freshDennisVsMany(n: number): { state: MatchState; dennis: Unit; foes: Unit[] } {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const foes = Array.from({ length: n }, (_, i) => makeUnit({ id: `e${i + 1}`, team: "B", kind: "hero" }));
  const state = makeState([dennis], foes);
  state.teams.A.energy = { generic: 40, serum: 40 };
  return { state, dennis, foes };
}

// =============================================================================
// Section 0 — SPEC GUARD: Dennis is permanently fused and has NO elemental forms.
// Oracle: frozen characters.json (starts_fused:true, can_fuse:false). The engine's
// generated fusion table must therefore expose ZERO "dennis" forms, and every
// element key that exists for other heroes must return undefined for hero "dennis".
// =============================================================================
test("dennis0 SPEC: the frozen roster marks Dennis permanently fused / non-fusing", () => {
  const chars = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../content/frozen/characters.json", import.meta.url)), "utf8"),
  ) as any;
  const arr: any[] = Array.isArray(chars) ? chars : Object.values(chars);
  const den = arr.find((c) => c.id === "dennis");
  assert.ok(den, "Dennis is in the frozen roster");
  assert.equal(den.starts_fused, true, "frozen: Dennis starts fused");
  assert.equal(den.can_fuse, false, "frozen: Dennis cannot fuse into other elements");
  assert.equal(den.element.name, "serum", "frozen: Dennis's permanent form is the Serum element");
});

test("dennis SPEC: no elemental fusion FORMS exist for Dennis (can_fuse:false is honored by the engine)", () => {
  const dennisForms = FUSIONS.filter((f) => f.hero === "dennis");
  assert.equal(dennisForms.length, 0, "the generated fusion table contains no Dennis forms");
  // Every fusion element KEY any hero uses must be undefined when asked for on Dennis.
  const allKeys = [...new Set(FUSIONS.map((f) => f.key))];
  assert.ok(allKeys.includes("serum"), "the 'serum' key exists (owned by other heroes)");
  for (const key of allKeys) {
    assert.equal(fusionForm("dennis", key), undefined, `Dennis must have no '${key}' fusion form`);
  }
});

// =============================================================================
// Section 1 — FUSION PASSIVE: dennis0 "Pain Tolerance"
// =============================================================================

// Clause A: "If Hector the Injector is on this Hero's team, Hector's passive won't create a minion at the
// start of the round, and all of Hector's skills that refer to Dennis will refer to this Hero instead."
test("dennis0 passive A: hero-Dennis on Hector's team is tagged as Hector's Dennis-reference AND suppresses the summon", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 3 });
  const heroDennis = Object.values(state.units).find((u) => u.heroId === "dennis")!;
  // "...all of Hector's skills that refer to Dennis will refer to this Hero instead": modeled as the understudy tag.
  assert.equal(heroDennis.understudyFor, "Dennis the Apprentice", "hero-Dennis stands in for Hector's 'Dennis' references");

  startRound(state); // Hector's roundStart summon fires here
  const apprentices = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Dennis the Apprentice");
  assert.equal(apprentices.length, 0, "Hector does NOT summon a Dennis minion while hero-Dennis is present");
});

test("dennis0 passive A CONTROL: with no same-team hero-Dennis, Hector's round-start summon still fires", () => {
  const state = buildMatch({ A: ["hector", "saya", "gaia"], B: ["roland", "sera", "ando"], seed: 3 });
  startRound(state);
  const apprentices = Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Dennis the Apprentice");
  assert.equal(apprentices.length, 1, "no hero-Dennis → the minion is summoned normally");
});

// Clause B: "If Dennis is damaged, he will gain Elemental Essence and 5 Damage Reduction until the end
// of his next turn."
test("dennis0 passive B: being damaged grants Dennis one Elemental Essence AND 5 Damage Reduction", () => {
  const { state, dennis } = freshDennisVsOne();
  assert.equal(essenceCount(dennis), 0);
  assert.equal(painDR(dennis), 0);

  damageEvent(state, "e", "dennis"); // Dennis is damaged
  assert.equal(essenceCount(dennis), 1, "gained an Elemental Essence charge");
  assert.equal(painDR(dennis), 5, "gained 5 Damage Reduction");
  assert.equal(painStacks(dennis), 1, "one Pain Tolerance stack backs the DR");
});

test("dennis0 passive B CONTROL: Dennis gains nothing when a DIFFERENT unit is the one damaged", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "dennis", "e"); // the ENEMY is damaged
  assert.equal(essenceCount(dennis), 0, "no essence when Dennis is not the target");
  assert.equal(painDR(dennis), 0, "no DR when Dennis is not the target");
  assert.equal(painStacks(dennis), 0);
});

test("dennis0 passive B: the 5 Damage Reduction actually reduces a later NORMAL hit by 5", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "e", "dennis"); // → 5 DR (the trigger event itself removes no HP)
  assert.equal(dennis.hp, 100, "the DR-granting event did not itself change HP (isolated)");
  runEffects(state, [{ op: "damage", amount: 10, dtype: "normal", to: "target" }] as any, { caster: state.units["e"]!, targets: [dennis] });
  assert.equal(dennis.hp, 95, "a 10 normal hit is reduced by 5 DR → 5 lost");
});

test("dennis0 passive B CONTROL: with no DR the same 10 normal hit removes the full 10", () => {
  const { state, dennis } = freshDennisVsOne();
  runEffects(state, [{ op: "damage", amount: 10, dtype: "normal", to: "target" }] as any, { caster: state.units["e"]!, targets: [dennis] });
  assert.equal(dennis.hp, 90, "no DR → full 10 lost");
});

// Clause B: "This effect stacks..."
test("dennis0 passive B: Damage Reduction STACKS — each incoming hit adds another 5", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "e", "dennis");
  assert.equal(painDR(dennis), 5);
  damageEvent(state, "e", "dennis");
  assert.equal(painDR(dennis), 10, "two hits → 10 DR (not capped at 5)");
  damageEvent(state, "e", "dennis");
  assert.equal(painDR(dennis), 15, "three hits → 15 DR");
  assert.equal(painStacks(dennis), 3);
});

// Clause B: "Dennis can only gain Elemental Essence from this effect once per turn."
test("dennis0 passive B: Elemental Essence is gained only ONCE per turn despite many hits (DR still stacks)", () => {
  const { state, dennis } = freshDennisVsOne();
  state.teams.A.energy = {}; // clear pool so essence income is observable
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis"); // three hits, same turn
  assert.equal(painStacks(dennis), 3, "DR stacks every hit");
  assert.equal(painDR(dennis), 15);
  // exactly ONE essence charge exists → converts exactly one income unit into element energy.
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.serum ?? 0, 1, "three same-turn hits yielded only ONE unit of element income");
});

// Clause B: "...but does not refresh." — each hit's stack expires on its OWN clock (end of Dennis's next turn).
test("dennis0 passive B: stacks do NOT refresh — an earlier hit expires independently of a later one", () => {
  const { state, dennis } = freshDennisVsOne();
  damageEvent(state, "e", "dennis"); // hit #1 (turn 1) → expires end of turn 3
  endTurn(state); endTurn(state); // advance to turn 3, A active
  assert.equal(painStacks(dennis), 1, "hit #1 still present entering turn 3");
  damageEvent(state, "e", "dennis"); // hit #2 (turn 3) → expires end of turn 5
  assert.equal(painStacks(dennis), 2);

  endTurn(state); // end of turn 3 — ONLY hit #1's clock fires; a refresh would have kept both alive
  assert.equal(painStacks(dennis), 1, "hit #1 expired on its own clock; hit #2 remains (no refresh)");
  assert.equal(painDR(dennis), 5, "DR recomputed to 5 x 1");
});

// =============================================================================
// Section 2 — FUSION ACTIVE: dennis1 "Big Green Fist"
//   "Deals 10 damage to target enemy, increased by 5 for each stack of Pain Tolerance on Dennis."
// =============================================================================
test("dennis1: base 10 damage to the target enemy at 0 Pain Tolerance stacks", () => {
  const { state, e } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(r.ok, true, "cast succeeds");
  assert.equal(e.hp, 90, "base 10");
});

test("dennis1: damage +5 per Pain Tolerance stack currently on Dennis", () => {
  const { state, dennis, e } = freshDennisVsOne();
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis"); // 3 stacks
  assert.equal(painStacks(dennis), 3);
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(e.hp, 100 - (10 + 5 * 3), "10 + 5*3 = 25");
});

test("dennis1 CONTROL: with 0 stacks the hit is exactly base 10 (scaling is stack-gated)", () => {
  const { state, dennis, e } = freshDennisVsOne();
  assert.equal(painStacks(dennis), 0);
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(e.hp, 90, "no stacks → base 10, not scaled");
});

test("dennis1 CONTROL: single-target — only the chosen enemy is hit", () => {
  const { state, foes } = freshDennisVsMany(2);
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e1"] });
  assert.equal(foes[0]!.hp, 90, "chosen enemy took 10");
  assert.equal(foes[1]!.hp, 100, "other enemy untouched");
});

// =============================================================================
// Section 3 — FUSION ACTIVE: dennis2 "HS-112 Fury Serum"
//   "For 4 turns any unit Dennis damages and any unit that damages him is Taunted for 1 turn.
//    This effect can not stack on enemies or Dennis."
// =============================================================================
test("dennis2: installs a 4-turn Fury window on Dennis", () => {
  const { state, dennis } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(hasFury(dennis), true, "Fury window active");
  assert.equal(furyDuration(dennis), 4, "for 4 turns");
});

test("dennis2: a unit DENNIS DAMAGES is Taunted toward Dennis for 1 turn", () => {
  const { state, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] }); // Dennis damages e
  assert.equal(tauntsToward(e, "dennis"), 1, "enemy Dennis damaged is Taunted toward Dennis");
  assert.equal(e.statuses.find((s) => s.kind === "taunt")?.duration, 1, "Taunt lasts 1 turn");
});

test("dennis2: a unit that DAMAGES DENNIS is Taunted toward Dennis for 1 turn", () => {
  const { state, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  damageEvent(state, "e", "dennis"); // e damages Dennis
  assert.equal(tauntsToward(e, "dennis"), 1, "the unit that damaged Dennis is Taunted toward Dennis");
});

test("dennis2 CONTROL: with NO Fury window, neither dealing nor taking damage applies a Taunt", () => {
  const { state, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] }); // Dennis damages e, no Fury
  damageEvent(state, "e", "dennis"); // e damages Dennis, no Fury
  assert.equal(tauntsToward(e, "dennis"), 0, "no Fury → no Taunt either direction");
});

test("dennis2: 'can not stack on enemies' — repeated hits keep exactly one Taunt on an enemy", () => {
  const { state, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  damageEvent(state, "e", "dennis");
  assert.equal(e.statuses.filter((s) => s.kind === "taunt").length, 1, "one Taunt only — cannot stack on an enemy");
});

test("dennis2: 'or Dennis' — repeated self-damage under Fury keeps at most ONE Taunt on Dennis", () => {
  // dennis3 deals 5 Affliction to Dennis himself; under Fury that is 'a unit that damages him', so Dennis is
  // Taunted toward himself. Doing it a second time must NOT add a second Taunt (frozen: cannot stack on Dennis).
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] }); // Fury on
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] }); // self 5 Affliction (#1)
  assert.equal(tauntsToward(dennis, "dennis"), 1, "first self-hit under Fury Taunts Dennis toward himself");
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] }); // self 5 Affliction (#2)
  assert.equal(tauntsToward(dennis, "dennis"), 1, "a second self-hit does NOT add a second Taunt (no stack on Dennis)");
});

// =============================================================================
// Section 4 — FUSION ACTIVE: dennis3 "HS-46 Ascendant Serum"
//   "Dennis takes 5 Affliction damage, ignores non-damage effects for 1 turn, and Big Green Fist deals
//    10 more damage until the end of his next turn."
// =============================================================================
test("dennis3: Dennis takes 5 Affliction self-damage", () => {
  const { state, dennis } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(dennis.hp, 95, "5 Affliction self-damage");
});

test("dennis3: installs a 1-turn non-damage-ignore window and the Ascendant (BGF+10) mark", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(hasNonDamageIgnore(dennis), true, "'ignores non-damage effects' window present");
  assert.equal(dennis.statuses.find((s) => s.kind === "non_damage_ignore")?.duration, 1, "for 1 turn");
  assert.equal(hasAscendant(dennis), true, "the BGF-empowering Ascendant mark is applied");
});

test("dennis3: 'ignores non-damage effects for 1 turn' — an incoming stun does not land", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(hasNonDamageIgnore(dennis), true);
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }] as any, { caster: e, targets: [dennis] });
  assert.equal(dennis.statuses.some((s) => s.kind === "stun"), false, "the non-damage stun is ignored while the window is up");
});

test("dennis3 CONTROL: without the Ascendant window an incoming stun DOES land", () => {
  const { state, dennis, e } = freshDennisVsOne();
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }] as any, { caster: e, targets: [dennis] });
  assert.equal(dennis.statuses.some((s) => s.kind === "stun"), true, "no window → the stun applies normally");
});

test("dennis3: Big Green Fist deals 10 MORE while the Ascendant window is up", () => {
  const { state, dennis, e } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] }); // Ascendant + self-affliction (=> some Pain stacks)
  const base = 10 + 5 * painStacks(dennis); // read live scaling so the +10 is isolated
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(100 - e.hp, base + 10, "BGF dealt its scaled base PLUS the Ascendant +10");
});

test("dennis3 CONTROL: without the Ascendant window Big Green Fist deals only its scaled base", () => {
  const { state, dennis, e } = freshDennisVsOne();
  const base = 10 + 5 * painStacks(dennis); // 0 stacks → 10
  performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(100 - e.hp, base, "no Ascendant → base only, no +10");
});

// =============================================================================
// Section 5 — FUSION ACTIVE: dennis4 "Shared Agony"
//   "Dennis deals 5 damage to all enemy units, and all enemy units deal 5 Piercing damage to him."
// =============================================================================
test("dennis4: Dennis deals 5 to EVERY enemy and takes 5 Piercing back from EACH", () => {
  const { state, dennis, foes } = freshDennisVsMany(3);
  const r = performAction(state, { unit: "dennis", skillId: "dennis4", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(foes[0]!.hp, 95, "enemy 1 took 5");
  assert.equal(foes[1]!.hp, 95, "enemy 2 took 5");
  assert.equal(foes[2]!.hp, 95, "enemy 3 took 5");
  assert.equal(dennis.hp, 100 - 5 * 3, "Dennis took 5 from each of 3 enemies = 15");
});

test("dennis4: each enemy's Piercing hit counts as 'Dennis is damaged' → one Pain Tolerance stack per enemy", () => {
  const { state, dennis } = freshDennisVsMany(2);
  performAction(state, { unit: "dennis", skillId: "dennis4", targets: [] });
  assert.equal(painStacks(dennis), 2, "two enemies → two incoming Piercing hits → two Pain Tolerance stacks");
});

test("dennis4: the return damage is PIERCING — it bypasses Dennis's own Pain Tolerance DR", () => {
  // Pre-load Dennis with Pain Tolerance DR, then Shared Agony vs one enemy. If the 5 return damage were
  // reducible, 5 DR would zero it; frozen calls it 'Piercing', so Dennis must still take the full 5.
  const { state, dennis } = freshDennisVsMany(1);
  damageEvent(state, "e1", "dennis"); // pre-stack: +5 DR
  assert.equal(painDR(dennis), 5, "Dennis holds 5 DR before Shared Agony");
  const hpBefore = dennis.hp;
  performAction(state, { unit: "dennis", skillId: "dennis4", targets: [] });
  assert.equal(hpBefore - dennis.hp, 5, "the 5 Piercing return ignores the 5 DR (full 5 taken)");
});

// =============================================================================
// Section 6 — FUSION ACTIVE: dennis5 "HS-88 Reconstitution Serum"
//   "Dennis heals 5 HP each turn (stacks)."
// =============================================================================
test("dennis5: no instant heal on cast — installs a 5-HP-per-turn regeneration", () => {
  const { state, dennis } = freshDennisVsOne();
  dennis.hp = 50;
  const r = performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  assert.equal(r.ok, true);
  assert.equal(dennis.hp, 50, "no instant heal — the heal is per-turn");
  assert.equal(reconRegen(dennis), 5, "5-HP/turn regen installed");
});

test("dennis5: '(stacks)' — a second cast grows the per-turn heal to 10", () => {
  const { state, dennis } = freshDennisVsOne();
  dennis.hp = 50;
  performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  assert.equal(reconRegen(dennis), 5, "one cast → 5/turn");
  const s = dennis.skills!.find((k) => k.id === "dennis5")!;
  for (let i = 0; i < 8 && s.currentCd > 0; i++) endTurn(state); // dennis5 has a 1-turn cd
  const r2 = performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  assert.equal(r2.ok, true, "second cast succeeds once off cooldown");
  assert.equal(reconRegen(dennis), 10, "two casts → 10/turn (stacks)");
});

test("dennis5: the regen actually heals Dennis by his next turn-end", () => {
  const { state, dennis } = freshDennisVsOne();
  dennis.hp = 50;
  performAction(state, { unit: "dennis", skillId: "dennis5", targets: ["dennis"] });
  endTurn(state);  // A end (birth turn — no tick expected)
  endTurn(state);  // B end
  startTurn(state); // A start
  endTurn(state);  // A end — Dennis's next turn-end
  assert.ok(dennis.hp >= 55, `expected at least +5 HP by Dennis's next turn-end; hp=${dennis.hp}`);
});

// =============================================================================
// Section 7 — FUSION ACTIVE: dennis6 "End of Shift"
//   "Dennis takes 25 Affliction damage, then uses HS-112 Fury Serum, HS-46 Ascendant Serum, and
//    HS-88 Reconstitution Serum on himself."
// =============================================================================
test("dennis6: Dennis takes 25 Affliction (plus the 5 from the inlined Ascendant self-affliction)", () => {
  const { state, dennis } = freshDennisVsOne();
  const r = performAction(state, { unit: "dennis", skillId: "dennis6", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(dennis.hp, 100 - 25 - 5, "25 from End of Shift + 5 from inlined HS-46 (Affliction bypasses DR)");
});

test("dennis6: then uses HS-112 Fury, HS-46 Ascendant and HS-88 Reconstitution on himself", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis6", targets: [] });
  assert.equal(hasFury(dennis), true, "Fury Serum was used");
  assert.equal(furyDuration(dennis), 4, "Fury window is 4 turns");
  assert.equal(hasAscendant(dennis), true, "Ascendant Serum was used (mark present)");
  assert.equal(hasNonDamageIgnore(dennis), true, "Ascendant Serum was used (non-damage-ignore window present)");
  assert.equal(reconRegen(dennis), 5, "Reconstitution Serum was used (5-HP/turn regen present)");
});

test("dennis6 CONTROL: without End of Shift, none of those three serum effects are present", () => {
  const { state, dennis } = freshDennisVsOne();
  assert.equal(hasFury(dennis), false);
  assert.equal(hasAscendant(dennis), false);
  assert.equal(reconRegen(dennis), undefined);
});

// =============================================================================
// Section 8 — Cost / cooldown / legality (from the frozen skill definitions)
// =============================================================================
test("dennis2 goes on a 3-turn cooldown and cannot be recast the same turn", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  const s = dennis.skills!.find((k) => k.id === "dennis2")!;
  assert.equal(s.currentCd, 3, "cooldown 3 per frozen");
  const again = performAction(state, { unit: "dennis", skillId: "dennis2", targets: [] });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "on-cooldown");
});

test("dennis6 goes on a 3-turn cooldown per frozen", () => {
  const { state, dennis } = freshDennisVsOne();
  performAction(state, { unit: "dennis", skillId: "dennis6", targets: [] });
  const s = dennis.skills!.find((k) => k.id === "dennis6")!;
  assert.equal(s.currentCd, 3, "cooldown 3 per frozen");
});

test("dennis1 is rejected for insufficient energy when the pool cannot pay its 1 Generic", () => {
  const { state } = freshDennisVsOne();
  state.teams.A.energy = {};
  const r = performAction(state, { unit: "dennis", skillId: "dennis1", targets: ["e"] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "insufficient-energy");
});

test("dennis3 pays its Specific cost from Dennis's own element (serum)", () => {
  const { state } = freshDennisVsOne();
  state.teams.A.energy = { serum: 1 }; // exactly one serum, no generic
  const r = performAction(state, { unit: "dennis", skillId: "dennis3", targets: [] });
  assert.equal(r.ok, true, "the 1 Specific is payable from the serum pool");
  assert.equal(state.teams.A.energy.serum ?? 0, 0, "the serum was spent");
});
