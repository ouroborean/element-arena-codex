import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { performAction } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Status, Unit } from "../src/types.ts";

/**
 * ADVERSARIAL, SPEC-DERIVED suite for PYRRHA's FUSION FORMS.
 * The FROZEN PROSE (content/frozen/skills.json) is the oracle for every assertion; the
 * generated/authored fusion content is read only to learn HOW to drive each form.
 *
 * Forms (passive / active), verbatim frozen text:
 *  alchemy    Alchemist's Fire  "Dealing damage to an enemy while Pyrrha has Bottled Flame will apply an
 *                                additional 5 Affliction damage for 4 turns."
 *             Bottled Flame     "Removes Fan the Flames from target enemy, giving Pyrrha Elemental Essence
 *                                and a Bottled Flame for 3 turns."
 *  apocalypse Ice Age           "Damaging an enemy with Feed the Fire now also lowers the target's damage by
 *                                5 for their next 2 turns."
 *             Extinction Event  "Deals 35 damage to all enemies, and for 1 turn, if that enemy becomes
 *                                invulnerable, they are stunned for 1 turn."
 *  brimstone  Festering Burns   "Fan the Flames is now permanent and stacks, but is no longer affected by
 *                                Pyrokinesis."
 *             Sulphur Vent      "Counters the first enemy to use a skill on Pyrrha for 1 turn. If an enemy is
 *                                successfully countered this way, they have a stack of Fan the Flames added."
 *  devil      Flames of Greed   "Fan the Flames now affects all enemies, but also affects all allies."
 *             Mammon's Flame    "Deals 40 Affliction damage to one enemy and 20 Affliction damage to Pyrrha.
 *                                This skill costs 1 more [Generic] and deals 10 more damage to the target and
 *                                Pyrrha each time it is used."
 *  dragon     Dragon's Hunger   "Pyrrha deals 5 more damage and healing with Feed the Fire, and it targets
 *                                all enemies currently affected by Fan the Flames."
 *             Flame of Legends  "Deals 25 Affliction damage to one enemy and applies the damage-over-time
 *                                portion of Fan the Flames. While Pyrrha is at or below 30 HP, this skill
 *                                targets all enemies."
 *  judgment   Flames of Judgment"Receiving damage from Fan the Flames or using a skill on Pyrrha or her
 *                                allies gives enemies a stack of Flames of Judgment."
 *             Judgment Day      "Target enemy with 7 or more stacks of Flames of Judgment is instantly killed.
 *                                This skill Bypasses and cannot be countered or reflected."
 *  mechanic   Exhaust Fumes     "Enemies affected by Fan the Flames receive 10 Affliction damage if they
 *                                target Pyrrha with a new skill."
 *             Blastoff          "Deals 15 damage to all enemies and makes Pyrrha invulnerable for 2 turns, or
 *                                until she uses a new skill."
 *  plasma     Burning Plasma    "Fan the Flames now Shatters the affected enemy for its duration."
 *             Ivory Cutter      "Deals 20 Piercing damage to target enemy. If the enemy is Shattered, they
 *                                take an additional 5 damage and Pyrrha gains Elemental Essence."
 *  ritual     Ritual of Agony   "Pyrrha's Ritual gains 4 Ritual Power whenever a unit receives damage or dies.
 *                                When this effect reaches 75 Ritual Power, all units will permanently receive
 *                                double damage (this effect does not stack)."
 *             Tormentor's Brand "Deals 15 damage to an enemy or an ally and sets their max HP to their
 *                                current HP."
 *  sun        Solar Flare       "Flashbang now costs [Sun] but affects all enemies."
 *             Scorched Earth    "Deals 20 Affliction damage to all enemy Heroes. If they are affected by Fan
 *                                the Flames, this skill deals an additional 10 damage and removes Elemental
 *                                Essence from them."
 */

// --------------------------------------------------------------------------- //
//  Harness
// --------------------------------------------------------------------------- //

const ROUNDSTART_FORMS = new Set(["brimstone", "devil", "dragon", "sun"]);

function fuse(element: string, opts: { enemies?: number; allies?: number } = {}) {
  const p = loadHero(heroById("pyrrha"), "A", "p");
  applyFusion(p, fusionForm("pyrrha", element)!);
  const allies: Unit[] = [];
  for (let i = 0; i < (opts.allies ?? 0); i++) allies.push(makeUnit({ id: `a${i + 1}`, team: "A", kind: "hero", name: `Ally${i + 1}` }));
  const enemies: Unit[] = [];
  for (let i = 0; i < (opts.enemies ?? 1); i++) enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", kind: "hero", name: `Enemy${i + 1}` }));
  const state = makeState([p, ...allies], enemies);
  const pool = { generic: 99, fire: 99, [element]: 99 };
  state.teams.A.energy = { ...pool };
  state.teams.B.energy = { ...pool };
  // brimstone/devil/dragon/sun rewrite a base skill via a roundStart-installed passive trigger.
  emit(state, { type: "roundStart" });
  return { p, state, enemies, allies };
}

const sk = (u: Unit, id: string) => u.skills!.find((s) => s.id === id)!;
const dotOf = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "dot" && s.name === name);
const dotTotal = (u: Unit, name: string) =>
  u.statuses.filter((s) => s.kind === "dot" && s.name === name).reduce((n, s) => n + (s.magnitude ?? 0), 0);
const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const markOf = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "mark" && s.name === name);
const stackMag = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "stack" && s.name === name)?.magnitude ?? 0;
const statusOf = (u: Unit, kind: Status["kind"], name?: string) =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const FAN = "Fan the Flames";
const pushFan = (u: Unit, appliedBy = "p", duration: number | null = 3) =>
  u.statuses.push({ kind: "dot", name: FAN, magnitude: 5, dtype: "affliction", duration, appliedBy, appliedTurn: 0 });

// --------------------------------------------------------------------------- //
//  Loadout sanity
// --------------------------------------------------------------------------- //

test("each Pyrrha fusion form re-elements her and inserts its active in slot 4", () => {
  for (const [element, id, name] of [
    ["alchemy", "pyrrhaalchemy1", "Bottled Flame"], ["apocalypse", "pyrrhaapocalypse1", "Extinction Event"],
    ["brimstone", "pyrrhabrimstone1", "Sulphur Vent"], ["devil", "pyrrhadevil1", "Mammon's Flame"],
    ["dragon", "pyrrhadragon1", "Flame of Legends"], ["judgment", "pyrrhajudgment1", "Judgment Day"],
    ["mechanic", "pyrrhamechanic1", "Blastoff"], ["plasma", "pyrrhaplasma1", "Ivory Cutter"],
    ["ritual", "pyrrharitual1", "Tormentor's Brand"], ["sun", "pyrrhasun1", "Scorched Earth"],
  ] as const) {
    const { p } = fuse(element);
    assert.equal(p.currentElement, element, `${element}: currentElement re-set`);
    assert.equal(p.fused, element);
    const s = sk(p, id);
    assert.equal(s.name, name, `${element}: active present`);
    assert.equal(p.skills!.indexOf(s), 3, `${element}: active inserted at slot 4`);
    // base kit intact
    for (const b of ["pyrrha1", "pyrrha2", "pyrrha3", "pyrrha4", "pyrrha5"]) assert.ok(sk(p, b), `${element}: ${b} kept`);
  }
});

// --------------------------------------------------------------------------- //
//  alchemy — Alchemist's Fire (passive) + Bottled Flame (active)
// --------------------------------------------------------------------------- //

test("Bottled Flame: removes Fan the Flames from the target, gives Pyrrha Essence + Bottled Flame(3)", () => {
  const { p, state, enemies } = fuse("alchemy");
  const e = enemies[0]!;
  pushFan(e);
  assert.ok(dotOf(e, FAN), "precondition: enemy is affected");
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhaalchemy1", targets: ["e1"] }).ok, true);
  assert.ok(!dotOf(e, FAN), "Fan the Flames removed from the target");
  assert.ok(hasEssence(p), "Pyrrha gained Elemental Essence");
  const m = markOf(p, "Bottled Flame");
  assert.ok(m, "Pyrrha gained a Bottled Flame");
  assert.equal(m!.duration, 3, "Bottled Flame lasts 3 turns");
});

test("Alchemist's Fire: while Pyrrha holds Bottled Flame, damaging an enemy adds 5 Affliction for 4 turns", () => {
  const { p, state, enemies } = fuse("alchemy");
  const e = enemies[0]!;
  // Give Pyrrha a Bottled Flame, then deal damage with a base skill (Fan the Flames' 15 up-front hit).
  p.statuses.push({ kind: "mark", name: "Bottled Flame", duration: 3, appliedBy: "p", appliedTurn: 0 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] }).ok, true);
  const af = dotOf(e, "Alchemist's Fire");
  assert.ok(af, "Alchemist's Fire dot applied on damage");
  assert.equal(af!.magnitude, 5, "5 Affliction per turn");
  assert.equal(af!.duration, 4, "for 4 turns");
  assert.equal(af!.dtype, "affliction");
});

test("Alchemist's Fire: NO extra dot when Pyrrha lacks Bottled Flame (control)", () => {
  const { state, enemies } = fuse("alchemy");
  const e = enemies[0]!;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] }).ok, true);
  assert.ok(!dotOf(e, "Alchemist's Fire"), "no Alchemist's Fire without the Bottled Flame mark");
});

// --------------------------------------------------------------------------- //
//  apocalypse — Ice Age (passive) + Extinction Event (active)
// --------------------------------------------------------------------------- //

test("Ice Age: Feed the Fire damaging an enemy lowers that enemy's damage by 5 for 2 turns", () => {
  const { state, enemies } = fuse("apocalypse", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  pushFan(e1);
  pushFan(e2);
  // Feed the Fire (pyrrha2) damages the Fan-affected target -> Ice Age applies -5 outgoing.
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha2", targets: ["e1"] }).ok, true);
  assert.equal(e1.hp, 90, "Feed the Fire dealt its 10 to the affected target");
  const mod = statusOf(e1, "outgoing_damage_mod");
  assert.ok(mod, "Ice Age applied an outgoing-damage debuff");
  assert.equal(mod!.magnitude, -5, "-5 to the target's damage");
  assert.equal(mod!.duration, 2, "for their next 2 turns");
  // Control: Pyrokinesis (pyrrha3) also deals damage but is NOT Feed the Fire -> no debuff.
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e2"] }).ok, true);
  assert.ok(e2.hp < 100, "Pyrokinesis did damage e2");
  assert.ok(!statusOf(e2, "outgoing_damage_mod"), "Ice Age is scoped to Feed the Fire, not Pyrokinesis");
});

test("Extinction Event: 35 damage to all enemies", () => {
  const { state, enemies } = fuse("apocalypse", { enemies: 2 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhaapocalypse1", targets: ["e1", "e2"] }).ok, true);
  assert.equal(enemies[0]!.hp, 65, "35 to e1");
  assert.equal(enemies[1]!.hp, 65, "35 to e2");
});

test("Extinction Event: an enemy that becomes invulnerable within the 1-turn window is stunned", () => {
  const { p, state, enemies } = fuse("apocalypse", { enemies: 2 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhaapocalypse1", targets: ["e1", "e2"] }).ok, true);
  // e1 becomes invulnerable -> the watch stuns it. e2 does not -> not stunned.
  enemies[0]!.statuses.push({ kind: "invulnerable", duration: 2, appliedBy: "e1", appliedTurn: 0 });
  emit(state, { type: "statusApplied", unit: "e1", source: "e1", kind: "invulnerable" });
  assert.ok(statusOf(enemies[0]!, "stun"), "enemy stunned for becoming invulnerable");
  assert.ok(!statusOf(enemies[1]!, "stun"), "e2 never became invulnerable -> not stunned (control)");
  // Control: Pyrrha (an ally) becoming invulnerable does NOT get stunned.
  emit(state, { type: "statusApplied", unit: "p", source: "p", kind: "invulnerable" });
  assert.ok(!statusOf(p, "stun"), "the stun is scoped to enemies, not allies");
});

// --------------------------------------------------------------------------- //
//  brimstone — Festering Burns (passive) + Sulphur Vent (active)
// --------------------------------------------------------------------------- //

test("Festering Burns: Fan the Flames' burn is now permanent (duration null)", () => {
  const { state, enemies } = fuse("brimstone");
  const e = enemies[0]!;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] }).ok, true);
  const d = dotOf(e, FAN);
  assert.ok(d, "burn applied");
  assert.equal(d!.duration, null, "the burn is permanent");
});

test("Festering Burns says Fan the Flames now STACKS, but re-casting only refreshes", () => {
  const { state, enemies } = fuse("brimstone");
  const e = enemies[0]!;
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] });
  sk((state.units["p"]!), "pyrrha1").currentCd = 0;
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] });
  // Frozen: "Fan the Flames is now ... stacks" -> two applications => 10 burn/turn.
  assert.equal(dotTotal(e, FAN), 10, "two applications should stack to 10 burn per turn");
});

test("Festering Burns says Fan the Flames is no longer affected by Pyrokinesis", () => {
  const { state, enemies } = fuse("brimstone");
  const e = enemies[0]!;
  performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] });
  assert.equal(dotOf(e, FAN)!.magnitude, 5, "burn starts at 5");
  // Pyrokinesis normally adds +5 to the burn; under Festering Burns it should NOT.
  performAction(state, { unit: "p", skillId: "pyrrha3", targets: ["e1"] });
  assert.equal(dotOf(e, FAN)!.magnitude, 5, "Pyrokinesis must not boost the Festering burn");
});

test("Sulphur Vent: counters the first enemy skill aimed at Pyrrha and burns that enemy; only the first", () => {
  const { p, state, enemies } = fuse("brimstone", { enemies: 2 });
  const atk = [{ op: "damage" as const, amount: 30 as const, to: "target" as const }];
  enemies[0]!.skills = [{ id: "atk", name: "atk", element: "fire", targeting: "single", effects: atk, cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful", "Instant"] }];
  enemies[1]!.skills = [{ id: "atk2", name: "atk2", element: "fire", targeting: "single", effects: atk, cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful", "Instant"] }];
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhabrimstone1", targets: [] }).ok, true);
  assert.ok(markOf(p, "Sulphur Vent"), "Sulphur Vent counter marker set on Pyrrha");
  // First enemy skill on Pyrrha -> countered (effects do not land) and that enemy is burned.
  const r1 = performAction(state, { unit: "e1", skillId: "atk", targets: ["p"] });
  assert.equal(r1.countered, true, "the first enemy skill on Pyrrha was countered");
  assert.equal(p.hp, 100, "the countered skill's 30 damage never landed");
  assert.ok(dotOf(enemies[0]!, FAN), "the countered enemy gains a stack of Fan the Flames");
  assert.ok(!markOf(p, "Sulphur Vent"), "the counter marker is consumed after the first counter");
  // Second enemy skill is NOT countered (only the FIRST).
  const r2 = performAction(state, { unit: "e2", skillId: "atk2", targets: ["p"] });
  assert.notEqual(r2.countered, true, "a later enemy skill is no longer countered");
  assert.equal(p.hp, 70, "the second skill's 30 damage lands");
});

// --------------------------------------------------------------------------- //
//  devil — Flames of Greed (passive) + Mammon's Flame (active)
// --------------------------------------------------------------------------- //

test("Flames of Greed: Fan the Flames now hits every enemy AND every ally", () => {
  const { p, state, enemies, allies } = fuse("devil", { enemies: 2, allies: 1 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] }).ok, true);
  for (const u of [enemies[0]!, enemies[1]!, allies[0]!]) {
    assert.ok(dotOf(u, FAN), `${u.id}: Fan the Flames burn applied`);
    assert.equal(u.hp, 85, `${u.id}: took the 15 up-front hit`);
  }
  // "all allies" includes Pyrrha herself (she is on the ally team).
  assert.ok(dotOf(p, FAN), "Pyrrha herself is also affected");
  assert.equal(p.hp, 85, "Pyrrha took the 15 up-front hit too");
});

test("Mammon's Flame: 40 to one enemy / 20 to Pyrrha, escalating +10 damage AND +1 Generic cost each use", () => {
  const { p, state, enemies } = fuse("devil");
  const e = enemies[0]!;
  const s = sk(p, "pyrrhadevil1");
  assert.equal(s.cost.generic, 1, "starts at 1 Generic");
  const beforeGen = state.teams.A.energy.generic!;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhadevil1", targets: ["e1"] }).ok, true);
  assert.equal(e.hp, 60, "first cast: 40 to the enemy");
  assert.equal(p.hp, 80, "first cast: 20 to Pyrrha");
  assert.equal(state.teams.A.energy.generic, beforeGen - 1, "first cast paid 1 Generic");
  assert.equal(s.cost.generic, 2, "cost escalated to 2 Generic");
  // second use
  s.currentCd = 0;
  const beforeGen2 = state.teams.A.energy.generic!;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhadevil1", targets: ["e1"] }).ok, true);
  assert.equal(e.hp, 10, "second cast: 50 to the enemy (40+10)");
  assert.equal(p.hp, 50, "second cast: 30 to Pyrrha (20+10)");
  assert.equal(state.teams.A.energy.generic, beforeGen2 - 2, "second cast paid 2 Generic");
  assert.equal(s.cost.generic, 3, "cost escalated again to 3 Generic");
});

// --------------------------------------------------------------------------- //
//  dragon — Dragon's Hunger (passive) + Flame of Legends (active)
// --------------------------------------------------------------------------- //

test("Dragon's Hunger: Feed the Fire deals +5 (15) and heals +5 (15), hitting all Fan-affected enemies", () => {
  const { p, state, enemies } = fuse("dragon", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  pushFan(e1);
  pushFan(e2);
  p.hp = 50;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha2", targets: [] }).ok, true);
  assert.equal(e1.hp, 85, "e1 took 15 (10 + Dragon's +5)");
  assert.equal(e2.hp, 85, "e2 (also affected) took 15 too");
  assert.equal(p.hp, 65, "Pyrrha healed 15 (10 + Dragon's +5)");
  assert.ok(hasEssence(p), "Pyrrha still gains Elemental Essence");
});

test("Dragon's Hunger: Feed the Fire hits only Fan-affected enemies", () => {
  const { state, enemies } = fuse("dragon", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  pushFan(e1); // e1 affected, e2 NOT affected
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha2", targets: [] }).ok, true);
  assert.equal(e1.hp, 85, "the affected enemy is hit for 15");
  assert.equal(e2.hp, 100, "an UNaffected enemy must not be targeted by Feed the Fire");
});

test("Flame of Legends: 25 Affliction + the Fan the Flames DoT on ONE enemy while Pyrrha is above 30 HP", () => {
  const { p, state, enemies } = fuse("dragon", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  p.hp = 31;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhadragon1", targets: ["e1"] }).ok, true);
  assert.equal(e1.hp, 75, "25 Affliction to the single target");
  const d = dotOf(e1, FAN);
  assert.ok(d, "applies the Fan the Flames DoT");
  assert.equal(d!.magnitude, 5);
  assert.equal(d!.duration, 3);
  assert.equal(e2.hp, 100, "the other enemy is untouched above 30 HP");
  assert.ok(!dotOf(e2, FAN));
});

test("Flame of Legends: while Pyrrha is at or below 30 HP it targets ALL enemies", () => {
  const { p, state, enemies } = fuse("dragon", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  p.hp = 30;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhadragon1", targets: ["e1"] }).ok, true);
  assert.equal(e1.hp, 75, "25 to e1");
  assert.equal(e2.hp, 75, "25 to e2 (all enemies at <=30 HP)");
  assert.ok(dotOf(e1, FAN) && dotOf(e2, FAN), "both get the Fan DoT");
});

// --------------------------------------------------------------------------- //
//  judgment — Flames of Judgment (passive) + Judgment Day (active)
// --------------------------------------------------------------------------- //

test("Flames of Judgment: taking damage from Fan the Flames grants the burning enemy a stack", () => {
  const { state, enemies } = fuse("judgment");
  const e = enemies[0]!;
  emit(state, { type: "damageDealt", source: "p", target: "e1", amount: 5, dtype: "affliction", sourceId: FAN });
  assert.equal(stackMag(e, "Flames of Judgment"), 1, "one stack per Fan the Flames damage instance");
  emit(state, { type: "damageDealt", source: "p", target: "e1", amount: 5, dtype: "affliction", sourceId: FAN });
  assert.equal(stackMag(e, "Flames of Judgment"), 2, "accumulates");
  // Control: damage NOT from Fan the Flames grants nothing.
  emit(state, { type: "damageDealt", source: "p", target: "e1", amount: 20, dtype: "affliction", sourceId: "pyrrha3" });
  assert.equal(stackMag(e, "Flames of Judgment"), 2, "non-Fan damage grants no Flames of Judgment stack");
});

test("Flames of Judgment: an enemy using a skill on Pyrrha or an ally gains a stack; not on its own side", () => {
  const { state, enemies } = fuse("judgment", { enemies: 2, allies: 1 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["p"], tags: ["Harmful"] });
  assert.equal(stackMag(e1, "Flames of Judgment"), 1, "enemy skill on Pyrrha -> stack");
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["a1"], tags: ["Harmful"] });
  assert.equal(stackMag(e1, "Flames of Judgment"), 2, "enemy skill on Pyrrha's ally -> stack");
  emit(state, { type: "skillUsed", caster: "e2", skillId: "y", targets: ["e1"], tags: ["Helpful"] });
  assert.equal(stackMag(e2, "Flames of Judgment"), 0, "enemy skill on its own ally -> no stack (control)");
});

test("Judgment Day: kills an enemy with 7+ Flames of Judgment stacks, spares one with 6; Bypasses invuln", () => {
  const { p, state, enemies } = fuse("judgment", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  e1.statuses.push({ kind: "stack", name: "Flames of Judgment", magnitude: 7, duration: null, appliedBy: "p", appliedTurn: 0 });
  e2.statuses.push({ kind: "stack", name: "Flames of Judgment", magnitude: 6, duration: null, appliedBy: "p", appliedTurn: 0 });
  // e1 is even Invulnerable — Judgment Day Bypasses, so it still dies.
  e1.statuses.push({ kind: "invulnerable", duration: 2, appliedBy: "e1", appliedTurn: 0 });
  const s = sk(p, "pyrrhajudgment1");
  assert.ok(s.tags.includes("Bypassing") && s.tags.includes("Uncounterable"), "Bypasses and cannot be countered/reflected");
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhajudgment1", targets: ["e1", "e2"] }).ok, true);
  assert.equal(e1.alive, false, "7-stack enemy instantly killed (despite Invulnerable — Bypassing)");
  assert.equal(e1.hp, 0);
  assert.equal(e2.alive, true, "6-stack enemy survives (needs 7+)");
});

// --------------------------------------------------------------------------- //
//  mechanic — Exhaust Fumes (passive) + Blastoff (active)
// --------------------------------------------------------------------------- //

test("Exhaust Fumes: a Fan-affected enemy that targets Pyrrha with a new skill takes 10 Affliction", () => {
  const { state, enemies, allies } = fuse("mechanic", { enemies: 2, allies: 1 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  pushFan(e1); // e1 affected; e2 not
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["p"], tags: ["Harmful"] });
  assert.equal(e1.hp, 90, "affected enemy targeting Pyrrha took 10 Affliction");
  // Control 1: unaffected enemy targeting Pyrrha -> nothing.
  emit(state, { type: "skillUsed", caster: "e2", skillId: "y", targets: ["p"], tags: ["Harmful"] });
  assert.equal(e2.hp, 100, "no Fan the Flames -> no Exhaust Fumes damage");
  // Control 2: affected enemy targeting someone OTHER than Pyrrha -> nothing.
  emit(state, { type: "skillUsed", caster: "e1", skillId: "z", targets: ["a1"], tags: ["Harmful"] });
  assert.equal(e1.hp, 90, "must target Pyrrha specifically");
});

test("Blastoff: 15 to all enemies + Pyrrha Invulnerable(2), ending early when SHE next uses a skill", () => {
  const { p, state, enemies } = fuse("mechanic", { enemies: 2 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhamechanic1", targets: ["e1", "e2"] }).ok, true);
  assert.equal(enemies[0]!.hp, 85, "15 to e1");
  assert.equal(enemies[1]!.hp, 85, "15 to e2");
  assert.ok(statusOf(p, "invulnerable", "Blastoff"), "Pyrrha is Invulnerable");
  assert.equal(statusOf(p, "invulnerable", "Blastoff")!.duration, 2, "for 2 turns");
  // The Blastoff cast itself survives (its one-shot grace), but her NEXT skill ends it.
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] }).ok, true);
  assert.ok(!statusOf(p, "invulnerable", "Blastoff"), "Invulnerable ends when Pyrrha uses a new skill");
});

test("Blastoff: an ENEMY's skill does not end Pyrrha's Invulnerable (control)", () => {
  const { p, state } = fuse("mechanic", { enemies: 1 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhamechanic1", targets: ["e1"] }).ok, true);
  assert.ok(statusOf(p, "invulnerable", "Blastoff"));
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["p"], tags: ["Harmful"] });
  assert.ok(statusOf(p, "invulnerable", "Blastoff"), "only Pyrrha's own skill cancels the Invulnerable");
});

// --------------------------------------------------------------------------- //
//  plasma — Burning Plasma (passive) + Ivory Cutter (active)
// --------------------------------------------------------------------------- //

test("Burning Plasma: applying Fan the Flames also Shatters the enemy for the burn's duration", () => {
  const { state, enemies } = fuse("plasma", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha1", targets: ["e1"] }).ok, true);
  const sh = statusOf(e1, "shatter");
  assert.ok(sh, "the Fan-affected enemy is Shattered");
  assert.equal(sh!.duration, 3, "Shatter lasts the burn's duration (3)");
  assert.ok(!statusOf(e2, "shatter"), "an un-Fanned enemy is not Shattered (control)");
});

test("Ivory Cutter: 20 Piercing; +5 and Essence if the target is Shattered", () => {
  const { p, state, enemies } = fuse("plasma", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  e1.statuses.push({ kind: "shatter", duration: 3, appliedBy: "p", appliedTurn: 0 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhaplasma1", targets: ["e1"] }).ok, true);
  assert.equal(e1.hp, 75, "Shattered target: 20 + 5 = 25");
  assert.ok(hasEssence(p), "Pyrrha gains Essence against a Shattered target");
  // Control: unshattered target -> 20 only, no Essence.
  const before = essenceCount(p);
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhaplasma1", targets: ["e2"] }).ok, true);
  assert.equal(e2.hp, 80, "unshattered: 20 Piercing only");
  assert.equal(essenceCount(p), before, "no extra Essence against an unshattered target");
});

// --------------------------------------------------------------------------- //
//  ritual — Ritual of Agony (passive) + Tormentor's Brand (active)
// --------------------------------------------------------------------------- //

test("Ritual of Agony: +4 Ritual Power whenever a unit takes damage or dies", () => {
  const { p, state } = fuse("ritual");
  emit(state, { type: "damageDealt", source: "e1", target: "p", amount: 5, dtype: "normal", sourceId: "x" });
  assert.equal(stackMag(p, "Ritual Power"), 4, "damage event -> +4");
  emit(state, { type: "damageDealt", source: "p", target: "e1", amount: 5, dtype: "normal", sourceId: "x" });
  assert.equal(stackMag(p, "Ritual Power"), 8, "accumulates on any unit's damage");
  emit(state, { type: "unitDied", unit: "e1", killer: "p" });
  assert.equal(stackMag(p, "Ritual Power"), 12, "a death also grants +4");
});

test("Ritual of Agony: at 75 Ritual Power all units permanently take double damage", () => {
  const { p, state, enemies } = fuse("ritual");
  const e = enemies[0]!;
  p.statuses.push({ kind: "stack", name: "Ritual Power", magnitude: 71, duration: null, appliedBy: "p", appliedTurn: 0 });
  emit(state, { type: "damageDealt", source: "p", target: "e1", amount: 1, dtype: "normal", sourceId: "x" }); // -> 75
  assert.ok(stackMag(p, "Ritual Power") >= 75, "threshold reached");
  assert.ok(markOf(p, "Ritual of Agony"), "the double-damage latch is set");
  const mult = statusOf(e, "incoming_damage_mult");
  assert.ok(mult, "every unit gains a double-damage multiplier");
  assert.equal(mult!.magnitude, 2, "x2 incoming damage");
  // Behavioural check: Tormentor's Brand's 15 now lands as 30.
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrharitual1", targets: ["e1"] }).ok, true);
  assert.equal(e.hp, 70, "15 base doubled to 30");
});

test("Tormentor's Brand: 15 damage then sets the target's max HP to its current HP (enemy or ally)", () => {
  const { state, enemies, allies } = fuse("ritual", { enemies: 1, allies: 1 });
  const e = enemies[0]!;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrharitual1", targets: ["e1"] }).ok, true);
  assert.equal(e.hp, 85, "15 damage");
  assert.equal(e.maxHp, 85, "max HP dropped to current HP");
  // Also works on an ally.
  const a = allies[0]!;
  sk((state.units["p"]!), "pyrrharitual1").currentCd = 0;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrharitual1", targets: ["a1"] }).ok, true);
  assert.equal(a.hp, 85, "15 damage to the ally");
  assert.equal(a.maxHp, 85, "ally max HP set to current");
});

// --------------------------------------------------------------------------- //
//  sun — Solar Flare (passive) + Scorched Earth (active)
// --------------------------------------------------------------------------- //

test("Solar Flare: Flashbang now costs 1 Sun (not Generic) and stuns ALL enemies", () => {
  const { p, state, enemies } = fuse("sun", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  const beforeGen = state.teams.A.energy.generic!;
  const beforeSun = state.teams.A.energy.sun!;
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrha4", targets: ["e1", "e2"] }).ok, true);
  assert.equal(state.teams.A.energy.generic, beforeGen, "no Generic spent (was 1 Generic before Solar Flare)");
  assert.equal(state.teams.A.energy.sun, beforeSun - 1, "costs 1 Sun now");
  for (const e of [e1, e2]) {
    const st = statusOf(e, "stun");
    assert.ok(st, `${e.id}: stunned by the team-wide Flashbang`);
    assert.equal(st!.scope?.tag, "Strategic");
    assert.equal(st!.scope?.mode, "except", "stuns non-Strategic skills");
  }
  assert.ok(statusOf(p, "invulnerable"), "Pyrrha still becomes Invulnerable");
});

test("Scorched Earth: 20 Affliction to all enemy Heroes; +10 and strips Essence from Fan-affected ones", () => {
  const { state, enemies } = fuse("sun", { enemies: 2 });
  const [e1, e2] = [enemies[0]!, enemies[1]!];
  pushFan(e1); // e1 affected; e2 not
  e1.statuses.push({ kind: "elemental_essence", duration: null, appliedBy: "e1", appliedTurn: 0 });
  e2.statuses.push({ kind: "elemental_essence", duration: null, appliedBy: "e2", appliedTurn: 0 });
  assert.equal(performAction(state, { unit: "p", skillId: "pyrrhasun1", targets: ["e1", "e2"] }).ok, true);
  assert.equal(e1.hp, 70, "Fan-affected: 20 + 10 = 30");
  assert.equal(e2.hp, 80, "unaffected: 20 only");
  assert.ok(!hasEssence(e1), "affected enemy's Elemental Essence removed");
  assert.ok(hasEssence(e2), "unaffected enemy keeps its Essence (control)");
});
