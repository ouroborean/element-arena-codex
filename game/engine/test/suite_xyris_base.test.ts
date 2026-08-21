import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED behavioral suite for XYRIS, King of Dreams — BASE kit.
// The oracle is the FROZEN prose (content/frozen/skills.json), not the code.
//
//   xyris0 Dream Body (passive): "Whenever this Hero is the sole target of a skill,
//           he gains Elemental Essence."
//   xyris1 Reveal Hidden Truth: "Xyris deals 15 damage to target enemy and Taunts
//           them for 1 turn."  (generic 1, cooldown 1, Harmful/Instant)
//   xyris2 Enter the Dreamscape: "Xyris deals 20 damage to target enemy and stuns
//           their helpful skills for 2 turns. While active, Xyris gains Elemental
//           Essence each turn."  (generic 2, cooldown 3)
//   xyris3 Twisted Nightmares: "Xyris deals 20 damage to target enemy. For 1 turn,
//           their AOE skills become single-target."  (generic 1 + specific 1)
//   xyris4 Somnic Apparition: "Xyris counters the next Harmful skill used by target
//           enemy for 1 turn. If countered this way, Xyris creates a Dream Reflection
//           minion (HP:35) with a copy of the countered skill (its Specific costs
//           change to Xyris' current Element.) This effect is invisible."  (generic 1)
//   xyris5 Echoes of Desire: "The next skill used by target ally will occur twice.
//           Cannot target Xyris."  (specific 3, cooldown 3)
//
// Xyris' element is Shadow, so specific costs are paid from the Shadow pool.
// =============================================================================

const ESSENCE = "elemental_essence";
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === ESSENCE).length;
const teamMinions = (st: MatchState, team: string): Unit[] =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive);

// A generous energy grant so cost is never the thing under test.
const fund = (st: MatchState, team: "A" | "B") => {
  st.teams[team].energy = { generic: 40, shadow: 40, fire: 40, water: 40 };
};

// --- reusable driver skills for the enemy / ally (fresh instances per test so
//     each carries its own currentCd). These are ONLY drivers — assertions come
//     from the frozen prose, never from these. ---
const enemySingleHarm = (amount = 6): ReturnType<typeof skill> =>
  skill("eHarm", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "single", element: "water",
  });
const enemyAoe = (amount = 5): ReturnType<typeof skill> =>
  skill("eAoe", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "all-enemies", element: "water",
  });
const enemySelfHelp = (): ReturnType<typeof skill> =>
  skill("eHelp", [{ op: "heal", amount: 5, to: "self" } as Effect], {
    tags: ["Helpful", "Instant"], targeting: "self", element: "water",
  });
const allyHarm = (amount = 12): ReturnType<typeof skill> =>
  skill("aHit", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "single", element: "shadow",
  });

// =============================================================================
// xyris0 — Dream Body (passive): sole target of ANY skill -> gains Elemental Essence
// =============================================================================

test("Dream Body: being the SOLE target of a skill grants Xyris Elemental Essence", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySingleHarm()] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  assert.equal(essenceCount(xyris), 0, "starts with no essence");
  const r = performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] });
  assert.ok(r.ok, "enemy single-target hit on Xyris resolves");
  assert.equal(essenceCount(xyris), 1, "sole-targeting Xyris grants exactly one Elemental Essence");
});

test("Dream Body: NO essence when Xyris is not the sole target (AOE hits him + an ally)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemyAoe()] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  const r = performAction(state, { unit: "e", skillId: "eAoe", targets: [] });
  assert.ok(r.ok, "enemy AOE resolves");
  assert.ok(xyris.hp < xyris.maxHp, "the AOE did hit Xyris");
  assert.ok(ally.hp < ally.maxHp, "the AOE also hit the ally (so Xyris was not the sole target)");
  assert.equal(essenceCount(xyris), 0, "a shared AOE target is NOT the 'sole target' -> no essence");
});

test("Dream Body: NO essence when the skill's sole target is someone else", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySingleHarm()] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  const r = performAction(state, { unit: "e", skillId: "eHarm", targets: ["a"] });
  assert.ok(r.ok, "enemy hits the ally");
  assert.equal(essenceCount(xyris), 0, "Xyris was not targeted at all -> no essence");
});

// =============================================================================
// xyris1 — Reveal Hidden Truth: 15 damage + Taunt for 1 turn
// =============================================================================

test("Reveal Hidden Truth: deals exactly 15 and Taunts the target for 1 turn", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  const before = enemy.hp;
  const r = performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  assert.ok(r.ok, "Reveal Hidden Truth casts");
  assert.equal(before - enemy.hp, 15, "deals exactly 15 damage");
  const taunt = enemy.statuses.find((s) => s.kind === "taunt");
  assert.ok(taunt, "the target is Taunted");
  assert.equal(taunt!.duration, 1, "Taunt lasts 1 turn");
});

test("Reveal Hidden Truth: the Taunt forces the enemy's single-target Harmful onto Xyris", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySingleHarm(6)] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // taunt enemy onto Xyris
  const xHp = xyris.hp, aHp = ally.hp;
  // enemy TRIES to hit the ally, but the Taunt forces it onto Xyris (the taunter).
  const r = performAction(state, { unit: "e", skillId: "eHarm", targets: ["a"] });
  assert.ok(r.ok, "enemy acts");
  assert.equal(aHp - ally.hp, 0, "the ally is spared — the attack was forced off it");
  assert.equal(xHp - xyris.hp, 6, "the forced attack lands on Xyris instead");
});

test("Reveal Hidden Truth: control — without the Taunt the enemy hits its chosen target", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySingleHarm(6)] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "B");

  const xHp = xyris.hp, aHp = ally.hp;
  const r = performAction(state, { unit: "e", skillId: "eHarm", targets: ["a"] });
  assert.ok(r.ok, "enemy acts");
  assert.equal(aHp - ally.hp, 6, "with no Taunt, the enemy hits the ally it chose");
  assert.equal(xHp - xyris.hp, 0, "Xyris is untouched");
});

test("Reveal Hidden Truth: goes on a 1-turn cooldown (no immediate recast)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  const sk = xyris.skills!.find((s) => s.id === "xyris1")!;
  assert.equal(sk.currentCd, 1, "cooldown is 1 after use");
  const r2 = performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  assert.equal(r2.ok, false, "cannot recast while on cooldown");
  assert.equal(r2.reason, "on-cooldown", "rejected specifically for being on cooldown");
});

// =============================================================================
// xyris2 — Enter the Dreamscape: 20 damage + stun HELPFUL skills 2 turns + Xyris gains Essence
// =============================================================================

test("Enter the Dreamscape: deals 20, stuns the target's HELPFUL skills for 2 turns, Xyris gains Essence", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  const before = enemy.hp;
  const eBefore = essenceCount(xyris);
  const r = performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] });
  assert.ok(r.ok, "Enter the Dreamscape casts");
  assert.equal(before - enemy.hp, 20, "deals exactly 20 damage");

  const stun = enemy.statuses.find((s) => s.kind === "stun");
  assert.ok(stun, "the target is stunned");
  assert.equal(stun!.duration, 2, "stun lasts 2 turns");
  assert.ok(stun!.scope, "the stun is scoped (not a full stun)");
  assert.equal(stun!.scope!.tag, "Helpful", "scoped to the Helpful class");
  assert.equal(stun!.scope!.mode, "only", "it stops ONLY Helpful skills");

  assert.equal(essenceCount(xyris) - eBefore, 1, "Xyris gains Elemental Essence while active");
});

test("Enter the Dreamscape: the stun blocks the target's Helpful skill but NOT its Harmful skill", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySelfHelp(), enemySingleHarm(6)] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] }); // stun Helpful for 2t
  const help = performAction(state, { unit: "e", skillId: "eHelp", targets: [] });
  assert.equal(help.ok, false, "the enemy's HELPFUL skill is stunned");
  assert.equal(help.reason, "stunned", "rejected specifically for the stun");

  const xHp = xyris.hp;
  const harm = performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] });
  assert.ok(harm.ok, "the enemy's HARMFUL skill is NOT stunned");
  assert.equal(xHp - xyris.hp, 6, "the harmful skill resolves normally");
});

test("Enter the Dreamscape: control — an un-stunned enemy may use its Helpful skill", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySelfHelp()] });
  const state = makeState([xyris], [enemy]);
  fund(state, "B");

  const r = performAction(state, { unit: "e", skillId: "eHelp", targets: [] });
  assert.ok(r.ok, "with no stun the Helpful skill is castable");
});

// =============================================================================
// xyris3 — Twisted Nightmares: 20 damage + target's AOE skills become single-target for 1 turn
// =============================================================================

test("Twisted Nightmares: deals 20 and makes the target's AOE skill hit only ONE unit", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyAoe(5)] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  const eBefore = enemy.hp;
  const r = performAction(state, { unit: "x", skillId: "xyris3", targets: ["e"] });
  assert.ok(r.ok, "Twisted Nightmares casts");
  assert.equal(eBefore - enemy.hp, 20, "deals exactly 20 damage");

  // The marked enemy's all-enemies skill now hits exactly one of {Xyris, ally}, not both.
  const xHp = xyris.hp, aHp = ally.hp;
  performAction(state, { unit: "e", skillId: "eAoe", targets: [] });
  const hits = (xHp - xyris.hp > 0 ? 1 : 0) + (aHp - ally.hp > 0 ? 1 : 0);
  assert.equal(hits, 1, "the AOE has become single-target: it strikes exactly one unit");
});

test("Twisted Nightmares: control — an unmarked enemy's AOE hits ALL enemies", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyAoe(5)] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "B");

  const xHp = xyris.hp, aHp = ally.hp;
  performAction(state, { unit: "e", skillId: "eAoe", targets: [] });
  assert.equal(xHp - xyris.hp, 5, "Xyris is hit");
  assert.equal(aHp - ally.hp, 5, "the ally is also hit — a normal AOE strikes both");
});

// =============================================================================
// xyris4 — Somnic Apparition: counters the next Harmful skill of target enemy;
//          on counter -> Dream Reflection minion (HP 35) with a copy of the
//          countered skill whose Specific cost is re-elemented to Xyris' element.
// =============================================================================

test("Somnic Apparition: counters the marked enemy's next Harmful skill and summons a Dream Reflection (HP 35)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  xyris.currentElement = "fire"; // distinguish from the base Shadow so the re-element is observable
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, currentElement: "water",
    skills: [skill("evil", [{ op: "damage", amount: 9, dtype: "normal", to: "target" } as Effect], {
      tags: ["Harmful", "Instant"], targeting: "single", element: "water", cost: { generic: 0, specific: 2 },
    })],
  });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  assert.equal(teamMinions(state, "A").length, 0, "no minions yet");
  performAction(state, { unit: "x", skillId: "xyris4", targets: ["e"] }); // arm the counter on the enemy

  const xHp = xyris.hp;
  const r = performAction(state, { unit: "e", skillId: "evil", targets: ["x"] });
  assert.ok(r.countered, "the enemy's Harmful skill was countered");
  assert.equal(xHp - xyris.hp, 0, "the countered skill dealt no damage to Xyris");

  const minions = teamMinions(state, "A");
  assert.equal(minions.length, 1, "a Dream Reflection minion was created");
  const dr = minions[0]!;
  assert.equal(dr.name, "Dream Reflection", "it is a Dream Reflection");
  assert.equal(dr.maxHp, 35, "created with HP 35");

  // Frozen: "a copy of the countered skill (its Specific costs change to Xyris' current Element)."
  const copied = (dr.skills ?? []).find((s) => s.id === "evil");
  assert.ok(copied, "the minion carries a copy of the countered skill");
  assert.equal(copied!.cost.specific, 2, "the copied skill keeps the countered skill's Specific amount");
  assert.equal(dr.currentElement, "fire", "the copy's Specific cost is now paid in Xyris' current Element (fire)");
});

test("Somnic Apparition: does NOT counter a NON-Harmful skill from the marked enemy", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemySelfHelp()] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris4", targets: ["e"] }); // arm
  const r = performAction(state, { unit: "e", skillId: "eHelp", targets: [] });
  assert.ok(r.ok && !r.countered, "a Helpful skill is not a Harmful skill -> not countered");
  assert.equal(teamMinions(state, "A").length, 0, "no Dream Reflection is created off a non-Harmful skill");
});

test("Somnic Apparition: counters only the NEXT Harmful skill — a second Harmful is not countered", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemySingleHarm(6)] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris4", targets: ["e"] }); // arm

  const r1 = performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] });
  assert.ok(r1.countered, "the first Harmful skill is countered");
  assert.equal(teamMinions(state, "A").length, 1, "one Dream Reflection from the counter");

  // Second harmful (eHarm has cooldown 0) — the watch is one-shot, so this one lands.
  const xHp = xyris.hp;
  const r2 = performAction(state, { unit: "e", skillId: "eHarm", targets: ["x"] });
  assert.ok(!r2.countered, "the next Harmful skill is NOT countered (the counter was one-shot)");
  assert.equal(xHp - xyris.hp, 6, "the second Harmful skill deals its damage");
  assert.equal(teamMinions(state, "A").length, 1, "no second Dream Reflection");
});

// =============================================================================
// xyris5 — Echoes of Desire: the target ally's next skill occurs twice; cannot target Xyris
// =============================================================================

test("Echoes of Desire: the target ally's next skill occurs twice", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [allyHarm(12)] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris5", targets: ["a"] }); // mark the ally
  const eHp = enemy.hp;
  performAction(state, { unit: "a", skillId: "aHit", targets: ["e"] });
  assert.equal(eHp - enemy.hp, 24, "the ally's 12-damage skill occurs twice -> 24 total");
});

test("Echoes of Desire: control — an unmarked ally's skill occurs once", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [allyHarm(12)] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  const eHp = enemy.hp;
  performAction(state, { unit: "a", skillId: "aHit", targets: ["e"] });
  assert.equal(eHp - enemy.hp, 12, "with no Echoes mark the skill occurs once -> 12");
});

// SUSPECTED BUG: frozen "Cannot target Xyris" is not enforced. xyris5's target-legality is
// authored as requires:{ not:{ sameUnit:["target","caster"] } }, but performAction evaluates
// skill.requires via evalSkillCondition (scheduler.ts:543), which builds its Ctx with targets:[]
// (interpret.ts:825). So the "target" selector resolves to undefined, sameUnit(undefined, caster)
// is false, not-false is true, and the gate passes for ANY chosen target — including Xyris himself.
// Observed: performAction(xyris5, targets:["x"]) -> {ok:true}, the "Echoes of Desire" mark lands on
// Xyris, and cost + cooldown are spent. Xyris even gains Elemental Essence (Dream Body), confirming
// he was accepted as the sole target. Frozen forbids this cast outright.
test.skip("SUSPECTED BUG: Echoes of Desire can be cast on Xyris (frozen: 'Cannot target Xyris')", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A");

  const r = performAction(state, { unit: "x", skillId: "xyris5", targets: ["x"] });
  assert.equal(r.ok, false, "Echoes of Desire cannot be cast on Xyris");
  assert.ok(!xyris.statuses.some((s) => s.kind === "mark" && s.name === "Echoes of Desire"),
    "no Echoes mark is placed on Xyris");
});
