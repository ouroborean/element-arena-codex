import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, tickDots } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { applyDamage } from "../src/damage.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + ayana triggers + fusion fns
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { viewerHasReveal, redactState } from "../src/visibility.ts";
import type { MatchState, Unit, Status, StatusKind } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";

// ============================================================================
// AYANA — FUSION FORMS — adversarial, spec-derived behavioral suite.
//
// The FROZEN prose (content/frozen/skills.json) is the ORACLE for WHAT to assert.
// The authored roster (fusions.authored.json / roster.generated.ts) is read ONLY
// to learn HOW to drive: fusion element keys, skill ids, cost, targeting and the
// status/mark/minion names each form produces.
//
// Ayana's base kit stays after a fusion (ayana1 Voice of Light, ayana2 Chorus,
// ayana3 Prayer, ayana5 Voice of Glory) — a fused hero pays SPECIFIC cost in the
// fusion element. Several fusion passives react to "an enemy triggers Voice of
// Light" = a 'Voice of Light'-marked enemy DEALS damage (eventSource holds the
// mark, applied by base ayana1).
//
// The 10 forms and their FROZEN text (verbatim):
//   angel      Choir On High  : "Whenever Ayana uses Chorus, she summons two Angel
//                                minions. While either of them is alive, Chorus is
//                                permanent. When both Angels are killed, Chorus
//                                immediately ends."
//              Providence     : "Heals Ayana or an ally for 35 HP."
//   anointment Maiden of Purity: "Using Chorus or Voice of Glory will heal your
//                                most damaged ally for 15 HP."
//              Blessed Leylines: "Target ally becomes Invulnerable for 1 turn and
//                                permanently receives 5 more healing from all
//                                sources (this effect does not stack)."
//   antidote   Panacea        : "Every 3 turns, Ayana is cleansed of all enemy
//                                effects at the end of her turn."
//              Healing Hands  : "Target ally is healed 30 HP. If this skill is
//                                used on Ayana, it activates Panacea."
//   divine     Godly Wisdom   : "Every 3 times enemies trigger Voice of Light or
//                                Prayer, Ayana automatically uses Voice of Glory."
//              Verse of Ascension: "Ayana ignores harmful effects for 2 turns and
//                                activates Chorus. This skill cannot be stunned."
//   judgment   Searing Rebuke : "If an enemy triggers Voice of Light, they receive
//                                15 Affliction damage."
//              Final Word     : "Deals 25 piercing damage to target enemy. If Ayana
//                                and her target have no living allies, Final Word
//                                deals double damage."
//   prism      Illumination   : "While Prism Sentence is active, all invisible
//                                skills become visible."
//              Prism Sentence : "Stuns target enemy for 2 turns. During this time,
//                                they will receive double damage from Voice of Light
//                                and casting Voice of Light on them will also cast it
//                                on the enemy team, Bypassing."
//   sanctuary  Hallowed Footsteps: "When dealing damage to or healing a target
//                                affected by your Consecrate, deal 10 additional
//                                damage or healing to them. This effect is not
//                                triggered by Consecrate."
//              Consecrate     : "Deals 5 Piercing damage to all enemies for 5 turns,
//                                and heals all allies for 5 HP for 5 turns."
//   vengeance  Divine Ire     : "Whenever an enemy deals damage to Ayana's allies,
//                                she permanently deals 5 additional damage to them
//                                with Voice of Light (stacks)."
//              Voice of Vengeance: "Deals 35 damage to target enemy, increased by 5
//                                for each dead ally. If both allies are dead, this
//                                damage becomes Piercing."
//   vigilante  Word of the Law: "Triggering Voice of Light causes the target to
//                                take 10 additional damage from it for 2 turns."
//              Bounty         : "Target enemy is Shattered for 2 turns. Allies who
//                                deal damage to them are healed for 10 health during
//                                this time."
//   zealot     Inquisition    : "Triggering Voice of Light now Isolates the target
//                                for 1 turn."
//              Purge the Wicked: "For 3 turns, all units are Shattered, but become
//                                immune to counters and stuns."
// ============================================================================

// --- driving helpers --------------------------------------------------------

function fusedAyana(element: string, id = "ay"): Unit {
  const ay = loadHero(heroById("ayana"), "A", id);
  applyFusion(ay, fusionForm("ayana", element)!);
  return ay;
}
const energyFor = (element: string): Record<string, number> => ({ generic: 40, [element]: 40 });
const ally = (id: string, over: Partial<Unit> = {}) => makeUnit({ id, team: "A", kind: "hero", ...over });
const enemy = (id: string, over: Partial<Unit> = {}) => makeUnit({ id, team: "B", kind: "hero", ...over });

/** Build a fused-Ayana scene (Ayana is slot-0 on team A) with energy pre-funded. */
function scene(element: string, allies: Unit[], enemies: Unit[]): { state: MatchState; ay: Unit } {
  const ay = fusedAyana(element);
  const state = makeState([ay, ...allies], enemies);
  state.teams.A.energy = energyFor(element);
  state.teams.B.energy = { generic: 40 };
  return { state, ay };
}

const st = (u: Unit, kind: StatusKind, name?: string): Status | undefined =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const markOf = (u: Unit, name: string): Status | undefined => st(u, "mark", name);
const stackMag = (u: Unit, name: string): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === name)?.magnitude ?? 0;
const minionsOn = (state: MatchState, team: "A" | "B", name?: string): Unit[] =>
  state.teams[team].units
    .map((id) => state.units[id]!)
    .filter((u) => u.kind === "minion" && (name === undefined || u.name === name));

/** Land `amount` `dtype` damage from dealer→target through the full pipeline, tagging the hit `sourceId`. */
function strike(state: MatchState, dealer: string, target: string, amount: number, sourceId?: string, dtype: "normal" | "piercing" | "affliction" | "true" = "normal"): void {
  const eff: Effect[] = [{ op: "damage", amount, dtype, to: "target", ...(sourceId ? { id: sourceId } : {}) }];
  runEffects(state, eff, { caster: state.units[dealer]!, targets: [state.units[target]!], targeting: "single" });
}
/** Heal target from `healer` through the pipeline (emits healReceived so passives fire). */
function healOp(state: MatchState, healer: string, target: string, amount: number): void {
  runEffects(state, [{ op: "heal", amount, to: "target" }], { caster: state.units[healer]!, targets: [state.units[target]!], targeting: "single" });
}
/** Give an enemy the base 'Voice of Light' mark (what ayana1 applies) so it can "trigger Voice of Light". */
function markVoL(u: Unit, applier = "ay"): void {
  u.statuses.push(status("mark", { name: "Voice of Light", appliedBy: applier, duration: 5 }));
}
/** A marked enemy deals new damage (fires "an enemy triggers Voice of Light" passives). */
function enemyDeals(state: MatchState, src: string, tgt = "ay"): void {
  emit(state, { type: "damageDealt", source: src, target: tgt, amount: 5, dtype: "normal", isNew: true });
}

// ###########################################################################
// # angel — Choir On High (passive) + Providence (active)
// ###########################################################################

test("angel/Choir On High: using Chorus summons two Angel minions and makes Chorus permanent", () => {
  const { state, ay } = scene("angel", [], [enemy("e")]);
  assert.equal(minionsOn(state, "A").length, 0, "precondition: no minions");

  assert.ok(performAction(state, { unit: "ay", skillId: "ayana2", targets: [] }).ok, "cast Chorus");
  const angels = minionsOn(state, "A", "Angel");
  assert.equal(angels.length, 2, "Chorus summons exactly two Angel minions");
  // "While either of them is alive, Chorus is permanent" — the Chorus mark is refreshed to duration null.
  assert.equal(markOf(ay, "Chorus")?.duration, null, "Chorus is permanent (duration null) while Angels live");
});

test("angel/Choir On High: Chorus ends only when BOTH Angels are killed (one alive keeps it)", () => {
  const { state, ay } = scene("angel", [], [enemy("e")]);
  performAction(state, { unit: "ay", skillId: "ayana2", targets: [] });
  const angels = minionsOn(state, "A", "Angel");
  assert.equal(angels.length, 2, "two Angels");

  // Kill the first Angel — the OTHER is still alive, so Chorus persists.
  angels[0]!.alive = false; angels[0]!.hp = 0;
  emit(state, { type: "unitDied", unit: angels[0]!.id, killer: "e" });
  assert.ok(markOf(ay, "Chorus"), "one Angel alive -> Chorus persists");

  // Kill the second — no Angels remain, so Chorus immediately ends.
  angels[1]!.alive = false; angels[1]!.hp = 0;
  emit(state, { type: "unitDied", unit: angels[1]!.id, killer: "e" });
  assert.ok(!markOf(ay, "Chorus"), "both Angels dead -> Chorus immediately ends");
});

test.skip("SUSPECTED BUG: Choir On High summons on ANY self skill, but frozen says only 'uses Chorus'", () => {
  // Frozen: "Whenever Ayana uses Chorus, she summons two Angel minions." A NON-Chorus self skill
  // (here Voice of Light) must NOT summon Angels. The trigger fires on any self skillUsed, so it does.
  const { state } = scene("angel", [], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] }).ok, "cast Voice of Light (not Chorus)");
  assert.equal(minionsOn(state, "A", "Angel").length, 0, "a non-Chorus skill must not summon Angels");
});

test("angel/Providence: heals target ally for exactly 35 HP (control: not more, capped at max)", () => {
  const { state } = scene("angel", [ally("a1", { hp: 50 })], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanaangel1", targets: ["a1"] }).ok, "cast Providence");
  assert.equal(state.units["a1"]!.hp, 85, "50 + 35 = 85");

  // Control: a near-full ally overheals to the cap, not past it.
  const s2 = scene("angel", [ally("a2", { hp: 90 })], [enemy("e")]);
  performAction(s2.state, { unit: "ay", skillId: "ayanaangel1", targets: ["a2"] });
  assert.equal(s2.state.units["a2"]!.hp, 100, "90 + 35 caps at 100 maxHp");
});

// ###########################################################################
// # anointment — Maiden of Purity (passive) + Blessed Leylines (active)
// ###########################################################################

test("anointment/Maiden of Purity: Chorus heals the single MOST-DAMAGED ally for 15", () => {
  const { state } = scene("anointment", [ally("a1", { hp: 40 }), ally("a2", { hp: 70 })], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayana2", targets: [] }).ok, "cast Chorus");
  assert.equal(state.units["a1"]!.hp, 55, "lowest-HP ally (40) healed 15 -> 55");
  assert.equal(state.units["a2"]!.hp, 70, "the higher-HP ally is NOT the most-damaged -> untouched");
});

test("anointment/Maiden of Purity: Voice of Glory also heals the most-damaged ally 15", () => {
  const { state } = scene("anointment", [ally("a1", { hp: 40 })], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayana5", targets: [] }).ok, "cast Voice of Glory");
  assert.equal(state.units["a1"]!.hp, 55, "Voice of Glory triggers the 15 heal");
});

test.skip("SUSPECTED BUG: Maiden of Purity heals on ANY self skill; frozen scopes it to Chorus/Voice of Glory", () => {
  // Frozen: "Using Chorus or Voice of Glory will heal your most damaged ally for 15 HP."
  // Voice of Light is neither, so it must not heal. The unscoped skillUsed trigger heals anyway.
  const { state } = scene("anointment", [ally("a1", { hp: 40 })], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] }).ok, "cast Voice of Light");
  assert.equal(state.units["a1"]!.hp, 40, "a non-Chorus/non-VoG skill must not heal the ally");
});

test("anointment/Blessed Leylines: applies Invulnerable(1) + a permanent +5 incoming-heal buff", () => {
  const { state } = scene("anointment", [ally("a1", { hp: 50 })], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanaanointment1", targets: ["a1"] }).ok, "cast Blessed Leylines");
  const a1 = state.units["a1"]!;
  assert.equal(st(a1, "invulnerable")?.duration, 1, "Invulnerable for 1 turn");
  const boon = st(a1, "incoming_heal_mod");
  assert.equal(boon?.magnitude, 5, "permanent +5 healing-received buff");
  assert.equal(boon?.duration, null, "the +5 buff is permanent (duration null)");
});

test("anointment/Blessed Leylines: the +5 is real (heal boosted) and DOES NOT STACK", () => {
  const { state } = scene("anointment", [ally("a1", { hp: 50 })], [enemy("e")]);
  performAction(state, { unit: "ay", skillId: "ayanaanointment1", targets: ["a1"] });
  // (Maiden of Purity heals on the cast; reset to a known baseline to measure only the +5 heal-mod.)
  state.units["a1"]!.hp = 50;
  healOp(state, "ay", "a1", 10);
  assert.equal(state.units["a1"]!.hp, 65, "heal 10 + Blessed Leylines 5 = 15 -> 65");

  // "does not stack": a second Blessed Leylines does not add a second +5.
  state.units["ay"]!.skills!.find((s) => s.id === "ayanaanointment1")!.currentCd = 0;
  performAction(state, { unit: "ay", skillId: "ayanaanointment1", targets: ["a1"] });
  state.units["a1"]!.hp = 50;
  healOp(state, "ay", "a1", 10);
  assert.equal(state.units["a1"]!.hp, 65, "two applications still only +5 (non-stacking), not +10");

  // Control: an ally WITHOUT the buff gets the raw heal only.
  const s2 = scene("anointment", [ally("b1", { hp: 50 })], [enemy("e")]);
  healOp(s2.state, "ay", "b1", 10);
  assert.equal(s2.state.units["b1"]!.hp, 60, "no Blessed Leylines -> heal is exactly 10");
});

test("anointment/Blessed Leylines: Invulnerable blocks a NEW harmful skill on the target", () => {
  const { state } = scene("anointment", [ally("a1", { hp: 50 })], [enemy("e")]);
  state.units["e"]!.skills = [
    { id: "hit", name: "Hit", element: "fire", targeting: "single", effects: [{ op: "damage", amount: 20, to: "target" }], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful", "Instant"] },
  ];
  // Control: before the buff the enemy can target a1.
  assert.ok(performAction(state, { unit: "e", skillId: "hit", targets: ["a1"] }).ok, "harmful hit lands pre-buff");

  performAction(state, { unit: "ay", skillId: "ayanaanointment1", targets: ["a1"] });
  const r = performAction(state, { unit: "e", skillId: "hit", targets: ["a1"] });
  assert.equal(r.ok, false, "Invulnerable target rejects a new harmful skill");
  assert.equal(r.reason, "no-legal-target", "…with no legal target");
});

// ###########################################################################
// # antidote — Panacea (passive) + Healing Hands (active)
// ###########################################################################

test("antidote/Panacea: cleanses enemy debuffs after the 3rd of Ayana's turn-ends (not before)", () => {
  const { state, ay } = scene("antidote", [], [enemy("e")]);
  ay.statuses.push(status("stun", { appliedBy: "e", duration: null }));
  ay.statuses.push(status("dot", { name: "Venom", magnitude: 5, dtype: "affliction", appliedBy: "e", duration: null }));

  state.activeTeam = "A"; endTurn(state); // her turn-end #1
  assert.ok(st(ay, "stun"), "debuff present after 1 turn-end");
  state.activeTeam = "A"; endTurn(state); // #2
  assert.ok(st(ay, "stun"), "debuff present after 2 turn-ends");
  state.activeTeam = "A"; endTurn(state); // #3 -> cleanse
  assert.ok(!st(ay, "stun"), "stun cleansed on Ayana's 3rd turn-end");
  assert.ok(!st(ay, "dot"), "dot cleansed on Ayana's 3rd turn-end");
});

test.skip("SUSPECTED BUG: Panacea cleanses on ENEMY turn-ends too; frozen scopes it to 'the end of HER turn'", () => {
  // Frozen: "…at the end of her turn." A cleanse that fires purely on enemy turn-ends (Ayana never acting)
  // violates that scope. Panacea's turnEnd trigger has no team predicate, so 3 enemy turn-ends cleanse her.
  const { state, ay } = scene("antidote", [], [enemy("e")]);
  ay.statuses.push(status("stun", { appliedBy: "e", duration: null }));
  for (let i = 0; i < 3; i++) { state.activeTeam = "B"; endTurn(state); }
  assert.ok(st(ay, "stun"), "3 enemy turn-ends (no Ayana turn) must NOT cleanse — cleanse is 'at the end of her turn'");
});

test("antidote/Healing Hands: heals target ally 30; on a non-Ayana ally it does NOT cleanse (control)", () => {
  const { state } = scene("antidote", [ally("a1", { hp: 40 })], [enemy("e")]);
  state.units["a1"]!.statuses.push(status("stun", { appliedBy: "e", duration: null }));
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanaantidote1", targets: ["a1"] }).ok, "cast Healing Hands on a1");
  assert.equal(state.units["a1"]!.hp, 70, "40 + 30 = 70");
  assert.ok(st(state.units["a1"]!, "stun"), "used on a non-Ayana ally -> Panacea is NOT activated (stun remains)");
});

test("antidote/Healing Hands: used ON AYANA it activates Panacea (cleanses her enemy debuffs)", () => {
  const { state, ay } = scene("antidote", [], [enemy("e")]);
  ay.hp = 50;
  // Use non-cast-blocking debuffs (a stun would block the cast itself); both are on Panacea's cleanse list.
  ay.statuses.push(status("silence", { appliedBy: "e", duration: null }));
  ay.statuses.push(status("dot", { name: "Venom", magnitude: 5, dtype: "affliction", appliedBy: "e", duration: null }));
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanaantidote1", targets: ["ay"] }).ok, "cast Healing Hands on self");
  assert.equal(ay.hp, 80, "50 + 30 = 80");
  assert.ok(!st(ay, "silence"), "Panacea cleanse removed the silence");
  assert.ok(!st(ay, "dot"), "Panacea cleanse removed the dot");
});

// ###########################################################################
// # divine — Godly Wisdom (passive) + Verse of Ascension (active)
// ###########################################################################

test("divine/Godly Wisdom: every 3 Voice-of-Light triggers auto-casts Voice of Glory", () => {
  const { state, ay } = scene("divine", [], [enemy("e")]);
  assert.equal(stackMag(ay, "Voice of Glory"), 0, "no Voice of Glory yet");

  markVoL(state.units["e"]!); enemyDeals(state, "e");
  assert.equal(stackMag(ay, "Godly Wisdom"), 1, "trigger #1 -> 1 stack");
  assert.equal(stackMag(ay, "Voice of Glory"), 0, "no auto-cast at 1");

  markVoL(state.units["e"]!); enemyDeals(state, "e");
  assert.equal(stackMag(ay, "Godly Wisdom"), 2, "trigger #2 -> 2 stacks");
  assert.equal(stackMag(ay, "Voice of Glory"), 0, "no auto-cast at 2");

  markVoL(state.units["e"]!); enemyDeals(state, "e");
  assert.equal(stackMag(ay, "Voice of Glory"), 1, "trigger #3 -> Voice of Glory auto-cast (1 stack gained)");
  assert.equal(stackMag(ay, "Godly Wisdom"), 0, "the Godly Wisdom counter resets to 0");
});

test("divine/Godly Wisdom: a Prayer trigger also counts; an UNMARKED enemy hit does not (control)", () => {
  const { state, ay } = scene("divine", [ally("a1")], [enemy("e")]);
  // Control: an unmarked enemy dealing damage advances nothing.
  enemyDeals(state, "e");
  assert.equal(stackMag(ay, "Godly Wisdom"), 0, "unmarked enemy hit -> no Godly Wisdom");

  // Prayer branch: a 'Prayer'-marked ally TAKES damage.
  state.units["a1"]!.statuses.push(status("mark", { name: "Prayer", appliedBy: "ay", duration: 5 }));
  emit(state, { type: "damageDealt", source: "e", target: "a1", amount: 6, dtype: "normal", isNew: true });
  assert.equal(stackMag(ay, "Godly Wisdom"), 1, "a Prayer trigger counts toward Godly Wisdom");
});

test("divine/Verse of Ascension: grants damage_ignore(2) + non_damage_ignore(2) and activates Chorus", () => {
  const { state, ay } = scene("divine", [], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanadivine1", targets: [] }).ok, "cast Verse of Ascension");
  assert.equal(st(ay, "damage_ignore")?.duration, 2, "ignores damage for 2 turns");
  assert.equal(st(ay, "non_damage_ignore")?.duration, 2, "ignores harmful non-damage for 2 turns");
  assert.equal(markOf(ay, "Chorus")?.duration, 2, "activates Chorus (base ayana2 mark, 2 turns)");
});

test("divine/Verse of Ascension: 'ignores harmful effects' voids incoming damage AND a foe's stun", () => {
  const { state, ay } = scene("divine", [], [enemy("e")]);
  performAction(state, { unit: "ay", skillId: "ayanadivine1", targets: [] });
  // damage_ignore: a 50-damage hit is fully voided.
  const r = applyDamage(ay, { amount: 50, type: "normal", isNew: true });
  assert.equal(r.hpLost, 0, "damage_ignore voids all incoming damage");
  // non_damage_ignore: an enemy-applied stun does not land.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: state.units["e"]!, targets: [ay], targeting: "single" });
  assert.ok(!st(ay, "stun"), "non_damage_ignore blocks a foe-applied stun");
});

test("divine/Verse of Ascension: is castable while stunned (Unstunnable); a normal skill is not (control)", () => {
  const { state, ay } = scene("divine", [], [enemy("e")]);
  ay.statuses.push(status("stun", { appliedBy: "e", duration: 3 }));
  // Control: a stunnable skill is blocked.
  assert.equal(performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] }).reason, "stunned", "Voice of Light is blocked while stunned");
  // Verse of Ascension cannot be stunned.
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanadivine1", targets: [] }).ok, "Verse of Ascension casts through the stun");
});

// ###########################################################################
// # judgment — Searing Rebuke (passive) + Final Word (active)
// ###########################################################################

test("judgment/Searing Rebuke: a Voice-of-Light-marked enemy that deals damage takes 15 Affliction", () => {
  const { state } = scene("judgment", [], [enemy("e"), enemy("e2")]);
  markVoL(state.units["e"]!);
  enemyDeals(state, "e");
  assert.equal(state.units["e"]!.hp, 85, "marked enemy that dealt damage takes 15 -> 85");
  // one-shot: the mark is consumed, so a second hit does not rebuke again.
  assert.ok(!markOf(state.units["e"]!, "Voice of Light"), "the Voice of Light mark is consumed");
  enemyDeals(state, "e");
  assert.equal(state.units["e"]!.hp, 85, "no further rebuke once the mark is gone");

  // Control: an UNMARKED enemy dealing damage is not rebuked.
  enemyDeals(state, "e2");
  assert.equal(state.units["e2"]!.hp, 100, "unmarked enemy -> no rebuke");
});

test("judgment/Final Word: 25 piercing normally (piercing ignores the target's DR)", () => {
  const { state } = scene("judgment", [ally("a1")], [enemy("e")]);
  state.units["e"]!.statuses.push(status("damage_reduction", { magnitude: 20, appliedBy: "e" }));
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanajudgment1", targets: ["e"] }).ok, "cast Final Word (Ayana has a living ally)");
  assert.equal(state.units["e"]!.hp, 75, "25 piercing ignores the 20 DR -> 100-25 = 75");
});

test("judgment/Final Word: doubles to 50 ONLY when both Ayana and her target are alone", () => {
  // Ayana alone AND target alone -> double.
  {
    const { state } = scene("judgment", [], [enemy("e")]);
    performAction(state, { unit: "ay", skillId: "ayanajudgment1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 50, "no living allies on either side -> double: 100-50 = 50");
  }
  // Control A: Ayana has a living ally -> single.
  {
    const { state } = scene("judgment", [ally("a1")], [enemy("e")]);
    performAction(state, { unit: "ay", skillId: "ayanajudgment1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 75, "Ayana not alone -> 25 only");
  }
  // Control B: target has a living ally -> single.
  {
    const { state } = scene("judgment", [], [enemy("e"), enemy("e2")]);
    performAction(state, { unit: "ay", skillId: "ayanajudgment1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 75, "target not alone -> 25 only");
  }
});

// ###########################################################################
// # prism — Illumination (passive) + Prism Sentence (active)
// ###########################################################################

test("prism/Prism Sentence: stuns(2), marks Prism Sentence(2), and adds a VoL-scoped x2 damage taken", () => {
  const { state } = scene("prism", [], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanaprism1", targets: ["e"] }).ok, "cast Prism Sentence");
  const e = state.units["e"]!;
  assert.equal(st(e, "stun")?.duration, 2, "stunned for 2 turns");
  assert.equal(markOf(e, "Prism Sentence")?.duration, 2, "marked Prism Sentence for 2 turns");
  const mult = st(e, "incoming_damage_mult");
  assert.equal(mult?.magnitude, 2, "double damage (x2)");
  assert.equal(mult?.viaSourceId, "ayana1.hit", "…scoped to Voice of Light (ayana1.hit)");
});

test("prism/Prism Sentence: Voice of Light hits are DOUBLED; other damage is not (scoped)", () => {
  const { state } = scene("prism", [], [enemy("e")]);
  performAction(state, { unit: "ay", skillId: "ayanaprism1", targets: ["e"] });
  const e = state.units["e"]!;
  // A VoL-sourced 15 becomes 30.
  assert.equal(applyDamage(e, { amount: 15, type: "normal", isNew: true, sourceId: "ayana1.hit" }).hpLost, 30, "VoL hit doubled");
  // Control: a non-VoL source is unaffected (the mult is viaSourceId-scoped).
  assert.equal(applyDamage(e, { amount: 15, type: "normal", isNew: true, sourceId: "other.hit" }).hpLost, 15, "non-VoL damage not doubled");
  // Control: an UNMARKED enemy is never doubled.
  const s2 = scene("prism", [], [enemy("x")]);
  assert.equal(applyDamage(s2.state.units["x"]!, { amount: 15, type: "normal", isNew: true, sourceId: "ayana1.hit" }).hpLost, 15, "no Prism mark -> not doubled");
});

test("prism/Prism Sentence: casting VoL on the marked enemy also hits the WHOLE enemy team, Bypassing", () => {
  const { state } = scene("prism", [], [enemy("e1"), enemy("e2", { hp: 100 })]);
  state.units["e2"]!.statuses.push(status("damage_reduction", { magnitude: 10, appliedBy: "e2" }));
  performAction(state, { unit: "ay", skillId: "ayanaprism1", targets: ["e1"] });
  // Base Voice of Light on the Prism-marked e1 splashes 15 (Bypassing) onto e2 even though e2 was NOT targeted.
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e1"] });
  assert.equal(state.units["e2"]!.hp, 85, "untargeted e2 takes the 15 splash, and Bypassing ignores its 10 DR");
  assert.ok(state.units["e1"]!.hp < 70, "e1 took its own doubled VoL hit plus the enemy-team splash");
});

test("prism/Illumination: while Prism Sentence is active, Ayana's team sees enemy Invisible effects", () => {
  const { state } = scene("prism", [], [enemy("e1"), enemy("e2")]);
  // e2 carries an Invisible enemy effect.
  state.units["e2"]!.statuses.push(status("mark", { name: "Ambush", invisible: true, appliedBy: "e2" }));
  assert.equal(viewerHasReveal(state, "A"), false, "no True Sight before Prism Sentence");
  const before = redactState(state, "A");
  assert.ok(!before.units["e2"]!.statuses.some((s) => s.name === "Ambush"), "the Invisible effect is hidden from A pre-Illumination");

  performAction(state, { unit: "ay", skillId: "ayanaprism1", targets: ["e1"] });
  assert.equal(viewerHasReveal(state, "A"), true, "Prism Sentence grants Illumination (reveal) to Ayana's team");
  const after = redactState(state, "A");
  assert.ok(after.units["e2"]!.statuses.some((s) => s.name === "Ambush"), "Illumination makes the enemy Invisible effect visible");
});

// ###########################################################################
// # sanctuary — Hallowed Footsteps (passive) + Consecrate (active)
// ###########################################################################

test("sanctuary/Consecrate: applies a 5/piercing/5-turn dot to enemies and a 5/5-turn regen to allies", () => {
  const { state, ay } = scene("sanctuary", [ally("a1", { hp: 50 })], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanasanctuary1", targets: [] }).ok, "cast Consecrate");
  const dot = st(state.units["e"]!, "dot", "Consecrate");
  assert.equal(dot?.magnitude, 5, "enemy dot magnitude 5");
  assert.equal(dot?.dtype, "piercing", "enemy dot is Piercing");
  assert.equal(dot?.duration, 5, "enemy dot lasts 5 turns");
  assert.equal(st(ay, "regen", "Consecrate")?.magnitude, 5, "Ayana (an ally) gets the regen");
  const reg = st(state.units["a1"]!, "regen", "Consecrate");
  assert.equal(reg?.magnitude, 5, "ally regen magnitude 5");
  assert.equal(reg?.duration, 5, "ally regen lasts 5 turns");
  // No instant effect on cast — it is a damage/heal-over-time.
  assert.equal(state.units["e"]!.hp, 100, "no immediate damage on cast");
  assert.equal(state.units["a1"]!.hp, 50, "no immediate heal on cast");
});

test("sanctuary/Consecrate: each tick is 5 (dot) / 5 (regen) — NOT boosted by Hallowed Footsteps", () => {
  const { state } = scene("sanctuary", [ally("a1", { hp: 50 })], [enemy("e")]);
  performAction(state, { unit: "ay", skillId: "ayanasanctuary1", targets: [] });
  state.turn += 1; // leave the birth turn so the tick fires
  tickDots(state, "A");
  assert.equal(state.units["e"]!.hp, 95, "dot tick deals exactly 5 (Consecrate does not trigger the +10)");
  assert.equal(state.units["a1"]!.hp, 55, "regen tick heals exactly 5 (Consecrate does not trigger the +10)");
});

test("sanctuary/Hallowed Footsteps: +10 damage to a Consecrate-affected enemy; NOT for Consecrate itself", () => {
  const { state } = scene("sanctuary", [], [enemy("e1"), enemy("e2"), enemy("e3")]);
  // e1 & e3 are 'affected by Consecrate' (hold the named dot); e2 is not.
  for (const id of ["e1", "e3"]) state.units[id]!.statuses.push(status("dot", { name: "Consecrate", magnitude: 5, dtype: "piercing", appliedBy: "ay", duration: 5 }));

  strike(state, "ay", "e1", 20, "ayana1.hit"); // Ayana deals non-Consecrate damage
  assert.equal(state.units["e1"]!.hp, 70, "20 + Hallowed Footsteps 10 = 30 -> 70");

  strike(state, "ay", "e2", 20, "ayana1.hit"); // control: no Consecrate dot
  assert.equal(state.units["e2"]!.hp, 80, "no Consecrate dot -> no +10");

  strike(state, "ay", "e3", 20, "Consecrate"); // the +10 is NOT triggered by Consecrate itself
  assert.equal(state.units["e3"]!.hp, 80, "Consecrate-sourced damage does not fire the +10");
});

test("sanctuary/Hallowed Footsteps: +10 healing to a Consecrate-affected ally (control: unaffected ally)", () => {
  const { state } = scene("sanctuary", [ally("a1", { hp: 50 }), ally("a2", { hp: 50 })], [enemy("e")]);
  state.units["a1"]!.statuses.push(status("regen", { name: "Consecrate", magnitude: 5, appliedBy: "ay", duration: 5 }));
  healOp(state, "ay", "a1", 20);
  assert.equal(state.units["a1"]!.hp, 80, "20 + Hallowed Footsteps 10 = 30 -> 80");
  healOp(state, "ay", "a2", 20);
  assert.equal(state.units["a2"]!.hp, 70, "ally without Consecrate regen -> heal is exactly 20");
});

// ###########################################################################
// # vengeance — Divine Ire (passive) + Voice of Vengeance (active)
// ###########################################################################

test("vengeance/Divine Ire: an enemy hitting an ally HERO banks +5 VoL bonus on it (stacks)", () => {
  const { state } = scene("vengeance", [ally("a1"), ally("am", { kind: "minion" })], [enemy("e")]);
  emit(state, { type: "damageDealt", source: "e", target: "a1", amount: 9, dtype: "normal", isNew: true });
  assert.equal(stackMag(state.units["e"]!, "Divine Ire"), 5, "one hit on an ally hero -> +5");
  emit(state, { type: "damageDealt", source: "e", target: "a1", amount: 9, dtype: "normal", isNew: true });
  assert.equal(stackMag(state.units["e"]!, "Divine Ire"), 10, "second hit -> stacks to +10");

  // Control: hitting an ally MINION (not a hero) banks nothing.
  emit(state, { type: "damageDealt", source: "e", target: "am", amount: 9, dtype: "normal", isNew: true });
  assert.equal(stackMag(state.units["e"]!, "Divine Ire"), 10, "an ally minion is not 'Ayana's allies' (hero) -> no bank");
});

test("vengeance/Divine Ire: the banked bonus makes base Voice of Light deal +5 (control: unmarked enemy)", () => {
  const { state } = scene("vengeance", [ally("a1")], [enemy("e"), enemy("e2")]);
  emit(state, { type: "damageDealt", source: "e", target: "a1", amount: 9, dtype: "normal", isNew: true });
  assert.equal(stackMag(state.units["e"]!, "Divine Ire"), 5, "e banked +5");
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
  assert.equal(state.units["e"]!.hp, 80, "Voice of Light 15 + Divine Ire 5 = 20 -> 80");
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e2"] });
  assert.equal(state.units["e2"]!.hp, 85, "control: no Divine Ire -> plain 15 -> 85");
});

test("vengeance/Voice of Vengeance: 35 base, +5 per dead ally, and Piercing once BOTH allies are dead", () => {
  // 0 dead allies -> 35 normal.
  {
    const { state } = scene("vengeance", [ally("a1"), ally("a2")], [enemy("e")]);
    performAction(state, { unit: "ay", skillId: "ayanavengeance1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 65, "0 dead -> 35 -> 65");
  }
  // 1 dead ally -> 40 normal.
  {
    const { state } = scene("vengeance", [ally("a1"), ally("a2", { alive: false, hp: 0 })], [enemy("e")]);
    performAction(state, { unit: "ay", skillId: "ayanavengeance1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 60, "1 dead -> 35+5 = 40 -> 60");
  }
  // 2 dead allies -> 45 AND Piercing (ignores DR).
  {
    const { state } = scene("vengeance", [ally("a1", { alive: false, hp: 0 }), ally("a2", { alive: false, hp: 0 })], [enemy("e")]);
    state.units["e"]!.statuses.push(status("damage_reduction", { magnitude: 20, appliedBy: "e" }));
    performAction(state, { unit: "ay", skillId: "ayanavengeance1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 55, "2 dead -> 45 Piercing ignores the 20 DR -> 55");
  }
});

// ###########################################################################
// # vigilante — Word of the Law (passive) + Bounty (active)
// ###########################################################################

test("vigilante/Word of the Law: triggering VoL adds +10 damage-from-VoL for 2 turns (VoL-scoped)", () => {
  const { state } = scene("vigilante", [], [enemy("e")]);
  markVoL(state.units["e"]!);
  enemyDeals(state, "e");
  const mod = st(state.units["e"]!, "incoming_damage_mod");
  assert.equal(mod?.magnitude, 10, "+10 incoming");
  assert.equal(mod?.duration, 2, "for 2 turns");
  assert.equal(mod?.viaSourceId, "ayana1.hit", "scoped to Voice of Light");
  assert.ok(!markOf(state.units["e"]!, "Voice of Light"), "the mark is consumed (one-shot)");

  // Behavioral: a VoL-sourced hit deals +10; a non-VoL hit does not.
  assert.equal(applyDamage(state.units["e"]!, { amount: 15, type: "normal", isNew: true, sourceId: "ayana1.hit" }).hpLost, 25, "VoL hit 15 + 10 = 25");
  assert.equal(applyDamage(state.units["e"]!, { amount: 15, type: "normal", isNew: true, sourceId: "other" }).hpLost, 15, "non-VoL hit is unaffected");
});

test("vigilante/Word of the Law: an UNMARKED enemy dealing damage gets no bonus (control)", () => {
  const { state } = scene("vigilante", [], [enemy("e")]);
  enemyDeals(state, "e");
  assert.ok(!st(state.units["e"]!, "incoming_damage_mod"), "unmarked enemy -> no Word of the Law bonus");
});

test("vigilante/Bounty: shatters(2) + marks Bounty(2); allies who hit the marked enemy heal 10", () => {
  const { state } = scene("vigilante", [ally("a1", { hp: 50 })], [enemy("e"), enemy("e2")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanavigilante1", targets: ["e"] }).ok, "cast Bounty");
  assert.equal(st(state.units["e"]!, "shatter")?.duration, 2, "target Shattered for 2 turns");
  assert.equal(markOf(state.units["e"]!, "Bounty")?.duration, 2, "target marked Bounty for 2 turns");

  // An ally dealing damage to the Bounty enemy is healed 10.
  strike(state, "a1", "e", 12);
  assert.equal(state.units["a1"]!.hp, 60, "ally a1 healed 10 for damaging the Bounty target");

  // Control: an ally damaging a NON-Bounty enemy is not healed.
  state.units["a1"]!.hp = 50;
  strike(state, "a1", "e2", 12);
  assert.equal(state.units["a1"]!.hp, 50, "no Bounty mark on e2 -> no lifesteal");
});

// ###########################################################################
// # zealot — Inquisition (passive) + Purge the Wicked (active)
// ###########################################################################

test("zealot/Inquisition: a VoL-marked enemy that deals damage is Isolated for 1 turn (mark consumed)", () => {
  const { state } = scene("zealot", [], [enemy("e"), enemy("e2")]);
  markVoL(state.units["e"]!);
  enemyDeals(state, "e");
  assert.equal(st(state.units["e"]!, "isolated")?.duration, 1, "the triggering enemy is Isolated for 1 turn");
  assert.ok(!markOf(state.units["e"]!, "Voice of Light"), "the Voice of Light mark is consumed");

  // Control: an unmarked enemy dealing damage is not Isolated.
  enemyDeals(state, "e2");
  assert.ok(!st(state.units["e2"]!, "isolated"), "unmarked enemy -> not Isolated");
});

test("zealot/Purge the Wicked: for 3 turns EVERY unit is Shattered, uncounterable, and stun-immune", () => {
  const { state, ay } = scene("zealot", [ally("a1")], [enemy("e")]);
  assert.ok(performAction(state, { unit: "ay", skillId: "ayanazealot1", targets: [] }).ok, "cast Purge the Wicked");
  for (const id of ["ay", "a1", "e"]) {
    const u = state.units[id]!;
    assert.equal(st(u, "shatter")?.duration, 3, `${id} Shattered for 3 turns`);
    assert.equal(st(u, "uncounterable")?.duration, 3, `${id} immune to counters for 3 turns`);
    assert.equal(markOf(u, "Stun Immunity")?.duration, 3, `${id} stun-immune for 3 turns`);
  }
  // Shatter is real: it voids the target's DR.
  state.units["e"]!.statuses.push(status("damage_reduction", { magnitude: 20, appliedBy: "e" }));
  assert.equal(applyDamage(state.units["e"]!, { amount: 30, type: "normal", isNew: true }).hpLost, 30, "Shatter voids the 20 DR -> full 30");
});

test("zealot/Purge the Wicked: stun-immunity is real — a stunned unit can still act (control: without it)", () => {
  // With Purge: Ayana is stun-immune, so a stun does not block her.
  {
    const { state, ay } = scene("zealot", [], [enemy("e")]);
    performAction(state, { unit: "ay", skillId: "ayanazealot1", targets: [] });
    ay.statuses.push(status("stun", { appliedBy: "e", duration: 2 }));
    ay.skills!.find((s) => s.id === "ayana1")!.currentCd = 0;
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] }).ok, "stun-immune Ayana still casts");
  }
  // Control: without Stun Immunity a stun blocks the same skill.
  {
    const { state, ay } = scene("zealot", [], [enemy("e")]);
    ay.statuses.push(status("stun", { appliedBy: "e", duration: 2 }));
    assert.equal(performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] }).reason, "stunned", "no Stun Immunity -> blocked");
  }
});
