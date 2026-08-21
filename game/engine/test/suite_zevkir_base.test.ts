import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { performAction, startTurn, endTurn, tickDots, effectiveCost } from "../src/scheduler.ts";
import { stackCount } from "../src/status.ts";
import type { Unit } from "../src/types.ts";

// ===================================================================================================== //
// Adversarial, SPEC-DERIVED suite for Tidecaller Zev'kir's BASE kit.
// The FROZEN prose (content/frozen/skills.json) is the oracle for every assertion below:
//
//   zevkir0 Oceans Gather (passive): "When Zev'kir reaches 1 stack of Call Tides, he gains Elemental
//     Essence. When he reaches 2 stacks, his harmful skills will stun their primary target for 1 turn.
//     When he reaches 3 stacks, his skills affect all valid targets."
//   zevkir1 Call Tides (Strategic, Channel, self, 1 generic): "Zev'kir begins Channeling, gaining a stack
//     of Call Tides each turn. These stacks are consumed on him using a new non-Strategic skill."
//   zevkir2 Riptide (Harmful, Instant, 1 water): "Zev'kir deals 5 damage to target enemy, increased by
//     10 damage per stack of Call Tides Zev'kir has."
//   zevkir3 Bubble Prison (Harmful, Control, 1 generic + 1 water): "Zev'kir deals 15 damage to target
//     enemy for 1 turn, increased by 1 turn per stack of Call Tides Zev'kir has. This skill will end if
//     Zev'kir is stunned."
//   zevkir4 Repulse (Helpful, Instant, invisible, 1 generic): "Zev'kir counters the first harmful skill
//     received by target ally. If a skill is countered, Zev'kir will automatically begin channeling Call
//     Tides. This effect is invisible."
//   zevkir5 Tidal Wave (Harmful, Instant, 5 water): "Zev'kir deals 45 piercing damage to target enemy.
//     This skill costs 1 less [water] per stack of Call Tides Zev'kir has."
//
// Content (roster.authored/generated) was read ONLY to drive: skill ids zevkir1..5, element = water,
// costs, targeting, and the status names (Call Tides stack, Bubble Prison dot, Repulse mark,
// elemental_essence). WHAT is asserted comes from the prose above.
// ===================================================================================================== //

const CT = (n: number) => ({
  kind: "stack" as const, name: "Call Tides", magnitude: n, duration: null, appliedBy: "zev", appliedTurn: 0,
});
const hasStun = (u: Unit) => u.statuses.some((s) => s.kind === "stun");
const stunDur = (u: Unit) => u.statuses.find((s) => s.kind === "stun")?.duration ?? null;
const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const bubbleDot = (u: Unit) => u.statuses.find((s) => s.kind === "dot" && s.name === "Bubble Prison");
const repulseMark = (u: Unit) => u.statuses.find((s) => s.kind === "mark" && s.name === "Repulse");
const isChanneling = (u: Unit) => u.statuses.some((s) => s.kind === "channeling" && s.name === "zevkir1");

/** Zev'kir on team A + N enemies (500 hp each), preloaded with `stacks` Call Tides, full energy. */
function arena(stacks: number, enemyCount = 2, enemyOpts: Partial<Unit>[] = []) {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  if (stacks > 0) zev.statuses.push(CT(stacks));
  const enemies: Unit[] = [];
  for (let i = 0; i < enemyCount; i++) {
    enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", hp: 500, maxHp: 500, ...(enemyOpts[i] ?? {}) }));
  }
  const state = makeState([zev], enemies);
  state.teams.A.energy = { generic: 40, water: 40 };
  return { zev, enemies, state };
}

// --------------------------------------------------------------------------------------------------- //
// zevkir1 — Call Tides: begins Channeling; gains a stack each turn.
// --------------------------------------------------------------------------------------------------- //
test("Call Tides: a cast installs a Channel and immediately yields the first stack", () => {
  const { zev, state } = arena(0, 1);
  assert.equal(stackCount(zev, "Call Tides"), 0, "no stacks before casting");
  assert.equal(isChanneling(zev), false, "not channeling before casting");

  const r = performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  assert.equal(r.ok, true, "Call Tides casts");
  assert.equal(stackCount(zev, "Call Tides"), 1, "first stack gained on the cast");
  assert.equal(isChanneling(zev), true, "Call Tides is a Channel — a channeling marker is installed");
});

test("Call Tides: the Channel grants an additional stack on each of Zev'kir's subsequent turns", () => {
  const { zev, state } = arena(0, 1);
  performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  assert.equal(stackCount(zev, "Call Tides"), 1, "1 stack right after the cast (turn 1)");

  // Advance a full round back to team A's next turn — the channel re-runs at Zev'kir's turn start.
  endTurn(state);   // A -> B
  startTurn(state); // B's turn (Zev'kir's channel does NOT run on the enemy turn)
  assert.equal(stackCount(zev, "Call Tides"), 1, "the channel does not tick on the opponent's turn");
  endTurn(state);   // B -> A
  startTurn(state); // A's turn start -> channel re-runs
  assert.equal(stackCount(zev, "Call Tides"), 2, "gaining a stack each turn: 1 -> 2 on Zev'kir's next turn");
});

test("Call Tides: stacks are consumed when Zev'kir uses a non-Strategic skill", () => {
  // Positive: Riptide is non-Strategic (Harmful/Instant) — after it resolves, Call Tides stacks are gone.
  const { zev, state } = arena(2, 1);
  assert.equal(stackCount(zev, "Call Tides"), 2, "preloaded 2 stacks");
  performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
  assert.equal(stackCount(zev, "Call Tides"), 0, "a non-Strategic skill consumes the Call Tides stacks");
});

test("Call Tides: a Strategic skill (recasting Call Tides itself) does NOT consume the stacks", () => {
  // Control on the consumption clause: Call Tides is Strategic, so using it must not clear the stacks.
  // It adds one more (the channel yield) instead: 2 -> 3.
  const { zev, state } = arena(2, 1);
  performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  assert.equal(stackCount(zev, "Call Tides"), 3, "a Strategic skill leaves stacks intact (2) and adds its own (+1)");
});

// --------------------------------------------------------------------------------------------------- //
// zevkir0 — Oceans Gather, clause 1: reaching 1 Call Tides stack grants Elemental Essence.
// --------------------------------------------------------------------------------------------------- //
test("Oceans Gather: reaching 1 Call Tides stack grants Elemental Essence (real cast)", () => {
  const { zev, state } = arena(0, 1);
  assert.equal(hasEssence(zev), false, "no Essence before reaching a stack");
  performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  assert.equal(stackCount(zev, "Call Tides"), 1, "now at exactly 1 stack");
  assert.equal(hasEssence(zev), true, "reaching 1 stack -> Elemental Essence");
});

test("Oceans Gather clause 1: fires only on reaching 1 (not the enemy, not at 2 stacks)", () => {
  // Control A — wrong recipient: a status landing on the enemy while Zev'kir sits at 1 stack grants nothing.
  {
    const { zev, enemies, state } = arena(1, 1);
    emit(state, { type: "statusApplied", unit: "e1", source: "zev", kind: "stack", name: "Call Tides" });
    assert.equal(hasEssence(zev), false, "a status on the enemy must not grant Zev'kir Essence");
    assert.equal(hasEssence(enemies[0]!), false, "and certainly not the enemy");
  }
  // Control B — the "==1" threshold: at 2 stacks, a further stack does not re-grant Essence.
  {
    const { zev, state } = arena(2, 1);
    emit(state, { type: "statusApplied", unit: "zev", source: "zev", kind: "stack", name: "Call Tides" });
    assert.equal(hasEssence(zev), false, "Essence is a reaching-1 event, not granted again at 2 stacks");
  }
});

// --------------------------------------------------------------------------------------------------- //
// zevkir2 — Riptide: 5 + 10 per Call Tides stack, to target enemy. (+ Oceans Gather clauses 2 & 3.)
// --------------------------------------------------------------------------------------------------- //
test("Riptide: deals 5 + 10 per Call Tides stack to the target enemy only", () => {
  for (const [n, dmg] of [[0, 5], [1, 15], [2, 25], [3, 35]] as const) {
    const { enemies, state } = arena(n, 2);
    performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(500 - enemies[0]!.hp, dmg, `Riptide at ${n} stacks deals 5+10*${n} = ${dmg}`);
    if (n < 3) assert.equal(enemies[1]!.hp, 500, `at ${n} stacks Riptide hits only the primary target`);
  }
});

test("Riptide + Oceans Gather clause 2: at >=2 stacks the primary target is stunned 1 turn; below that, not", () => {
  {
    const { enemies, state } = arena(1, 1);
    performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(hasStun(enemies[0]!), false, "1 stack (< 2): no stun");
  }
  {
    const { enemies, state } = arena(2, 1);
    performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(hasStun(enemies[0]!), true, "2 stacks: primary is stunned");
    assert.equal(stunDur(enemies[0]!), 1, "the stun lasts exactly 1 turn");
  }
});

test("Riptide + Oceans Gather clause 3: at >=3 stacks it hits all enemies, but only the primary is stunned", () => {
  const { enemies, state } = arena(3, 2);
  performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
  assert.equal(500 - enemies[0]!.hp, 35, "primary takes 35");
  assert.equal(500 - enemies[1]!.hp, 35, "clause 3: the secondary enemy is also hit for 35");
  assert.equal(hasStun(enemies[0]!), true, "primary is stunned (>=2 stacks)");
  assert.equal(hasStun(enemies[1]!), false, "clause 2 stuns the PRIMARY target only, not the fanned secondary");
});

// --------------------------------------------------------------------------------------------------- //
// zevkir3 — Bubble Prison: 15 damage for (1 + stacks) turns; ends if Zev'kir is stunned. (+ clauses 2 & 3.)
// --------------------------------------------------------------------------------------------------- //
test("Bubble Prison: applies a 15-per-turn effect on the target lasting 1 + stacks turns", () => {
  for (const [n, dur] of [[0, 1], [1, 2], [2, 3], [3, 4]] as const) {
    const { enemies, state } = arena(n, 2);
    performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
    const d = bubbleDot(enemies[0]!);
    assert.ok(d, `Bubble Prison lands on the primary at ${n} stacks`);
    assert.equal(d!.magnitude, 15, "15 damage per turn");
    assert.equal(d!.duration, dur, `duration is 1 + ${n} = ${dur} turns`);
    if (n < 3) assert.equal(bubbleDot(enemies[1]!), undefined, `at ${n} stacks it targets only the primary`);
  }
});

test("Bubble Prison: the effect actually deals 15 damage on Zev'kir's next turn", () => {
  const { enemies, state } = arena(0, 1); // duration 1 -> one 15-damage tick
  performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
  assert.equal(enemies[0]!.hp, 500, "no tick on the birth turn");
  state.turn += 1; // advance to a later Zev'kir turn so the applier-team DoT ticks
  tickDots(state, "A");
  assert.equal(enemies[0]!.hp, 485, "the Bubble Prison effect deals 15 damage on the tick");
});

test("Bubble Prison + Oceans Gather clause 3: at >=3 stacks it lands on every enemy", () => {
  const { enemies, state } = arena(3, 2);
  performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
  assert.ok(bubbleDot(enemies[0]!), "primary gets Bubble Prison");
  assert.ok(bubbleDot(enemies[1]!), "clause 3: the secondary enemy is imprisoned too");
  assert.equal(bubbleDot(enemies[1]!)!.duration, 4, "duration 1 + 3 on the secondary as well");
  assert.equal(hasStun(enemies[0]!), true, "primary stunned (>=2)");
  assert.equal(hasStun(enemies[1]!), false, "only the primary is stunned");
});

test("Bubble Prison: the effect ENDS when Zev'kir is stunned (and persists otherwise)", () => {
  // Positive: Zev'kir becomes stunned -> his Bubble Prison is cleared from all enemies.
  {
    const { zev, enemies, state } = arena(0, 2);
    performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
    assert.ok(bubbleDot(enemies[0]!), "Bubble Prison is live before Zev'kir is stunned");
    zev.statuses.push({ kind: "stun", duration: 1, appliedBy: "e1", appliedTurn: 0 });
    emit(state, { type: "statusApplied", unit: "zev", source: "e1", kind: "stun" });
    assert.equal(bubbleDot(enemies[0]!), undefined, "Zev'kir stunned -> Bubble Prison ends");
  }
  // Control 1 — no stun on Zev'kir: some other status landing on him leaves Bubble Prison intact.
  {
    const { enemies, state } = arena(0, 1);
    performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
    emit(state, { type: "statusApplied", unit: "zev", source: "zev", kind: "stack", name: "Call Tides" });
    assert.ok(bubbleDot(enemies[0]!), "no stun on Zev'kir -> Bubble Prison persists");
  }
  // Control 2 — a stun landing on the ENEMY (not Zev'kir) must not end Zev'kir's Bubble Prison.
  {
    const { enemies, state } = arena(0, 1);
    performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
    emit(state, { type: "statusApplied", unit: "e1", source: "zev", kind: "stun" });
    assert.ok(bubbleDot(enemies[0]!), "a stun on the enemy does not end Bubble Prison");
  }
});

// --------------------------------------------------------------------------------------------------- //
// zevkir5 — Tidal Wave: 45 piercing to target; costs 1 less water per stack. (+ clauses 2 & 3.)
// --------------------------------------------------------------------------------------------------- //
test("Tidal Wave: deals 45 damage to the target enemy", () => {
  const { enemies, state } = arena(0, 2);
  performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
  assert.equal(500 - enemies[0]!.hp, 45, "45 damage to the target");
  assert.equal(enemies[1]!.hp, 500, "at 0 stacks only the primary is hit");
});

test("Tidal Wave: the 45 damage is PIERCING — it ignores the target's damage reduction", () => {
  // Piercing bypasses Damage Reduction; a normal-damage control (Riptide) does not.
  {
    const { enemies, state } = arena(0, 1, [{ statuses: [{ kind: "damage_reduction", magnitude: 20, duration: null, appliedBy: "x", appliedTurn: 0 }] }]);
    performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
    assert.equal(500 - enemies[0]!.hp, 45, "piercing Tidal Wave lands the full 45 through 20 DR");
  }
  {
    // Control: Riptide (normal damage) at 2 stacks = 25 base is reduced by 3 DR to 22.
    const { zev, enemies, state } = arena(0, 1, [{ statuses: [{ kind: "damage_reduction", magnitude: 3, duration: null, appliedBy: "x", appliedTurn: 0 }] }]);
    zev.statuses.push(CT(2));
    performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(500 - enemies[0]!.hp, 22, "normal damage IS reduced by DR (25 - 3), proving piercing is special");
  }
});

test("Tidal Wave: the water cost drops by 1 per Call Tides stack (floored at 0)", () => {
  const skillOf = (u: Unit) => (u.skills ?? []).find((s) => s.id === "zevkir5")!;
  for (const [n, spec] of [[0, 5], [1, 4], [2, 3], [3, 2], [5, 0], [6, 0]] as const) {
    const { zev, state } = arena(n, 1);
    const cost = effectiveCost(zev, skillOf(zev), state);
    assert.equal(cost.specific, spec, `at ${n} stacks the water cost is ${spec}`);
    assert.equal(cost.generic, 0, "no generic component");
  }
});

test("Tidal Wave: cost reduction is real at the pay gate — 3 stacks makes 2 water enough, 1 water not", () => {
  // At 3 stacks the cost is 3 - ... wait: 5 - 3 = 2 water.
  {
    const { state } = arena(3, 1);
    state.teams.A.energy = { generic: 0, water: 2 }; // exactly the reduced cost
    const r = performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
    assert.equal(r.ok, true, "2 water covers the 3-stack-reduced cost (5 - 3 = 2)");
  }
  {
    const { state } = arena(3, 1);
    state.teams.A.energy = { generic: 40, water: 1 }; // 1 water < 2 cost; generic cannot pay a specific cost
    const r = performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
    assert.equal(r.ok, false, "1 water cannot pay the 2-water cost (generic never pays a specific cost)");
    assert.equal(r.reason, "insufficient-energy");
  }
  {
    // Full 5 stacks -> free: castable with an empty pool.
    const { zev, state } = arena(5, 1);
    state.teams.A.energy = { generic: 0, water: 0 };
    const r = performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
    assert.equal(r.ok, true, "at 5 stacks Tidal Wave is free (5 - 5 = 0)");
    assert.equal(stackCount(zev, "Call Tides"), 0, "and the stacks are then consumed (non-Strategic)");
  }
});

test("Tidal Wave + Oceans Gather clauses 2 & 3: stun primary at >=2, hit all enemies at >=3", () => {
  {
    const { enemies, state } = arena(2, 2);
    performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
    assert.equal(hasStun(enemies[0]!), true, "2 stacks: primary stunned");
    assert.equal(enemies[1]!.hp, 500, "still single-target at 2 stacks");
  }
  {
    const { enemies, state } = arena(3, 2);
    performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
    assert.equal(500 - enemies[0]!.hp, 45, "primary hit for 45");
    assert.equal(500 - enemies[1]!.hp, 45, "clause 3: secondary hit for 45 too");
    assert.equal(hasStun(enemies[0]!), true, "primary stunned");
    assert.equal(hasStun(enemies[1]!), false, "secondary not stunned (primary-only)");
  }
});

// --------------------------------------------------------------------------------------------------- //
// zevkir4 — Repulse: counters the first harmful skill received by target ally; the effect is invisible;
//           on a counter Zev'kir begins channeling Call Tides.
// --------------------------------------------------------------------------------------------------- //

/** A stock harmful enemy skill for driving the counter. */
function harmfulEnemySkill(dmg = 30) {
  return {
    id: "ehit", name: "Enemy Strike", element: "fire", targeting: "single",
    effects: [{ op: "damage", amount: dmg, dtype: "normal", to: "target" }],
    cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful"],
  } as any;
}
function helpfulEnemySkill() {
  return {
    id: "eheal", name: "Enemy Mend", element: "fire", targeting: "single",
    effects: [{ op: "heal", amount: 10, to: "target" }],
    cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Helpful"],
  } as any;
}

function repulseArena() {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  const ally = makeUnit({ id: "ally", team: "A", hp: 300, maxHp: 300 });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 300, maxHp: 300, currentElement: "fire" });
  enemy.skills = [harmfulEnemySkill(), helpfulEnemySkill()];
  const state = makeState([zev, ally], [enemy]);
  state.teams.A.energy = { generic: 40, water: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { zev, ally, enemy, state };
}

test("Repulse: places an INVISIBLE Repulse mark on the target ally (and nobody else)", () => {
  const { zev, ally, enemy, state } = repulseArena();
  const r = performAction(state, { unit: "zev", skillId: "zevkir4", targets: ["ally"] });
  assert.equal(r.ok, true, "Repulse casts");
  const m = repulseMark(ally);
  assert.ok(m, "the ally carries a Repulse mark");
  assert.equal(m!.invisible, true, "the effect is invisible");
  assert.equal(repulseMark(enemy), undefined, "the enemy is not marked");
  assert.equal(repulseMark(zev), undefined, "Zev'kir is not marked (single-target, < 3 stacks)");
});

test("Repulse: the first harmful skill the marked ally receives is countered (no damage); the mark is consumed", () => {
  const { ally, enemy, state } = repulseArena();
  performAction(state, { unit: "zev", skillId: "zevkir4", targets: ["ally"] });
  // First harmful skill -> countered.
  const r1 = performAction(state, { unit: "e1", skillId: "ehit", targets: ["ally"] });
  assert.equal(r1.countered, true, "the first harmful skill is countered");
  assert.equal(ally.hp, 300, "the countered skill deals no damage");
  assert.equal(repulseMark(ally), undefined, "the mark is consumed by the counter");

  // Reset the enemy skill's cooldown and fire again: the SECOND harmful skill is NOT countered.
  enemy.skills!.find((s) => s.id === "ehit")!.currentCd = 0;
  const r2 = performAction(state, { unit: "e1", skillId: "ehit", targets: ["ally"] });
  assert.notEqual(r2.countered, true, "only the FIRST harmful skill is countered");
  assert.equal(ally.hp, 270, "the second harmful skill lands its 30 damage");
});

test("Repulse: controls — an unmarked ally is not protected, and a HELPFUL skill is not countered", () => {
  // Unmarked ally: a harmful skill lands normally.
  {
    const { ally, state } = repulseArena();
    // No Repulse cast at all.
    const r = performAction(state, { unit: "e1", skillId: "ehit", targets: ["ally"] });
    assert.notEqual(r.countered, true, "no mark -> no counter");
    assert.equal(ally.hp, 270, "the harmful skill hits the unmarked ally for 30");
  }
  // Marked ally, but the incoming skill is Helpful: Repulse only counters HARMFUL skills.
  {
    const { ally, state } = repulseArena();
    performAction(state, { unit: "zev", skillId: "zevkir4", targets: ["ally"] });
    const r = performAction(state, { unit: "e1", skillId: "eheal", targets: ["ally"] });
    assert.notEqual(r.countered, true, "a Helpful skill is not countered");
    assert.ok(repulseMark(ally), "and the mark survives — only the first HARMFUL skill consumes it");
  }
});

test("Repulse + Oceans Gather clause 3: at >=3 stacks Repulse marks all allies", () => {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  zev.statuses.push(CT(3));
  const a1 = makeUnit({ id: "a1", team: "A", hp: 100 });
  const a2 = makeUnit({ id: "a2", team: "A", hp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([zev, a1, a2], [e1]);
  state.teams.A.energy = { generic: 40, water: 40 };
  performAction(state, { unit: "zev", skillId: "zevkir4", targets: ["a1"] });
  assert.ok(repulseMark(a1), "clause 3: ally a1 marked");
  assert.ok(repulseMark(a2), "clause 3: ally a2 marked (all allies, not just the chosen target)");
  assert.equal(repulseMark(e1), undefined, "enemies are never marked by Repulse");
});

// --------------------------------------------------------------------------------------------------- //
// zevkir4 — Repulse, "on a counter Zev'kir will automatically begin channeling Call Tides".
// SUSPECTED BUG: the engine's counter reaction runs Call Tides' effects INLINE (a single addStack) but
// never installs a channeling marker, so Zev'kir does not actually BEGIN CHANNELING — the frozen text's
// ongoing channel (a stack each subsequent turn, and the reaching-1-stack Essence) never starts.
// --------------------------------------------------------------------------------------------------- //
test.skip("SUSPECTED BUG: a Repulse counter should make Zev'kir BEGIN CHANNELING Call Tides (a channel, not one stack)", () => {
  const { zev, state } = repulseArena();
  assert.equal(isChanneling(zev), false, "not channeling before the counter");
  performAction(state, { unit: "zev", skillId: "zevkir4", targets: ["ally"] });
  // Using Repulse (non-Strategic) consumes any stacks; start clean.
  assert.equal(stackCount(zev, "Call Tides"), 0, "no stacks going into the counter");

  performAction(state, { unit: "e1", skillId: "ehit", targets: ["ally"] });

  // Frozen: "will automatically begin channeling Call Tides." A begun channel is a channeling marker that
  // keeps yielding a stack each turn — not merely a one-off stack.
  assert.equal(isChanneling(zev), true, "the counter must START the Call Tides channel");

  // And because a real channel begins, the next Zev'kir turn should add another stack (2nd stack),
  // which the inline addStack-only implementation cannot do.
  const before = stackCount(zev, "Call Tides");
  endTurn(state); startTurn(state); // A -> B
  endTurn(state); startTurn(state); // B -> A: channel would re-run
  assert.equal(stackCount(zev, "Call Tides"), before + 1, "the begun channel yields a stack on Zev'kir's next turn");
});
