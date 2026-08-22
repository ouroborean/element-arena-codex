import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startTurn, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED behavioral suite for XYRIS' AUGMENTS.
// The ORACLE is the FROZEN augment prose (content/frozen/augments.json), NOT the code:
//
//   xyris1 Painful Memories:       "Reveal Hidden Truth lowers its targets damage
//                                   dealt by 10 for 1 turn."
//   xyris2 Somnic Adaptation:      "Xyris gains 5 permanent Shield each time he gains
//                                   Elemental Essence."
//   xyris3 Return to the Dream:    "If Xyris has Elemental Essence when he uses Enter
//                                   the Dreamscape, its cooldown is set to 1."
//   xyris4 Neverending Nightmares: "Twisted Nightmares becomes permanent if used on an
//                                   enemy affected by Enter the Dreamscape."
//   xyris5 Twisted Replica:        "Dream Reflection minions are created with the
//                                   countered enemy's current HP."
//
// Base kit (frozen skills.json), used only to know what the augment MODIFIES:
//   xyris1 Reveal Hidden Truth: 15 dmg + Taunt 1t.
//   xyris2 Enter the Dreamscape: 20 dmg + stun Helpful 2t; Xyris gains Essence; base cd 3.
//   xyris3 Twisted Nightmares: 20 dmg; target's AOE -> single-target for 1t.
//   xyris4 Somnic Apparition: counter next Harmful; on counter -> Dream Reflection (HP 35).
//   xyris0 Dream Body (passive): sole target of a skill -> Xyris gains Elemental Essence.
// Xyris' element is Shadow, so specific costs pay from the Shadow pool.
// =============================================================================

const ESSENCE = "elemental_essence";
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === ESSENCE).length;
const teamMinions = (st: MatchState, team: string): Unit[] =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive);

const fund = (st: MatchState, team: "A" | "B") => {
  st.teams[team].energy = { generic: 40, shadow: 40, fire: 40, water: 40 };
};

// --- driver skills (ONLY drivers; assertions derive from frozen, never from these) ---
const enemyHit = (amount = 25): ReturnType<typeof skill> =>
  skill("eHit", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "single", element: "water", cooldown: 0,
  });
const enemyAoe = (amount = 6): ReturnType<typeof skill> =>
  skill("eAoe", [{ op: "damage", amount, dtype: "normal", to: "target" } as Effect], {
    tags: ["Harmful", "Instant"], targeting: "all-enemies", element: "water", cooldown: 0,
  });
// A NON-damaging single-target skill: sole-targets a unit (triggers Xyris' Dream Body when aimed at him)
// without consuming any Shield, so cumulative Shield is cleanly observable.
const enemyMarkSole = (): ReturnType<typeof skill> =>
  skill("eMark", [{ op: "applyStatus", to: "target", status: { kind: "mark", name: "probe", duration: 1 } } as Effect], {
    tags: ["Strategic", "Instant"], targeting: "single", element: "water", cooldown: 0,
  });

// One full A->B->A wrap: after it, a 1-turn status APPLIED BY team A on the cast turn
// has ticked at team A's next turn-end (tickDurationsForTeam gates on appliedTurn < turn).
function advanceFullRound(state: MatchState): void {
  endTurn(state);   // A -> B (turn++, no team-A tick: appliedTurn == turn)
  startTurn(state);
  endTurn(state);   // B -> A (turn++)
  startTurn(state);
  endTurn(state);   // A ends its next turn -> team-A statuses tick (appliedTurn < turn)
  startTurn(state);
}

// =============================================================================
// xyris1 — Painful Memories: "Reveal Hidden Truth lowers its targets damage dealt by 10 for 1 turn."
// =============================================================================

test("Painful Memories: after Reveal Hidden Truth, the target deals 10 less damage", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris1")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyHit(25)] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // 15 dmg + Taunt + -10 outgoing

  // The enemy now deals 10 less: base 25 -> 15 (the Taunt also forces it onto Xyris, so it lands on him).
  const xHp = xyris.hp;
  const r = performAction(state, { unit: "e", skillId: "eHit", targets: ["x"] });
  assert.ok(r.ok, "the enemy acts");
  assert.equal(xHp - xyris.hp, 15, "the target's 25-damage skill is lowered by 10 -> 15");
});

test("Painful Memories: the reduction is exactly -10 for 1 turn (magnitude + duration)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris1")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  const mod = enemy.statuses.find((s) => s.kind === "outgoing_damage_mod");
  assert.ok(mod, "Reveal Hidden Truth applies an outgoing-damage reduction to its target");
  assert.equal(mod!.magnitude, -10, "the reduction is exactly 10 (magnitude -10)");
  assert.equal(mod!.duration, 1, "it lasts exactly 1 turn");
});

test("Painful Memories: control — an enemy NOT hit by Reveal Hidden Truth deals full damage", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris1")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyHit(25)] });
  const state = makeState([xyris], [enemy]);
  fund(state, "B");

  // Augment present, but Reveal Hidden Truth was never used on this enemy -> no reduction.
  const xHp = xyris.hp;
  performAction(state, { unit: "e", skillId: "eHit", targets: ["x"] });
  assert.equal(xHp - xyris.hp, 25, "with no Reveal Hidden Truth mark, the enemy deals its full 25");
});

test("Painful Memories: the reduction expires after 1 turn (enemy deals full again)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris1")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyHit(25)] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] });
  advanceFullRound(state); // the 1-turn reduction (applied by team A) ticks off
  fund(state, "B");
  assert.ok(!enemy.statuses.some((s) => s.kind === "outgoing_damage_mod"), "the reduction has expired");

  const xHp = xyris.hp;
  performAction(state, { unit: "e", skillId: "eHit", targets: ["x"] });
  assert.equal(xHp - xyris.hp, 25, "after 1 turn the target is back to its full 25 damage");
});

// =============================================================================
// xyris2 — Somnic Adaptation: "Xyris gains 5 permanent Shield each time he gains Elemental Essence."
// =============================================================================

test("Somnic Adaptation: each Elemental Essence gain grants Xyris exactly 5 permanent Shield", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris2")!);
  // Drive a REAL essence gain: Dream Body gives Xyris essence when he is the sole target of a skill.
  // Use a non-damaging driver so the Shield we are measuring is never spent absorbing a hit.
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemyMarkSole()] });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  assert.equal(totalShield(xyris), 0, "starts with no shield");
  performAction(state, { unit: "e", skillId: "eMark", targets: ["x"] }); // sole-targets Xyris -> Dream Body essence
  assert.ok(essenceCount(xyris) >= 1, "Xyris gained Elemental Essence");
  assert.equal(totalShield(xyris), 5, "gaining Essence grants exactly 5 Shield");

  // "each time" — a second essence gain grants another 5. (Essence is a non-stacking flag, so the
  // count stays 1, but the second application is still a 'gain' and grants another Shield.)
  performAction(state, { unit: "e", skillId: "eMark", targets: ["x"] });
  assert.equal(totalShield(xyris), 10, "each further gain adds another 5 Shield");

  assert.ok(xyris.shields.every((s) => s.duration === null), "the granted Shield is permanent (no duration)");
});

test("Somnic Adaptation: control — no essence gain -> no Shield", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris2")!);
  const ally = makeUnit({ id: "a", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [enemyMarkSole()] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  // The skill's sole target is the ALLY, not Xyris -> Dream Body does not fire -> no essence, no Shield.
  performAction(state, { unit: "e", skillId: "eMark", targets: ["a"] });
  assert.equal(essenceCount(xyris), 0, "Xyris gained no essence (he was not the target)");
  assert.equal(totalShield(xyris), 0, "no essence gained -> no Shield granted");
});

test("Somnic Adaptation: does NOT fire when the essence lands on another unit", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris2")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([xyris], [enemy]);

  // essence lands on the ENEMY: the trigger gates on the recipient being Xyris -> no Shield for Xyris.
  emit(state, { type: "statusApplied", unit: "e", source: "e", kind: ESSENCE });
  assert.equal(totalShield(xyris), 0, "an enemy gaining essence grants Xyris nothing");
});

// =============================================================================
// xyris3 — Return to the Dream: "If Xyris has Elemental Essence when he uses Enter
//          the Dreamscape, its cooldown is set to 1."  (base cooldown 3)
// =============================================================================

const dreamscapeCd = (u: Unit): number => u.skills!.find((s) => s.id === "xyris2")!.currentCd;

// SUSPECTED BUG: frozen says "its cooldown is set to 1", but the engine leaves it at the base 3.
// The augment realizes "set to 1" with an in-cast `modifyCooldown delta:-2` on Enter the Dreamscape.
// That op writes skill.currentCd during runEffects (scheduler.ts:611); but immediately AFTER effects run,
// performAction overwrites it: `skill.currentCd = effectiveCooldown(caster, skill)` (scheduler.ts:612),
// and effectiveCooldown folds in ONLY `cooldown_mod` statuses (scheduler.ts:398-402) — it does NOT fold
// the pending self-cd delta. So the mid-cast reduction is clobbered and currentCd resolves to 3+0 = 3.
// This is exactly the Sera "Eyes of Vengeance" precedent the authored note flagged. Observed: currentCd == 3.
test("Return to the Dream: with Elemental Essence, Enter the Dreamscape's cooldown is set to 1", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris3")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  // Pre-existing essence (the check runs at use time, BEFORE the skill grants its own essence).
  xyris.statuses.push(status(ESSENCE));
  const r = performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] });
  assert.ok(r.ok, "Enter the Dreamscape casts");
  assert.equal(dreamscapeCd(xyris), 1, "holding Essence at cast time sets the cooldown to 1 (not the base 3)");
});

test("Return to the Dream: control — WITHOUT Elemental Essence, the cooldown is the base 3", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris3")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  assert.equal(essenceCount(xyris), 0, "Xyris holds no essence at cast time");
  const r = performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] });
  assert.ok(r.ok, "Enter the Dreamscape casts");
  // The skill grants Xyris essence during the cast, but the condition is checked FIRST -> no reduction.
  assert.equal(dreamscapeCd(xyris), 3, "with no pre-existing essence, the cooldown stays at the base 3");
});

// =============================================================================
// xyris4 — Neverending Nightmares: "Twisted Nightmares becomes permanent if used on an
//          enemy affected by Enter the Dreamscape."
// =============================================================================

const twistedMark = (u: Unit) => u.statuses.find((s) => s.kind === "mark" && s.name === "Twisted Nightmares");

test("Neverending Nightmares: on an enemy under Enter the Dreamscape, the effect is permanent", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris4")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] }); // Enter the Dreamscape -> enemy affected
  performAction(state, { unit: "x", skillId: "xyris3", targets: ["e"] }); // Twisted Nightmares on the affected enemy

  const mark = twistedMark(enemy);
  assert.ok(mark, "the Twisted Nightmares mark lands");
  assert.equal(mark!.duration, null, "the mark is PERMANENT (no duration) against an Enter-the-Dreamscape target");
});

test("Neverending Nightmares: control — on an UNAFFECTED enemy the effect lasts only 1 turn", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris4")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([xyris], [enemy]);
  fund(state, "A");

  // No Enter the Dreamscape first -> enemy is not affected -> base 1-turn behavior.
  performAction(state, { unit: "x", skillId: "xyris3", targets: ["e"] });
  const mark = twistedMark(enemy);
  assert.ok(mark, "the Twisted Nightmares mark lands");
  assert.equal(mark!.duration, 1, "against an unaffected enemy the mark is the base 1 turn");
});

test("Neverending Nightmares: the permanent AOE->single survives a full round", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris4")!);
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyAoe(6)] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris2", targets: ["e"] }); // affect the enemy
  performAction(state, { unit: "x", skillId: "xyris3", targets: ["e"] }); // permanent Twisted Nightmares
  advanceFullRound(state); // a base 1-turn version would have expired here
  fund(state, "B");

  // The enemy's AOE is STILL single-target after the round: it strikes exactly one of {Xyris, ally}.
  const xHp = xyris.hp, aHp = ally.hp;
  performAction(state, { unit: "e", skillId: "eAoe", targets: [] });
  const hits = (xHp - xyris.hp > 0 ? 1 : 0) + (aHp - ally.hp > 0 ? 1 : 0);
  assert.equal(hits, 1, "AOE->single is still in force a round later (permanent)");
});

test("Neverending Nightmares: control — the 1-turn AOE->single reverts after a round", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris4")!);
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [enemyAoe(6)] });
  const state = makeState([xyris, ally], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris3", targets: ["e"] }); // unaffected enemy -> 1-turn only
  advanceFullRound(state);
  fund(state, "B");

  const xHp = xyris.hp, aHp = ally.hp;
  performAction(state, { unit: "e", skillId: "eAoe", targets: [] });
  const hits = (xHp - xyris.hp > 0 ? 1 : 0) + (aHp - ally.hp > 0 ? 1 : 0);
  assert.equal(hits, 2, "after 1 turn the AOE reverts to hitting ALL enemies");
});

// =============================================================================
// xyris5 — Twisted Replica: "Dream Reflection minions are created with the countered
//          enemy's current HP."  (base: HP 35)
// =============================================================================

test("Twisted Replica: the Dream Reflection is created with the countered enemy's CURRENT HP", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris5")!);
  // Enemy at 70/100 current HP so the value is distinct from BOTH the base 35 and the enemy's max 100.
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero", hp: 70, maxHp: 100, currentElement: "water",
    skills: [skill("evil", [{ op: "damage", amount: 9, dtype: "normal", to: "target" } as Effect], {
      tags: ["Harmful", "Instant"], targeting: "single", element: "water", cost: { generic: 0, specific: 1 }, cooldown: 0,
    })],
  });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  performAction(state, { unit: "x", skillId: "xyris4", targets: ["e"] }); // arm Somnic Apparition on the enemy
  const r = performAction(state, { unit: "e", skillId: "evil", targets: ["x"] });
  assert.ok(r.countered, "the enemy's Harmful skill is countered");

  const minions = teamMinions(state, "A");
  assert.equal(minions.length, 1, "a Dream Reflection is created off the counter");
  const dr = minions[0]!;
  assert.equal(dr.name, "Dream Reflection", "it is a Dream Reflection");
  assert.equal(dr.hp, 70, "created with the countered enemy's CURRENT HP (70), not the base 35");
  assert.equal(dr.maxHp, 70, "its max HP is likewise the countered enemy's current HP");
  assert.notEqual(dr.maxHp, 35, "NOT the base 35");
  assert.notEqual(dr.maxHp, enemy.maxHp, "NOT the enemy's max HP");
});

test("Twisted Replica: the HP tracks the enemy's CURRENT HP at counter time (damaged enemy)", () => {
  const xyris = loadHero(heroById("xyris"), "A", "x");
  applyAugment(xyris, augmentById("xyris5")!);
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, currentElement: "water",
    skills: [skill("evil", [{ op: "damage", amount: 9, dtype: "normal", to: "target" } as Effect], {
      tags: ["Harmful", "Instant"], targeting: "single", element: "water", cost: { generic: 0, specific: 0 }, cooldown: 0,
    })],
  });
  const state = makeState([xyris], [enemy]);
  fund(state, "A"); fund(state, "B");

  // Chip the enemy down first so "current HP" is clearly neither max nor the base 35, then arm + counter.
  performAction(state, { unit: "x", skillId: "xyris1", targets: ["e"] }); // Reveal Hidden Truth: 15 dmg -> 85
  performAction(state, { unit: "x", skillId: "xyris4", targets: ["e"] }); // arm Somnic Apparition
  const hpAtCounter = enemy.hp;
  const r = performAction(state, { unit: "e", skillId: "evil", targets: ["x"] });
  assert.ok(r.countered, "the enemy's Harmful skill is countered");

  const dr = teamMinions(state, "A")[0]!;
  assert.equal(dr.hp, hpAtCounter, "the Dream Reflection mirrors the enemy's current HP at the moment of the counter");
});
