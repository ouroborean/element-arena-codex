import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { performAction, endTurn, canUse } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Status, StatusKind, Unit } from "../src/types.ts";

/**
 * ADVERSARIAL, SPEC-DERIVED suite for TITANIA's FUSION FORMS.
 * The FROZEN PROSE (content/frozen/skills.json) is the oracle for every assertion; the authored /
 * generated fusion content is read only to learn HOW to drive each form (skill ids, element keys,
 * cost, targeting, and the status/minion names a form produces).
 *
 * Forms (passive / active), verbatim frozen text:
 *  antidote  Capricious Cornucopia "When Titania uses Prance, Gift from the Fae changes to its beneficial
 *                                   version. When she uses a harmful skill on an enemy, it changes to its
 *                                   harmful version."
 *            Gift from the Fae      "If in its beneficial version, heals its target for 20 HP for 2 turns.
 *                                   If in its harmful version, any healing the target receives for the next
 *                                   3 turns is dealt as Affliction damage instead. This skill starts the
 *                                   game in its beneficial form."
 *  assassin  Sealed Fate            "Damage from Thorn Prick or its periodic effect will instantly kill
 *                                   minions if their HP falls below 20 from the hit."
 *            Drop of Moonglove      "For 1 turn, if target enemy receives healing, they will permanently
 *                                   ignore healing and receive 15 Affliction damage each turn for the rest
 *                                   of the round. This effect is invisible."
 *  battery   Arcadian Advancement   "Each time an ally triggers Prance, Titania's effects will permanently
 *                                   last an additional turn."
 *            The Whimsy Engine      "For the next 1 turn, any time a unit uses a new skill, they will instead
 *                                   use a random one of their skills with randomly selected targets."
 *  blight    Five Plagues           "Titania begins each round with 5 stacks of Five Plagues. Whenever an
 *                                   enemy receives Affliction damage from Titania, they have a 10% chance per
 *                                   stack to receive a random one of the following effects: skill costs
 *                                   increased by [65] for 1 turn, Shattered for 1 turn, non-Strategic skills
 *                                   stunned for 1 turn, Strategic skills stunned for 1 turn, Isolated for 1 turn."
 *            Locust Swarm           "Deals 15 Affliction damage to all enemies. Removes one stack of Five
 *                                   Plagues from Titania with each use"
 *  brimstone Barren Realm           "Titania now also generates one stack of Summer Clique any time she takes
 *                                   damage. Whenever she would create a Summer Courtesan, she instead deals 10
 *                                   Affliction damage to the enemy target with the lowest HP (random if tied).
 *                                   This effect Bypasses invulnerability."
 *            Arcadia, Enraged       "All enemies receive 5 Affliction damage each turn for 4 turns. During
 *                                   this time, Thorn Prick has no cost and its initial damage is increased by 5."
 *  evolution Compound Eyes          "Titania can no longer by Blinded, Stunned, or have her costs changed."
 *            Hive Formation         "For 4 turns, target ally gains Compound Eyes. During this time, if Titania
 *                                   uses Barbed Wit, the Taunt effect redirects to a random ally with Hive Formation."
 *  faerie    Summer Queen           "While Titania has a Summer Courtesan, she cannot be targeted by harmful skills."
 *            Burning Order          "Target Summer Courtesan deals triple damage this turn."
 *  serum     Weaponized Mirth       "Laughing Powder's damage over time is doubled, and when it transfers to a
 *                                   new target, the current target receives 15 Affliction damage."
 *            Hysteria Serum         "Target enemy is permanently Isolated, and receives 20 Affliction damage if
 *                                   they use a Helpful skill."
 *  spore     Hallucinogenic Spores  "Enemies affected by Barbed Wit or Laughing Powder have their non-Strategic
 *                                   skill costs increased by [65]. This effect does not stack."
 *            Raving Madness         "All enemies affected by Hallucinogenic Spores take 10 Affliction damage for
 *                                   2 turns. This effect Bypasses invulnerability."
 *  stasis    Winter Exile           "Titania can no longer create Summer Courtesan minions. When she uses Summer
 *                                   Clique, she instead creates Winter Loyalist minions."
 *            Icy Smile              "If target enemy receives new damage this turn, they are stunned and the
 *                                   damaging ally receives Elemental Essence."
 */

// --------------------------------------------------------------------------- //
//  Harness
// --------------------------------------------------------------------------- //

function fuse(element: string, opts: { allies?: Unit[]; enemies?: Unit[] } = {}) {
  const t = loadHero(heroById("titania"), "A", "t");
  applyFusion(t, fusionForm("titania", element)!);
  const allies = opts.allies ?? [];
  const enemies = opts.enemies ?? [makeUnit({ id: "e", team: "B" })];
  const st = makeState([t, ...allies], enemies);
  st.teams.A.energy = { generic: 40, [element]: 40, poison: 40 };
  st.teams.B.energy = { generic: 40, poison: 40, fire: 40, [element]: 40 };
  // blight / evolution install their passive via a roundStart trigger (Five Plagues counter; Compound Eyes mark).
  emit(st, { type: "roundStart" });
  return { t, st, enemies, allies };
}

const sk = (u: Unit, id: string) => u.skills!.find((s) => s.id === id)!;
const statusOf = (u: Unit, kind: StatusKind, name?: string): Status | undefined =>
  u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
const dotOf = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "dot" && s.name === name);
const regenOf = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "regen" && s.name === name);
const hasKind = (u: Unit, kind: StatusKind, name?: string): boolean => statusOf(u, kind, name) !== undefined;
const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const stackMag = (u: Unit, name: string): number => u.statuses.find((s) => s.kind === "stack" && s.name === name)?.magnitude ?? 0;
const setStack = (u: Unit, name: string, n: number) => {
  const s = u.statuses.find((x) => x.kind === "stack" && x.name === name);
  if (s) s.magnitude = n;
  else u.statuses.push({ kind: "stack", name, magnitude: n, duration: null, appliedBy: u.id, appliedTurn: 0 });
};
const minions = (st: MatchState, team: string, name?: string): Unit[] =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive && (name === undefined || u.name === name));

const dmgSkill = (id: string, amount: number, over: Partial<import("../src/skill.ts").SkillInstance> = {}) =>
  skill(id, [{ op: "damage", amount, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single", cost: { generic: 0, specific: 0 }, cooldown: 0, ...over });
const healSkill = (id: string, amount: number, over: Partial<import("../src/skill.ts").SkillInstance> = {}) =>
  skill(id, [{ op: "heal", amount, to: "target" }], { tags: ["Helpful", "Instant"], targeting: "single", cost: { generic: 0, specific: 0 }, cooldown: 0, ...over });

// A full A-round cycle so a Titania-applied dot/regen ticks exactly once (see suite_titania_base): the tick
// only fires on the applier team's turn-end when appliedTurn < state.turn.
const oneATick = (st: MatchState) => { endTurn(st); endTurn(st); endTurn(st); };

// =============================================================================================== //
//  Loadout sanity — each form re-elements Titania & inserts its active in slot 4 (index 3)
// =============================================================================================== //

test("each Titania fusion form re-elements her and inserts its active in slot 4; base kit intact", () => {
  for (const [element, id, name] of [
    ["antidote", "titaniaantidote1", "Gift from the Fae"], ["assassin", "titaniaassassin1", "Drop of Moonglove"],
    ["battery", "titaniabattery1", "The Whimsy Engine"], ["blight", "titaniablight1", "Locust Swarm"],
    ["brimstone", "titaniabrimstone1", "Arcadia, Enraged"], ["evolution", "titaniaevolution1", "Hive Formation"],
    ["faerie", "titaniafaerie1", "Burning Order"], ["serum", "titaniaserum1", "Hysteria Serum"],
    ["spore", "titaniaspore1", "Raving Madness"], ["stasis", "titaniastasis1", "Icy Smile"],
  ] as const) {
    const { t } = fuse(element);
    assert.equal(t.currentElement, element, `${element}: currentElement re-set`);
    assert.equal(t.fused, element, `${element}: fused marker set`);
    const s = sk(t, id);
    assert.equal(s.name, name, `${element}: active present`);
    assert.equal(t.skills!.indexOf(s), 3, `${element}: active inserted at slot 4 (index 3)`);
    for (const b of ["titania1", "titania2", "titania3", "titania4", "titania5"]) assert.ok(sk(t, b), `${element}: base ${b} kept`);
  }
});

// =============================================================================================== //
//  antidote — Capricious Cornucopia (passive) + Gift from the Fae (active)
// =============================================================================================== //

test("Gift from the Fae: STARTS beneficial — a 20 HP/turn regen for 2 turns", () => {
  const { t, st, enemies } = fuse("antidote");
  const e = enemies[0]!;
  const r = performAction(st, { unit: "t", skillId: "titaniaantidote1", targets: ["e"] });
  assert.equal(r.ok, true, "Gift resolves");
  const reg = regenOf(e, "Gift from the Fae");
  assert.ok(reg, "beneficial version applies a regen");
  assert.equal(reg!.magnitude, 20, "heals 20 HP");
  assert.equal(reg!.duration, 2, "for 2 turns");
  assert.equal(hasKind(e, "heal_becomes_damage"), false, "no harmful conversion in the beneficial version");
});

test("Gift from the Fae beneficial regen actually heals 20/turn", () => {
  const { st, enemies } = fuse("antidote", { enemies: [makeUnit({ id: "e", team: "B", hp: 50 })] });
  const e = enemies[0]!;
  performAction(st, { unit: "t", skillId: "titaniaantidote1", targets: ["e"] });
  oneATick(st); // one regen tick on Titania's next turn
  assert.equal(e.hp, 70, "regen ticked +20 (50 -> 70)");
});

test("Capricious Cornucopia: a harmful skill on an enemy flips Gift to its HARMFUL version (heal->Affliction for 3 turns)", () => {
  const { t, st, enemies } = fuse("antidote", { enemies: [makeUnit({ id: "e", team: "B", hp: 50 }), makeUnit({ id: "e2", team: "B", hp: 60 })] });
  const target = enemies[1]!; // e2 — the eventual Gift target, kept clean of Thorn Prick
  // Flip to harmful by using a harmful skill (Thorn Prick) on an enemy.
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.ok(statusOf(t, "mark", "Gift Malice"), "the harmful-version flag (Gift Malice) is set after a harmful skill on an enemy");

  const r = performAction(st, { unit: "t", skillId: "titaniaantidote1", targets: ["e2"] });
  assert.equal(r.ok, true, "harmful Gift resolves");
  assert.equal(regenOf(target, "Gift from the Fae"), undefined, "no beneficial regen in the harmful version");
  assert.ok(hasKind(target, "heal_becomes_damage"), "the harmful version installs a heal->damage conversion");
});

test("Gift (harmful version): the next heal is dealt to the target as damage instead (HP falls, and it ignores Shield)", () => {
  const healer = makeUnit({ id: "h", team: "B", skills: [healSkill("hheal", 25)] });
  const target = makeUnit({ id: "e2", team: "B", hp: 50, shield: 30 });
  const { st } = fuse("antidote", { enemies: [makeUnit({ id: "e", team: "B" }), healer, target] });
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] }); // flip to harmful
  performAction(st, { unit: "t", skillId: "titaniaantidote1", targets: ["e2"] });

  const shieldBefore = target.shields.reduce((a, s) => a + s.amount, 0);
  performAction(st, { unit: "h", skillId: "hheal", targets: ["e2"] }); // 25 "heal"
  assert.equal(target.hp, 25, "the 25 healing is dealt as damage instead (50 -> 25), not added");
  assert.equal(target.shields.reduce((a, s) => a + s.amount, 0), shieldBefore, "Affliction conversion ignores the Shield");
});

test("Capricious Cornucopia: using Prance flips Gift BACK to its beneficial version", () => {
  const { t, st, enemies } = fuse("antidote");
  const e = enemies[0]!;
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] }); // harmful flip
  assert.ok(statusOf(t, "mark", "Gift Malice"), "harmful flag set");
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // Prance
  assert.equal(statusOf(t, "mark", "Gift Malice"), undefined, "Prance clears the harmful flag (beneficial again)");

  // ...and a subsequent Gift is beneficial (regen), not the conversion.
  const clean = makeUnit({ id: "e3", team: "B", hp: 40 });
  st.units["e3"] = clean; st.teams.B.units.push("e3");
  performAction(st, { unit: "t", skillId: "titaniaantidote1", targets: ["e3"] });
  assert.ok(regenOf(clean, "Gift from the Fae"), "beneficial regen after the Prance re-flip");
});

// =============================================================================================== //
//  assassin — Sealed Fate (passive) + Drop of Moonglove (active)
// =============================================================================================== //

test("Sealed Fate: Thorn Prick's hit instantly kills a MINION left below 20 HP by the hit", () => {
  const m = makeUnit({ id: "m", team: "B", kind: "minion", name: "Dummy", hp: 25, maxHp: 25 });
  const { st } = fuse("assassin", { enemies: [m] });
  const r = performAction(st, { unit: "t", skillId: "titania1", targets: ["m"] });
  assert.equal(r.ok, true, "Thorn Prick resolves");
  assert.equal(m.alive, false, "the minion (25 -> 15 by the 10 hit, below 20) is instantly killed");
});

test("Sealed Fate: a minion NOT left below 20 by the hit survives (control); and Heroes are never executed", () => {
  const m = makeUnit({ id: "m", team: "B", kind: "minion", name: "Dummy", hp: 40, maxHp: 40 });
  const hero = makeUnit({ id: "e", team: "B", hp: 25, maxHp: 100 });
  const { st } = fuse("assassin", { enemies: [m, hero] });
  performAction(st, { unit: "t", skillId: "titania1", targets: ["m"] });
  assert.equal(m.alive, true, "minion at 40 -> 30 (not below 20) survives");
  assert.equal(m.hp, 30, "...taking only the ordinary 10 damage");

  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(hero.alive, true, "Sealed Fate executes MINIONS only — the 25 -> 15 hero is not executed");
  assert.equal(hero.hp, 15, "the hero just takes the 10 damage");
});

test("Sealed Fate: Thorn Prick's PERIODIC (DoT) tick executes a minion it drives below 20", () => {
  const m = makeUnit({ id: "m", team: "B", kind: "minion", name: "Dummy", hp: 32, maxHp: 32 });
  const { st } = fuse("assassin", { enemies: [m] });
  performAction(st, { unit: "t", skillId: "titania1", targets: ["m"] }); // 32 -> 22 (survives the hit) + permanent Thorn Prick DoT
  assert.equal(m.alive, true, "control: the hit leaves it at 22 (not below 20)");
  oneATick(st); // the permanent Thorn Prick DoT ticks 5: 22 -> 17 (below 20)
  assert.equal(m.alive, false, "the periodic effect drives it below 20 and executes it");
});

test("Drop of Moonglove: after the target receives healing, it permanently ignores further healing and takes 15 Affliction/turn", () => {
  const healer = makeUnit({ id: "h", team: "B", skills: [healSkill("h1", 25), healSkill("h2", 25, { cooldown: 0 })] });
  const target = makeUnit({ id: "e", team: "B", hp: 50 });
  const { st } = fuse("assassin", { enemies: [target, healer] });
  const r = performAction(st, { unit: "t", skillId: "titaniaassassin1", targets: ["e"] });
  assert.equal(r.ok, true, "Moonglove resolves");
  assert.equal(hasKind(target, "heal_lock"), false, "control: no anti-heal yet (only armed as a watch)");

  performAction(st, { unit: "h", skillId: "h1", targets: ["e"] }); // the healing that springs the trap
  assert.equal(target.hp, 75, "the triggering heal itself still lands (50 -> 75)");
  assert.ok(hasKind(target, "heal_lock"), "afterwards the target permanently ignores healing");
  const dot = dotOf(target, "Moonglove");
  assert.ok(dot, "and gains a 15 Affliction/turn DoT");
  assert.equal(dot!.magnitude, 15, "the DoT ticks 15");
  assert.equal(dot!.duration, null, "for the rest of the round (permanent)");

  // A further heal is now ignored.
  const hpBefore = target.hp;
  performAction(st, { unit: "h", skillId: "h2", targets: ["e"] });
  assert.equal(target.hp, hpBefore, "subsequent healing is ignored (heal_lock)");
});

test("Drop of Moonglove: with NO healing received in the window, no anti-heal or DoT ever appears (control)", () => {
  const target = makeUnit({ id: "e", team: "B", hp: 50 });
  const { st } = fuse("assassin", { enemies: [target] });
  performAction(st, { unit: "t", skillId: "titaniaassassin1", targets: ["e"] });
  assert.equal(hasKind(target, "heal_lock"), false, "no anti-heal without a heal to trigger it");
  assert.equal(dotOf(target, "Moonglove"), undefined, "no DoT without a heal to trigger it");
});

test("Drop of Moonglove is invisible: the statuses it lays are marked invisible", () => {
  const target = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("assassin", { enemies: [target] });
  performAction(st, { unit: "t", skillId: "titaniaassassin1", targets: ["e"] });
  const mark = statusOf(target, "mark", "Drop of Moonglove");
  assert.ok(mark, "the Moonglove mark is applied");
  assert.equal(mark!.invisible, true, "'This effect is invisible' — the mark is flagged invisible");
});

// =============================================================================================== //
//  battery — Arcadian Advancement (passive) + The Whimsy Engine (active)
// =============================================================================================== //

test("Arcadian Advancement: an ally triggering Prance extends Titania's future effects by +1 turn", () => {
  const ally = makeUnit({ id: "a", team: "A", skills: [healSkill("abuff", 1, { targeting: "single" })] });
  const { t, st, enemies } = fuse("battery", { allies: [ally], enemies: [makeUnit({ id: "e", team: "B" })] });

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // Prance -> Prance Watch on Titania
  performAction(st, { unit: "a", skillId: "abuff", targets: ["t"] }); // ally uses a new skill on Titania while Prance Watch is up
  assert.equal(stackMag(t, "Arcadian Advancement"), 1, "the ally-triggered Prance granted one Arcadian Advancement stack");

  // Now a Titania-applied 2-turn effect lasts 3.
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // Laughing Powder -> its 2-turn DoT
  const dot = dotOf(enemies[0]!, "Laughing Powder");
  assert.ok(dot, "Laughing Powder DoT applied");
  assert.equal(dot!.duration, 3, "the normally-2-turn DoT is extended to 3 by the +1");
});

test("Arcadian Advancement: WITHOUT an ally-triggered Prance, durations are normal (control)", () => {
  const { t, st, enemies } = fuse("battery");
  assert.equal(stackMag(t, "Arcadian Advancement"), 0, "no advancement stacks");
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] });
  assert.equal(dotOf(enemies[0]!, "Laughing Powder")!.duration, 2, "the DoT keeps its base 2-turn duration");
});

test("Arcadian Advancement: Titania triggering her OWN Prance does not grant the stack (must be an ALLY)", () => {
  const { t, st } = fuse("battery");
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // her own Prance
  assert.equal(stackMag(t, "Arcadian Advancement"), 0, "self-Prance is not 'an ally triggers Prance'");
});

test("The Whimsy Engine: marks EVERY unit for the next 1 turn", () => {
  const ally = makeUnit({ id: "a", team: "A" });
  const { t, st, enemies } = fuse("battery", { allies: [ally], enemies: [makeUnit({ id: "e", team: "B" }), makeUnit({ id: "e2", team: "B" })] });
  const r = performAction(st, { unit: "t", skillId: "titaniabattery1", targets: [] });
  assert.equal(r.ok, true, "The Whimsy Engine resolves");
  for (const u of [t, ally, enemies[0]!, enemies[1]!]) {
    const m = statusOf(u, "mark", "The Whimsy Engine");
    assert.ok(m, `${u.id} is caught by the engine`);
    assert.equal(m!.duration, 1, `${u.id}: for the next 1 turn`);
  }
});

// The frozen effect proper: a marked unit's declared skill is swapped for a random one of its own skills.
// Here the enemy carries two self-target skills applying distinct marks; it DECLARES "sA" (mark AA) but the
// engine substitutes a DIFFERENT skill "sB" (mark BB) — proving the "instead use a random one" replacement.
const wMark = (id: string, name: string) => skill(id, [{ op: "applyStatus", to: "self", status: { kind: "mark", name, duration: null } }], { tags: ["Strategic", "Instant"], targeting: "self", cost: { generic: 0, specific: 0 }, cooldown: 0 });

test("The Whimsy Engine: a marked unit uses a DIFFERENT (randomly chosen) skill than the one it declared", () => {
  const e = makeUnit({ id: "e", team: "B", skills: [wMark("sA", "AA"), wMark("sB", "BB")] });
  const { st } = fuse("battery", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titaniabattery1", targets: [] }); // engine ON, e is marked
  const r = performAction(st, { unit: "e", skillId: "sA", targets: [] }); // declares sA (would apply AA)
  assert.equal(r.ok, true, "the action resolves");
  assert.equal(e.statuses.some((s) => s.name === "AA"), false, "the DECLARED skill (sA -> AA) did NOT run");
  assert.equal(e.statuses.some((s) => s.name === "BB"), true, "a random one of its skills (sB -> BB) ran instead");
});

test("The Whimsy Engine control: OUTSIDE the window, the declared skill runs as declared", () => {
  const e = makeUnit({ id: "e", team: "B", skills: [wMark("sA", "AA"), wMark("sB", "BB")] });
  const { st } = fuse("battery", { enemies: [e] });
  const r = performAction(st, { unit: "e", skillId: "sA", targets: [] }); // no engine active
  assert.equal(r.ok, true, "resolves");
  assert.equal(e.statuses.some((s) => s.name === "AA"), true, "the declared sA ran (mark AA)");
  assert.equal(e.statuses.some((s) => s.name === "BB"), false, "no replacement happened");
});

// =============================================================================================== //
//  blight — Five Plagues (passive) + Locust Swarm (active)
// =============================================================================================== //

test("Five Plagues: Titania begins the round with exactly 5 stacks", () => {
  const { t } = fuse("blight"); // fuse() emits roundStart, which sets the counter
  assert.equal(stackMag(t, "Five Plagues"), 5, "5 stacks at round start");
});

test("Locust Swarm: 15 Affliction to all enemies, and removes one Five Plagues stack", () => {
  const { t, st, enemies } = fuse("blight", { enemies: [makeUnit({ id: "e", team: "B" }), makeUnit({ id: "e2", team: "B" })] });
  const before = stackMag(t, "Five Plagues");
  const r = performAction(st, { unit: "t", skillId: "titaniablight1", targets: [] });
  assert.equal(r.ok, true, "Locust Swarm resolves");
  assert.equal(enemies[0]!.hp, 85, "enemy1 took 15 (100 -> 85)");
  assert.equal(enemies[1]!.hp, 85, "enemy2 took 15 (100 -> 85) — all enemies");
  assert.equal(stackMag(t, "Five Plagues"), before - 1, "one Five Plagues stack removed");
});

test("Locust Swarm's Affliction ignores Shield (affliction-typed damage)", () => {
  const e = makeUnit({ id: "e", team: "B", shield: 20 });
  const { st } = fuse("blight", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titaniablight1", targets: [] });
  assert.equal(e.hp, 85, "the 15 Affliction lands on HP, ignoring the Shield");
  assert.equal(e.shields.reduce((a, s) => a + s.amount, 0), 20, "the Shield is untouched");
});

test("Five Plagues: an enemy taking Affliction from Titania receives exactly ONE random plague (10 stacks => guaranteed proc)", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { t, st } = fuse("blight", { enemies: [e] });
  setStack(t, "Five Plagues", 10); // 10% * 10 = 100% chance => a guaranteed proc on the next Affliction hit
  const plagueCount = (u: Unit) => u.statuses.filter((s) => s.kind === "cost_mod" || s.kind === "shatter" || s.kind === "stun" || s.kind === "isolated").length;
  assert.equal(plagueCount(e), 0, "control: the enemy carries none of the plague effects beforehand");

  performAction(st, { unit: "t", skillId: "titaniablight1", targets: [] }); // 15 Affliction from Titania => proc
  assert.equal(plagueCount(e), 1, "'a random ONE of the following effects' — exactly one plague lands");
  const plague = e.statuses.find((s) => s.kind === "cost_mod" || s.kind === "shatter" || s.kind === "stun" || s.kind === "isolated")!;
  assert.equal(plague.duration, 1, "each plague effect lasts 1 turn");
});

test("Five Plagues: with 0 stacks there is never a proc (control)", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { t, st } = fuse("blight", { enemies: [e] });
  setStack(t, "Five Plagues", 0);
  performAction(st, { unit: "t", skillId: "titaniablight1", targets: [] });
  const plagueCount = e.statuses.filter((s) => s.kind === "cost_mod" || s.kind === "shatter" || s.kind === "stun" || s.kind === "isolated").length;
  assert.equal(plagueCount, 0, "0 stacks => 0% chance => no plague");
});

// =============================================================================================== //
//  brimstone — Barren Realm (passive) + Arcadia, Enraged (active)
// =============================================================================================== //

test("Barren Realm: Titania gains a Summer Clique stack whenever she takes damage", () => {
  const attacker = makeUnit({ id: "e", team: "B", skills: [dmgSkill("ehit", 10)] });
  const { t, st } = fuse("brimstone", { enemies: [attacker] });
  assert.equal(stackMag(t, "Prance"), 0, "control: no Summer Clique stacks yet");
  performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] }); // damages Titania
  assert.equal(stackMag(t, "Prance"), 1, "taking damage generated one Summer Clique (Prance) stack");
});

test("Barren Realm: creating a Courtesan instead deals 10 Affliction to the lowest-HP enemy (Bypasses invulnerability), and no minion is made", () => {
  const low = makeUnit({ id: "e", team: "B", hp: 40, statuses: [{ kind: "invulnerable", duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const high = makeUnit({ id: "e2", team: "B", hp: 90 });
  const { t, st } = fuse("brimstone", { enemies: [low, high] });
  setStack(t, "Prance", 2); // Summer Clique would create 2 Courtesans...
  const r = performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(r.ok, true, "Summer Clique resolves");
  assert.equal(minions(st, "A").length, 0, "no Summer Courtesans are actually created under Barren Realm");
  assert.equal(low.hp, 20, "each would-be Courtesan (2) instead deals 10 Affliction to the lowest-HP enemy: 40 -> 20");
  assert.equal(high.hp, 90, "the higher-HP enemy is untouched");
  // 'This effect Bypasses invulnerability' — the low enemy above was Invulnerable and still took it.
});

test("Arcadia, Enraged: applies a 5-Affliction/turn DoT (4 turns) to every enemy", () => {
  const { st, enemies } = fuse("brimstone", { enemies: [makeUnit({ id: "e", team: "B" }), makeUnit({ id: "e2", team: "B" })] });
  const r = performAction(st, { unit: "t", skillId: "titaniabrimstone1", targets: [] });
  assert.equal(r.ok, true, "Arcadia, Enraged resolves");
  for (const e of enemies) {
    const dot = dotOf(e, "Arcadia, Enraged");
    assert.ok(dot, `${e.id} has the Arcadia DoT`);
    assert.equal(dot!.magnitude, 5, "5 per turn");
    assert.equal(dot!.duration, 4, "for 4 turns");
    assert.equal(dot!.dtype, "affliction", "Affliction-typed");
  }
});

test("Arcadia, Enraged: during its window Thorn Prick costs nothing and its initial damage is +5", () => {
  const { t, st, enemies } = fuse("brimstone", { enemies: [makeUnit({ id: "e", team: "B" })] });
  const e = enemies[0]!;
  // control BEFORE the buff: Thorn Prick costs 1 generic and deals 10.
  assert.deepEqual({ ...sk(t, "titania1").cost }, { generic: 1, specific: 0 }, "base Thorn Prick cost 1 generic");

  performAction(st, { unit: "t", skillId: "titaniabrimstone1", targets: [] }); // arm the window
  st.teams.A.energy = { generic: 0, brimstone: 0, poison: 0 }; // no energy at all...
  const hpBefore = e.hp;
  const r = performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(r.ok, true, "...yet Thorn Prick is still castable — it now has no cost");
  assert.equal(hpBefore - e.hp, 15, "its initial damage is increased by 5 (10 -> 15)");
});

// =============================================================================================== //
//  evolution — Compound Eyes (passive) + Hive Formation (active)
// =============================================================================================== //

test("Compound Eyes: a Stun / Blind / cost-change landing on Titania is immediately voided", () => {
  const { t, st } = fuse("evolution");
  assert.ok(statusOf(t, "mark", "Compound Eyes"), "Titania permanently carries the Compound Eyes mark");
  const foe = makeUnit({ id: "x", team: "B" });
  for (const bad of [
    { kind: "stun" as const },
    { kind: "blind" as const },
    { kind: "cost_mod" as const, magnitude: 1 },
  ]) {
    runEffects(st, [{ op: "applyStatus", to: "target", status: { ...bad, duration: 2 } }], { caster: foe, self: foe, targets: [t] });
    assert.equal(hasKind(t, bad.kind), false, `Compound Eyes voids an incoming ${bad.kind}`);
  }
});

test("Compound Eyes: a normal unit (no mark) keeps the same Stun (control)", () => {
  const { st } = fuse("evolution");
  const foe = makeUnit({ id: "x", team: "B" });
  const victim = makeUnit({ id: "v", team: "B" });
  runEffects(st, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: foe, self: foe, targets: [victim] });
  assert.equal(hasKind(victim, "stun"), true, "a unit without Compound Eyes stays stunned");
});

test("Hive Formation: grants the target ally Compound Eyes (4 turns) + Hive Formation (4 turns), sharing the immunity", () => {
  const ally = makeUnit({ id: "a", team: "A" });
  const { st } = fuse("evolution", { allies: [ally] });
  const r = performAction(st, { unit: "t", skillId: "titaniaevolution1", targets: ["a"] });
  assert.equal(r.ok, true, "Hive Formation resolves");
  const ce = statusOf(ally, "mark", "Compound Eyes");
  const hf = statusOf(ally, "mark", "Hive Formation");
  assert.ok(ce, "ally gains Compound Eyes");
  assert.equal(ce!.duration, 4, "for 4 turns");
  assert.ok(hf, "ally gains the Hive Formation mark");
  assert.equal(hf!.duration, 4, "for 4 turns");

  // the shared immunity: a stun landing on the Hive ally is voided too
  const foe = makeUnit({ id: "x", team: "B" });
  runEffects(st, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: foe, self: foe, targets: [ally] });
  assert.equal(hasKind(ally, "stun"), false, "the Hive ally shares Titania's Stun immunity");
});

test("Hive Formation: while a Hive ally exists, Barbed Wit's Taunt redirects onto that ally (not onto Titania)", () => {
  const ally = makeUnit({ id: "a", team: "A" });
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("evolution", { allies: [ally], enemies: [e] });
  performAction(st, { unit: "t", skillId: "titaniaevolution1", targets: ["a"] }); // ally becomes a Hive Formation ally
  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] }); // Barbed Wit on the enemy
  const taunt = statusOf(e, "taunt");
  assert.ok(taunt, "the enemy is taunted");
  assert.equal(taunt!.unitRef, "a", "the Taunt is redirected onto the Hive Formation ally, not Titania");
});

test("Hive Formation control: with NO Hive ally, Barbed Wit taunts the enemy onto Titania", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("evolution", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  assert.equal(statusOf(e, "taunt")!.unitRef, "t", "without Hive Formation, the taunt forces the enemy onto Titania");
});

// =============================================================================================== //
//  faerie — Summer Queen (passive) + Burning Order (active)
// =============================================================================================== //

test("Summer Queen: while Titania has a Summer Courtesan she cannot be targeted by harmful skills; targetable again once it dies", () => {
  const attacker = makeUnit({ id: "e", team: "B", skills: [dmgSkill("ehit", 10), dmgSkill("ekill", 40)] });
  const { t, st } = fuse("faerie", { enemies: [attacker] });

  // control: no Courtesan -> Titania is a legal harmful target
  assert.equal(performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] }).ok, true, "control: Titania is targetable with no Courtesan");
  assert.equal(t.hp, 90, "...and takes the hit (100 -> 90)");

  setStack(t, "Prance", 1);
  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] }); // Summer Clique -> a Courtesan
  assert.equal(minions(st, "A", "Summer Courtesan").length, 1, "one Summer Courtesan exists");
  assert.ok(hasKind(t, "invulnerable"), "Summer Queen makes Titania un-harmful-targetable while a Courtesan lives");
  const blocked = performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] });
  assert.equal(blocked.ok, false, "a harmful skill on Titania is now rejected");
  assert.equal(blocked.reason, "no-legal-target", "...for lack of a legal target");

  // kill the Courtesan -> Titania becomes targetable again
  const courtesan = minions(st, "A", "Summer Courtesan")[0]!;
  performAction(st, { unit: "e", skillId: "ekill", targets: [courtesan.id] });
  assert.equal(courtesan.alive, false, "the Courtesan is slain");
  assert.equal(hasKind(t, "invulnerable"), false, "Summer Queen drops the protection once the last Courtesan is gone");
});

test("Burning Order: the target Summer Courtesan deals TRIPLE damage this turn", () => {
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const { t, st } = fuse("faerie", { enemies: [foe] });
  setStack(t, "Prance", 1);
  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] }); // create a Courtesan
  const c = minions(st, "A", "Summer Courtesan")[0]!;

  performAction(st, { unit: "t", skillId: "titaniafaerie1", targets: [c.id] }); // Burning Order on the Courtesan
  performAction(st, { unit: c.id, skillId: "titaniaminion2", targets: ["e"] }); // Diving Slash: base 10 piercing
  assert.equal(foe.hp, 70, "10 base -> 30 tripled (100 -> 70)");
});

test("Burning Order control: a Courtesan WITHOUT Burning Order deals its normal damage", () => {
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const { t, st } = fuse("faerie", { enemies: [foe] });
  setStack(t, "Prance", 1);
  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  const c = minions(st, "A", "Summer Courtesan")[0]!;
  performAction(st, { unit: c.id, skillId: "titaniaminion2", targets: ["e"] });
  assert.equal(foe.hp, 90, "base Diving Slash deals its ordinary 10 (100 -> 90)");
});

// =============================================================================================== //
//  serum — Weaponized Mirth (passive) + Hysteria Serum (active)
// =============================================================================================== //

test("Weaponized Mirth: Laughing Powder's DoT is doubled to 10/turn", () => {
  const { st, enemies } = fuse("serum");
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // Laughing Powder
  const dot = dotOf(enemies[0]!, "Laughing Powder");
  assert.ok(dot, "Laughing Powder DoT applied");
  assert.equal(dot!.magnitude, 10, "doubled from 5 to 10");
});

test("Weaponized Mirth: doubled DoT ticks for 10 (control that the magnitude is really used)", () => {
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const { st } = fuse("serum", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] });
  oneATick(st);
  assert.equal(e.hp, 90, "one doubled tick deals 10 (100 -> 90)");
});

test("Weaponized Mirth: when a non-Titania unit uses a skill on the powdered target, that (current) target takes 15 Affliction", () => {
  const ally = makeUnit({ id: "a", team: "A", skills: [dmgSkill("ahit", 5)] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const { st } = fuse("serum", { allies: [ally], enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder e
  const hpBefore = e.hp;
  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] }); // ally acts on the powdered target: 5 hit + 15 transfer
  assert.equal(hpBefore - e.hp, 20, "the current target takes the ally's 5 plus 15 Affliction on transfer");
});

// FROZEN: "...and WHEN IT TRANSFERS to a new target, the current target receives 15 Affliction damage."
// A transfer means Laughing Powder's DoT actually moves to the unit that used a new skill on the holder (the
// base Laughing Powder clause: "Anyone who uses a new skill on that character is afflicted by Laughing Powder").
// Under fusion the engine keeps the 15-Affliction pulse but the DoT no longer transfers — the acting ally is
// never afflicted — so Weaponized Mirth's "15 on transfer" fires though no transfer occurs. (Root cause: the
// fusion machinery drops Titania's base-kit reactive triggers, so the Laughing Powder spread is gone.)
test("serum Weaponized Mirth: Laughing Powder transfers to the actor AND the former holder takes 15 Affliction", () => {
  const ally = makeUnit({ id: "a", team: "A", skills: [dmgSkill("ahit", 5)] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const { st } = fuse("serum", { allies: [ally], enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder e (its DoT is doubled)
  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] }); // a non-Titania unit uses a new skill on e
  // Frozen: the DoT transfers onto the acting ally (this is what makes the "15 on transfer" a real transfer).
  assert.ok(dotOf(ally, "Laughing Powder"), "the ally that acted on the holder is afflicted — the DoT transferred");
  assert.equal(100 - e.hp, 20, "and the (former) holder takes the ally's 5 + 15 Affliction as it transfers");
});

test("Hysteria Serum: permanently Isolates the target (its allies can no longer help it)", () => {
  const target = makeUnit({ id: "e", team: "B" });
  const mate = makeUnit({ id: "e2", team: "B", skills: [healSkill("mheal", 10)] });
  const { st } = fuse("serum", { enemies: [target, mate] });
  assert.equal(performAction(st, { unit: "e2", skillId: "mheal", targets: ["e"] }).ok, true, "control: an ally can help the target before Isolation");

  performAction(st, { unit: "t", skillId: "titaniaserum1", targets: ["e"] });
  const iso = statusOf(target, "isolated");
  assert.ok(iso, "the target is Isolated");
  assert.equal(iso!.duration, null, "permanently");
  const blocked = performAction(st, { unit: "e2", skillId: "mheal", targets: ["e"] });
  assert.equal(blocked.ok, false, "a Helpful skill can no longer target the Isolated enemy");
  assert.equal(blocked.reason, "no-legal-target");
});

test("Hysteria Serum: the target takes 20 Affliction when IT uses a Helpful skill (but not a Harmful one)", () => {
  const target = makeUnit({ id: "e", team: "B", hp: 100, skills: [healSkill("egift", 5, { targeting: "single" }), dmgSkill("ehit", 5)] });
  const mate = makeUnit({ id: "e2", team: "B" });
  const { st } = fuse("serum", { enemies: [target, mate] });
  performAction(st, { unit: "t", skillId: "titaniaserum1", targets: ["e"] });

  // control: a Harmful skill does not spring the 20 Affliction
  performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] });
  assert.equal(target.hp, 100, "control: using a Harmful skill costs the target no HP");

  performAction(st, { unit: "e", skillId: "egift", targets: ["e2"] }); // a Helpful skill on its mate
  assert.equal(target.hp, 80, "using a Helpful skill deals 20 Affliction to the target (100 -> 80)");
});

// =============================================================================================== //
//  spore — Hallucinogenic Spores (passive) + Raving Madness (active)
// =============================================================================================== //

test("Hallucinogenic Spores: a Barbed-Wit'd enemy pays +[65] (1) on non-Strategic skills, but Strategic skills are unaffected", () => {
  const e = makeUnit({ id: "e", team: "B", skills: [dmgSkill("ehit", 5, { cost: { generic: 1, specific: 0 } }), skill("estrat", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "X", duration: null } }], { tags: ["Strategic", "Instant"], targeting: "self", cost: { generic: 1, specific: 0 } })] });
  const { st } = fuse("spore", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] }); // Barbed Wit -> taunt
  const cm = statusOf(e, "cost_mod", "Hallucinogenic Spores");
  assert.ok(cm, "a Hallucinogenic Spores cost increase is applied");
  assert.equal(cm!.magnitude, 1, "[65] = +1 energy");

  const startGen = st.teams.B.energy.generic ?? 0;
  performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] }); // non-Strategic: base 1 + 1 = 2 generic
  assert.equal((st.teams.B.energy.generic ?? 0), startGen - 2, "non-Strategic skill costs 1 more (paid 2 generic)");

  const gen2 = st.teams.B.energy.generic ?? 0;
  performAction(st, { unit: "e", skillId: "estrat", targets: [] }); // Strategic: unchanged, base 1 generic
  assert.equal((st.teams.B.energy.generic ?? 0), gen2 - 1, "the Strategic skill is NOT surcharged (paid its base 1)");
});

test("Hallucinogenic Spores: does NOT stack — Barbed Wit AND Laughing Powder together still leave a single +1", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("spore", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] }); // Barbed Wit
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // Laughing Powder
  const mods = e.statuses.filter((s) => s.kind === "cost_mod" && s.name === "Hallucinogenic Spores");
  assert.equal(mods.length, 1, "only one Hallucinogenic Spores cost_mod exists");
  assert.equal(mods[0]!.magnitude, 1, "and its magnitude stays 1 (does not stack to 2)");
});

test("Hallucinogenic Spores: the cost increase DROPS once the enemy is no longer affected (Laughing Powder expires)", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("spore", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // Laughing Powder (2-turn DoT)
  assert.ok(statusOf(e, "cost_mod", "Hallucinogenic Spores"), "cost increase present while affected");

  for (let i = 0; i < 8 && dotOf(e, "Laughing Powder"); i++) endTurn(st); // run the DoT out
  assert.equal(dotOf(e, "Laughing Powder"), undefined, "Laughing Powder has expired");
  assert.equal(statusOf(e, "cost_mod", "Hallucinogenic Spores"), undefined, "the cost increase is dropped once neither Barbed Wit nor Laughing Powder remains");
});

test("Hallucinogenic Spores: a clean enemy has no cost increase (control)", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("spore", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // Titania acts, but not on the enemy
  assert.equal(statusOf(e, "cost_mod", "Hallucinogenic Spores"), undefined, "an un-afflicted enemy is not surcharged");
});

test("Raving Madness: only Spore-affected enemies take 10 Affliction/turn for 2 turns; unaffected enemies are spared", () => {
  const affected = makeUnit({ id: "e", team: "B" });
  const clean = makeUnit({ id: "e2", team: "B" });
  const { st } = fuse("spore", { enemies: [affected, clean] });
  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] }); // affect e via Barbed Wit
  assert.ok(statusOf(affected, "cost_mod", "Hallucinogenic Spores"), "precondition: e is Spore-affected");

  const r = performAction(st, { unit: "t", skillId: "titaniaspore1", targets: [] });
  assert.equal(r.ok, true, "Raving Madness resolves");
  const dot = dotOf(affected, "Raving Madness");
  assert.ok(dot, "the affected enemy gets the Raving Madness DoT");
  assert.equal(dot!.magnitude, 10, "10 per turn");
  assert.equal(dot!.duration, 2, "for 2 turns");
  assert.equal(dotOf(clean, "Raving Madness"), undefined, "the unaffected enemy takes nothing");
});

test("Raving Madness: Bypasses invulnerability — an Invulnerable Spore-affected enemy is still hit", () => {
  const e = makeUnit({ id: "e", team: "B", statuses: [{ kind: "invulnerable", duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const { st } = fuse("spore", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] }); // Barbed Wit is Bypassing-agnostic? taunt still applies via the fusion trigger

  // Ensure it is Spore-affected regardless of the Barbed Wit targeting path.
  if (!statusOf(e, "cost_mod", "Hallucinogenic Spores")) e.statuses.push({ kind: "cost_mod", name: "Hallucinogenic Spores", magnitude: 1, duration: null, appliedBy: "t", appliedTurn: 0 });
  performAction(st, { unit: "t", skillId: "titaniaspore1", targets: [] });
  assert.ok(dotOf(e, "Raving Madness"), "Raving Madness lands on the invulnerable enemy (Bypassing)");
});

// =============================================================================================== //
//  stasis — Winter Exile (passive) + Icy Smile (active)
// =============================================================================================== //

test("Winter Exile: Summer Clique creates Winter Loyalists instead of Summer Courtesans", () => {
  const { t, st } = fuse("stasis");
  setStack(t, "Prance", 2);
  const r = performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(r.ok, true, "Summer Clique resolves");
  assert.equal(minions(st, "A", "Winter Loyalist").length, 2, "two Winter Loyalists are created");
  assert.equal(minions(st, "A", "Summer Courtesan").length, 0, "no Summer Courtesans exist");
});

test("Icy Smile: an enemy that takes new damage this turn is stunned, and the damaging ally gains Elemental Essence", () => {
  const ally = makeUnit({ id: "a", team: "A", skills: [dmgSkill("ahit", 10)] });
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("stasis", { allies: [ally], enemies: [e] });
  performAction(st, { unit: "t", skillId: "titaniastasis1", targets: ["e"] }); // arm Icy Smile
  assert.equal(hasKind(e, "stun"), false, "control: no stun before the enemy is damaged");
  assert.equal(hasEssence(ally), false, "control: the ally has no Essence yet");

  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] }); // ally deals new damage
  assert.ok(hasKind(e, "stun"), "the damaged enemy is stunned");
  assert.equal(hasEssence(ally), true, "the damaging ally gains Elemental Essence");
});

test("Icy Smile control: an armed enemy that is NOT damaged this turn is never stunned", () => {
  const e = makeUnit({ id: "e", team: "B" });
  const { st } = fuse("stasis", { enemies: [e] });
  performAction(st, { unit: "t", skillId: "titaniastasis1", targets: ["e"] });
  assert.equal(hasKind(e, "stun"), false, "no damage -> no stun");
});
