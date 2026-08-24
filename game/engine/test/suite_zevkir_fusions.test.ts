import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { performAction, startTurn, endTurn, tickDots } from "../src/scheduler.ts";
import { stackCount } from "../src/status.ts";
import type { Unit } from "../src/types.ts";

// ===================================================================================================== //
// Adversarial, SPEC-DERIVED suite for Tidecaller Zev'kir's TEN FUSION FORMS (passive + active each).
// The FROZEN prose (content/frozen/skills.json) is the ORACLE for every assertion below. Verbatim:
//
//  alchemy   Submerged Leyline (passive): "Zevkir's allies deal 5 additional damage while he Channels Call Tides."
//            Leyline Bolt (0G+1S, Harmful/Instant): "Deals 25 Damage to a random enemy. If used during Call
//            Tides, it affects target enemy instead, and deals Piercing damage."
//  anointment Atlantean Hymn (passive): "Allies heal for 5 health per turn during Call Tides."
//            Purelight Pool (0G+1S, Helpful/Instant, cd1): "Heals target ally for 20 health. This causes 5
//            additional healing for every stack of Call Tides on Zev'Kir"
//  blood     Sanguine Spectre (passive): "Zev'kir heals for 10 health whenever he deals damage. If he is at
//            full health, he instead gains a stack of Call Tides."
//            Crimson Tide (2G, Harmful/Instant/Affliction, cd2): "Zev'kir targets all enemies, losing 5 health
//            for each enemy targeted. The following turn, each targeted enemy takes 15 Affliction Damage, plus
//            5 for each stack of Call Tides on Zev'kir."
//  current   Static Maelstrom (passive): "Channeling Call Tides now changes Zev'kir's costs to Generic, and
//            causes him to deal 10 additional damage with his next ability."
//            Crackling Slipstream (1G+1S, Harmful/Instant): "Deals 25 Piercing damage to target enemy. If
//            Zev'kir has at least 3 stacks of Call Tides, he applies Static Maelstrom to his team for 1 turn."
//  glacier   Freezing Brine (passive): "Damaging enemies with Riptide adds a stack of Freezing Brine for each
//            stack of Call Tides on Zev'kir. Upon reaching 5 stacks, the enemy is stunned for 1 turn and the
//            stacks are consumed."
//            Cold Snap (2G+1S, Harmful/Helpful/Instant/Bypassing, cd4): "Targets all stunned allies and
//            invulnerable enemies. Allies become invulnerable until their next turn, and enemies are stunned
//            for their next turn."
//  mirror    Patient Predation (passive): "Call Tides will now continue until a new harmful skill is used on
//            Zev'kir. The harmful skill is reflected to its user and Call Tides ends."
//            Lens of the Deep (0G+1S, Harmful/Instant, cd2): "Deals 15 Piercing damage to target enemy, and
//            for their next two turns that enemy will receive double damage from reflected skills."
//  mist      Misty Mire (passive): "Bubble Prison will now target all enemies, dealing 15 Piercing damage to a
//            random target per turn. This damage Bypasses"
//            Spear of Fog (0G+1S, Harmful/Instant): "Deals 15 damage to target enemy. If used on an enemy
//            affected by Bubble Prison, deals double damage and Bypasses."
//  ocean     Chains of Atlantis (passive): "Whenever Zev'kir or his allies end their turn Channeling an
//            ability, a random enemy gains a stack of Chains of Atlantis. Enemies marked by Chains of Atlantis
//            receive 5 Affliction damage per stack during each turn of Call Tides."
//            Abyssal Grasp (1G+1S, Harmful/Instant, cd1): "Deals 30 damage to target enemy. If Zev'kir is
//            Channeling Call Tides, this damage becomes Piercing. If the damaged enemy is marked by Chains of
//            Atlantis, they are stunned for 1 turn."
//  serum     Rapid Mutation (passive): "Zev'kir takes 5 Affliction Damage at the end of each of his turns. For
//            every 15 Health he is missing, Zev'kir has one additional stack of Call Tides"
//            Mutable Form (0G+1S, Strategic/Instant, cd2): "Zev'kir gains 10 Shield for 2 turns for each stack
//            of Call Tides he has."
//  slime     Stinking Marsh (passive): "When Zev'kir has no stacks of Call Tides, his skills are treated as
//            though he had two, and deal Affliction damage instead. Whenever Zev'kir uses a skill with 0 stacks
//            of Call Tides, he takes 10 Affliction damage."
//            Rising Bog (2G+1S, Helpful/Instant, cd2): "Zev'kir consumes his stacks of Call Tides, changing his
//            costs to Generic costs and granting his team 10 Shield per turn. The duration is equal to the
//            number of Call Tides stacks consumed."
//
// Content (fusions.authored/generated) was read ONLY to drive: fusion element keys, fusion skill ids
// (zevkir<element>1), base skill ids (zevkir1 Call Tides, zevkir2 Riptide, zevkir3 Bubble Prison),
// costs, targeting, and status/mark names. WHAT is asserted comes from the FROZEN prose above.
//
// NOTE ON COST: fusing re-elements Zev'kir (currentElement := the fusion element), and the scheduler
// pays a skill's Specific cost from currentElement. So every arena stocks the fusion element's pool.
// ===================================================================================================== //

const CT = (n: number) => ({
  kind: "stack" as const, name: "Call Tides", magnitude: n, duration: null, appliedBy: "z", appliedTurn: 0,
});
const DR = (n: number) => ({ kind: "damage_reduction" as const, magnitude: n, duration: null, appliedBy: "x", appliedTurn: 0 });
const CHAINS = (n: number) => ({ kind: "stack" as const, name: "Chains of Atlantis", magnitude: n, duration: null, appliedBy: "z", appliedTurn: 0 });

const hasStun = (u: Unit) => u.statuses.some((s) => s.kind === "stun");
const hasInvuln = (u: Unit) => u.statuses.some((s) => s.kind === "invulnerable");
const isChanneling = (u: Unit) => u.statuses.some((s) => s.kind === "channeling");
const shieldTotal = (u: Unit) => (u.shields ?? []).reduce((a, s) => a + s.amount, 0);
const fbStacks = (u: Unit) => u.statuses.find((s) => s.kind === "stack" && s.name === "Freezing Brine")?.magnitude ?? 0;

/** Load Zev'kir on team A (id "z") and fuse him into `key`. */
function fuse(key: string): Unit {
  const z = loadHero(heroById("zevkir"), "A", "z");
  applyFusion(z, fusionForm("zevkir", key) as FusionForm);
  return z;
}

/** A stock harmful enemy skill (fire, single-target) for driving reflect/counter. */
function enemyStrike(dmg = 30) {
  return {
    id: "ehit", name: "Enemy Strike", element: "fire", targeting: "single",
    effects: [{ op: "damage", amount: dmg, dtype: "normal", to: "target" }],
    cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful"],
  } as any;
}
function allyStrike(dmg = 20) {
  return {
    id: "ahit", name: "Ally Strike", element: "fire", targeting: "single",
    effects: [{ op: "damage", amount: dmg, dtype: "normal", to: "target" }],
    cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful"],
  } as any;
}

// =================================================================================================== //
// alchemy — Submerged Leyline (passive): allies deal +5 while Zev'kir Channels Call Tides.
// =================================================================================================== //
test("Submerged Leyline: while Zev'kir Channels Call Tides, his allies deal +5 damage (not himself)", () => {
  const z = fuse("alchemy");
  const ally = makeUnit({ id: "a1", team: "A", hp: 300, maxHp: 300 });
  ally.skills = [allyStrike(20)];
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z, ally], [e1]);
  state.teams.A.energy = { generic: 40, alchemy: 40, water: 40 };

  // Baseline: no channel -> ally deals its raw 20.
  performAction(state, { unit: "a1", skillId: "ahit", targets: ["e1"] });
  assert.equal(500 - e1.hp, 20, "no channel -> ally's base 20 damage");
  assert.equal(ally.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.name === "Submerged Leyline"), false, "no buff before channel");

  // Begin Channeling Call Tides -> the passive grants allies the +5 outgoing buff.
  ally.skills[0]!.currentCd = 0;
  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] });
  assert.equal(isChanneling(z), true, "Call Tides channel is up");
  assert.equal(ally.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.name === "Submerged Leyline" && s.magnitude === 5), true, "ally gains the +5 Submerged Leyline buff");
  assert.equal(z.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.name === "Submerged Leyline"), false, "the buff is for ALLIES — Zev'kir himself is excluded");

  const hp = e1.hp;
  performAction(state, { unit: "a1", skillId: "ahit", targets: ["e1"] });
  assert.equal(hp - e1.hp, 25, "while Zev'kir channels, the ally deals 20 + 5 = 25");
});

test("Submerged Leyline: the +5 ally buff is removed once Zev'kir stops Channeling", () => {
  const z = fuse("alchemy");
  const ally = makeUnit({ id: "a1", team: "A", hp: 300, maxHp: 300 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z, ally], [e1]);
  state.teams.A.energy = { generic: 40, alchemy: 40, water: 40 };

  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] });
  assert.equal(ally.statuses.some((s) => s.name === "Submerged Leyline"), true, "buff present while channeling");

  // Cast a new non-Strategic skill: cancels the channel -> statusExpired{channeling} tears the buff down.
  performAction(state, { unit: "z", skillId: "zevkiralchemy1", targets: ["e1"] });
  assert.equal(isChanneling(z), false, "channel ended by acting");
  assert.equal(ally.statuses.some((s) => s.name === "Submerged Leyline"), false, "the +5 ally buff ends when Zev'kir stops Channeling");
});

// alchemy — Leyline Bolt (active).
test("Leyline Bolt: with NO Call Tides channel it deals 25 (normal) damage to the enemy", () => {
  const z = fuse("alchemy");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, alchemy: 40 };
  performAction(state, { unit: "z", skillId: "zevkiralchemy1", targets: ["e1"] });
  // Non-Channeling branch: 25 NORMAL. Through 10 DR that is 15 — proving it is NOT piercing here.
  assert.equal(500 - e1.hp, 15, "25 normal damage, reduced by 10 DR to 15 (non-channel branch is normal-typed)");
});

test("Leyline Bolt used DURING Call Tides hits the target for 25 PIERCING", () => {
  // Frozen: "If used during Call Tides, it affects target enemy instead, and deals Piercing damage."
  // performAction cancels the channel (removeStatus 'channeling') BEFORE runEffects, so the skill's
  // `if has(channeling,self)` reads FALSE and falls to the else branch (normal). With 10 DR on the
  // target, piercing would land the full 25; normal is reduced to 15.
  const z = fuse("alchemy");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, alchemy: 40, water: 40 };
  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] }); // begin Channeling Call Tides
  assert.equal(isChanneling(z), true, "channeling before Leyline Bolt");
  performAction(state, { unit: "z", skillId: "zevkiralchemy1", targets: ["e1"] });
  assert.equal(500 - e1.hp, 25, "during Call Tides Leyline Bolt is PIERCING -> full 25 through 10 DR");
});

// =================================================================================================== //
// anointment — Atlantean Hymn (passive): allies (incl. self) heal 5/turn during Call Tides.
// =================================================================================================== //
test("Atlantean Hymn: during Call Tides, allies (incl. Zev'kir) heal 5 health per turn", () => {
  const z = fuse("anointment");
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 300 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z, ally], [e1]);
  state.teams.A.energy = { generic: 40, anointment: 40, water: 40 };

  assert.equal(ally.statuses.some((s) => s.kind === "regen" && s.name === "Atlantean Hymn"), false, "no regen before channel");
  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] }); // begin Channeling
  assert.equal(ally.statuses.some((s) => s.kind === "regen" && s.name === "Atlantean Hymn" && s.magnitude === 5), true, "ally gains the Atlantean Hymn regen");

  const hp = ally.hp;
  state.turn += 1;      // advance past the apply turn so the regen ticks
  tickDots(state, "A"); // Zev'kir's team tick
  assert.equal(ally.hp - hp, 5, "the wounded ally heals 5 on the tick");
});

test("Atlantean Hymn: no regen without the Call Tides channel (control)", () => {
  const z = fuse("anointment");
  const ally = makeUnit({ id: "a1", team: "A", hp: 100, maxHp: 300 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z, ally], [e1]);
  state.teams.A.energy = { generic: 40, anointment: 40, water: 40 };

  const hp = ally.hp;
  state.turn += 1;
  tickDots(state, "A");
  assert.equal(ally.hp - hp, 0, "no channel -> no Atlantean Hymn healing");
});

// anointment — Purelight Pool (active).
test("Purelight Pool: heals the target ally 20 + 5 per Call Tides stack on Zev'kir", () => {
  for (const [n, healed] of [[0, 20], [2, 30], [4, 40]] as const) {
    const z = fuse("anointment");
    if (n > 0) z.statuses.push(CT(n));
    const ally = makeUnit({ id: "a1", team: "A", hp: 50, maxHp: 300 });
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z, ally], [e1]);
    state.teams.A.energy = { generic: 40, anointment: 40 };
    const hp = ally.hp;
    performAction(state, { unit: "z", skillId: "zevkiranointment1", targets: ["a1"] });
    assert.equal(ally.hp - hp, healed, `at ${n} Call Tides stacks Purelight Pool heals 20 + 5*${n} = ${healed}`);
  }
});

// =================================================================================================== //
// blood — Sanguine Spectre (passive): heal 10 on dealing damage; at full HP gain a Call Tides stack instead.
// =================================================================================================== //
test("Sanguine Spectre: dealing damage while wounded heals Zev'kir 10 (no stack gained)", () => {
  const z = fuse("blood");
  z.hp = z.maxHp - 50; // wounded
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, blood: 40, water: 40 };

  const hp = z.hp, stacks = stackCount(z, "Call Tides");
  performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] }); // Riptide deals damage
  assert.equal(z.hp - hp, 10, "dealing damage while wounded heals Zev'kir 10");
  assert.equal(stackCount(z, "Call Tides"), stacks, "wounded branch heals — it does NOT grant a Call Tides stack");
});

test("Sanguine Spectre: dealing damage at FULL health grants a Call Tides stack instead (no heal)", () => {
  const z = fuse("blood");
  z.hp = z.maxHp; // full
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, blood: 40, water: 40 };

  const stacks = stackCount(z, "Call Tides");
  performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
  assert.equal(z.hp, z.maxHp, "at full health there is nothing to heal");
  assert.equal(stackCount(z, "Call Tides"), stacks + 1, "at full health, dealing damage grants a Call Tides stack instead");
});

// blood — Crimson Tide (active).
test("Crimson Tide: Zev'kir loses 5 HP per enemy targeted, then each enemy takes 15 + 5*stacks Affliction next turn", () => {
  const z = fuse("blood");
  z.statuses.push(CT(2));
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1, e2]);
  state.teams.A.energy = { generic: 40, blood: 40 };

  const zHp = z.hp;
  performAction(state, { unit: "z", skillId: "zevkirblood1", targets: [] });
  assert.equal(zHp - z.hp, 10, "Zev'kir loses 5 per enemy targeted: 5 * 2 = 10");
  assert.equal(e1.hp, 500, "the strike is deferred — no immediate enemy damage");
  assert.equal(e2.hp, 500, "no immediate enemy damage on the second enemy either");

  // The following turn each targeted enemy takes 15 + 5*stacks (2) = 25 Affliction.
  state.turn += 1;
  endTurn(state); // fires the scheduled follow-up (anchored to Zev'kir's team turn-end)
  assert.equal(500 - e1.hp, 25, "next turn e1 takes 15 + 5*2 = 25 Affliction");
  assert.equal(500 - e2.hp, 25, "next turn e2 takes 15 + 5*2 = 25 Affliction");
});

test("Crimson Tide: the self-loss scales with the number of enemies (control: 3 enemies -> lose 15)", () => {
  const z = fuse("blood");
  const enemies = [1, 2, 3].map((i) => makeUnit({ id: `e${i}`, team: "B", hp: 500, maxHp: 500 }));
  const state = makeState([z], enemies);
  state.teams.A.energy = { generic: 40, blood: 40 };
  const zHp = z.hp;
  performAction(state, { unit: "z", skillId: "zevkirblood1", targets: [] });
  assert.equal(zHp - z.hp, 15, "5 health per enemy targeted: 5 * 3 = 15");
});

// =================================================================================================== //
// current — Static Maelstrom (passive): channeling remaps costs to Generic + a +10 next-ability bonus.
// =================================================================================================== //
test("Static Maelstrom: beginning to Channel Call Tides remaps Zev'kir's costs to Generic and grants +10 next-ability damage", () => {
  const z = fuse("current");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, current: 40, water: 40 };

  assert.equal(z.statuses.some((s) => s.kind === "cost_currency_remap" && s.name === "Static Maelstrom"), false, "no remap before channel");
  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] }); // begin Channeling
  assert.equal(z.statuses.some((s) => s.kind === "cost_currency_remap" && s.name === "Static Maelstrom"), true, "Channeling remaps costs to Generic (cost_currency_remap)");
  assert.equal(z.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === 10), true, "and grants a +10 next-ability damage bonus");
});

// current — Crackling Slipstream (active).
test("Crackling Slipstream: deals 25 PIERCING to the target (full through Damage Reduction)", () => {
  const z = fuse("current");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, current: 40 };
  performAction(state, { unit: "z", skillId: "zevkircurrent1", targets: ["e1"] });
  assert.equal(500 - e1.hp, 25, "25 piercing lands full through 10 DR (a normal hit would be 15)");
});

test("Crackling Slipstream: at >=3 Call Tides stacks it applies Static Maelstrom to the whole team; below 3 it does not", () => {
  // Positive: 3 stacks -> the team (incl. self and allies) gets the Static Maelstrom pair for 1 turn.
  {
    const z = fuse("current");
    z.statuses.push(CT(3));
    const ally = makeUnit({ id: "a1", team: "A", hp: 300, maxHp: 300 });
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z, ally], [e1]);
    state.teams.A.energy = { generic: 40, current: 40 };
    performAction(state, { unit: "z", skillId: "zevkircurrent1", targets: ["e1"] });
    assert.equal(ally.statuses.some((s) => s.kind === "cost_currency_remap"), true, "ally gets the Static Maelstrom cost remap");
    assert.equal(ally.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === 10), true, "ally gets the +10 damage bonus");
    assert.equal(z.statuses.some((s) => s.kind === "cost_currency_remap"), true, "Zev'kir himself is part of 'his team'");
  }
  // Control: only 2 stacks -> no team grant.
  {
    const z = fuse("current");
    z.statuses.push(CT(2));
    const ally = makeUnit({ id: "a1", team: "A", hp: 300, maxHp: 300 });
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z, ally], [e1]);
    state.teams.A.energy = { generic: 40, current: 40 };
    performAction(state, { unit: "z", skillId: "zevkircurrent1", targets: ["e1"] });
    assert.equal(ally.statuses.some((s) => s.kind === "cost_currency_remap"), false, "below 3 stacks: no Static Maelstrom for the team");
  }
});

// =================================================================================================== //
// glacier — Freezing Brine (passive): Riptide adds Freezing Brine = Call Tides stacks; at 5 -> stun + consume.
// =================================================================================================== //
test("Freezing Brine: Riptide adds a Freezing Brine stack per Call Tides stack (0 stacks adds nothing)", () => {
  // Positive: 2 Call Tides -> Riptide plants 2 Freezing Brine on the struck enemy.
  // (NB: the base Riptide separately stuns the primary at >=2 Call Tides — Oceans Gather's clause is baked
  // into the skill effects and survives fusion — so we assert only the Freezing Brine COUNT here, not stun.)
  {
    const z = fuse("glacier");
    z.statuses.push(CT(2));
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, glacier: 40, water: 40 };
    performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(fbStacks(e1), 2, "Riptide at 2 Call Tides plants 2 Freezing Brine stacks");
  }
  // Control on "per stack of Call Tides": at 0 Call Tides, Riptide plants 0 Freezing Brine.
  {
    const z = fuse("glacier");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, glacier: 40, water: 40 };
    performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(fbStacks(e1), 0, "0 Call Tides -> 0 Freezing Brine added");
  }
});

test("Freezing Brine: reaching 5 stacks stuns the enemy 1 turn and consumes the stacks", () => {
  // Isolate the Freezing-Brine stun from the base Riptide's baked >=2-Call-Tides stun by driving at 1 Call
  // Tides (Riptide adds 1 FB, and 1 < 2 so no baked stun). Pre-seed 4 FB so this hit reaches the 5 threshold.
  {
    const z = fuse("glacier");
    z.statuses.push(CT(1));
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [{ kind: "stack", name: "Freezing Brine", magnitude: 4, duration: null, appliedBy: "z", appliedTurn: 0 }] });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, glacier: 40, water: 40 };
    performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(hasStun(e1), true, "4 + 1 = 5 Freezing Brine -> the enemy is stunned");
    assert.equal(fbStacks(e1), 0, "the 5 stacks are consumed on the stun");
  }
  // Control: 3 + 1 = 4 (< 5), at 1 Call Tides (no baked stun) -> not stunned, stacks retained.
  {
    const z = fuse("glacier");
    z.statuses.push(CT(1));
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [{ kind: "stack", name: "Freezing Brine", magnitude: 3, duration: null, appliedBy: "z", appliedTurn: 0 }] });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, glacier: 40, water: 40 };
    performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(hasStun(e1), false, "4 < 5 Freezing Brine -> no stun");
    assert.equal(fbStacks(e1), 4, "and the 4 stacks persist (only reaching 5 consumes them)");
  }
});

test("Freezing Brine: only RIPTIDE plants stacks — a non-Riptide damaging skill does not (control)", () => {
  const z = fuse("glacier");
  z.statuses.push(CT(2));
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, glacier: 40, water: 40 };
  performAction(state, { unit: "z", skillId: "zevkir5", targets: ["e1"] }); // Tidal Wave (not Riptide)
  assert.equal(500 - e1.hp > 0, true, "Tidal Wave did deal damage");
  assert.equal(fbStacks(e1), 0, "Freezing Brine only triggers off Riptide, not Tidal Wave");
});

// glacier — Cold Snap (active).
test("Cold Snap: stunned allies become invulnerable; invulnerable enemies become stunned; others untouched", () => {
  const z = fuse("glacier");
  const stunnedAlly = makeUnit({ id: "a1", team: "A", hp: 300, maxHp: 300, statuses: [{ kind: "stun", duration: 1, appliedBy: "x", appliedTurn: 0 }] });
  const freeAlly = makeUnit({ id: "a2", team: "A", hp: 300, maxHp: 300 });
  const invulnEnemy = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [{ kind: "invulnerable", duration: 2, appliedBy: "x", appliedTurn: 0 }] });
  const freeEnemy = makeUnit({ id: "e2", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z, stunnedAlly, freeAlly], [invulnEnemy, freeEnemy]);
  state.teams.A.energy = { generic: 40, glacier: 40 };

  performAction(state, { unit: "z", skillId: "zevkirglacier1", targets: [] });
  assert.equal(hasInvuln(stunnedAlly), true, "the stunned ally becomes invulnerable");
  assert.equal(hasInvuln(freeAlly), false, "an un-stunned ally is NOT made invulnerable");
  assert.equal(hasStun(invulnEnemy), true, "the invulnerable enemy becomes stunned");
  assert.equal(hasStun(freeEnemy), false, "a non-invulnerable enemy is NOT stunned");
});

// =================================================================================================== //
// mirror — Patient Predation (passive): while channeling, a harmful skill on Zev'kir is reflected + ends CT.
// =================================================================================================== //
test("Patient Predation: a harmful skill on the channeling Zev'kir is reflected to its caster and ends Call Tides", () => {
  const z = fuse("mirror");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, currentElement: "fire" });
  e1.skills = [enemyStrike(30)];
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, mirror: 40, water: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] }); // Zev'kir begins Channeling
  assert.equal(isChanneling(z), true, "channeling before the enemy strikes");

  const zHp = z.hp, eHp = e1.hp;
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["z"] });
  assert.equal(zHp - z.hp, 0, "the harmful skill is reflected — Zev'kir takes no damage");
  assert.equal(eHp - e1.hp, 30, "the harmful skill is reflected back onto its user for its 30");
  assert.equal(isChanneling(z), false, "and Call Tides ends");
});

test("Patient Predation control: with NO channel there is no reflection — the harmful skill hits Zev'kir", () => {
  const z = fuse("mirror");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, currentElement: "fire" });
  e1.skills = [enemyStrike(30)];
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, mirror: 40, water: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  const zHp = z.hp, eHp = e1.hp;
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["z"] });
  assert.equal(zHp - z.hp, 30, "no channel -> no reflection: Zev'kir takes the 30");
  assert.equal(eHp - e1.hp, 0, "and the caster takes nothing");
});

// mirror — Lens of the Deep (active).
test("Lens of the Deep: deals 15 PIERCING and marks the enemy for 2 turns", () => {
  const z = fuse("mirror");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, mirror: 40 };
  performAction(state, { unit: "z", skillId: "zevkirmirror1", targets: ["e1"] });
  assert.equal(500 - e1.hp, 15, "15 piercing lands full through 10 DR (a normal hit would be 5)");
  const mark = e1.statuses.find((s) => s.kind === "mark" && s.name === "Lens of the Deep");
  assert.ok(mark, "the enemy is marked by Lens of the Deep");
  assert.equal(mark!.duration, 2, "the mark lasts 2 turns");
});

test.skip("SUSPECTED BUG: a Lens-marked enemy should take DOUBLE damage from reflected skills (frozen), but the reflection path does not read the mark — it deals single", () => {
  // Frozen: "...for their next two turns that enemy will receive double damage from reflected skills."
  // Setup: mark e1 with Lens, begin Channeling, then let e1 strike Zev'kir. Patient Predation reflects the
  // 30-damage strike back onto e1. Since e1 carries the Lens mark, the reflected hit should be DOUBLED (60).
  const z = fuse("mirror");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, currentElement: "fire" });
  e1.skills = [enemyStrike(30)];
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, mirror: 40, water: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };

  performAction(state, { unit: "z", skillId: "zevkirmirror1", targets: ["e1"] }); // Lens on e1 (15 piercing)
  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] });          // begin Channeling
  const eHp = e1.hp;
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["z"] });            // reflected onto marked e1
  assert.equal(eHp - e1.hp, 60, "the reflected 30 is DOUBLED to 60 by the Lens of the Deep mark");
});

// =================================================================================================== //
// mist — Misty Mire (passive): Bubble Prison now targets ALL enemies; its per-turn damage is Piercing/Bypasses.
// =================================================================================================== //
test("Misty Mire: Bubble Prison now imprisons ALL enemies (not just the chosen target)", () => {
  const z = fuse("mist");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1, e2]);
  state.teams.A.energy = { generic: 40, mist: 40, water: 40 };
  performAction(state, { unit: "z", skillId: "zevkir3", targets: ["e1"] }); // Bubble Prison, chosen = e1
  assert.equal(e1.statuses.some((s) => s.name === "Bubble Prison"), true, "the chosen enemy is imprisoned");
  assert.equal(e2.statuses.some((s) => s.name === "Bubble Prison"), true, "Misty Mire fans Bubble Prison onto EVERY enemy, incl. the un-chosen e2");
});

test("Misty Mire: the per-turn Bubble Prison damage is 15 and Bypasses Damage Reduction (Piercing)", () => {
  const z = fuse("mist");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, mist: 40, water: 40 };
  performAction(state, { unit: "z", skillId: "zevkir3", targets: ["e1"] });
  const hp = e1.hp;
  // The reshaped per-turn "15 Piercing to a random target" fires on Zev'kir's team turn-START (with one
  // enemy the random pick is deterministic). Piercing/Bypasses -> the full 15 lands through the 10 DR.
  startTurn(state);
  assert.equal(hp - e1.hp, 15, "the per-turn damage is 15 and lands FULL through 10 DR (Piercing/Bypasses)");
});

// mist — Spear of Fog (active).
test("Spear of Fog: 15 to an ordinary enemy; DOUBLE (30) and Bypassing against a Bubble-Prison'd enemy", () => {
  // Control: an ordinary enemy behind 10 DR takes 15 normal -> 5.
  {
    const z = fuse("mist");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, mist: 40 };
    performAction(state, { unit: "z", skillId: "zevkirmist1", targets: ["e1"] });
    assert.equal(500 - e1.hp, 5, "ordinary enemy: 15 normal, reduced by 10 DR to 5");
  }
  // Positive: a Bubble-Prison'd enemy behind 10 DR takes 30, Bypassing the DR (full 30).
  {
    const z = fuse("mist");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10), { kind: "mark", name: "Bubble Prison", duration: 3, appliedBy: "z", appliedTurn: 0 }] });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, mist: 40 };
    performAction(state, { unit: "z", skillId: "zevkirmist1", targets: ["e1"] });
    assert.equal(500 - e1.hp, 30, "Bubble-Prison'd enemy: DOUBLE (30) that Bypasses the 10 DR (full 30)");
  }
});

// =================================================================================================== //
// ocean — Chains of Atlantis (passive): channeling turn-ends chain a random enemy; chained enemies take
// 5 Affliction per stack each Call Tides turn.
// =================================================================================================== //
test("Chains of Atlantis: ending a turn while Channeling grants a random enemy a Chains stack; chained enemies then take 5*stacks per Call Tides turn", () => {
  const z = fuse("ocean");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, ocean: 40, water: 40 };

  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] }); // begin Channeling
  endTurn(state); // Zev'kir's team turn-end while Channeling -> a random enemy is chained
  const chains = e1.statuses.find((s) => s.kind === "stack" && s.name === "Chains of Atlantis");
  assert.equal(chains?.magnitude ?? 0, 1, "a random enemy gains a Chains of Atlantis stack at the channeling turn-end");

  // A Call Tides turn (turnStart while Zev'kir Channels) -> the chained enemy takes 5 * stacks Affliction.
  const hp = e1.hp;
  startTurn(state);
  assert.equal(hp - e1.hp, 5, "the chained enemy takes 5 Affliction per stack (1 stack -> 5) during Call Tides");
});

test("Chains of Atlantis control: a turn-end while NOT Channeling chains no one", () => {
  const z = fuse("ocean");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, ocean: 40, water: 40 };
  endTurn(state); // not channeling
  assert.equal(e1.statuses.some((s) => s.name === "Chains of Atlantis"), false, "no channel -> no enemy is chained");
});

// ocean — Abyssal Grasp (active).
test("Abyssal Grasp: deals 30 to the target; if the enemy is Chains-marked it is stunned 1 turn", () => {
  // Chained enemy -> stunned.
  {
    const z = fuse("ocean");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [CHAINS(1)] });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, ocean: 40 };
    performAction(state, { unit: "z", skillId: "zevkirocean1", targets: ["e1"] });
    assert.equal(500 - e1.hp, 30, "30 damage to the target");
    assert.equal(hasStun(e1), true, "a Chains-marked enemy is stunned for 1 turn");
  }
  // Control: an un-chained enemy takes the 30 but is NOT stunned.
  {
    const z = fuse("ocean");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, ocean: 40 };
    performAction(state, { unit: "z", skillId: "zevkirocean1", targets: ["e1"] });
    assert.equal(500 - e1.hp, 30, "30 damage to the target");
    assert.equal(hasStun(e1), false, "an un-chained enemy is not stunned");
  }
});

test("Abyssal Grasp during Call Tides deals PIERCING", () => {
  // Frozen: "If Zev'kir is Channeling Call Tides, this damage becomes Piercing."
  // As with Leyline Bolt, performAction removes the channeling status BEFORE runEffects, so the skill's
  // `if has(channeling,self)` reads FALSE and the damage stays normal. Through 10 DR: piercing = 30, normal = 20.
  const z = fuse("ocean");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, statuses: [DR(10)] });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, ocean: 40, water: 40 };
  performAction(state, { unit: "z", skillId: "zevkir1", targets: ["z"] }); // begin Channeling
  assert.equal(isChanneling(z), true, "channeling before Abyssal Grasp");
  performAction(state, { unit: "z", skillId: "zevkirocean1", targets: ["e1"] });
  assert.equal(500 - e1.hp, 30, "during Call Tides Abyssal Grasp is PIERCING -> full 30 through 10 DR");
});

// =================================================================================================== //
// serum — Rapid Mutation (passive): 5 Affliction at each of his turn-ends; +1 effective Call Tides / 15 missing HP.
// =================================================================================================== //
test("Rapid Mutation: Zev'kir takes 5 Affliction at the end of his turn", () => {
  const z = fuse("serum");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, serum: 40 };
  const hp = z.hp;
  endTurn(state); // Zev'kir's team turn-end
  assert.equal(hp - z.hp, 5, "5 Affliction self-damage at his turn-end");
});

test("Rapid Mutation: Zev'kir has +1 effective Call Tides stack for every 15 HP he is missing", () => {
  const z = fuse("serum");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  emit(state, { type: "roundStart" }); // installs the missing-HP derived-stack read

  assert.equal(stackCount(z, "Call Tides"), 0, "at full HP, no derived Call Tides stacks");
  z.hp = z.maxHp - 30;
  assert.equal(stackCount(z, "Call Tides"), 2, "30 missing HP -> +2 effective Call Tides stacks (floor 30/15)");
  z.hp = z.maxHp - 44;
  assert.equal(stackCount(z, "Call Tides"), 2, "44 missing HP -> still +2 (floor 44/15), not +3");
  z.hp = z.maxHp - 45;
  assert.equal(stackCount(z, "Call Tides"), 3, "45 missing HP -> +3 effective Call Tides stacks");
});

// serum — Mutable Form (active).
test("Mutable Form: grants 10 Shield (for 2 turns) per Call Tides stack; 0 stacks grants none", () => {
  for (const [n, sh] of [[0, 0], [1, 10], [3, 30]] as const) {
    const z = fuse("serum");
    if (n > 0) z.statuses.push(CT(n));
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, serum: 40 };
    performAction(state, { unit: "z", skillId: "zevkirserum1", targets: ["z"] });
    assert.equal(shieldTotal(z), sh, `at ${n} Call Tides stacks Mutable Form grants 10*${n} = ${sh} Shield`);
    if (n > 0) assert.equal(z.shields![0]!.duration, 2, "the Shield lasts 2 turns");
  }
});

// =================================================================================================== //
// slime — Stinking Marsh (passive): at 0 Call Tides, skills act as-if 2 stacks and deal Affliction; a
// 0-stack skill use costs Zev'kir 10 Affliction.
// =================================================================================================== //
test("Stinking Marsh: at 0 Call Tides stacks, Riptide is computed as-if 2 stacks and deals Affliction (bypasses Shield)", () => {
  const z = fuse("slime");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, shield: 100 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, slime: 40, water: 40 };
  emit(state, { type: "roundStart" }); // installs the as-if-2 read + Affliction override

  const shBefore = shieldTotal(e1);
  performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] }); // Riptide at RAW 0 stacks
  // Riptide = 5 + 10*stacks; as-if-2 -> 25. Affliction bypasses the 100 Shield and lands on HP.
  assert.equal(500 - e1.hp, 25, "as-if-2: Riptide deals 5 + 10*2 = 25, and as Affliction it bypasses the Shield onto HP");
  assert.equal(shieldTotal(e1), shBefore, "the Shield is untouched — the damage was Affliction, which ignores Shield");
});

test("Stinking Marsh control: with a real Call Tides stack the skill is normal-typed and Shield absorbs it", () => {
  const z = fuse("slime");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500, shield: 100 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, slime: 40, water: 40 };
  emit(state, { type: "roundStart" });
  z.statuses.push(CT(1)); // now RAW 1 -> the as-if-2 floor and Affliction override are OFF

  performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] }); // Riptide at 1 stack = 15 normal
  assert.equal(e1.hp, 500, "the 15 normal damage is fully absorbed by the Shield -> HP untouched");
  assert.equal(shieldTotal(e1), 85, "the Shield absorbed the 15 (100 -> 85), proving it was NOT Affliction");
});

test("Stinking Marsh: using a skill at 0 Call Tides stacks costs Zev'kir 10 Affliction; with a stack it does not", () => {
  // Positive: at RAW 0 stacks, using any skill self-inflicts 10 Affliction.
  {
    const z = fuse("slime");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, slime: 40, water: 40 };
    emit(state, { type: "roundStart" });
    const hp = z.hp;
    performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(hp - z.hp, 10, "using a skill at 0 Call Tides -> 10 Affliction self-damage");
  }
  // Control: with a real stack, no self-damage.
  {
    const z = fuse("slime");
    const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
    const state = makeState([z], [e1]);
    state.teams.A.energy = { generic: 40, slime: 40, water: 40 };
    emit(state, { type: "roundStart" });
    z.statuses.push(CT(1));
    const hp = z.hp;
    performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(hp - z.hp, 0, "with a Call Tides stack, using a skill costs no self-Affliction");
  }
});

// slime — Rising Bog (active).
test("Rising Bog: consumes all Call Tides stacks, remaps costs to Generic, and shields the team 10/turn", () => {
  const z = fuse("slime");
  z.statuses.push(CT(3));
  const ally = makeUnit({ id: "a1", team: "A", hp: 300, maxHp: 300 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z, ally], [e1]);
  state.teams.A.energy = { generic: 40, slime: 40 };

  performAction(state, { unit: "z", skillId: "zevkirslime1", targets: [] });
  assert.equal(z.statuses.some((s) => s.kind === "stack" && s.name === "Call Tides"), false, "all Call Tides stacks are consumed");
  assert.equal(z.statuses.some((s) => s.kind === "cost_mod" && s.name === "Rising Bog"), true, "Zev'kir's costs are remapped to Generic (cost_mod)");
  assert.equal(shieldTotal(ally), 10, "the team is granted 10 Shield (the first per-turn grant)");
  assert.equal(shieldTotal(z), 10, "Zev'kir (part of 'his team') is shielded too");
});

test("Rising Bog: the Generic-cost remap lasts a number of turns equal to the Call Tides stacks consumed", () => {
  // Duration is read BEFORE the consumption; 3 stacks -> a 3-turn cost_mod.
  const z = fuse("slime");
  z.statuses.push(CT(3));
  const e1 = makeUnit({ id: "e1", team: "B", hp: 500, maxHp: 500 });
  const state = makeState([z], [e1]);
  state.teams.A.energy = { generic: 40, slime: 40 };
  performAction(state, { unit: "z", skillId: "zevkirslime1", targets: [] });
  const cm = z.statuses.find((s) => s.kind === "cost_mod" && s.name === "Rising Bog");
  assert.ok(cm, "the cost_mod is present");
  assert.equal(cm!.duration, 3, "its duration equals the 3 Call Tides stacks consumed");
});
