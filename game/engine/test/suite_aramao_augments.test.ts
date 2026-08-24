import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts"; // side-effect: pulls in custom-handler registration via hero.ts
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// ===========================================================================
// Adversarial, SPEC-DERIVED behavioural suite for Aramao's AUGMENTS.
// Every assertion is anchored to the FROZEN augment prose (the oracle in
// content/frozen/augments.json), never to the implementation.
//
//   aramao1 "Veiled Beat": "Sand Quake's cost is reduced by 1 [65], but Desert
//        Veil only applies Veiled for 1 turn."
//   aramao2 "Hidden Oasis": "If Mirage Trap expires without being triggered, the
//        affected enemy heals the allied Hero directly across from them for 25 HP."
//   aramao3 "Vanishing Act": "After Desert Veil finishes applying Veiled, the
//        untargeted allied Hero is Veiled for 2 turns."
//   aramao4 "Wraithblade": "If Aramao is Veiled, Desert Knife deals 10 more damage
//        and extends the duration of his Veiled effects by 1 turn."
//   aramao5 "Dune Step": "Trial of Sands lasts 1 more turn. While it is active,
//        all enemy Heroes are considered to be across from Aramao, and all allied
//        Heroes are considered to be adjacent to him."
//
// Base kit the augments modify (frozen skills.json):
//   Desert Knife (aramao1)  = 10 Piercing; swap toward the across ally if the
//        target isn't across; does not break Veiled.
//   Sand Quake (aramao2)    = 10 Piercing all enemies + extend all Veiled by 2.
//   Mirage Trap (aramao3)   = mark an enemy for 1 turn; counter their first
//        (non-)Strategic skill.
//   Desert Veil (aramao4)   = Veil target-or-Aramao + a partner for 2 turns.
//   Heart of the Desert (aramao5) = heal adjacent (and self if only one adjacent).
//   Trial of the Sands (aramao6)  = 3-turn self mark that re-veils allies each
//        turn-end and retaliates with Desert Knife; shuffles Aramao's team once.
//   Dune Stalker (passive)  = +5 to the enemy directly across + Essence on hitting
//        that across enemy.
//
// GEOMETRY: makeState assigns slots 0,1,2 in listed order per side. "across" =
// the enemy in Aramao's slot; "adjacent" = an ally whose slot differs by 1.
// Aramao's element is "nomad".
// ===========================================================================

const has = (u: Unit, kind: string, name?: string): boolean =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const veiledOf = (u: Unit) => u.statuses.find((s) => s.kind === "veiled");
const markOf = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "mark" && s.name === name);
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const skillOf = (u: Unit, id: string): SkillInstance => (u.skills ?? []).find((s) => s.id === id)!;

function fund(state: MatchState) {
  state.teams.A.energy = { generic: 40, nomad: 40 };
  state.teams.B.energy = { generic: 40, nomad: 40 };
}

/** Aramao with a single augment already applied. */
function augmentedAramao(augId: string, id = "ar"): Unit {
  const ar = loadHero(heroById("aramao"), "A", id);
  applyAugment(ar, augmentById(augId)!);
  return ar;
}

// A plain enemy Hero carrying a non-Strategic Harmful attack and a Strategic skill.
function enemyWith(id: string): Unit {
  const attack = skill("ek", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], {
    name: "Enemy Knife", tags: ["Harmful", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  });
  const strat = skill("es", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "esRan", duration: null } }], {
    name: "Enemy Scheme", tags: ["Strategic", "Instant"], cost: { generic: 1, specific: 0 }, targeting: "single",
  });
  return makeUnit({ id, team: "B", hp: 100, maxHp: 100, skills: [attack, strat] });
}

// =========================================================================== //
//  aramao1 — Veiled Beat: "Sand Quake's cost is reduced by 1, but Desert Veil
//  only applies Veiled for 1 turn."
// =========================================================================== //

test("aramao1: Sand Quake costs 1 less generic than base (frozen: 'reduced by 1')", () => {
  // Base hero: measure what Sand Quake costs unmodified.
  const base = loadHero(heroById("aramao"), "A", "arB");
  const be0 = makeUnit({ id: "be0", team: "B", hp: 100, maxHp: 100 });
  const baseState = makeState([base], [be0], 1);
  fund(baseState);
  const baseBefore = baseState.teams.A.energy.generic!;
  performAction(baseState, { unit: "arB", skillId: "aramao2", targets: [] });
  const baseSpent = baseBefore - baseState.teams.A.energy.generic!;

  // Augmented hero: same cast, must cost exactly one less generic.
  const ar = augmentedAramao("aramao1");
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([ar], [e0], 1);
  fund(state);
  const before = state.teams.A.energy.generic!;
  const r = performAction(state, { unit: "ar", skillId: "aramao2", targets: [] });
  assert.equal(r.ok, true);
  const spent = before - state.teams.A.energy.generic!;
  assert.equal(spent, baseSpent - 1, "Veiled Beat lowers Sand Quake's generic cost by exactly 1");
  assert.equal(spent, 1, "Sand Quake now costs 1 generic (base was 2)");
  assert.equal(e0.hp, 85, "Sand Quake still deals its 10 Piercing (+5 Dune Stalker to the across enemy)");
});

test("aramao1: Desert Veil (self-target) Veils Aramao AND the random ally for only 1 turn (base is 2)", () => {
  // Base control: unmodified Desert Veil grants 2-turn Veils.
  const base = loadHero(heroById("aramao"), "A", "arB");
  const bal = makeUnit({ id: "bal", team: "A", hp: 100, maxHp: 100 });
  const bstate = makeState([base, bal], [makeUnit({ id: "be0", team: "B" })], 1);
  fund(bstate);
  performAction(bstate, { unit: "arB", skillId: "aramao4", targets: ["arB"] });
  assert.equal(veiledOf(base)!.duration, 2, "control: base Desert Veil Veils Aramao for 2 turns");
  assert.equal(veiledOf(bal)!.duration, 2, "control: base Desert Veil Veils the partner for 2 turns");

  // Augmented: every Veil this skill grants is only 1 turn.
  const ar = augmentedAramao("aramao1");
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 });
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 });
  const state = makeState([ar, al1, al2], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao4", targets: ["ar"] });
  assert.equal(r.ok, true);
  assert.equal(has(ar, "veiled"), true, "Aramao is Veiled");
  assert.equal(veiledOf(ar)!.duration, 1, "Veiled Beat: Aramao's Veil lasts only 1 turn");
  const others = [al1, al2].filter((u) => has(u, "veiled"));
  assert.equal(others.length, 1, "exactly one random other ally is Veiled");
  assert.equal(veiledOf(others[0]!)!.duration, 1, "Veiled Beat: the random ally's Veil lasts only 1 turn");
});

test("aramao1: Desert Veil (ally-target) Veils both for only 1 turn and still swaps positions", () => {
  const ar = augmentedAramao("aramao1");                                 // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 });   // slot 1 (target)
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 });   // slot 2 (bystander)
  const state = makeState([ar, al1, al2], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao4", targets: ["al1"] });
  assert.equal(r.ok, true);
  assert.equal(veiledOf(al1)!.duration, 1, "the targeted ally's Veil lasts only 1 turn");
  assert.equal(veiledOf(ar)!.duration, 1, "Aramao's Veil lasts only 1 turn");
  assert.equal(ar.slot, 1, "Aramao still swaps into the targeted ally's slot");
  assert.equal(al1.slot, 0, "the targeted ally still takes Aramao's old slot");
  assert.equal(has(al2, "veiled"), false, "the bystander ally is untouched by base Desert Veil");
});

// =========================================================================== //
//  aramao2 — Hidden Oasis: "If Mirage Trap expires without being triggered, the
//  affected enemy heals the allied Hero directly across from them for 25 HP."
// =========================================================================== //

test("aramao2: a Mirage Trap that lapses untriggered heals the ally across from the trapped enemy for 25", () => {
  const al0 = makeUnit({ id: "al0", team: "A", hp: 50, maxHp: 100 });  // slot 0 (across from e0)
  const ar = augmentedAramao("aramao2");                               // slot 1
  const e0 = enemyWith("e0");                                          // B slot 0 (across from al0, not Aramao)
  const state = makeState([al0, ar], [e0], 1);
  fund(state);
  assert.equal(al0.slot, 0);
  assert.equal(e0.slot, 0);
  const cast = performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e0"] });
  assert.equal(cast.ok, true);
  assert.equal(has(e0, "mark"), true, "the enemy is trapped");
  const arHpBefore = ar.hp;

  // Let the trap lapse without the enemy ever using a skill: durations tick on
  // Aramao's turn-end, so it expires on his NEXT turn-end (3 endTurns: A, B, A).
  endTurn(state); // team A ends (birth turn, no tick)
  endTurn(state); // team B ends
  assert.equal(has(e0, "mark"), true, "the trap is still armed one round later");
  endTurn(state); // team A ends again -> the 1-turn mark lapses -> onExpire fires

  assert.equal(has(e0, "mark"), false, "the trap has expired");
  assert.equal(al0.hp, 75, "the ally directly across from the trapped enemy is healed 25 (50 -> 75)");
  assert.equal(ar.hp, arHpBefore, "Aramao, who is NOT across from the trapped enemy, is not the one healed");
});

test("aramao2 CONTROL: a trap that FIRES (is triggered) does not heal on removal", () => {
  const al0 = makeUnit({ id: "al0", team: "A", hp: 50, maxHp: 100 });  // slot 0 (across from e0)
  const ar = augmentedAramao("aramao2");                               // slot 1
  const e0 = enemyWith("e0");                                          // B slot 0 (not across from Aramao -> counters Strategic)
  const state = makeState([al0, ar], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e0"] });
  // e0 is not across from Aramao, so the trap counters its first Strategic skill.
  const fired = performAction(state, { unit: "e0", skillId: "es", targets: ["e0"] });
  assert.equal(fired.countered, true, "the Strategic skill is countered (the trap fired)");
  assert.equal(has(e0, "mark"), false, "a fired trap is removed early");
  // Advance past when it would have naturally lapsed: no onExpire heal must occur.
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(al0.hp, 50, "a triggered trap does NOT heal the ally (only an untriggered lapse does)");
});

test("aramao2 CONTROL: without the augment, a lapsing Mirage Trap heals nobody", () => {
  const al0 = makeUnit({ id: "al0", team: "A", hp: 50, maxHp: 100 });  // slot 0
  const ar = loadHero(heroById("aramao"), "A", "ar");                  // slot 1 (NO augment)
  const e0 = enemyWith("e0");                                          // B slot 0
  const state = makeState([al0, ar], [e0], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao3", targets: ["e0"] });
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(has(e0, "mark"), false, "the base trap still lapses");
  assert.equal(al0.hp, 50, "base Mirage Trap has no on-lapse heal");
});

// =========================================================================== //
//  aramao3 — Vanishing Act: "After Desert Veil finishes applying Veiled, the
//  untargeted allied Hero is Veiled for 2 turns."
// =========================================================================== //

test("aramao3: after Desert Veil (ally-target) the untargeted third ally is Veiled for 2 turns", () => {
  const ar = augmentedAramao("aramao3");                                 // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 });   // slot 1 (target -> Veiled by base)
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 });   // slot 2 (untargeted leftover)
  const state = makeState([ar, al1, al2], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao4", targets: ["al1"] });
  assert.equal(r.ok, true);
  assert.equal(has(al1, "veiled"), true, "base Desert Veil Veiled the targeted ally");
  assert.equal(has(ar, "veiled"), true, "base Desert Veil Veiled Aramao");
  assert.equal(has(al2, "veiled"), true, "Vanishing Act Veils the untargeted third ally");
  assert.equal(veiledOf(al2)!.duration, 2, "the leftover ally's Veil lasts 2 turns");
});

test("aramao3 CONTROL: without the augment, the third ally is left un-Veiled", () => {
  const ar = loadHero(heroById("aramao"), "A", "ar");                    // slot 0 (NO augment)
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 });   // slot 1 (target)
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 });   // slot 2
  const state = makeState([ar, al1, al2], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao4", targets: ["al1"] });
  assert.equal(has(al2, "veiled"), false, "base Desert Veil leaves the third ally un-Veiled");
});

test("aramao3: after Desert Veil (self-target) ALL three allied Heroes end Veiled", () => {
  const ar = augmentedAramao("aramao3");                                 // slot 0
  const al1 = makeUnit({ id: "al1", team: "A", hp: 100, maxHp: 100 });   // slot 1
  const al2 = makeUnit({ id: "al2", team: "A", hp: 100, maxHp: 100 });   // slot 2
  const state = makeState([ar, al1, al2], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao4", targets: ["ar"] });
  assert.equal(r.ok, true);
  // Base self-target Veils Aramao + one random other; Vanishing Act mops up the leftover.
  assert.equal(has(ar, "veiled"), true, "Aramao Veiled");
  assert.equal(has(al1, "veiled"), true, "ally 1 Veiled");
  assert.equal(has(al2, "veiled"), true, "ally 2 Veiled");
  assert.equal((veiledOf(al1)!.duration ?? 0) >= 2 || (veiledOf(al2)!.duration ?? 0) >= 2, true,
    "the ally covered only by Vanishing Act keeps a 2-turn Veil");
});

// =========================================================================== //
//  aramao4 — Wraithblade: "If Aramao is Veiled, Desert Knife deals 10 more damage
//  and extends the duration of his Veiled effects by 1 turn."
// =========================================================================== //

test("aramao4: while Veiled, Desert Knife deals +10 (20 to a non-across enemy) and extends his Veil by 1", () => {
  const ar = augmentedAramao("aramao4");                               // A slot 0 (alone -> no swap partner)
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });   // B slot 0 (across, avoided)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });   // B slot 1 (NOT across -> no Dune Stalker +5)
  const state = makeState([ar], [e0, e1], 1);
  fund(state);
  ar.statuses.push({ kind: "veiled", duration: 2, appliedBy: "ar", appliedTurn: 0 });
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 80, "10 base Piercing + 10 Wraithblade = 20 to the non-across target");
  assert.equal(has(ar, "veiled"), true, "Desert Knife does not break his Veil");
  assert.equal(veiledOf(ar)!.duration, 3, "Wraithblade extends his Veil by 1 turn (2 -> 3)");
});

test("aramao4 CONTROL: while NOT Veiled, Desert Knife deals only base 10 and adds no Veil", () => {
  const ar = augmentedAramao("aramao4");                               // A slot 0 (alone)
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });   // B slot 0 (across, avoided)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });   // B slot 1 (NOT across)
  const state = makeState([ar], [e0, e1], 1);
  fund(state);
  assert.equal(has(ar, "veiled"), false, "Aramao is not Veiled");
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 90, "no Wraithblade bonus while un-Veiled: only the base 10 lands");
  assert.equal(has(ar, "veiled"), false, "no Veil is created out of nothing");
});

// =========================================================================== //
//  aramao5 — Dune Step: "Trial of Sands lasts 1 more turn. While it is active,
//  all enemy Heroes are considered to be across from Aramao, and all allied
//  Heroes are considered to be adjacent to him."
// =========================================================================== //

test("aramao5: Trial of the Sands now lasts 4 turns instead of 3", () => {
  // Base control.
  const base = loadHero(heroById("aramao"), "A", "arB");
  const bstate = makeState([base], [makeUnit({ id: "be0", team: "B" })], 1);
  fund(bstate);
  performAction(bstate, { unit: "arB", skillId: "aramao6", targets: [] });
  assert.equal(markOf(base, "Trial of the Sands")!.duration, 3, "control: base Trial mark lasts 3 turns");

  const ar = augmentedAramao("aramao5");
  const state = makeState([ar], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  const r = performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  assert.equal(r.ok, true);
  assert.equal(markOf(ar, "Trial of the Sands")!.duration, 4, "Dune Step: the Trial window lasts 4 turns");
});

test("Dune Step: while Trial is active every enemy counts as 'across' (Dune Stalker +5 + Essence apply)", () => {
  const ar = augmentedAramao("aramao5");                              // A slot 0 (alone -> shuffle no-op)
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100, maxHp: 100 });  // B slot 0 (truly across)
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });  // B slot 1 (NOT across by geometry)
  const state = makeState([ar], [e0, e1], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  assert.equal(ar.slot, 0, "a one-hero shuffle keeps Aramao in slot 0");
  assert.equal(has(ar, "mark", "Trial of the Sands"), true, "Trial is active");
  assert.equal(essenceCount(ar), 0, "no Essence before he strikes");
  const r = performAction(state, { unit: "ar", skillId: "aramao1", targets: ["e1"] });
  assert.equal(r.ok, true);
  // Frozen: while Trial is active every enemy is "across", so the geometrically
  // non-across e1 still eats Dune Stalker's +5 and grants Essence.
  assert.equal(e1.hp, 85, "the non-across enemy takes 10 Piercing + 5 Dune Stalker = 15 (counts as across)");
  assert.equal(essenceCount(ar) >= 1, true, "damaging an enemy that now counts as across grants Essence");
});

test("Dune Step: while Trial is active every ally counts as 'adjacent' (Heart of the Desert heals the whole team)", () => {
  const ar = augmentedAramao("aramao5");                                // slot 0
  const adj = makeUnit({ id: "adj", team: "A", hp: 50, maxHp: 100 });   // slot 1 (geometrically adjacent)
  const far = makeUnit({ id: "far", team: "A", hp: 50, maxHp: 100 });   // slot 2 (geometrically NOT adjacent)
  const state = makeState([ar, adj, far], [makeUnit({ id: "e0", team: "B" })], 1);
  fund(state);
  performAction(state, { unit: "ar", skillId: "aramao6", targets: [] });
  // Trial's cast shuffles the team; pin a known geometry so the test is deterministic.
  ar.slot = 0; adj.slot = 1; far.slot = 2;
  assert.equal(has(ar, "mark", "Trial of the Sands"), true, "Trial is active");
  const r = performAction(state, { unit: "ar", skillId: "aramao5", targets: ["ar"] });
  assert.equal(r.ok, true);
  // Frozen: while Trial is active every ally is "adjacent", so the slot-2 far ally
  // (never adjacent by geometry) is healed by Heart of the Desert.
  assert.equal(far.hp, 65, "the far ally counts as adjacent and is healed 15 (50 -> 65)");
});
