import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { performAction, startTurn, endTurn, effectiveCost } from "../src/scheduler.ts";
import { stackCount } from "../src/status.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import type { Unit } from "../src/types.ts";

// ===================================================================================================== //
// Adversarial, SPEC-DERIVED suite for Tidecaller Zev'kir's AUGMENTS.
// The FROZEN augment prose (content/frozen/augments.json) is the oracle for every assertion below:
//
//   zevkir1 "Atlantean Waters": "While Zev'kir is Channeling Call Tides, he heals 5 HP per turn and
//     ignores stuns."
//   zevkir2 "Airless Prison": "If Zev'kir has 2 or more stacks of Call Tides, Bubble Prison increases
//     affected enemy skill costs by 1 [Generic]. If he has 4 or more stacks, they are increased by 1
//     Energy of the target's Element instead."   ([65] = Generic energy; [2] = Water.)
//   zevkir3 "Piercing Tide": "If Zev'kir has 2 or more stacks of Call Tides, Riptide deals Piercing
//     damage. If he has 4 or more stacks, it deals Affliction damage instead."
//   zevkir4 "Storm Surge": "Tidal Wave deals 20 less damage, but its base cost is reduced by 2 Specific
//     energy."
//   zevkir5 "Arcane Barrier": "While Repulse is not on cooldown, Zev'kir gains 15 Shield that replenishes
//     at the start of his turn."
//
// Base kit the augments modify (frozen skills.json):
//   Call Tides (zevkir1, Channel, self) — begins Channeling; a stack each turn.
//   Riptide (zevkir2, Harmful/Instant) — 5 + 10 per Call Tides stack.
//   Bubble Prison (zevkir3, Harmful/Control) — 15/turn for 1+stacks turns; ends if Zev'kir stunned.
//   Repulse (zevkir4, Helpful/Instant, invisible, cooldown 3).
//   Tidal Wave (zevkir5, Harmful/Instant) — 45 PIERCING; costs 1 less Water per Call Tides stack.
//   Oceans Gather (zevkir0, passive) — 2 stacks: harmful skills stun primary 1 turn; 3 stacks: skills hit
//     ALL valid targets.  (These base clauses interact with the augment tests below.)
//
// Content (augments.generated.ts / roster.generated.ts) was read ONLY to drive: augment ids, which base
// skill each touches, costs, targeting, element = water, and status names. WHAT is asserted comes from the
// frozen prose above.
// ===================================================================================================== //

const CT = (n: number) => ({
  kind: "stack" as const, name: "Call Tides", magnitude: n, duration: null, appliedBy: "zev", appliedTurn: 0,
});
const isChanneling = (u: Unit) => u.statuses.some((s) => s.kind === "channeling" && s.name === "zevkir1");
const hasStunImmunity = (u: Unit) => u.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity");
const totalShield = (u: Unit) => u.shields.reduce((t, s) => t + s.amount, 0);
const barrierShields = (u: Unit) => u.shields.filter((s) => s.id === "Arcane Barrier");

/** Zev'kir on team A (with augment `augId` applied) + N enemies, preloaded with `stacks` Call Tides. */
function arena(augId: string, stacks: number, enemyCount = 2, enemyOpts: (Partial<Unit> & { shield?: number })[] = []) {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  applyAugment(zev, augmentById(augId)!);
  if (stacks > 0) zev.statuses.push(CT(stacks));
  const enemies: Unit[] = [];
  for (let i = 0; i < enemyCount; i++) {
    enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", hp: 500, maxHp: 500, currentElement: "fire", ...(enemyOpts[i] ?? {}) }));
  }
  const state = makeState([zev], enemies);
  state.teams.A.energy = { generic: 40, water: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { zev, enemies, state };
}

// =================================================================================================== //
// zevkir1 — Atlantean Waters: "While Channeling Call Tides, he heals 5 HP per turn and ignores stuns."
// =================================================================================================== //

test("Atlantean Waters: casting Call Tides begins the channel and heals Zev'kir 5 HP", () => {
  const { zev, state } = arena("zevkir1", 0, 1);
  zev.hp = 50; // wounded
  assert.equal(isChanneling(zev), false, "not channeling before the cast");
  const r = performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  assert.equal(r.ok, true, "Call Tides casts");
  assert.equal(isChanneling(zev), true, "the channel is now running");
  assert.equal(zev.hp, 55, "the channel's first tick heals 5 HP (50 -> 55)");
});

test("Atlantean Waters: the 5-HP heal recurs on each channel turn (a stack each turn is base; +5 HP is the augment)", () => {
  const { zev, state } = arena("zevkir1", 0, 1);
  zev.hp = 50;
  performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] }); // tick 1
  assert.equal(zev.hp, 55, "heal #1 on the cast turn");
  // Advance a full round back to Zev'kir's next turn; runChannels re-runs Call Tides (heal #2).
  endTurn(state); startTurn(state); // A -> B (channel does NOT tick on the enemy turn)
  assert.equal(zev.hp, 55, "no heal on the opponent's turn");
  endTurn(state); startTurn(state); // B -> A: channel re-runs
  assert.equal(zev.hp, 60, "heal #2 on Zev'kir's next channel turn (55 -> 60)");
});

test("Atlantean Waters: the per-turn heal does not overheal past max HP", () => {
  const { zev, state } = arena("zevkir1", 0, 1);
  zev.hp = 98; // maxHp 100
  performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  assert.equal(zev.hp, 100, "5-HP heal is capped at max HP (98 -> 100, not 103)");
});

test("Atlantean Waters: while Channeling, Zev'kir IGNORES stuns (a stun does not stop him from acting)", () => {
  // Positive: channeling -> Stun Immunity is live -> a stun landing on Zev'kir does not block his skills.
  {
    const { zev, state } = arena("zevkir1", 0, 1);
    performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
    assert.equal(hasStunImmunity(zev), true, "channeling grants the stun-ignoring state");
    zev.statuses.push({ kind: "stun", duration: 1, appliedBy: "e1", appliedTurn: 0 });
    const r = performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(r.ok, true, "the stun is ignored while Channeling — Riptide still resolves");
  }
  // Control: NOT channeling (no Call Tides cast) -> no stun-ignoring -> the same stun blocks the skill.
  {
    const { zev, state } = arena("zevkir1", 0, 1);
    assert.equal(hasStunImmunity(zev), false, "no channel -> no stun immunity");
    zev.statuses.push({ kind: "stun", duration: 1, appliedBy: "e1", appliedTurn: 0 });
    const r = performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
    assert.equal(r.ok, false, "outside the channel a stun blocks Zev'kir");
    assert.equal(r.reason, "stunned", "…specifically because he is stunned");
  }
});

test("Atlantean Waters: a stun cannot interrupt the Call Tides channel while it is running", () => {
  // 'ignores stuns' also keeps the channel alive: a stun that would normally break the channel does not.
  const { zev, state } = arena("zevkir1", 0, 1);
  performAction(state, { unit: "zev", skillId: "zevkir1", targets: ["zev"] });
  zev.statuses.push({ kind: "stun", duration: 5, appliedBy: "e1", appliedTurn: 0 });
  endTurn(state); startTurn(state); // A -> B
  endTurn(state); startTurn(state); // B -> A: runChannels would drop an interrupted channel
  assert.equal(isChanneling(zev), true, "the channel persists through the stun (stuns are ignored)");
  assert.equal(stackCount(zev, "Call Tides"), 2, "and it keeps yielding a stack each turn (1 -> 2)");
});

// =================================================================================================== //
// zevkir2 — Airless Prison: at >=2 stacks Bubble Prison raises affected-enemy costs by 1 Generic;
//           at >=4 stacks, by 1 Energy of the target's Element instead.
// =================================================================================================== //

/** A stock enemy skill of a known cost, for measuring the cost increase Bubble Prison imposes. */
const enemySkill = (generic: number, specific: number) =>
  skill("efoo", [{ op: "damage", amount: 1, to: "target" }], { element: "fire", cost: { generic, specific }, tags: ["Harmful"] });

test("Airless Prison: below 2 Call Tides stacks, Bubble Prison does NOT raise the enemy's costs", () => {
  const { enemies, state } = arena("zevkir2", 1, 1);
  const es = enemySkill(1, 0);
  assert.deepEqual(effectiveCost(enemies[0]!, es, state), { generic: 1, specific: 0 }, "baseline cost before");
  performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
  assert.deepEqual(effectiveCost(enemies[0]!, es, state), { generic: 1, specific: 0 },
    "at 1 stack (< 2) the augment adds no cost increase");
  assert.equal(enemies[0]!.statuses.some((s) => s.kind === "cost_mod"), false, "no cost_mod applied below the threshold");
});

test("Airless Prison: at 2-3 Call Tides stacks, Bubble Prison raises the imprisoned enemy's costs by 1 Generic", () => {
  const { enemies, state } = arena("zevkir2", 2, 2);
  const es = enemySkill(1, 0);
  performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
  // 'increases affected enemy skill costs by 1 [Generic]' — the imprisoned enemy pays +1 generic.
  assert.deepEqual(effectiveCost(enemies[0]!, es, state), { generic: 2, specific: 0 },
    "the imprisoned enemy's generic cost is raised by 1 (1 -> 2)");
  // 'affected enemy' — at 2 stacks Bubble Prison is still single-target (Oceans Gather all-targets is >=3),
  // so the OTHER enemy, untouched by Bubble Prison, keeps its baseline cost.
  assert.deepEqual(effectiveCost(enemies[1]!, es, state), { generic: 1, specific: 0 },
    "an enemy Bubble Prison did not affect is not made more expensive");
});

// SUSPECTED BUG: frozen says the >=4 tier increases costs "by 1 Energy of the target's Element" — the +1
// should fall on the enemy's SPECIFIC (element) cost. The engine applies a flat magnitude-1 `cost_mod` with
// no element dimension, which lands on Generic (0 -> 1) and leaves the element cost at 1 — so the enemy pays
// (Generic 1, Specific 1) instead of the intended (Generic 0, Specific 2). The >=4 tier is thus behaviorally
// identical to the >=2 tier (+1 Generic); the element denomination cannot be expressed.
test("Airless Prison >=4 raises the target's-ELEMENT (Specific) cost by 1, not Generic", () => {
  // Frozen: '...increased by 1 Energy of the target's Element instead.' The enemy's skill is priced in its
  // own element (Water here), so the +1 must fall on the SPECIFIC (element) cost, leaving Generic untouched.
  const { enemies, state } = arena("zevkir2", 4, 1);
  const es = enemySkill(0, 1); // costs 1 of the target's element
  performAction(state, { unit: "zev", skillId: "zevkir3", targets: ["e1"] });
  const cost = effectiveCost(enemies[0]!, es, state);
  assert.equal(cost.specific, 2, "the target's-element cost is raised by 1 (1 -> 2) at >=4 stacks");
  assert.equal(cost.generic, 0, "…and the Generic component is NOT the one raised at the >=4 tier");
});

// =================================================================================================== //
// zevkir3 — Piercing Tide: Riptide is Piercing at >=2 stacks, Affliction at >=4 stacks (else normal).
//   normal    -> reduced by Damage Reduction, absorbed by Shield
//   piercing  -> IGNORES Damage Reduction, absorbed by Shield
//   affliction-> IGNORES Damage Reduction AND Shield
// =================================================================================================== //

test("Piercing Tide: below 2 stacks Riptide is NORMAL damage (Damage Reduction still applies)", () => {
  // 1 stack: 5 + 10 = 15. With 5 Damage Reduction, normal damage is reduced to 10.
  const { enemies, state } = arena("zevkir3", 1, 1, [{ statuses: [{ kind: "damage_reduction", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }] }]);
  performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
  assert.equal(500 - enemies[0]!.hp, 10, "normal damage IS reduced by DR (15 - 5 = 10) below 2 stacks");
});

test("Piercing Tide: at 2-3 stacks Riptide is PIERCING — ignores DR but is still absorbed by Shield", () => {
  // 2 stacks: 5 + 20 = 25. Enemy has 5 DR and a 10 Shield.
  // Piercing ignores the 5 DR (so 25), the 10 Shield absorbs 10 -> 15 to HP.
  //   (normal would be 25-5=20, shield 10 -> 10 HP;  affliction would ignore shield too -> 25 HP.)
  const { enemies, state } = arena("zevkir3", 2, 1, [{
    shield: 10,
    statuses: [{ kind: "damage_reduction", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }],
  }]);
  performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
  assert.equal(500 - enemies[0]!.hp, 15, "piercing ignores DR (full 25) but the 10 Shield absorbs 10 -> 15 HP lost");
  assert.equal(totalShield(enemies[0]!), 0, "the shield was consumed by the (non-shield-bypassing) piercing hit");
});

test("Piercing Tide: at >=4 stacks Riptide is AFFLICTION — ignores DR AND Shield", () => {
  // 4 stacks: 5 + 40 = 45. Enemy has 5 DR and a 10 Shield. Affliction ignores both -> full 45 to HP,
  // and the shield is left untouched (that is what distinguishes affliction from piercing here).
  const { enemies, state } = arena("zevkir3", 4, 1, [{
    shield: 10,
    statuses: [{ kind: "damage_reduction", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }],
  }]);
  performAction(state, { unit: "zev", skillId: "zevkir2", targets: ["e1"] });
  assert.equal(500 - enemies[0]!.hp, 45, "affliction ignores DR and Shield -> full 45 to HP");
  assert.equal(totalShield(enemies[0]!), 10, "the shield is bypassed entirely (untouched), proving affliction (not piercing)");
});

// =================================================================================================== //
// zevkir4 — Storm Surge: "Tidal Wave deals 20 less damage, but its base cost is reduced by 2 Specific."
// =================================================================================================== //

test("Storm Surge: Tidal Wave deals 20 LESS damage (45 -> 25), still Piercing", () => {
  // Piercing preserved: the 25 lands in full through Damage Reduction.
  const { enemies, state } = arena("zevkir4", 0, 1, [{ statuses: [{ kind: "damage_reduction", magnitude: 8, duration: null, appliedBy: "x", appliedTurn: 0 }] }]);
  performAction(state, { unit: "zev", skillId: "zevkir5", targets: ["e1"] });
  assert.equal(500 - enemies[0]!.hp, 25, "Tidal Wave now deals 25 (was 45) — 20 less — and pierces the 8 DR");
});

test("Storm Surge: Tidal Wave's base Specific cost is reduced by 2 (5 -> 3)", () => {
  const { zev, state } = arena("zevkir4", 0, 1);
  const tw = zev.skills!.find((s) => s.id === "zevkir5")!;
  const cost = effectiveCost(zev, tw, state);
  assert.equal(cost.specific, 3, "base Specific cost is 5 - 2 = 3 at 0 stacks");
  assert.equal(cost.generic, 0, "no generic component");
});

// SUSPECTED BUG: Storm Surge lowers only Tidal Wave's BASE Specific cost (5 -> 3); the skill's own dynamic
// "costs 1 less Water per Call Tides stack" (base frozen text) is unmentioned and should persist. The
// augment is applied via a wholesale replaceSkill whose replacement omits the base skill's `costMods`, so
// the per-stack reduction is dropped entirely: the cost stays a flat 3 regardless of Call Tides stacks.
test("Storm Surge keeps Tidal Wave's per-stack Specific reduction (cost 1/0 at 2/3 stacks)", () => {
  // Frozen changes only the BASE cost by -2; Tidal Wave's own '1 less Specific per Call Tides stack' is
  // unchanged, so at 2 stacks the cost is 3 - 2 = 1, and at 3 stacks it is 0.
  {
    const { zev, state } = arena("zevkir4", 2, 1);
    const tw = zev.skills!.find((s) => s.id === "zevkir5")!;
    assert.equal(effectiveCost(zev, tw, state).specific, 1, "3 (reduced base) - 2 (two stacks) = 1 Water");
  }
  {
    const { zev, state } = arena("zevkir4", 3, 1);
    const tw = zev.skills!.find((s) => s.id === "zevkir5")!;
    assert.equal(effectiveCost(zev, tw, state).specific, 0, "3 (reduced base) - 3 (three stacks) = 0 Water");
  }
});

// =================================================================================================== //
// zevkir5 — Arcane Barrier: "While Repulse is not on cooldown, Zev'kir gains 15 Shield that replenishes
//           at the start of his turn."
// =================================================================================================== //

test("Arcane Barrier: with Repulse off cooldown, Zev'kir gains a 15 Shield at the start of his turn", () => {
  const { zev, state } = arena("zevkir5", 0, 1);
  zev.skills!.find((s) => s.id === "zevkir4")!.currentCd = 0; // Repulse ready
  assert.equal(totalShield(zev), 0, "no barrier before his turn starts");
  startTurn(state);
  assert.equal(totalShield(zev), 15, "his turn start grants a 15 Shield (Repulse is off cooldown)");
  assert.equal(barrierShields(zev).length, 1, "exactly one Arcane Barrier shield instance");
  assert.equal(barrierShields(zev)[0]!.amount, 15, "…of 15");
});

test("Arcane Barrier: when Repulse IS on cooldown, no barrier is granted", () => {
  const { zev, state } = arena("zevkir5", 0, 1);
  zev.skills!.find((s) => s.id === "zevkir4")!.currentCd = 3; // Repulse on cooldown
  startTurn(state);
  assert.equal(totalShield(zev), 0, "'while Repulse is not on cooldown' — on cooldown, no shield is granted");
});

test("Arcane Barrier: the barrier does not fire on the OPPONENT's turn start", () => {
  const { zev, state } = arena("zevkir5", 0, 1);
  zev.skills!.find((s) => s.id === "zevkir4")!.currentCd = 0;
  emit(state, { type: "turnStart", team: "B" }); // an enemy turn start
  assert.equal(totalShield(zev), 0, "the barrier replenishes at the start of HIS turn, not the enemy's");
});

// SUSPECTED BUG: "15 Shield that replenishes at the start of his turn" means the barrier is topped back up
// to 15 each turn (a refresh, capped at 15) — not a fresh 15 added on top of the old one. The custom
// `replenishShieldWhileSkillReady` calls addShield each turn without first removing the prior Arcane Barrier
// shield, so the (duration-null, never-expiring) barrier accumulates: 15 -> 30 -> 45 ... over successive turns.
test("Arcane Barrier replenishes to a capped 15 each turn (does not stack to 30)", () => {
  // 'gains 15 Shield that replenishes' — each turn tops the barrier back to 15; it must not stack to 30, 45...
  const { zev, state } = arena("zevkir5", 0, 1);
  zev.skills!.find((s) => s.id === "zevkir4")!.currentCd = 0;
  startTurn(state);
  assert.equal(totalShield(zev), 15, "first turn: 15");
  endTurn(state); startTurn(state); // A -> B
  endTurn(state); startTurn(state); // B -> A: replenish again
  assert.equal(totalShield(zev), 15, "still 15 after a second turn — replenished, not doubled to 30");
});
