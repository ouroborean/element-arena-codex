import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { performAction, effectiveCost, startTurn, endTurn } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { redactState } from "../src/visibility.ts";
import { stackCount } from "../src/status.ts";
import { totalShield } from "../src/damage.ts";
import type { Unit } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";

// =============================================================================
// Adversarial, spec-derived behavioral suite for SERA — AUGMENTS.
// Oracle = the FROZEN prose (content/frozen/augments.json + the frozen BASE skill
// descriptions/costs in content/frozen/skills.json). Authored/generated content is read
// only to learn how to drive (augment ids, which base skill each touches, status names).
//
//   sera1 Vengeful Tempest   — "Synthetic Skyblade deals 5 additional base damage, costs an
//                               additional Generic, and will consume 2 stacks of Eyes of Vengeance."
//                               (base Synthetic Skyblade = sera1: 15 dmg, +10/consume-1 if marked, 1 Generic)
//   sera2 Proto-Prophecy     — "Enemies targeted by Heavenly Parry deal 10 reduced damage for their
//                               next turn. This effect is invisible."  (base Heavenly Parry = skill sera3)
//   sera3 Ire of the Storm   — "If Energized Wingstorm consumes 3 or more stacks of Eyes of Vengeance,
//                               it will deal an additional 15 Piercing damage to each target the
//                               following turn."  (base Energized Wingstorm = skill sera2)
//   sera4 Unto Others        — "Proactivity Protocol now deals 15 normal Damage and heals for 25, but
//                               gains an additional 1 turn cooldown."  (base Proactivity = skill sera5:
//                               20 True self, 20 Shield, heal 20, cooldown 4)
//   sera5 Fueled by Vengeance — "Divinity Engine lasts an additional turn for each of Sera's dead allies."
//                               (base Divinity Engine = skill sera6: flat 2 turns)
// =============================================================================

const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;
const eyes = (u: Unit) => stackCount(u, "Eyes of Vengeance");
const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const hasMark = (u: Unit, name: string) => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const seedEyes = (u: Unit, n: number) => u.statuses.push(status("stack", { name: "Eyes of Vengeance", magnitude: n }));

// Fire Sera's (team A) delayTurns:1 scheduled effect at her NEXT turn-end.
// endTurn on the cast turn is the birth turn (no fire); the scheduled fires at A's following turn-end.
function passToSerasNextTurnEnd(state: ReturnType<typeof makeState>): void {
  endTurn(state);                       // A ends the cast turn (birth turn — nothing fires yet)
  startTurn(state); endTurn(state);     // B's turn
  startTurn(state); endTurn(state);     // A's following turn — scheduled 15 Piercing fires here
}

// ---------------------------------------------------------------------------
// sera1 — Vengeful Tempest (re-authors Synthetic Skyblade, skill sera1)
// ---------------------------------------------------------------------------

test("sera1 augment (unmarked target): Synthetic Skyblade deals 5 MORE base damage — 20, not the base 15", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera1")!);
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(enemy.hp, 80, "'5 additional base damage': 15 + 5 = 20 to an unmarked target (100 -> 80)");
  assert.equal(essenceCount(sera), 0, "unmarked -> no Elemental Essence");
});

test("sera1 augment CONTROL: the BASE (un-augmented) Synthetic Skyblade deals only 15 to an unmarked target", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(enemy.hp, 85, "without the augment the +5 is absent: 15 damage (100 -> 85)");
});

test("sera1 augment: costs an ADDITIONAL Generic — effective cost.generic is 2 (base is 1)", () => {
  const base = loadHero(heroById("sera"), "A", "s");
  const baseState = makeState([base], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(effectiveCost(base, skillOf(base, "sera1"), baseState).generic, 1, "base Skyblade costs 1 Generic");

  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera1")!);
  const state = makeState([sera], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(effectiveCost(sera, skillOf(sera, "sera1"), state).generic, 2, "'costs an additional Generic': 1 + 1 = 2");
});

test("sera1 augment: the additional Generic is actually charged — 1 Generic is NOT enough to cast", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera1")!);
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 1, vengeance: 0 };

  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, false, "1 Generic cannot pay the augmented cost of 2 Generic");
  assert.equal(r.reason, "insufficient-energy", "rejected for energy, not some other reason");
  assert.equal(enemy.hp, 100, "the cast did not resolve");
});

test("sera1 augment (marked target): deals 20 base + 10 bonus = 30, CONSUMES 2 Eyes stacks, grants Essence", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera1")!);
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(enemy, 3); // 3 so 'consume 2' is unambiguous (leaves 1, not 0)

  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(enemy.hp, 70, "20 augmented base + 10 marked bonus = 30 (100 -> 70)");
  assert.equal(eyes(enemy), 1, "'will consume 2 stacks': 3 - 2 = 1 remaining");
  assert.equal(essenceCount(sera), 1, "the marked bonus still grants Sera Elemental Essence");
});

test("sera1 augment CONTROL: the BASE Synthetic Skyblade consumes only 1 Eyes stack (3 -> 2)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(enemy, 3);

  performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(eyes(enemy), 2, "base consumes 1 (3 -> 2); the augment's -2 is what distinguishes it");
  assert.equal(enemy.hp, 75, "base 15 + 10 bonus = 25 (100 -> 75) — no +5 without the augment");
});

// ---------------------------------------------------------------------------
// sera2 — Proto-Prophecy (appends to Heavenly Parry, skill sera3)
// ---------------------------------------------------------------------------

test("sera2 augment: an enemy targeted by Heavenly Parry deals 10 LESS damage (20 -> 10) next turn", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera2")!);
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  // The debuffed enemy now deals a raw 20 normal hit at Sera: the -10 outgoing mod reduces it to 10.
  runEffects(state, [{ op: "damage", amount: 20, dtype: "normal", to: "target" }] as Effect[], { caster: enemy, targets: [sera] });
  assert.equal(sera.hp, 90, "'deal 10 reduced damage': 20 - 10 = 10 lands (100 -> 90)");
});

test("sera2 augment CONTROL: without the augment, Heavenly Parry imposes NO outgoing-damage penalty (full 20 lands)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  assert.ok(!enemy.statuses.some((s) => s.kind === "outgoing_damage_mod"), "no -10 debuff on the base skill");
  runEffects(state, [{ op: "damage", amount: 20, dtype: "normal", to: "target" }] as Effect[], { caster: enemy, targets: [sera] });
  assert.equal(sera.hp, 80, "no reduction: the full 20 lands (100 -> 80)");
});

test("sera2 augment: 'This effect is invisible' — the debuffed enemy cannot see the -10 penalty", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera2")!);
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  const debuff = enemy.statuses.find((s) => s.kind === "outgoing_damage_mod");
  assert.ok(debuff && debuff.invisible, "the penalty carries invisible:true on the real state");
  assert.ok(
    !redactState(state, "B").units["e"]!.statuses.some((s) => s.kind === "outgoing_damage_mod"),
    "redacted for the enemy's own team (B): the enemy cannot see the -10 penalty on itself",
  );
});

// ---------------------------------------------------------------------------
// sera3 — Ire of the Storm (appends to Energized Wingstorm, skill sera2)
// ---------------------------------------------------------------------------

test("sera3 augment: consuming 3+ Eyes stacks -> each enemy takes an extra 15 Piercing the FOLLOWING turn", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera3")!);
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100 });
  const state = makeState([sera], [e1, e2, e3]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(e1, 1); seedEyes(e2, 1); seedEyes(e3, 1); // 3 marked -> Wingstorm consumes 3 stacks

  const r = performAction(state, { unit: "s", skillId: "sera2", targets: [] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(e1.hp, 85, "base Wingstorm: 15 Piercing now (100 -> 85)");
  assert.equal(e2.hp, 85, "base Wingstorm: 15 Piercing now (100 -> 85)");
  assert.equal(e3.hp, 85, "base Wingstorm: 15 Piercing now (100 -> 85)");

  passToSerasNextTurnEnd(state);
  assert.equal(e1.hp, 70, "the following turn: +15 Piercing (85 -> 70)");
  assert.equal(e2.hp, 70, "the following turn: +15 Piercing (85 -> 70)");
  assert.equal(e3.hp, 70, "the following turn: +15 Piercing (85 -> 70)");
});

test("sera3 augment CONTROL (only 2 consumed): NO extra Piercing the following turn", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera3")!);
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([sera], [e1, e2]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(e1, 1); seedEyes(e2, 1); // only 2 marked -> only 2 consumed, below the 3 threshold

  performAction(state, { unit: "s", skillId: "sera2", targets: [] });
  assert.equal(e1.hp, 85, "base Wingstorm 15 Piercing (100 -> 85)");
  assert.equal(e2.hp, 85, "base Wingstorm 15 Piercing (100 -> 85)");

  passToSerasNextTurnEnd(state);
  assert.equal(e1.hp, 85, "fewer than 3 consumed -> no scheduled +15 (stays 85)");
  assert.equal(e2.hp, 85, "fewer than 3 consumed -> no scheduled +15 (stays 85)");
});

test("sera3 augment CONTROL: the BASE Energized Wingstorm never deals follow-up Piercing, even with 3 marked", () => {
  const sera = loadHero(heroById("sera"), "A", "s"); // no augment
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100 });
  const state = makeState([sera], [e1, e2, e3]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(e1, 1); seedEyes(e2, 1); seedEyes(e3, 1);

  performAction(state, { unit: "s", skillId: "sera2", targets: [] });
  passToSerasNextTurnEnd(state);
  assert.equal(e1.hp, 85, "no augment -> no follow-up (stays 85)");
  assert.equal(e2.hp, 85, "no augment -> no follow-up (stays 85)");
  assert.equal(e3.hp, 85, "no augment -> no follow-up (stays 85)");
});

// ---------------------------------------------------------------------------
// sera4 — Unto Others (re-authors Proactivity Protocol, skill sera5)
// ---------------------------------------------------------------------------

test("sera4 augment: Proactivity Protocol deals 15 NORMAL to Sera, still grants 20 Shield, and heals the ally 25", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera4")!);
  const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
  const state = makeState([sera, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  const r = performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(sera.hp, 85, "'deals 15 normal Damage' to Sera (100 -> 85); shield is granted AFTER the hit");
  assert.equal(totalShield(sera), 20, "the 20 Shield is preserved");
  assert.equal(ally.hp, 75, "'heals for 25' (50 -> 75)");
});

test("sera4 augment: the self-hit is now NORMAL (mitigable by a pre-existing shield), not the base's True", () => {
  // Augmented: 15 NORMAL against a 30 pre-shield -> fully absorbed, Sera's HP untouched.
  {
    const sera = loadHero(heroById("sera"), "A", "s");
    applyAugment(sera, augmentById("sera4")!);
    sera.shields = [{ amount: 30, duration: null, appliedBy: "x", appliedTurn: 0 }];
    const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
    const state = makeState([sera, ally], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = { generic: 40, vengeance: 40 };

    performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
    assert.equal(sera.hp, 100, "15 NORMAL is absorbed by the pre-existing shield — HP untouched");
    assert.equal(totalShield(sera), 35, "30 - 15 absorbed = 15, then + 20 granted = 35");
  }
  // CONTROL — base (un-augmented) Proactivity: 20 TRUE bypasses the same 30 pre-shield and hits HP.
  {
    const sera = loadHero(heroById("sera"), "A", "s");
    sera.shields = [{ amount: 30, duration: null, appliedBy: "x", appliedTurn: 0 }];
    const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
    const state = makeState([sera, ally], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = { generic: 40, vengeance: 40 };

    performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
    assert.equal(sera.hp, 80, "base 20 TRUE bypasses the shield (100 -> 80)");
    assert.equal(ally.hp, 70, "base heals only 20 (50 -> 70) — the augment's +5 heal is absent");
  }
});

// SUSPECTED BUG: frozen 'Proactivity Protocol ... gains an additional 1 turn cooldown'. The frozen BASE
// cooldown (skills.json sera5) is 4, so the augmented skill must go on cooldown 4 + 1 = 5. The authored
// replaceSkill ships cooldown 4 (its note assumed a base of 3), so the "+1" is never applied — a real cast
// puts Proactivity on cd 4 instead of the frozen-derived 5. Kept as an executable bug report.
test.skip("SUSPECTED BUG: frozen 'additional 1 turn cooldown' -> base 4 + 1 = 5, but the augmented Proactivity Protocol goes on cd 4 (the +1 is never applied)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera4")!);
  const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
  const state = makeState([sera, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
  assert.equal(skillOf(sera, "sera5").currentCd, 5, "'additional 1 turn cooldown': base 4 + 1 = 5");
});

// ---------------------------------------------------------------------------
// sera5 — Fueled by Vengeance (re-authors Divinity Engine, skill sera6)
// ---------------------------------------------------------------------------

test("sera5 augment CONTROL (0 dead allies): Divinity Engine still lasts the base 2 turns", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera5")!);
  const state = makeState([sera], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const ndi = sera.statuses.find((s) => s.kind === "non_damage_ignore");
  assert.ok(ndi, "the 'ignore non-damage effects' buff is installed");
  assert.equal(ndi!.duration, 2, "0 dead allies -> 2 + 0 = 2 turns");
  const mark = sera.statuses.find((s) => s.kind === "mark" && s.name === "Divinity Engine");
  assert.ok(mark, "the Divinity Engine mark is installed");
  assert.equal(mark!.duration, 2, "the mark also lasts 2 turns with 0 dead allies");
});

test("sera5 augment: ONE dead ally hero extends Divinity Engine by 1 turn (2 -> 3)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera5")!);
  const deadAlly = makeUnit({ id: "a", team: "A", kind: "hero" });
  deadAlly.alive = false;
  const state = makeState([sera, deadAlly], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const ndi = sera.statuses.find((s) => s.kind === "non_damage_ignore");
  assert.equal(ndi!.duration, 3, "'an additional turn for each dead ally': 2 + 1 = 3");
  const mark = sera.statuses.find((s) => s.kind === "mark" && s.name === "Divinity Engine");
  assert.equal(mark!.duration, 3, "the Divinity Engine mark also extends to 3");
});

test("sera5 augment: TWO dead ally heroes extend Divinity Engine by 2 turns (2 -> 4)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera5")!);
  const d1 = makeUnit({ id: "a1", team: "A", kind: "hero" }); d1.alive = false;
  const d2 = makeUnit({ id: "a2", team: "A", kind: "hero" }); d2.alive = false;
  const state = makeState([sera, d1, d2], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const ndi = sera.statuses.find((s) => s.kind === "non_damage_ignore");
  assert.equal(ndi!.duration, 4, "two dead allies -> 2 + 2 = 4 turns");
});

test("sera5 augment CONTROL: a LIVING ally hero does NOT extend the duration ('dead' allies only)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera5")!);
  const liveAlly = makeUnit({ id: "a", team: "A", kind: "hero" }); // alive
  const state = makeState([sera, liveAlly], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const ndi = sera.statuses.find((s) => s.kind === "non_damage_ignore");
  assert.equal(ndi!.duration, 2, "a living ally is not counted -> stays 2");
});
