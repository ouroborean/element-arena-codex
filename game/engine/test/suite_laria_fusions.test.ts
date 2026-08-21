import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { performAction, endTurn, startTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { MatchState, Status, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, FROZEN-PROSE-derived suite for LARIA's FUSION FORMS.
// Oracle = ../content/frozen/skills.json (laria<element>0 passive / laria<element>1 active).
// Authored content (fusions.authored.json) is read only to learn HOW to drive (element keys,
// skill ids, cost, status/minion names) — never to decide WHAT to assert.
//
// Each of Laria's 10 forms REPLACES her base "Deepening Shadows" passive (fusion passiveMode
// "replace") and inserts one active at slot 3. Deepening Shadows remains her stack resource,
// but the base end-of-turn self-generation trigger is gone after fusing, so DS is seeded here.
//
// FROZEN TEXT of each form (owner=laria):
//  assassin0 Ambush:            "Skills Laria uses while affected by Vanish deal double damage"
//  assassin1 Severance:         "Laria deals 10 Affliction damage to target enemy. Deals 10 more
//                                damage for each stack of Deepening Shadows on the target,
//                                removing those stacks."
//  curse0 Cursed Shadows:       "Cursed units or units with 4 stacks of Deepening Shadows have
//                                their skills costs increased by 1 Generic energy. Using a skill
//                                will remove 1 stack of Deepening Shadows."
//  curse1 Curse of Darkness:    "Target character receives 15 affliction damage and one stack of
//                                Deepening Shadows each turn for 3 turns. If they don't use a
//                                skill during that time, Curse of Darkness will copy itself to one
//                                of their allies at its current duration."
//  dimension0 In Between:       "If Laria uses Vanish or Nightwrap on herself, she will ignore
//                                Harmful effects for 1 turn. This effect has a 2 turn Cooldown."
//  dimension1 Spirit Away:      "For her next two turns, if Laria triggers In Between, she will
//                                also apply its effects to target hero. If they are an enemy, they
//                                first receive 25 true damage"
//  ion0 Dark Matter:            "When Laria uses Vanish, all stacks of Deepening Shadows on the
//                                field return to her, dealing 5 damage or healing to the character
//                                that had them. This transfer ignores the stack limit ..."
//  ion1 Dark Matter Beam:       "Deals 10 damage to target enemy for each stack of Deepening
//                                Shadows on Laria. This Consumes Deepening Shadows on use."
//  mirror0 Black Reflection:    "Whenever another Hero reaches 4 stacks of Deepening Shadows,
//                                Laria will swap her current HP with theirs."
//  mirror1 Shadow Rebound:      "For one turn, the first harmful skill used on target ally is
//                                reflected back to its user. This effect is invisible until revealed."
//  moon0 Full Moon's Night:     "Nightfall no longer makes characters invulnerable, lasts 4 turns,
//                                and causes characters with 3 or more stacks of Deepening Shadows
//                                to become Mooncursed. ..."
//  moon1 Mooncurse:             "Target unit has their Strategic skills stunned, deals 5 more
//                                non-Affliction damage, and receivies 10 Affliction damage each
//                                turn for 3 turns. This effect cannot be applied to units already
//                                affected by it."
//  night0 Deep, Dark Night:     "Once enemy heroes have a total of 10 or more stacks of Deepening
//                                Shadows, you can see all invisible effects created by your
//                                opponent. Once allied heroes have a total of 10 or more stacks ...,
//                                all allied effects become invisible."
//  night1 Snuff Out:            "Target enemy gains 3 stacks of Deepening Shadows, ignoring the
//                                stack limit. Then, if their current health is less than their
//                                stacks of Deepening Shadows x 5, Laria will execute them."
//  ninja0 Shadow Clones:        "Whenever Laria would create one or more stacks of Deepening
//                                Shadows, she instead creates a Shadow Clone minion. ..."
//  ninja1 Shadow Cross:         "Laria becomes invulnerable for 1 turn, creates a Shadow Clone,
//                                and deals 15 Piercing damage to one enemy. Until the end of the
//                                turn, Shadow Strike damage to that target is increased by 10."
//  ritual0 Ritual of Culling Night: "Laria's Ritual gains 1 Ritual Power for each stack of
//                                Deepening Shadows on the field at the end of each turn. Once ...
//                                50 Ritual Power, Laria will consume her Ritual to deal 45
//                                affliction damage to all heroes not affected by Nightcloak Candle."
//  ritual1 Nightcloak Candle:   "Target ally gains a stack of Deepening Shadows and is marked by
//                                Nightcloak Candle permanently. ... their skills deal 5 more
//                                non-Affliction damage and any enemy who uses a harmful skill on
//                                them will take 5 Affliction damage and be marked by Nightcloak
//                                Candle for 1 turn. Receiving damage this way generates 5 Ritual
//                                Power. This effect does not stack"
//  vigilante0 Evencoin:         "Each battle, the first enemy Hero to deal a killing blow receives
//                                1 Evencoin. Characters with Evencoins are treated as though they
//                                have triple their actual stacks of Deepening Shadows."
//  vigilante1 Midnight Justice: "Deals 25 damage to target enemy. If that enemy is above 50 health,
//                                their non-strategic skills are stunned for 1 turn. If they have an
//                                Evencoin, Midnight Justice deals 10 more damage and has no Cooldown"
// ===========================================================================

const DS = "Deepening Shadows";
const ds = (n: number): Status => ({ kind: "stack", name: DS, magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0 });
const dr = (n: number): Status => ({ kind: "damage_reduction", magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0 });
const vanish = (): Status => ({ kind: "damage_reduction", name: "Vanish", magnitude: 15, duration: 3, appliedBy: "seed", appliedTurn: 0 });
const evencoin = (): Status => ({ kind: "stack", name: "Evencoin", magnitude: 1, duration: null, appliedBy: "seed", appliedTurn: 0 });
const mark = (name: string, duration: number | null = null): Status => ({ kind: "mark", name, duration, appliedBy: "seed", appliedTurn: 0 });

const dsCount = (u: Unit): number => u.statuses.find((s) => s.kind === "stack" && s.name === DS)?.magnitude ?? 0;
const hasKind = (u: Unit, kind: string): boolean => u.statuses.some((s) => s.kind === kind);
const st = (u: Unit, kind: Status["kind"], name?: string): Status | undefined =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const minionsOf = (state: MatchState, team: "A" | "B", name?: string): Unit[] =>
  Object.values(state.units).filter((u) => u.kind === "minion" && u.team === team && (name === undefined || u.name === name));

function fuse(element: string, id = "la"): Unit {
  const laria = loadHero(heroById("laria"), "A", id);
  applyFusion(laria, fusionForm("laria", element)!);
  return laria;
}
function fund(state: MatchState, element: string, team: "A" | "B" = "A"): void {
  // A fused hero pays specific cost in her FUSION element; shadow covers any base-kit specific too.
  state.teams[team].energy = { generic: 40, [element]: 40, shadow: 40 };
}
const enemy = (id: string, over: Partial<Unit> = {}): Unit => makeUnit({ id, team: "B", kind: "hero", hp: 100, maxHp: 100, ...over });
const ally = (id: string, over: Partial<Unit> = {}): Unit => makeUnit({ id, team: "A", kind: "hero", hp: 100, maxHp: 100, ...over });

// ###########################################################################
// # assassin — Ambush (passive) + Severance (lariaassassin1)
// ###########################################################################

test("assassin/Ambush: while Vanish is on Laria, a 10-damage skill deals double (20)", () => {
  const laria = fuse("assassin");
  laria.statuses = [vanish()]; // affected by Vanish
  const e1 = enemy("e1"); // 0 Deepening Shadows -> Nightwrap base = 10
  const state = makeState([laria], [e1]);
  fund(state, "assassin");

  performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] }); // Nightwrap, base 10
  assert.equal(e1.hp, 80, "Ambush doubles the 10 damage to 20 while Vanish is up");
});

test("assassin/Ambush control: with NO Vanish, the same skill deals only its base 10", () => {
  const laria = fuse("assassin");
  laria.statuses = []; // not affected by Vanish
  const e1 = enemy("e1");
  const state = makeState([laria], [e1]);
  fund(state, "assassin");

  performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.equal(e1.hp, 90, "no Vanish -> no doubling, only 10 damage");
});

test("assassin/Severance: 10 Affliction + 10 per Deepening Shadows, removing those stacks (ignores DR)", () => {
  const laria = fuse("assassin");
  const e1 = enemy("e1", { statuses: [ds(2), dr(10)] }); // 2 stacks, DR 10
  const state = makeState([laria], [e1]);
  fund(state, "assassin");

  const r = performAction(state, { unit: "la", skillId: "lariaassassin1", targets: ["e1"] });
  assert.ok(r.ok, "Severance resolves");
  // 10 + 10*2 = 30 Affliction; Affliction ignores DR entirely -> full 30 lands.
  assert.equal(e1.hp, 70, "10 + 10 per stack (2) = 30 Affliction, unblocked by DR 10");
  assert.equal(dsCount(e1), 0, "the target's Deepening Shadows are removed");
});

test("assassin/Severance control: a 0-stack target takes exactly 10 (no scaling)", () => {
  const laria = fuse("assassin");
  const e1 = enemy("e1"); // 0 stacks
  const state = makeState([laria], [e1]);
  fund(state, "assassin");

  performAction(state, { unit: "la", skillId: "lariaassassin1", targets: ["e1"] });
  assert.equal(e1.hp, 90, "0 stacks -> flat 10 Affliction");
});

// ###########################################################################
// # curse — Cursed Shadows (passive) + Curse of Darkness (lariacurse1)
// ###########################################################################

test("curse/Cursed Shadows: Cursed units OR 4+ Deepening Shadows get +1 skill cost (recomputed at round start)", () => {
  const laria = fuse("curse");
  const e4 = enemy("e4", { statuses: [ds(4)] }); // 4 stacks -> cost aura
  const eC = enemy("eC", { statuses: [mark("Cursed")] }); // Cursed -> cost aura
  const e3 = enemy("e3", { statuses: [ds(3)] }); // 3 stacks, not Cursed -> control (no aura)
  const state = makeState([laria], [e4, eC, e3]);

  emit(state, { type: "roundStart" }); // aura recomputes at round start

  assert.equal(st(e4, "cost_mod", "Cursed Shadows")?.magnitude, 1, "4-stack unit: +1 cost");
  assert.equal(st(eC, "cost_mod", "Cursed Shadows")?.magnitude, 1, "Cursed unit: +1 cost");
  assert.equal(st(e3, "cost_mod", "Cursed Shadows"), undefined, "3-stack, un-Cursed unit: no cost increase");
});

test("curse/Cursed Shadows: using a skill removes 1 Deepening Shadows from the actor", () => {
  const laria = fuse("curse");
  laria.statuses = [ds(2)];
  const state = makeState([laria], [enemy("e1")]);

  emit(state, { type: "skillUsed", caster: "la", skillId: "laria4", targets: ["la"] });
  assert.equal(dsCount(laria), 1, "acting stripped exactly 1 Deepening Shadows (2 -> 1)");
});

test("curse/Cursed Shadows control: a skill user with 0 Deepening Shadows is not driven negative", () => {
  const laria = fuse("curse");
  laria.statuses = []; // 0 stacks
  const state = makeState([laria], [enemy("e1")]);

  emit(state, { type: "skillUsed", caster: "la", skillId: "laria4", targets: ["la"] });
  assert.equal(dsCount(laria), 0, "no stacks to remove -> stays 0 (no negative stacks)");
});

test("curse/Curse of Darkness: 15 Affliction + 1 Deepening Shadows per turn for 3 turns", () => {
  const laria = fuse("curse");
  const e1 = enemy("e1");
  const state = makeState([laria], [e1]);
  fund(state, "curse");

  const r = performAction(state, { unit: "la", skillId: "lariacurse1", targets: ["e1"] });
  assert.ok(r.ok, "Curse of Darkness resolves");
  assert.equal(st(e1, "dot", "Curse of Darkness")?.magnitude, 15, "15 Affliction/turn dot installed");
  assert.equal(st(e1, "dot", "Curse of Darkness")?.duration, 3, "for 3 turns");

  // One of Laria's turn-ends: the dot ticks 15 and a Deepening Shadows stack lands.
  state.turn += 1; state.activeTeam = "A"; endTurn(state);
  assert.equal(e1.hp, 85, "first tick deals 15 Affliction");
  assert.equal(dsCount(e1), 1, "first tick also grants 1 Deepening Shadows");
});

test("curse/Curse of Darkness: if the cursed target never acts, the curse copies to an ally at full duration", () => {
  const laria = fuse("curse");
  const e1 = enemy("e1"); // cursed, will never act
  const e2 = enemy("e2"); // its ally — should receive the copy
  const state = makeState([laria], [e1, e2]);
  fund(state, "curse");

  performAction(state, { unit: "la", skillId: "lariacurse1", targets: ["e1"] });
  assert.equal(st(e2, "dot", "Curse of Darkness"), undefined, "ally is not cursed yet");

  // Three of Laria's turn-ends elapse without e1 acting -> mark expires -> copy fires.
  for (let i = 0; i < 3; i++) { state.turn += 1; state.activeTeam = "A"; endTurn(state); }

  assert.equal(st(e2, "dot", "Curse of Darkness")?.magnitude, 15, "curse copied to the ally");
  assert.equal(st(e2, "dot", "Curse of Darkness")?.duration, 3, "copy is at full (current) duration 3");
});

test("curse/Curse of Darkness control: if the target ACTS during the window, no copy is made", () => {
  const laria = fuse("curse");
  const e1 = enemy("e1");
  e1.skills = [skill("estep", [], { tags: ["Strategic"], targeting: "self" })];
  const e2 = enemy("e2");
  const state = makeState([laria], [e1, e2]);
  fund(state, "curse");
  state.teams.B.energy = { generic: 40 };

  performAction(state, { unit: "la", skillId: "lariacurse1", targets: ["e1"] });
  performAction(state, { unit: "e1", skillId: "estep", targets: ["e1"] }); // the cursed target acts -> cancels copy

  for (let i = 0; i < 3; i++) { state.turn += 1; state.activeTeam = "A"; endTurn(state); }
  assert.equal(st(e2, "dot", "Curse of Darkness"), undefined, "acting cancelled the copy — ally stays uncursed");
});

// ###########################################################################
// # dimension — In Between (passive) + Spirit Away (lariadimension1)
// ###########################################################################

test("dimension/In Between: a self-cast (Vanish) makes Laria ignore Harmful effects for 1 turn", () => {
  const laria = fuse("dimension");
  const state = makeState([laria], [enemy("e1")]);
  fund(state, "dimension");

  performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] }); // Vanish on herself
  assert.equal(st(laria, "non_damage_ignore", "In Between")?.duration, 1, "In Between grants a 1-turn non-damage ignore");
  assert.ok(st(laria, "mark", "In Between CD"), "the 2-turn internal cooldown mark is set");
});

test("dimension/In Between control: a non-self skill does NOT trigger In Between", () => {
  const laria = fuse("dimension");
  const state = makeState([laria], [enemy("e1")]);
  fund(state, "dimension");

  performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] }); // Nightwrap on an ENEMY
  assert.equal(st(laria, "non_damage_ignore", "In Between"), undefined, "no self-cast -> no In Between");
});

test("dimension/In Between: the 2-turn cooldown blocks re-triggering", () => {
  const laria = fuse("dimension");
  const state = makeState([laria], [enemy("e1")]);
  fund(state, "dimension");

  performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] });
  laria.statuses = laria.statuses.filter((s) => s.kind !== "non_damage_ignore"); // clear the buff to detect a re-grant
  performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] }); // still within In Between CD
  assert.equal(st(laria, "non_damage_ignore", "In Between"), undefined, "In Between CD prevents a second grant");
});

test("dimension/Spirit Away: casting it installs the 2-turn Spirit Away link on Laria", () => {
  const laria = fuse("dimension");
  const e1 = enemy("e1");
  const state = makeState([laria], [e1]);
  fund(state, "dimension");

  const r = performAction(state, { unit: "la", skillId: "lariadimension1", targets: ["e1"] });
  assert.ok(r.ok, "Spirit Away resolves");
  assert.equal(st(laria, "mark", "Spirit Away")?.duration, 2, "Spirit Away link lasts her next two turns");
});

// SUSPECTED BUG: Spirit Away's payload ("if Laria triggers In Between she will ALSO apply its effects to the
// target hero; if an enemy, they first receive 25 true damage") is never applied. The In Between trigger only
// touches Laria (self non_damage_ignore + CD); no wiring reads the Spirit Away link, so the enemy takes 0 and
// gains nothing when In Between fires while Spirit Away is up.
test.skip("SUSPECTED BUG: dimension/Spirit Away — triggering In Between deals 25 true to the linked enemy and shares In Between's effect", () => {
  const laria = fuse("dimension");
  const e1 = enemy("e1", { hp: 100 });
  const state = makeState([laria], [e1]);
  fund(state, "dimension");

  performAction(state, { unit: "la", skillId: "lariadimension1", targets: ["e1"] }); // link e1
  performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] }); // self-cast -> In Between triggers

  assert.equal(e1.hp, 75, "linked enemy first receives 25 true damage when In Between triggers");
  assert.ok(st(e1, "non_damage_ignore"), "In Between's effect is also applied to the linked hero");
});

// ###########################################################################
// # ion — Dark Matter (passive) + Dark Matter Beam (lariaion1)
// ###########################################################################

test("ion/Dark Matter: casting Vanish pulls every Deepening Shadows stack on the field to Laria (ignoring the cap), 5 dmg/heal + clear", () => {
  const laria = fuse("ion");
  laria.statuses = []; // 0 stacks of her own (isolate the transfer)
  const e1 = enemy("e1", { hp: 100, statuses: [ds(3)] }); // enemy: 5 damage
  const a1 = ally("a1", { hp: 50, maxHp: 100, statuses: [ds(2)] }); // ally: 5 heal
  const state = makeState([laria, a1], [e1]);
  fund(state, "ion");

  const r = performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] }); // Vanish
  assert.ok(r.ok, "Vanish resolves");
  assert.equal(dsCount(laria), 5, "all 3+2 field stacks return to Laria (5 > 3 cap: limit ignored)");
  assert.equal(e1.hp, 95, "enemy that held stacks takes 5 damage");
  assert.equal(a1.hp, 55, "ally that held stacks is healed 5");
  assert.equal(dsCount(e1), 0, "enemy's Deepening Shadows cleared");
  assert.equal(dsCount(a1), 0, "ally's Deepening Shadows cleared");
});

test("ion/Dark Matter control: a non-Vanish skill does not pull field stacks", () => {
  const laria = fuse("ion");
  laria.statuses = [];
  const e1 = enemy("e1", { statuses: [ds(3)] });
  const state = makeState([laria], [e1]);
  fund(state, "ion");

  performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] }); // Nightwrap, not Vanish
  assert.equal(dsCount(laria), 0, "no Vanish -> no transfer to Laria");
  assert.ok(dsCount(e1) >= 3, "enemy keeps its stacks (Nightwrap even adds one)");
});

test("ion/Dark Matter Beam: 10 damage per Deepening Shadows on Laria, then consumes them", () => {
  const laria = fuse("ion");
  laria.statuses = [ds(4)]; // 4 stacks (over the base cap; seeded directly)
  const e1 = enemy("e1", { hp: 100 });
  const state = makeState([laria], [e1]);
  fund(state, "ion");

  const r = performAction(state, { unit: "la", skillId: "lariaion1", targets: ["e1"] });
  assert.ok(r.ok, "Dark Matter Beam resolves");
  assert.equal(e1.hp, 60, "10 * 4 = 40 damage");
  assert.equal(dsCount(laria), 0, "Laria's Deepening Shadows are consumed");
});

test("ion/Dark Matter Beam control: with 0 Deepening Shadows on Laria it deals 0", () => {
  const laria = fuse("ion");
  laria.statuses = [];
  const e1 = enemy("e1", { hp: 100 });
  const state = makeState([laria], [e1]);
  fund(state, "ion");

  performAction(state, { unit: "la", skillId: "lariaion1", targets: ["e1"] });
  assert.equal(e1.hp, 100, "no stacks -> 0 damage");
});

// ###########################################################################
// # mirror — Black Reflection (passive) + Shadow Rebound (lariamirror1)
// ###########################################################################

test("mirror/Black Reflection: another hero reaching 4 Deepening Shadows swaps Laria's current HP with theirs", () => {
  const laria = fuse("mirror");
  laria.hp = 100;
  const e1 = enemy("e1", { hp: 30, statuses: [ds(4)] }); // now at 4 stacks
  const state = makeState([laria], [e1]);

  emit(state, { type: "statusApplied", unit: "e1", source: "la", kind: "stack", name: DS });
  assert.equal(laria.hp, 30, "Laria's current HP swapped down to the enemy's 30");
  assert.equal(e1.hp, 100, "the enemy's current HP swapped up to Laria's 100");
});

test("mirror/Black Reflection control: reaching only 3 stacks does NOT swap", () => {
  const laria = fuse("mirror");
  laria.hp = 100;
  const e1 = enemy("e1", { hp: 30, statuses: [ds(3)] });
  const state = makeState([laria], [e1]);

  emit(state, { type: "statusApplied", unit: "e1", source: "la", kind: "stack", name: DS });
  assert.equal(laria.hp, 100, "3 stacks (< 4) -> no swap");
  assert.equal(e1.hp, 30, "enemy HP unchanged");
});

test("mirror/Black Reflection control: Laria reaching 4 on HERSELF does not swap (must be ANOTHER hero)", () => {
  const laria = fuse("mirror");
  laria.hp = 100;
  laria.statuses = [ds(4)];
  const e1 = enemy("e1", { hp: 30 });
  const state = makeState([laria], [e1]);

  emit(state, { type: "statusApplied", unit: "la", source: "la", kind: "stack", name: DS });
  assert.equal(laria.hp, 100, "Laria's own 4 stacks do not trigger a self-swap");
  assert.equal(e1.hp, 30, "enemy HP unchanged");
});

test("mirror/Black Reflection control: a non-hero (minion) reaching 4 does not swap", () => {
  const laria = fuse("mirror");
  laria.hp = 100;
  const minion = makeUnit({ id: "m1", team: "B", kind: "minion", hp: 20, statuses: [ds(4)] });
  const state = makeState([laria], [minion]);

  emit(state, { type: "statusApplied", unit: "m1", source: "la", kind: "stack", name: DS });
  assert.equal(laria.hp, 100, "a minion at 4 stacks does not swap (only Heroes)");
});

test("mirror/Shadow Rebound: casting it lays the Shadow Rebound ward on the target ally", () => {
  const laria = fuse("mirror");
  const a1 = ally("a1");
  const state = makeState([laria, a1], [enemy("e1")]);
  fund(state, "mirror");

  const r = performAction(state, { unit: "la", skillId: "lariamirror1", targets: ["a1"] });
  assert.ok(r.ok, "Shadow Rebound resolves");
  assert.equal(st(a1, "mark", "Shadow Rebound")?.duration, 1, "a 1-turn Shadow Rebound ward is placed on the ally");
});

// SUSPECTED BUG: the active only lays an inert "Shadow Rebound" mark — no reflect trigger is installed for it
// (cf. ando:magnet "Opposites Attract", which installs a skillDeclared/reflect watch). So the first Harmful
// skill on the warded ally lands normally instead of reflecting back to its user.
test.skip("SUSPECTED BUG: mirror/Shadow Rebound — the first harmful skill on the warded ally reflects to its user", () => {
  const laria = fuse("mirror");
  const a1 = ally("a1", { hp: 100 });
  const e1 = enemy("e1", { hp: 100 });
  e1.skills = [skill("ehit", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful"], targeting: "single" })];
  const state = makeState([laria, a1], [e1]);
  fund(state, "mirror");
  state.teams.B.energy = { generic: 40 };

  performAction(state, { unit: "la", skillId: "lariamirror1", targets: ["a1"] }); // ward a1
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["a1"] }); // enemy strikes the warded ally

  assert.equal(a1.hp, 100, "the harmful skill is reflected away — the ally is unharmed");
  assert.equal(e1.hp, 80, "the 20 damage rebounds onto the attacker");
});

// ###########################################################################
// # moon — Full Moon's Night (passive) + Mooncurse (lariamoon1)
// ###########################################################################

test("moon/Full Moon's Night: casting Nightfall makes a 3+-stack character Mooncursed (stun/+5/10 Affliction, 4 turns)", () => {
  const laria = fuse("moon");
  laria.statuses = [];
  const e3 = enemy("e3", { statuses: [ds(3)] }); // 3 stacks -> Mooncursed
  const e2 = enemy("e2", { statuses: [ds(2)] }); // 2 stacks -> control, no Mooncurse
  const state = makeState([laria], [e3, e2]);
  fund(state, "moon");

  performAction(state, { unit: "la", skillId: "laria5", targets: [] }); // Nightfall
  assert.equal(st(e3, "dot", "Mooncursed")?.magnitude, 10, "3-stack enemy suffers the 10 Affliction/turn Mooncursed dot");
  assert.ok(st(e3, "stun", "Mooncursed")?.scope?.tag === "Strategic", "Strategic skills are stunned");
  assert.equal(st(e3, "outgoing_damage_mod", "Mooncursed")?.magnitude, 5, "+5 non-Affliction outgoing");
  assert.equal(st(e3, "dot", "Mooncursed")?.duration, 4, "the passive's Mooncurse lasts 4 turns");
  assert.equal(st(e2, "dot", "Mooncursed"), undefined, "a 2-stack character is not Mooncursed");
});

// SUSPECTED BUG: frozen says Full Moon's Night makes Nightfall "no longer make characters invulnerable", but the
// base laria5 Nightfall is unchanged by the fusion (its invulnerable clause still applies to everyone).
test.skip("SUSPECTED BUG: moon/Full Moon's Night — Nightfall no longer grants invulnerability", () => {
  const laria = fuse("moon");
  laria.statuses = [];
  const e3 = enemy("e3", { statuses: [ds(3)] });
  const state = makeState([laria], [e3]);
  fund(state, "moon");

  performAction(state, { unit: "la", skillId: "laria5", targets: [] });
  assert.equal(hasKind(e3, "invulnerable"), false, "Nightfall must no longer make characters invulnerable");
  assert.equal(hasKind(laria, "invulnerable"), false, "the caster is not made invulnerable either");
});

// SUSPECTED BUG: frozen ties Mooncursing to NIGHTFALL specifically ("Nightfall ... causes characters ... to
// become Mooncursed"), but the passive fires on ANY skill Laria uses (skillUsed cannot gate on skill id), so a
// non-Nightfall skill Mooncurses a 3+-stack character too.
test.skip("SUSPECTED BUG: moon/Full Moon's Night — only Nightfall (not other skills) causes Mooncurse", () => {
  const laria = fuse("moon");
  const e3 = enemy("e3", { statuses: [ds(3)] });
  const state = makeState([laria], [e3]);
  fund(state, "moon");

  performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] }); // Vanish, NOT Nightfall
  assert.equal(st(e3, "dot", "Mooncursed"), undefined, "a non-Nightfall skill must not Mooncurse the enemy");
});

test("moon/Mooncurse (active): applies stun/+5/10-Affliction for 3 turns, and the dot deals 10 on tick", () => {
  const laria = fuse("moon");
  const e1 = enemy("e1", { hp: 100 });
  const state = makeState([laria], [e1]);
  fund(state, "moon");

  const r = performAction(state, { unit: "la", skillId: "lariamoon1", targets: ["e1"] });
  assert.ok(r.ok, "Mooncurse resolves");
  assert.equal(st(e1, "stun", "Mooncursed")?.scope?.tag, "Strategic", "Strategic skills stunned");
  assert.equal(st(e1, "outgoing_damage_mod", "Mooncursed")?.magnitude, 5, "+5 non-Affliction outgoing");
  assert.equal(st(e1, "dot", "Mooncursed")?.magnitude, 10, "10 Affliction/turn dot");
  assert.equal(st(e1, "dot", "Mooncursed")?.duration, 3, "for 3 turns (active version)");

  state.turn += 1; state.activeTeam = "A"; endTurn(state); // one Laria turn-end -> the dot ticks
  assert.equal(e1.hp, 90, "the Mooncursed dot deals 10 Affliction on its tick");
});

test("moon/Mooncurse control: it cannot be applied to a unit already Mooncursed", () => {
  const laria = fuse("moon");
  const e1 = enemy("e1", { statuses: [{ kind: "dot", name: "Mooncursed", magnitude: 10, dtype: "affliction", duration: 3, appliedBy: "seed", appliedTurn: 0 }] });
  const state = makeState([laria], [e1]);
  fund(state, "moon");

  const before = e1.statuses.filter((s) => s.name === "Mooncursed").length;
  performAction(state, { unit: "la", skillId: "lariamoon1", targets: ["e1"] });
  const after = e1.statuses.filter((s) => s.name === "Mooncursed").length;
  assert.equal(after, before, "already-Mooncursed target gains no second application");
});

// ###########################################################################
// # night — Deep, Dark Night (passive) + Snuff Out (larianight1)
// ###########################################################################

test("night/Deep, Dark Night: enemy heroes holding 10+ total Deepening Shadows grant Laria's team True Sight (reveal)", () => {
  const laria = fuse("night");
  laria.statuses = [];
  const e1 = enemy("e1", { statuses: [ds(5)] });
  const e2 = enemy("e2", { statuses: [ds(5)] }); // total 10 across enemy heroes
  const state = makeState([laria], [e1, e2]);
  state.activeTeam = "A";

  startTurn(state);
  assert.ok(st(laria, "reveal", "Deep, Dark Night"), "10+ enemy stacks -> Laria gains reveal (sees invisible enemy effects)");
});

test("night/Deep, Dark Night control: 9 total enemy stacks does not grant reveal", () => {
  const laria = fuse("night");
  laria.statuses = [];
  const e1 = enemy("e1", { statuses: [ds(5)] });
  const e2 = enemy("e2", { statuses: [ds(4)] }); // total 9
  const state = makeState([laria], [e1, e2]);
  state.activeTeam = "A";

  startTurn(state);
  assert.equal(st(laria, "reveal", "Deep, Dark Night"), undefined, "9 (< 10) enemy stacks -> no reveal");
});

test("night/Deep, Dark Night: allied heroes holding 10+ total Deepening Shadows makes all allied effects invisible (veiled)", () => {
  const laria = fuse("night");
  laria.statuses = [ds(5)];
  const a1 = ally("a1", { statuses: [ds(5)] }); // allied total 10
  const state = makeState([laria, a1], [enemy("x")]);
  state.activeTeam = "A";

  startTurn(state);
  assert.ok(st(laria, "veiled", "Deep, Dark Night"), "Laria becomes veiled");
  assert.ok(st(a1, "veiled", "Deep, Dark Night"), "the ally becomes veiled");
});

test("night/Deep, Dark Night control: 9 total allied stacks does not veil the team", () => {
  const laria = fuse("night");
  laria.statuses = [ds(5)];
  const a1 = ally("a1", { statuses: [ds(4)] }); // allied total 9
  const state = makeState([laria, a1], [enemy("x")]);
  state.activeTeam = "A";

  startTurn(state);
  assert.equal(st(laria, "veiled", "Deep, Dark Night"), undefined, "9 (< 10) allied stacks -> no veil");
});

test("night/Snuff Out: the target gains 3 Deepening Shadows ignoring the cap; not executed while HP >= stacks x5", () => {
  const laria = fuse("night");
  const e1 = enemy("e1", { hp: 100, statuses: [ds(3)] }); // 3 -> 6 stacks, over the cap
  const state = makeState([laria], [e1]);
  fund(state, "night");

  const r = performAction(state, { unit: "la", skillId: "larianight1", targets: ["e1"] });
  assert.ok(r.ok, "Snuff Out resolves");
  assert.equal(dsCount(e1), 6, "3 stacks added over the cap (3 -> 6)");
  assert.equal(e1.alive, true, "100 HP is not < 6*5=30 -> not executed");
});

test("night/Snuff Out: executes a target whose HP is below stacks x5 (measured after +3)", () => {
  const laria = fuse("night");
  const e1 = enemy("e1", { hp: 10, statuses: [ds(1)] }); // 1 -> 4 stacks -> threshold 20; 10 < 20 -> execute
  const state = makeState([laria], [e1]);
  fund(state, "night");

  performAction(state, { unit: "la", skillId: "larianight1", targets: ["e1"] });
  assert.equal(e1.alive, false, "10 HP < 4*5=20 -> executed");
});

test("night/Snuff Out control: a healthy target above the threshold survives", () => {
  const laria = fuse("night");
  const e1 = enemy("e1", { hp: 100 }); // 0 -> 3 stacks -> threshold 15; 100 >= 15 -> survives
  const state = makeState([laria], [e1]);
  fund(state, "night");

  performAction(state, { unit: "la", skillId: "larianight1", targets: ["e1"] });
  assert.equal(e1.alive, true, "100 HP is above 3*5=15 -> not executed");
});

// ###########################################################################
// # ninja — Shadow Clones (passive) + Shadow Cross (larianinja1)
// ###########################################################################

test("ninja/Shadow Clones: a Deepening Shadows creation on a target becomes a Shadow Clone instead", () => {
  const laria = fuse("ninja");
  const e1 = enemy("e1");
  const state = makeState([laria], [e1]);
  assert.equal(minionsOf(state, "A", "Shadow Clone").length, 0, "no clones before");

  // Drive the "would create a Deepening Shadows stack" event Laria's passive keys on.
  emit(state, { type: "statusApplied", unit: "e1", source: "la", kind: "stack", name: DS });
  assert.equal(minionsOf(state, "A", "Shadow Clone").length, 1, "a Shadow Clone minion is created instead");
  assert.equal(dsCount(e1), 0, "the Deepening Shadows stack is not left on the target");
});

// SUSPECTED BUG: base-kit Deepening Shadows placements use the `addStack` op, which does not emit a
// `statusApplied` event — so the Shadow Clones react never fires from real gameplay. Nightwrap places a real DS
// stack on the target and no Shadow Clone is created.
test.skip("SUSPECTED BUG: ninja/Shadow Clones — a real DS-placing skill (Nightwrap) creates a Shadow Clone instead of a stack", () => {
  const laria = fuse("ninja");
  const e1 = enemy("e1");
  const state = makeState([laria], [e1]);
  fund(state, "ninja");

  performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] }); // Nightwrap places 1 Deepening Shadows
  assert.equal(minionsOf(state, "A", "Shadow Clone").length, 1, "Laria creates a Shadow Clone instead of the stack");
  assert.equal(dsCount(e1), 0, "no Deepening Shadows stack is left on the target");
});

test("ninja/Shadow Cross: Laria turns invulnerable, summons a Shadow Clone, and deals 15 Piercing (ignoring DR)", () => {
  const laria = fuse("ninja");
  const e1 = enemy("e1", { hp: 100, statuses: [dr(10)] }); // DR 10 must NOT reduce Piercing
  const state = makeState([laria], [e1]);
  fund(state, "ninja");

  const r = performAction(state, { unit: "la", skillId: "larianinja1", targets: ["e1"] });
  assert.ok(r.ok, "Shadow Cross resolves");
  assert.ok(hasKind(laria, "invulnerable"), "Laria becomes invulnerable");
  assert.equal(minionsOf(state, "A", "Shadow Clone").length, 1, "a Shadow Clone is created");
  assert.equal(e1.hp, 85, "15 Piercing ignores the enemy's DR 10");
  assert.ok(st(e1, "mark", "Shadow Cross"), "the target is marked by Shadow Cross");
});

test("ninja/Shadow Cross: its clone's Shadow Strike deals +10 to the marked target (15 vs an unmarked 5)", () => {
  const laria = fuse("ninja");
  const marked = enemy("e1", { hp: 100 });
  const unmarked = enemy("e2", { hp: 100 });
  const state = makeState([laria], [marked, unmarked]);
  fund(state, "ninja");

  performAction(state, { unit: "la", skillId: "larianinja1", targets: ["e1"] }); // marks e1, spawns a clone
  const clone = minionsOf(state, "A", "Shadow Clone")[0]!;

  performAction(state, { unit: clone.id, skillId: "shadowclone1", targets: ["e2"] }); // unmarked
  assert.equal(unmarked.hp, 95, "Shadow Strike on an unmarked target deals its base 5 Piercing");

  performAction(state, { unit: clone.id, skillId: "shadowclone1", targets: ["e1"] }); // marked by Shadow Cross
  assert.equal(marked.hp, 100 - 15 - 15, "Shadow Strike on the Shadow Cross target deals 5+10 = 15 (already 15 from the cast)");
});

// ###########################################################################
// # ritual — Ritual of Culling Night (passive) + Nightcloak Candle (lariaritual1)
// ###########################################################################

test("ritual/Ritual of Culling Night: at turn-end Laria gains Ritual Power equal to total field Deepening Shadows", () => {
  const laria = fuse("ritual");
  laria.statuses = [ds(3)];
  const e1 = enemy("e1", { statuses: [ds(4)] }); // field total 3 + 4 = 7
  const state = makeState([laria], [e1]);
  state.activeTeam = "A";

  endTurn(state);
  assert.equal(st(laria, "stack", "Ritual Power")?.magnitude, 7, "gained Ritual Power = 7 (field-wide Deepening Shadows sum)");
});

test("ritual/Ritual of Culling Night: reaching 50 Ritual Power consumes the Ritual and deals 45 Affliction to heroes without Nightcloak Candle", () => {
  const laria = fuse("ritual");
  laria.statuses = [ds(3), { kind: "stack", name: "Ritual Power", magnitude: 45, duration: null, appliedBy: "seed", appliedTurn: 0 }];
  laria.hp = 100;
  const e1 = enemy("e1", { hp: 100, statuses: [ds(4)] }); // field total 7 -> RP hits 52
  const a1 = ally("a1", { hp: 100, statuses: [mark("Nightcloak Candle")] }); // spared
  const state = makeState([laria, a1], [e1]);
  state.activeTeam = "A";

  endTurn(state);
  assert.equal(st(laria, "stack", "Ritual Power"), undefined, "the whole Ritual is consumed (Ritual Power removed)");
  assert.equal(laria.hp, 55, "Laria (no Nightcloak Candle) takes 45 Affliction");
  assert.equal(e1.hp, 55, "the enemy hero takes 45 Affliction");
  assert.equal(a1.hp, 100, "the Nightcloak Candle ally is spared");
});

test("ritual/Ritual of Culling Night control: below 50 Ritual Power, no 45-damage detonation", () => {
  const laria = fuse("ritual");
  laria.statuses = [ds(1), { kind: "stack", name: "Ritual Power", magnitude: 40, duration: null, appliedBy: "seed", appliedTurn: 0 }];
  laria.hp = 100;
  const e1 = enemy("e1", { hp: 100 }); // field total 1 -> RP hits 41 (< 50)
  const state = makeState([laria], [e1]);
  state.activeTeam = "A";

  endTurn(state);
  assert.equal(st(laria, "stack", "Ritual Power")?.magnitude, 41, "Ritual Power accrues to 41, not consumed");
  assert.equal(e1.hp, 100, "no detonation below 50 Ritual Power");
});

test("ritual/Nightcloak Candle: marks the ally permanently, grants a Deepening Shadows stack, and +5 non-Affliction outgoing", () => {
  const laria = fuse("ritual");
  const a1 = ally("a1", { hp: 100 });
  const state = makeState([laria, a1], [enemy("e1")]);
  fund(state, "ritual");

  const r = performAction(state, { unit: "la", skillId: "lariaritual1", targets: ["a1"] });
  assert.ok(r.ok, "Nightcloak Candle resolves");
  assert.ok(st(a1, "mark", "Nightcloak Candle"), "the ally is marked by Nightcloak Candle");
  assert.equal(st(a1, "mark", "Nightcloak Candle")?.duration, null, "the mark is permanent (no expiry)");
  assert.equal(dsCount(a1), 1, "the ally gains a Deepening Shadows stack");
  assert.equal(st(a1, "outgoing_damage_mod", "Nightcloak Candle")?.magnitude, 5, "+5 non-Affliction outgoing");
});

test("ritual/Nightcloak Candle: does not stack (a second cast adds nothing)", () => {
  const laria = fuse("ritual");
  const a1 = ally("a1", { hp: 100 });
  const state = makeState([laria, a1], [enemy("e1")]);
  fund(state, "ritual");

  performAction(state, { unit: "la", skillId: "lariaritual1", targets: ["a1"] });
  laria.skills!.find((s) => s.id === "lariaritual1")!.currentCd = 0; // clear cooldown for a second cast
  performAction(state, { unit: "la", skillId: "lariaritual1", targets: ["a1"] });
  assert.equal(dsCount(a1), 1, "a second Nightcloak Candle grants no additional Deepening Shadows (does not stack)");
});

// SUSPECTED BUG: the retaliation clause ("any enemy who uses a harmful skill on them will take 5 Affliction and
// be marked by Nightcloak Candle for 1 turn. Receiving damage this way generates 5 Ritual Power") is not wired —
// the mark carries no standing reaction, so a harmful enemy skill on the marked ally provokes nothing.
test.skip("SUSPECTED BUG: ritual/Nightcloak Candle — an enemy who strikes the marked ally takes 5 Affliction, is marked, and gives Laria 5 Ritual Power", () => {
  const laria = fuse("ritual");
  const a1 = ally("a1", { hp: 100 });
  const e1 = enemy("e1", { hp: 100 });
  e1.skills = [skill("ehit", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful"], targeting: "single" })];
  const state = makeState([laria, a1], [e1]);
  fund(state, "ritual");
  state.teams.B.energy = { generic: 40 };

  performAction(state, { unit: "la", skillId: "lariaritual1", targets: ["a1"] });
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["a1"] }); // enemy strikes the marked ally

  assert.equal(e1.hp, 95, "the attacker takes 5 Affliction retaliation");
  assert.ok(st(e1, "mark", "Nightcloak Candle"), "the attacker is marked by Nightcloak Candle");
  assert.equal(st(laria, "stack", "Ritual Power")?.magnitude, 5, "the retaliation generates 5 Ritual Power for Laria");
});

// ###########################################################################
// # vigilante — Evencoin (passive) + Midnight Justice (lariavigilante1)
// ###########################################################################

test("vigilante/Evencoin: the first enemy hero to land a killing blow receives 1 Evencoin", () => {
  const laria = fuse("vigilante");
  laria.statuses = [];
  const victim = ally("v", { hp: 1 });
  const e1 = enemy("e1");
  const state = makeState([laria, victim], [e1]);

  emit(state, { type: "unitDied", unit: "v", killer: "e1" });
  assert.equal(st(e1, "stack", "Evencoin")?.magnitude, 1, "the killing enemy hero gains an Evencoin");
  assert.ok(st(laria, "mark", "Evencoin Given"), "the once-per-battle award is locked");
});

test("vigilante/Evencoin control: an ALLY's killing blow grants no Evencoin (must be an enemy hero)", () => {
  const laria = fuse("vigilante");
  laria.statuses = [];
  const a1 = ally("a1");
  const victim = enemy("v", { hp: 1 });
  const state = makeState([laria, a1], [victim]);

  emit(state, { type: "unitDied", unit: "v", killer: "a1" });
  assert.equal(st(a1, "stack", "Evencoin"), undefined, "an allied killer gains no Evencoin");
  assert.equal(st(laria, "mark", "Evencoin Given"), undefined, "the award is not spent by an allied kill");
});

test("vigilante/Evencoin: only the FIRST enemy killer is coined; a later enemy killer gets none", () => {
  const laria = fuse("vigilante");
  laria.statuses = [];
  const victim = ally("v", { hp: 1 });
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([laria, victim], [e1, e2]);

  emit(state, { type: "unitDied", unit: "v", killer: "e1" });
  emit(state, { type: "unitDied", unit: "v", killer: "e2" });
  assert.equal(st(e1, "stack", "Evencoin")?.magnitude, 1, "the first enemy killer is coined");
  assert.equal(st(e2, "stack", "Evencoin"), undefined, "a subsequent enemy killer gets nothing (once per battle)");
});

test("vigilante/Evencoin: an Evencoin holder counts as triple its Deepening Shadows (Nightfall reads 3x)", () => {
  const laria = fuse("vigilante");
  laria.statuses = [];
  const coined = enemy("e1", { hp: 100, statuses: [ds(2), evencoin()] }); // 2 real -> 6 effective
  const plain = enemy("e2", { hp: 100, statuses: [ds(2)] }); // control: 2 real -> 2 effective
  const state = makeState([laria], [coined, plain]);
  fund(state, "vigilante");

  emit(state, { type: "roundStart" }); // installs the triple-count read
  performAction(state, { unit: "la", skillId: "laria5", targets: [] }); // Nightfall: 5 damage per Deepening Shadows stack
  assert.equal(coined.hp, 70, "Evencoin holder: 5 * (2*3=6) = 30 damage");
  assert.equal(plain.hp, 90, "plain enemy: 5 * 2 = 10 damage");
});

test("vigilante/Midnight Justice: 25 damage; an enemy left above 50 HP has its non-Strategic skills stunned", () => {
  const laria = fuse("vigilante");
  const e1 = enemy("e1", { hp: 100 });
  const state = makeState([laria], [e1]);
  fund(state, "vigilante");

  const r = performAction(state, { unit: "la", skillId: "lariavigilante1", targets: ["e1"] });
  assert.ok(r.ok, "Midnight Justice resolves");
  assert.equal(e1.hp, 75, "25 damage");
  assert.equal(st(e1, "stun", "Midnight Justice")?.scope?.tag, "Strategic", "a Strategic-EXCEPT stun (non-Strategic skills stunned)");
  assert.equal(st(e1, "stun", "Midnight Justice")?.scope?.mode, "except", "the stun spares Strategic skills");
});

test("vigilante/Midnight Justice control: an enemy left at/below 50 HP is not stunned", () => {
  const laria = fuse("vigilante");
  const e1 = enemy("e1", { hp: 40 }); // 40 -> 15, below 50 both before and after the 25
  const state = makeState([laria], [e1]);
  fund(state, "vigilante");

  performAction(state, { unit: "la", skillId: "lariavigilante1", targets: ["e1"] });
  assert.equal(e1.hp, 15, "25 damage");
  assert.equal(st(e1, "stun", "Midnight Justice"), undefined, "not above 50 HP -> no stun");
});

test("vigilante/Midnight Justice: against an Evencoin holder it deals 10 more damage (35)", () => {
  const laria = fuse("vigilante");
  const e1 = enemy("e1", { hp: 100, statuses: [evencoin()] });
  const state = makeState([laria], [e1]);
  fund(state, "vigilante");

  performAction(state, { unit: "la", skillId: "lariavigilante1", targets: ["e1"] });
  assert.equal(e1.hp, 65, "25 + 10 = 35 damage against an Evencoin holder");
});

// SUSPECTED BUG: "If they have an Evencoin, Midnight Justice ... has no Cooldown." The skill's own effect zeroes
// its cooldown mid-cast, but the scheduler sets currentCd = effectiveCooldown AFTER the effects run, clobbering
// the reset — so the cooldown is still 1 after hitting an Evencoin holder.
test.skip("SUSPECTED BUG: vigilante/Midnight Justice — hitting an Evencoin holder leaves it off cooldown", () => {
  const laria = fuse("vigilante");
  const e1 = enemy("e1", { hp: 100, statuses: [evencoin()] });
  const state = makeState([laria], [e1]);
  fund(state, "vigilante");

  performAction(state, { unit: "la", skillId: "lariavigilante1", targets: ["e1"] });
  assert.equal(laria.skills!.find((s) => s.id === "lariavigilante1")!.currentCd, 0, "no Cooldown against an Evencoin holder");
});

test("vigilante/Midnight Justice control: against a NON-Evencoin enemy the skill goes on its normal cooldown", () => {
  const laria = fuse("vigilante");
  const e1 = enemy("e1", { hp: 100 });
  const state = makeState([laria], [e1]);
  fund(state, "vigilante");

  performAction(state, { unit: "la", skillId: "lariavigilante1", targets: ["e1"] });
  assert.equal(laria.skills!.find((s) => s.id === "lariavigilante1")!.currentCd, 1, "normal cooldown 1 with no Evencoin");
});
