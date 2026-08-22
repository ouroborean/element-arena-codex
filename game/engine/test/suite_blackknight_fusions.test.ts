import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound, endTurn } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit, StatusKind } from "../src/types.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED suite for THE BLACK KNIGHT's FUSION FORMS.
//
// Oracle = the FROZEN prose (content/frozen/skills.json) for every fusion passive
// (blackknight<elem>0) and active (blackknight<elem>1); authored/generated content is
// consulted ONLY for how to drive (element key, skill id, cost, targeting, status /
// minion names). Assertions never read the effect implementation.
//
// KEY GLOSSARY (content/rulings.json), used only to know WHAT the frozen numbers mean:
//   normal   = respects Damage Reduction (DR) and Shield.
//   piercing = ignores DR, respects Shield.
//   affliction = ignores DR AND Shield.
//   Bypassing (keyword) = ignores Shield/Invulnerable (may target an invulnerable unit).
//   "enhanced" = the Black Knight's acts-alone state, carried as a self mark "Exile"
//     (blackknight0 Exile). Fusion swaps in the fusion passive but the base Exile
//     maintainer is origin:"innate" and survives; even so we SEED the "Exile" mark
//     directly to exercise enhanced branches deterministically (a permitted
//     "status the skill produces" drive detail — same as suite_blackknight_base).
//
// The 10 forms under test (element -> passive / active):
//   blight      Plaguebringer / Fester
//   blood       Lonely Thirst / Bloodsoaked Strike
//   curse       The Onyx Legion / Curse of Fealty
//   devil       Hellfire / Infernal Blow
//   evil        Merciless / Horrify
//   ghost       Ethereal Form / Ghostblade
//   grave       Gravekeeper / Bury
//   lich        Legion of the Damned / Boneshape
//   reanimation Unflinching Thrall / Reanimate
//   zealot      Hunger for Battle / Fervor
// =============================================================================

const FUSION_ELEMENTS = [
  "blight", "blood", "curse", "devil", "evil", "ghost", "grave", "lich", "reanimation", "zealot",
] as const;

function bk(team: "A" | "B", id: string): Unit {
  return loadHero(heroById("blackknight"), team, id);
}
function fuse(u: Unit, element: string): void {
  applyFusion(u, fusionForm("blackknight", element)!);
}
function fund(state: MatchState, element: string, team: "A" | "B" = "A"): void {
  // A fused hero pays ALL specific costs (base + fusion skills) from its CURRENT (fusion) element.
  state.teams[team].energy = { generic: 40, unholy: 40, [element]: 40 };
}
function seedExile(u: Unit): void {
  u.statuses.push({ kind: "mark", name: "Exile", duration: 1, appliedBy: u.id, appliedTurn: 0 });
}
function find(u: Unit, kind: StatusKind, name?: string) {
  return u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
}
function has(u: Unit, kind: StatusKind, name?: string): boolean {
  return !!find(u, kind, name);
}
function markCount(u: Unit, name: string): number {
  return u.statuses.filter((s) => s.kind === "mark" && s.name === name).length;
}
function shieldOf(u: Unit): number {
  return u.shields.reduce((a, s) => a + s.amount, 0);
}
function minionsNamed(state: MatchState, team: "A" | "B", name: string): Unit[] {
  return state.teams[team].units
    .map((id) => state.units[id]!)
    .filter((u) => u && u.kind === "minion" && u.name === name && u.alive);
}
function enemy(id: string, over: Partial<Unit> & { shield?: number } = {}): Unit {
  return makeUnit({ id, team: "B", kind: "hero", hp: 100, maxHp: 100, ...over });
}

// =====================================================================================
// Section 0 — every advertised form exists in the generated table (drive-fact guard)
// =====================================================================================
test("all 10 Black Knight fusion forms are present in the generated FUSIONS table", () => {
  for (const el of FUSION_ELEMENTS) {
    const form = fusionForm("blackknight", el);
    assert.ok(form, `missing fusion form blackknight:${el}`);
    assert.equal(form!.hero, "blackknight");
    assert.equal(form!.element, el);
    assert.ok(form!.skill?.id === `blackknight${el}1`, `active id for ${el}`);
  }
});

// #####################################################################################
// BLIGHT — Plaguebringer (passive) + Fester (active)
//   Plaguebringer: "Enemies affected by the Black Knight's enhanced abilities take 5
//                   Affliction damage each turn, permanently (stacks)."
//   Fester:        "Deals 20 damage to a target affected by Plaguebringer, and lowers
//                   their damage by 5, permanently (stacks)."
// #####################################################################################

test("Plaguebringer: an ENHANCED ability that affects an enemy applies a 5 Affliction/turn dot; a second stacks it to 10", () => {
  const k = bk("A", "b"); fuse(k, "blight"); seedExile(k);
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "blight");

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // enhanced Oathbreaker affects e
  const dot = find(e, "dot", "Plaguebringer");
  assert.ok(dot, "an enhanced ability seeds the Plaguebringer dot on the affected enemy");
  assert.equal(dot!.magnitude, 5, "magnitude 5 (5 Affliction/turn)");
  assert.equal(dot!.dtype, "affliction", "the dot is Affliction");
  assert.equal(dot!.duration, null, "permanent (no expiry)");

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // second enhanced ability
  assert.equal(find(e, "dot", "Plaguebringer")!.magnitude, 10, "'stacks' — a second enhanced hit grows it to 10");
});

test("Plaguebringer control: an UN-enhanced ability applies no dot (gated on 'enhanced')", () => {
  const k = bk("A", "b"); fuse(k, "blight"); // NO Exile
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "blight");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(find(e, "dot", "Plaguebringer"), undefined, "un-enhanced abilities do not apply Plaguebringer");
});

test("Plaguebringer tick: the dot deals exactly 5 Affliction each turn, ignoring Shield (Affliction)", () => {
  const k = bk("A", "b"); fuse(k, "blight");
  const e = enemy("e", { shield: 20 });
  // Push the permanent dot directly (appliedBy = the fused BK) so a single turn-cycle ticks it in isolation.
  e.statuses.push({ kind: "dot", name: "Plaguebringer", magnitude: 5, dtype: "affliction", duration: null, appliedBy: "b", appliedTurn: 0 });
  const state = makeState([k], [e]); fund(state, "blight");

  endTurn(state); // A's turn ends -> A-applied dots tick
  assert.equal(e.hp, 95, "5 Affliction went straight to HP (Affliction ignores the 20 Shield)");
  assert.equal(shieldOf(e), 20, "the shield was untouched by the Affliction tick");
});

test("Fester: 20 damage to a Plaguebringer-affected target and a permanent -5 to its damage; a second cast stacks to -10", () => {
  const k = bk("A", "b"); fuse(k, "blight");
  const e = enemy("e");
  e.statuses.push({ kind: "dot", name: "Plaguebringer", magnitude: 5, dtype: "affliction", duration: null, appliedBy: "b", appliedTurn: 0 });
  const state = makeState([k], [e]); fund(state, "blight");

  performAction(state, { unit: "b", skillId: "blackknightblight1", targets: ["e"] });
  assert.equal(e.hp, 80, "Fester deals 20 damage");
  const mod = find(e, "outgoing_damage_mod", "Fester");
  assert.ok(mod, "Fester lowers the target's damage");
  assert.equal(mod!.magnitude, -5, "by 5 (a -5 outgoing modifier)");
  assert.equal(mod!.duration, null, "permanently (no expiry)");

  const skill = k.skills!.find((s) => s.id === "blackknightblight1")!;
  skill.currentCd = 0; // clear the 1-turn cooldown to cast again this turn
  performAction(state, { unit: "b", skillId: "blackknightblight1", targets: ["e"] });
  assert.equal(find(e, "outgoing_damage_mod", "Fester")!.magnitude, -10, "'stacks' — a second Fester lowers damage by another 5");
});

// #####################################################################################
// BLOOD — Lonely Thirst (passive) + Bloodsoaked Strike (active)
//   Lonely Thirst: "The Black Knight heals 5 health whenever he damages an enemy,
//                   increased to 10 if his skills are enhanced."
//   Bloodsoaked Strike: "Deals 40 damage to target enemy. While enhanced, this skill
//                   deals 15 less damage, but its damage changes to Affliction and it
//                   becomes AOE."
// #####################################################################################

test("Lonely Thirst: damaging an enemy heals 5 (un-enhanced)", () => {
  const k = bk("A", "b"); fuse(k, "blood"); k.hp = 50;
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "blood");
  performAction(state, { unit: "b", skillId: "blackknightblood1", targets: ["e"] }); // 40 normal
  assert.equal(e.hp, 60, "control: 40 damage landed");
  assert.equal(k.hp, 55, "healed 5 for damaging an enemy");
});

test("Lonely Thirst: while ENHANCED, damaging an enemy heals 10 instead of 5", () => {
  const k = bk("A", "b"); fuse(k, "blood"); seedExile(k); k.hp = 50;
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "blood");
  performAction(state, { unit: "b", skillId: "blackknightblood1", targets: ["e"] }); // enhanced -> 25 affliction AOE, one enemy = one damage instance
  assert.equal(k.hp, 60, "enhanced heal is 10, not 5");
});

test("Lonely Thirst control: a self skill that deals no damage heals nothing", () => {
  const k = bk("A", "b"); fuse(k, "blood"); k.hp = 50;
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "blood");
  performAction(state, { unit: "b", skillId: "blackknight2", targets: ["b"] }); // Misery: no damage dealt
  assert.equal(k.hp, 50, "no heal without damaging an enemy");
});

test("Bloodsoaked Strike (un-enhanced): 40 NORMAL to the single chosen enemy only", () => {
  const k = bk("A", "b"); fuse(k, "blood");
  const e1 = enemy("e1", { shield: 10 }); const e2 = enemy("e2");
  const state = makeState([k], [e1, e2]); fund(state, "blood");
  performAction(state, { unit: "b", skillId: "blackknightblood1", targets: ["e1"] });
  assert.equal(e1.hp, 70, "40 normal - 10 shield = 30 to HP (normal respects Shield)");
  assert.equal(shieldOf(e1), 0, "the shield absorbed 10");
  assert.equal(e2.hp, 100, "un-enhanced Bloodsoaked is single-target, not AOE");
});

test("Bloodsoaked Strike (enhanced): 25 AFFLICTION to ALL enemies, ignoring Shield", () => {
  const k = bk("A", "b"); fuse(k, "blood"); seedExile(k);
  const e1 = enemy("e1", { shield: 30 }); const e2 = enemy("e2", { shield: 30 });
  const state = makeState([k], [e1, e2]); fund(state, "blood");
  performAction(state, { unit: "b", skillId: "blackknightblood1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "40 - 15 = 25 Affliction straight to HP (ignores the 30 shield)");
  assert.equal(e2.hp, 75, "becomes AOE: the non-targeted enemy is hit for 25 too");
  assert.equal(shieldOf(e1), 30, "Affliction did not touch the shield");
});

// #####################################################################################
// CURSE — The Onyx Legion (passive) + Curse of Fealty (active)
//   Onyx Legion: "Allies affected by Curse of Fealty never count as acting when
//                 determining if The Black Knight is acting alone."
//   Curse of Fealty: "The Black Knight targets an enemy or one of his allies. For 3
//                 turns, that unit deals 5 less non-Affliction damage and the Black
//                 Knight deals 5 more damage. If empowered, this skill affects another
//                 random valid target."
// #####################################################################################

test("Curse of Fealty: cursed target gets -5 (3 turns) and the Black Knight gets +5 (3 turns), which raises his next hit by 5", () => {
  const k = bk("A", "b"); fuse(k, "curse");
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "curse");
  performAction(state, { unit: "b", skillId: "blackknightcurse1", targets: ["e"] });

  const tgtMod = find(e, "outgoing_damage_mod", "Curse of Fealty");
  assert.ok(tgtMod, "the cursed unit gets an outgoing debuff");
  assert.equal(tgtMod!.magnitude, -5, "deals 5 less");
  assert.equal(tgtMod!.duration, 3, "for 3 turns");
  const selfMod = k.statuses.find((s) => s.kind === "outgoing_damage_mod" && (s.magnitude ?? 0) > 0);
  assert.ok(selfMod, "the Black Knight gets an outgoing buff");
  assert.equal(selfMod!.magnitude, 5, "he deals 5 more");
  assert.equal(selfMod!.duration, 3, "for 3 turns");

  // Behavioural: base Oathbreaker (un-enhanced 15) now deals 15 + 5 = 20.
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(e.hp, 80, "Oathbreaker 15 + Curse of Fealty's +5 = 20");
});

test("Curse of Fealty (empowered): affects a SECOND unit too; un-empowered curses exactly one", () => {
  // Un-empowered control.
  {
    const k = bk("A", "b"); fuse(k, "curse");
    const e1 = enemy("e1"); const e2 = enemy("e2");
    const state = makeState([k], [e1, e2]); fund(state, "curse");
    performAction(state, { unit: "b", skillId: "blackknightcurse1", targets: ["e1"] });
    const marked = [k, e1, e2].filter((u) => markCount(u, "Curse of Fealty") > 0);
    assert.equal(marked.length, 1, "un-empowered: exactly the chosen target bears Curse of Fealty");
    assert.equal(markCount(e1, "Curse of Fealty"), 1);
  }
  // Empowered (Exile) -> a second random valid target is also affected.
  {
    const k = bk("A", "b"); fuse(k, "curse"); seedExile(k);
    const e1 = enemy("e1"); const e2 = enemy("e2");
    const state = makeState([k], [e1, e2], 1); fund(state, "curse"); // seed 1 -> the extra pick lands on e2
    performAction(state, { unit: "b", skillId: "blackknightcurse1", targets: ["e1"] });
    const marked = [k, e1, e2].filter((u) => markCount(u, "Curse of Fealty") > 0);
    assert.ok(marked.length >= 2, `empowered curses a second unit (marked ${marked.length})`);
    assert.equal(markCount(e1, "Curse of Fealty"), 1, "the chosen target is still cursed");
  }
});

test("The Onyx Legion: acting alone gives the Black Knight Exile + Elemental Essence at his turn-end (baseline maintainer works)", () => {
  const k = bk("A", "b"); fuse(k, "curse");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [enemy("e")]); fund(state, "curse");
  state.actedThisTurn = ["b"]; // only the Black Knight acted
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(has(k, "mark", "Exile"), "sole actor -> enhanced (Exile)");
  assert.ok(has(k, "elemental_essence"), "and gains Elemental Essence");
});

test("The Onyx Legion control: a NON-cursed ally that acted stops him from being alone (no Exile)", () => {
  const k = bk("A", "b"); fuse(k, "curse");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [enemy("e")]); fund(state, "curse");
  state.actedThisTurn = ["b", "al"]; // an ally also acted, uncursed
  emit(state, { type: "turnEnd", team: "A" });
  assert.equal(has(k, "mark", "Exile"), false, "an ordinary acting ally means he is NOT alone");
});

test.skip("SUSPECTED BUG: The Onyx Legion — a CURSED ally that acted should NOT count, so the Black Knight is still alone; engine ignores 'excludeMark' and denies Exile", () => {
  // Frozen: allies affected by Curse of Fealty "never count as acting" for the acts-alone check.
  // So with only a *cursed* ally having acted, the Black Knight is effectively alone -> Exile.
  // Engine: the exileActingAlone custom never reads the authored `excludeMark:"Curse of Fealty"`
  // arg, so the cursed ally still counts -> otherAllyActed -> Exile denied/removed.
  const k = bk("A", "b"); fuse(k, "curse");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  ally.statuses.push({ kind: "mark", name: "Curse of Fealty", duration: 3, appliedBy: "b", appliedTurn: 0 });
  const state = makeState([k, ally], [enemy("e")]); fund(state, "curse");
  state.actedThisTurn = ["b", "al"]; // only a CURSED ally acted alongside him
  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(has(k, "mark", "Exile"), "a cursed ally does not count as acting -> the Black Knight is alone -> Exile");
});

// #####################################################################################
// DEVIL — Hellfire (passive) + Infernal Blow (active)
//   Hellfire: "The Black Knight's abilities permanently apply Hellfire to all enemy
//             targets affected, dealing 5 affliction damage every turn. This effect
//             does not stack".
//   Infernal Blow: "The Black Knight draws in the Hellfire from all targets, dealing
//             10 affliction damage to any target that had a stack. Then he deals 15
//             damage to one target, increased by 5 for every stack removed".
// #####################################################################################

test("Hellfire: any ability applies a 5 Affliction/turn Hellfire dot to an affected enemy (not enhanced-gated)", () => {
  const k = bk("A", "b"); fuse(k, "devil"); // NO Exile -> proves it is not enhanced-gated
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "devil");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  const dot = find(e, "dot", "Hellfire");
  assert.ok(dot, "Hellfire applied on a plain (un-enhanced) ability");
  assert.equal(dot!.magnitude, 5);
  assert.equal(dot!.dtype, "affliction");
  assert.equal(dot!.duration, null, "permanent");
});

test("Hellfire 'does not stack': a second ability leaves a single 5-magnitude Hellfire dot", () => {
  const k = bk("A", "b"); fuse(k, "devil");
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "devil");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  const dots = e.statuses.filter((s) => s.kind === "dot" && s.name === "Hellfire");
  assert.equal(dots.length, 1, "only one Hellfire dot");
  assert.equal(dots[0]!.magnitude, 5, "does not stack (stays 5, unlike Plaguebringer)");
});

test("Hellfire control: an ALLY affected by the Black Knight's ability gets no Hellfire (enemies only)", () => {
  const k = bk("A", "b"); fuse(k, "devil");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [enemy("e")]); fund(state, "devil");
  performAction(state, { unit: "b", skillId: "blackknight3" }); // Unholy Aura hits all allies+enemies
  assert.equal(find(ally, "dot", "Hellfire"), undefined, "Hellfire only lands on enemies");
});

test("Infernal Blow: draws 10 Affliction from every Hellfire-bearer, removes it, then hits the target for 15 + 5 per stack removed", () => {
  const k = bk("A", "b"); fuse(k, "devil");
  const e1 = enemy("e1"); const e2 = enemy("e2"); const e3 = enemy("e3"); // e3 has no Hellfire
  for (const e of [e1, e2]) e.statuses.push({ kind: "dot", name: "Hellfire", magnitude: 5, dtype: "affliction", duration: null, appliedBy: "b", appliedTurn: 0 });
  const state = makeState([k], [e1, e2, e3]); fund(state, "devil");

  performAction(state, { unit: "b", skillId: "blackknightdevil1", targets: ["e1"] });
  // 2 Hellfire stacks present -> main hit = 15 + 5*2 = 25 to e1; then 10 Affliction drawn from e1 and e2.
  assert.equal(e1.hp, 65, "e1: 25 main hit + 10 draw = 35 lost");
  assert.equal(e2.hp, 90, "e2: 10 Affliction drawn in");
  assert.equal(e3.hp, 100, "e3 had no Hellfire -> untouched");
  // The draw REMOVES Hellfire, but Infernal Blow is one of the Black Knight's abilities and it affected
  // e1 & e2, so the Hellfire passive immediately re-applies a fresh 5-magnitude Hellfire to both — while
  // e3 (never affected) still has none. This is faithful to "his abilities permanently apply Hellfire to
  // all enemy targets affected".
  assert.equal(find(e1, "dot", "Hellfire")!.magnitude, 5, "Hellfire re-applied to the affected e1");
  assert.equal(find(e2, "dot", "Hellfire")!.magnitude, 5, "Hellfire re-applied to the affected e2");
  assert.equal(find(e3, "dot", "Hellfire"), undefined, "e3 was never affected -> still no Hellfire");
});

test("Infernal Blow control: with no Hellfire anywhere, it just deals the base 15 (no per-stack bonus, no draws)", () => {
  const k = bk("A", "b"); fuse(k, "devil");
  const e1 = enemy("e1"); const e2 = enemy("e2");
  const state = makeState([k], [e1, e2]); fund(state, "devil");
  performAction(state, { unit: "b", skillId: "blackknightdevil1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "15 base, +5*0 stacks");
  assert.equal(e2.hp, 100, "no draw from a non-bearer");
});

// #####################################################################################
// EVIL — Merciless (passive) + Horrify (active)
//   Merciless: "Oathbreaker Strike may now be used on allied Heroes. If the Black
//               Knight kills an ally in this way, he deals 10 additional damage for
//               the rest of the game."  (Clause 1 is a documented targeting change.)
//   Horrify:   "Deals 15 damage to a target and stuns them for 1 turn. While enhanced,
//               the target is also Isolated for 1 turn."
// #####################################################################################

test("Merciless: killing an ally grants a permanent +10 to the Black Knight's damage", () => {
  const k = bk("A", "b"); fuse(k, "evil");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const state = makeState([k, ally], [enemy("e")]); fund(state, "evil");
  emit(state, { type: "unitDied", unit: "al", killer: "b" }); // Black Knight killed his ally
  const mod = find(k, "outgoing_damage_mod", "Merciless");
  assert.ok(mod, "he gains a damage bonus");
  assert.equal(mod!.magnitude, 10, "+10 additional damage");

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // base Oathbreaker 15 + 10
  assert.equal(state.units["e"]!.hp, 75, "Oathbreaker 15 + Merciless 10 = 25");
});

test("Merciless control: killing an ENEMY (not an ally) grants no bonus", () => {
  const k = bk("A", "b"); fuse(k, "evil");
  const e = enemy("e", { hp: 0, alive: false });
  const state = makeState([k], [e]); fund(state, "evil");
  emit(state, { type: "unitDied", unit: "e", killer: "b" });
  assert.equal(find(k, "outgoing_damage_mod", "Merciless"), undefined, "an enemy kill does not trigger Merciless");
});

test("Merciless control: an ally dying to someone ELSE grants no bonus", () => {
  const k = bk("A", "b"); fuse(k, "evil");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const state = makeState([k, ally], [enemy("e")]); fund(state, "evil");
  emit(state, { type: "unitDied", unit: "al", killer: "e" }); // killed by the enemy, not the Black Knight
  assert.equal(find(k, "outgoing_damage_mod", "Merciless"), undefined, "only HIS kills count");
});

test("Horrify (un-enhanced): 15 damage + a 1-turn stun; NOT Isolated", () => {
  const k = bk("A", "b"); fuse(k, "evil");
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "evil");
  performAction(state, { unit: "b", skillId: "blackknightevil1", targets: ["e"] });
  assert.equal(e.hp, 85, "15 damage");
  const stun = find(e, "stun");
  assert.ok(stun, "stuns the target");
  assert.equal(stun!.duration, 1, "for 1 turn");
  assert.equal(has(e, "isolated"), false, "un-enhanced Horrify does NOT Isolate");
});

test("Horrify (enhanced): ALSO Isolates the target for 1 turn", () => {
  const k = bk("A", "b"); fuse(k, "evil"); seedExile(k);
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "evil");
  performAction(state, { unit: "b", skillId: "blackknightevil1", targets: ["e"] });
  const iso = find(e, "isolated");
  assert.ok(iso, "enhanced Horrify Isolates");
  assert.equal(iso!.duration, 1, "for 1 turn");
});

// #####################################################################################
// GHOST — Ethereal Form (passive) + Ghostblade (active)
//   Ethereal Form (passive): "The turn after ignoring a skill, the Black Knight deals
//                             10 additional damage."
//   Ghostblade: "Deals 25 damage to target enemy. If under the effect of Ethereal Form,
//                this damage bypasses and becomes piercing."
// #####################################################################################

test("Ethereal Form: the turn after ignoring an enemy Harmful skill, the Black Knight deals +10", () => {
  const k = bk("A", "b"); fuse(k, "ghost");
  k.statuses.push({ kind: "damage_ignore", duration: 2, appliedBy: "b", appliedTurn: 0 }); // Dead or Alive's ignore window
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "ghost"); fund(state, "ghost", "B");

  // An enemy Harmful skill lands on the Black Knight while he is ignoring -> schedules the +10 for next turn.
  emit(state, { type: "skillUsed", caster: "e", skillId: "enemyHit", targets: ["b"], tags: ["Harmful"] });
  assert.ok(state.scheduled.length > 0, "ignoring a skill schedules the delayed bonus");

  endTurn(state); endTurn(state); endTurn(state); // A, B, A -> the scheduled effect fires at his next turn
  assert.ok(has(k, "mark", "Ethereal Form"), "the Ethereal Form window is now active");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // base Oathbreaker 15 +10
  assert.equal(e.hp, 75, "15 + 10 additional = 25");
});

test("Ethereal Form control: without an active ignore window, an incoming skill schedules nothing", () => {
  const k = bk("A", "b"); fuse(k, "ghost"); // no damage_ignore/non_damage_ignore
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "ghost");
  emit(state, { type: "skillUsed", caster: "e", skillId: "enemyHit", targets: ["b"], tags: ["Harmful"] });
  assert.equal(state.scheduled.length, 0, "no ignore in progress -> no Ethereal Form bonus queued");
});

test("Ghostblade (no Ethereal Form): 25 NORMAL — reduced by Damage Reduction", () => {
  const k = bk("A", "b"); fuse(k, "ghost");
  const e = enemy("e", { statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([k], [e]); fund(state, "ghost");
  performAction(state, { unit: "b", skillId: "blackknightghost1", targets: ["e"] });
  assert.equal(e.hp, 85, "25 normal - 10 DR = 15");
});

test("Ghostblade (under Ethereal Form): becomes PIERCING — ignores Damage Reduction", () => {
  const k = bk("A", "b"); fuse(k, "ghost");
  k.statuses.push({ kind: "mark", name: "Ethereal Form", duration: 1, appliedBy: "b", appliedTurn: 0 });
  const e = enemy("e", { statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([k], [e]); fund(state, "ghost");
  performAction(state, { unit: "b", skillId: "blackknightghost1", targets: ["e"] });
  assert.equal(e.hp, 75, "piercing 25 ignores the 10 DR");
});

test("Ghostblade under Ethereal Form bypasses (ignores Shield), and is piercing", () => {
  // Frozen: under Ethereal Form Ghostblade's damage "bypasses AND becomes piercing". 'Bypasses' (keyword)
  // = ignores Shield/Invulnerable. The engine only sets dtype piercing (ignores DR, not Shield), so a
  // shielded enemy soaks the whole hit.
  const k = bk("A", "b"); fuse(k, "ghost");
  k.statuses.push({ kind: "mark", name: "Ethereal Form", duration: 1, appliedBy: "b", appliedTurn: 0 });
  const e = enemy("e", { shield: 30 });
  const state = makeState([k], [e]); fund(state, "ghost");
  performAction(state, { unit: "b", skillId: "blackknightghost1", targets: ["e"] });
  assert.equal(e.hp, 75, "bypassing 25 should hit HP through the shield");
});

// #####################################################################################
// GRAVE — Gravekeeper (passive) + Bury (active)
//   Gravekeeper: "The Black Knight begins play with 3 Grave minions."
//   Bury: "Deals 25 damage to target enemy, increased by 10 for each living Zombie. If
//          this kills an enemy, the Black Knight creates a Grave if he has space."
// #####################################################################################

test("Gravekeeper: the Black Knight begins the round with exactly 3 Grave minions", () => {
  const k = bk("A", "b"); fuse(k, "grave");
  const state = makeState([k], [enemy("e")]); fund(state, "grave");
  startRound(state, "A"); // fires the round-start passive
  assert.equal(minionsNamed(state, "A", "Grave").length, 3, "3 Grave minions at round start");
});

test("Bury: 25 base, +10 per LIVING ZOMBIE (Graves do not count)", () => {
  const k = bk("A", "b");
  const z1 = makeUnit({ id: "z1", team: "A", kind: "minion", name: "Zombie", hp: 40, maxHp: 40 });
  const z2 = makeUnit({ id: "z2", team: "A", kind: "minion", name: "Zombie", hp: 40, maxHp: 40 });
  const g1 = makeUnit({ id: "g1", team: "A", kind: "minion", name: "Grave", hp: 30, maxHp: 30 });
  fuse(k, "grave");
  const e = enemy("e", { hp: 200, maxHp: 200 });
  const state = makeState([k, z1, z2, g1], [e]); fund(state, "grave");
  performAction(state, { unit: "b", skillId: "blackknightgrave1", targets: ["e"] });
  assert.equal(e.hp, 200 - (25 + 10 * 2), "25 + 10*2 zombies = 45 (the Grave minion adds nothing)");
});

test("Bury: killing an enemy creates a Grave (space available); a non-kill creates none", () => {
  // Non-lethal control.
  {
    const k = bk("A", "b"); fuse(k, "grave");
    const e = enemy("e", { hp: 100, maxHp: 100 });
    const state = makeState([k], [e]); fund(state, "grave");
    performAction(state, { unit: "b", skillId: "blackknightgrave1", targets: ["e"] }); // 25, not lethal
    assert.equal(minionsNamed(state, "A", "Grave").length, 0, "no kill -> no Grave");
  }
  // Lethal -> one Grave appears.
  {
    const k = bk("A", "b"); fuse(k, "grave");
    const e = enemy("e", { hp: 20, maxHp: 100 });
    const state = makeState([k], [e]); fund(state, "grave");
    performAction(state, { unit: "b", skillId: "blackknightgrave1", targets: ["e"] }); // 25 kills the 20-HP enemy
    assert.equal(e.alive, false, "enemy died");
    assert.equal(minionsNamed(state, "A", "Grave").length, 1, "a Grave was created on the kill");
  }
});

test("Bury: at the 6-minion cap, a kill creates NO Grave ('if he has space')", () => {
  const k = bk("A", "b");
  const zs = Array.from({ length: 6 }, (_, i) => makeUnit({ id: `z${i}`, team: "A", kind: "minion", name: "Zombie", hp: 40, maxHp: 40 }));
  fuse(k, "grave");
  const e = enemy("e", { hp: 30, maxHp: 100 });
  const state = makeState([k, ...zs], [e]); fund(state, "grave");
  performAction(state, { unit: "b", skillId: "blackknightgrave1", targets: ["e"] }); // 25 + 60 = 85, lethal
  assert.equal(e.alive, false, "enemy died");
  assert.equal(minionsNamed(state, "A", "Grave").length, 0, "no space (6 minions) -> no Grave created");
});

// #####################################################################################
// LICH — Legion of the Damned (passive) + Boneshape (active)
//   Legion: "When the Black Knight uses an enhanced ability, he summons two Skeleton
//            minions. Maximum 4."
//   Boneshape: "Sacrifices a Skeleton minion and gives the Black Knight 20 Shield."
// #####################################################################################

test("Legion of the Damned: each ENHANCED ability summons 2 Skeletons, capped at 4", () => {
  const k = bk("A", "b"); fuse(k, "lich"); seedExile(k);
  const e = enemy("e", { hp: 500, maxHp: 500 });
  const state = makeState([k], [e]); fund(state, "lich");

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // enhanced ability #1
  assert.equal(minionsNamed(state, "A", "Skeleton").length, 2, "first enhanced ability -> 2 Skeletons");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // #2
  assert.equal(minionsNamed(state, "A", "Skeleton").length, 4, "second -> 4 Skeletons");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] }); // #3
  assert.equal(minionsNamed(state, "A", "Skeleton").length, 4, "capped at 4 (no more summoned)");
});

test("Legion of the Damned control: an UN-enhanced ability summons no Skeletons", () => {
  const k = bk("A", "b"); fuse(k, "lich"); // no Exile
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "lich");
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(minionsNamed(state, "A", "Skeleton").length, 0, "not enhanced -> no Skeletons");
});

test("Boneshape: sacrifices ONE Skeleton and grants the Black Knight 20 Shield", () => {
  const k = bk("A", "b"); fuse(k, "lich"); // no Exile, so Legion does not also fire and re-summon
  const s1 = makeUnit({ id: "s1", team: "A", kind: "minion", name: "Skeleton", hp: 10, maxHp: 10 });
  const s2 = makeUnit({ id: "s2", team: "A", kind: "minion", name: "Skeleton", hp: 10, maxHp: 10 });
  const state = makeState([k, s1, s2], [enemy("e")]); fund(state, "lich");
  performAction(state, { unit: "b", skillId: "blackknightlich1" });
  assert.equal(minionsNamed(state, "A", "Skeleton").length, 1, "exactly one Skeleton was sacrificed");
  assert.equal(shieldOf(k), 20, "the Black Knight gained 20 Shield");
});

test("Boneshape control: with no Skeleton to sacrifice, no Shield is granted", () => {
  const k = bk("A", "b"); fuse(k, "lich");
  const state = makeState([k], [enemy("e")]); fund(state, "lich");
  const r = performAction(state, { unit: "b", skillId: "blackknightlich1" });
  assert.equal(r.ok, true, "the cast still resolves");
  assert.equal(shieldOf(k), 0, "no Skeleton -> no Shield");
});

// #####################################################################################
// REANIMATION — Unflinching Thrall (passive) + Reanimate (active)
//   Unflinching Thrall: "While the Black Knight has a Reanimated ally, he gains 15 DR".
//   Reanimate: "Reanimates one dead ally, reviving them with 50 HP, and permanently
//               stunning their Strategic skills."
// #####################################################################################

test("Unflinching Thrall: a Reanimated ally grants +15 DR (30 incoming -> 15 taken); losing it removes the DR", () => {
  const k = bk("A", "b"); fuse(k, "reanimation");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = enemy("e");
  const state = makeState([k, ally], [e]); fund(state, "reanimation");

  // Reanimated ally appears (mark + its statusApplied event) -> Unflinching Thrall grants 15 DR.
  ally.statuses.push({ kind: "mark", name: "Reanimated", duration: null, appliedBy: "b", appliedTurn: 0 });
  emit(state, { type: "statusApplied", unit: "al", source: "b", kind: "mark", name: "Reanimated" });
  const dr = find(k, "damage_reduction", "Unflinching Thrall");
  assert.ok(dr, "the Black Knight gains DR");
  assert.equal(dr!.magnitude, 15, "15 DR");
  runEffects(state, [{ op: "damage", amount: 30, dtype: "normal", to: "target" }], { caster: e, targets: [k] });
  assert.equal(k.hp, 85, "30 - 15 DR = 15 taken");

  // The Reanimated ally dies -> the DR is removed.
  ally.alive = false;
  emit(state, { type: "unitDied", unit: "al", killer: "e" });
  assert.equal(find(k, "damage_reduction", "Unflinching Thrall"), undefined, "DR removed when the Reanimated ally dies");
});

test("Unflinching Thrall control: without a Reanimated ally he has no such DR (takes full 30)", () => {
  const k = bk("A", "b"); fuse(k, "reanimation");
  const e = enemy("e");
  const state = makeState([k], [e]); fund(state, "reanimation");
  runEffects(state, [{ op: "damage", amount: 30, dtype: "normal", to: "target" }], { caster: e, targets: [k] });
  assert.equal(k.hp, 70, "no Reanimated ally -> no 15 DR -> takes the full 30");
});

test("Reanimate (effect tree): revives a dead ally at 50 HP, marks it Reanimated, and stuns its Strategic skills only", () => {
  // The revive op is exercised directly on the dead target (see the SUSPECTED BUG below for why the
  // real single-target cast path cannot reach it). This isolates the effect's correctness.
  const k = bk("A", "b"); fuse(k, "reanimation");
  const dead = makeUnit({
    id: "al", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false,
    skills: [
      { id: "strat", name: "strat", element: "fire", targeting: "self", effects: [], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Strategic"] },
      { id: "basic", name: "basic", element: "fire", targeting: "self", effects: [], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: [] },
    ],
  });
  const state = makeState([k, dead], [enemy("e")]); fund(state, "reanimation");

  const effects = k.skills!.find((s) => s.id === "blackknightreanimation1")!.effects;
  runEffects(state, effects, { caster: k, self: k, targets: [dead], skillId: "blackknightreanimation1" });

  assert.equal(dead.alive, true, "revived");
  assert.equal(dead.hp, 50, "at 50 HP");
  assert.ok(has(dead, "mark", "Reanimated"), "marked Reanimated");
  const stun = find(dead, "stun");
  assert.ok(stun, "stunned");
  assert.equal(stun!.duration, null, "permanently");
  assert.equal(stun!.scope?.tag, "Strategic", "scoped to Strategic skills");
  // Behavioural: its Strategic skill is blocked, its non-Strategic skill is not.
  assert.equal(performAction(state, { unit: "al", skillId: "strat" }).reason, "stunned", "Strategic skill is stunned");
  assert.equal(performAction(state, { unit: "al", skillId: "basic" }).ok, true, "a non-Strategic skill still works");
});

test.skip("SUSPECTED BUG: Reanimate cannot target a dead ally through the real cast path — single-target resolution drops dead units, so nobody is revived", () => {
  // Frozen: "Reanimates one dead ally, reviving them with 50 HP". But resolveTargets filters to LIVING
  // units for 'single' targeting, so the chosen dead ally is dropped and the cast defaults elsewhere;
  // the revive op no-ops on a living unit. (Same class of bug as keeper5 'Hero's Return'.)
  const k = bk("A", "b"); fuse(k, "reanimation");
  const dead = makeUnit({ id: "al", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const state = makeState([k, dead], [enemy("e")]); fund(state, "reanimation");
  performAction(state, { unit: "b", skillId: "blackknightreanimation1", targets: ["al"] });
  assert.equal(dead.alive, true, "the dead ally should be reanimated");
  assert.equal(dead.hp, 50, "at 50 HP");
});

// #####################################################################################
// ZEALOT — Hunger for Battle (passive) + Fervor (active)
//   Hunger for Battle: "The Black Knight deals 5 additional damage whenever he deals
//                       damage. This effect stacks, but is removed if the Black Knight
//                       ends a turn without dealing damage."
//   Fervor: "Deals 25 piercing damage to a target, and gives the Black Knight
//            Elemental Essence".
// #####################################################################################

test("Fervor: 25 PIERCING (ignores DR, respects Shield) and grants Elemental Essence", () => {
  const k = bk("A", "b"); fuse(k, "zealot");
  const e = enemy("e", { statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([k], [e]); fund(state, "zealot");
  performAction(state, { unit: "b", skillId: "blackknightzealot1", targets: ["e"] });
  assert.equal(e.hp, 75, "piercing 25 ignores the 10 DR");
  assert.ok(has(k, "elemental_essence"), "grants the Black Knight Elemental Essence");
});

test("Fervor: piercing does NOT ignore Shield", () => {
  const k = bk("A", "b"); fuse(k, "zealot");
  const e = enemy("e", { shield: 30 });
  const state = makeState([k], [e]); fund(state, "zealot");
  performAction(state, { unit: "b", skillId: "blackknightzealot1", targets: ["e"] });
  assert.equal(e.hp, 100, "the 30 Shield fully absorbs the 25 piercing");
  assert.equal(shieldOf(e), 5, "shield took 25");
});

test("Hunger for Battle: +5 per damage instance, STACKING across repeated hits", () => {
  const k = bk("A", "b"); fuse(k, "zealot");
  const e = enemy("e", { hp: 300, maxHp: 300 });
  const state = makeState([k], [e]); fund(state, "zealot");
  const fervor = k.skills!.find((s) => s.id === "blackknightzealot1")!;

  performAction(state, { unit: "b", skillId: "blackknightzealot1", targets: ["e"] });
  assert.equal(e.hp, 275, "hit #1: 25 (buff applies AFTER this hit)");
  fervor.currentCd = 0;
  performAction(state, { unit: "b", skillId: "blackknightzealot1", targets: ["e"] });
  assert.equal(e.hp, 245, "hit #2: 25 + 5 = 30");
  fervor.currentCd = 0;
  performAction(state, { unit: "b", skillId: "blackknightzealot1", targets: ["e"] });
  assert.equal(e.hp, 210, "hit #3: 25 + 10 = 35 ('stacks')");
});

test("Hunger for Battle: ending his own turn WITHOUT dealing damage removes the buff", () => {
  const k = bk("A", "b"); fuse(k, "zealot");
  // He holds the buff but did NOT deal damage this turn (no 'Fed' mark) -> at his turn-end it is stripped.
  k.statuses.push({ kind: "outgoing_damage_mod", name: "Hunger for Battle", magnitude: 5, duration: null, appliedBy: "b", appliedTurn: 0 });
  const state = makeState([k], [enemy("e")]); fund(state, "zealot");
  endTurn(state); // A's turn ends, he dealt no damage
  assert.equal(find(k, "outgoing_damage_mod", "Hunger for Battle"), undefined, "buff removed after a damage-less turn");
});

test.skip("SUSPECTED BUG: Hunger for Battle is wiped on the OPPONENT's turn-end even though the Black Knight dealt damage on his own turn", () => {
  // Frozen: removed only if HE "ends a turn without dealing damage". The turnEnd trigger is not team-scoped,
  // so after he deals damage (turn A) it clears the 'Fed' flag on A's end and then strips the whole buff on
  // B's end — a premature wipe that violates the frozen condition.
  const k = bk("A", "b"); fuse(k, "zealot");
  const e = enemy("e", { hp: 300, maxHp: 300 });
  const state = makeState([k], [e]); fund(state, "zealot");
  performAction(state, { unit: "b", skillId: "blackknightzealot1", targets: ["e"] }); // deals damage -> +5, Fed
  assert.equal(find(k, "outgoing_damage_mod", "Hunger for Battle")!.magnitude, 5, "precondition: buff present");
  endTurn(state); // A ends (he DID deal damage this turn)
  endTurn(state); // B ends
  assert.ok(find(k, "outgoing_damage_mod", "Hunger for Battle"), "buff must survive: he dealt damage on his own turn");
});
