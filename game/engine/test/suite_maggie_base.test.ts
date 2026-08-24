import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { redactState } from "../src/visibility.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// ===========================================================================================
// ADVERSARIAL, SPEC-DERIVED suite for Maggie Thorncursed's BASE kit.
// Oracle = the FROZEN prose (content/frozen/skills.json). Every expectation below is derived
// from that text, NOT from the effect trees. Content/roster was read only to learn HOW to drive
// (skill ids, costs, element="unholy", the "Curse of Thorns"/"Grasping Vines" status names).
//
//   maggie0 Curse of Thorns (passive): "When Maggie uses a skill, she takes 5 Affliction damage
//     each turn for the rest of the game."  (one accumulating stack per skill use; 5/turn each.)
//   maggie1 Bramblelash: "Deals 15 damage to target enemy. Until the end of Maggie's next turn,
//     if that target receives new damage, she will gain Elemental Essence"
//   maggie2 Grasping Vines: "Maggie prepares to cast Grasping Vines on target enemy. The following
//     turn, they receive 15 damage. If the target uses a skill during this time, they are also
//     stunned for 1 turn. The target of this skill is invisible. This effect will be cancelled if
//     Maggie is stunned."
//   maggie3 Thornburst: "Deals 30 damage to one enemy. If Maggie has 3 or more stacks of Curse of
//     Thorns on her, this skill will target all enemies."
//   maggie4 Cursed Resistance: "Maggie gains 10 permanent shield for every stack of Curse of Thorns
//     on her."
//   maggie5 The Thornborn Witch: "Maggie ignores damage from Curse of Thorns for 2 turns. During
//     this time, she deals damage equal to her Curse of Thorns damage to all targetable enemies and
//     allies each turn."
// ===========================================================================================

function fullEnergy(): { generic: number; unholy: number } {
  return { generic: 40, unholy: 40 };
}
// Seed N stacks of Curse of Thorns directly (precondition; matches maggie0's accumulating stack).
function seedCurse(u: Unit, n: number): void {
  u.statuses.push(status("stack", { name: "Curse of Thorns", magnitude: n, duration: null, appliedBy: "maggie", appliedTurn: 0 }));
}
function hasEssence(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "elemental_essence");
}
function hasStun(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "stun");
}
const hasGVmark = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "Grasping Vines");

// -------------------------------------------------------------------------------------------
// maggie0 — Curse of Thorns (passive)
// -------------------------------------------------------------------------------------------

test("maggie0: using a skill inflicts 5 Affliction on Maggie at each of her later turns; never using one inflicts nothing", () => {
  // POSITIVE — one skill use => 5 Affliction every subsequent Maggie turn ("each turn ... rest of the game").
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok, "Bramblelash cast");
    assert.equal(maggie.hp, 100, "no self-damage on the turn the skill was used (birth turn is skipped)");
    endTurn(state); // A ends turn 1 (birth turn, no tick)
    endTurn(state); // B ends turn 2
    endTurn(state); // A ends turn 3 -> first Curse tick
    assert.equal(maggie.hp, 95, "5 Affliction at Maggie's first turn after using a skill");
    endTurn(state); // B ends turn 4
    endTurn(state); // A ends turn 5 -> second Curse tick (persists 'each turn')
    assert.equal(maggie.hp, 90, "another 5 Affliction the following Maggie turn");
  }

  // CONTROL — a Maggie who never uses a skill takes no Curse of Thorns damage.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    for (let i = 0; i < 6; i++) endTurn(state);
    assert.equal(maggie.hp, 100, "no skill used => no Curse of Thorns, no self-damage");
  }
});

test("maggie0: the per-turn Affliction scales with the number of skills used (2 uses => 10/turn)", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const e = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = fullEnergy();
  // Two skill uses on the same turn (Bramblelash has no cooldown) => 2 stacks => 10 Affliction/turn.
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
  assert.equal(maggie.hp, 100, "still no self-damage on the use turn");
  endTurn(state); // turn 1 A (birth)
  endTurn(state); // turn 2 B
  endTurn(state); // turn 3 A -> tick
  assert.equal(maggie.hp, 90, "2 stacks => 10 Affliction on Maggie's next turn");
});

// -------------------------------------------------------------------------------------------
// maggie1 — Bramblelash
// -------------------------------------------------------------------------------------------

test("maggie1: deals 15 to the targeted enemy only", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const state = makeState([maggie], [e1, e2]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e1"] }).ok);
  assert.equal(e1.hp, 85, "15 damage to the chosen enemy");
  assert.equal(e2.hp, 100, "the other enemy is untouched (single target)");
});

test("maggie1: new damage to the Bramblelash-marked target grants Maggie Elemental Essence", () => {
  // Frozen: "Until the end of Maggie's next turn, if that target receives new damage, she will gain
  // Elemental Essence." Drive: mark e1 with Bramblelash, then deal it fresh damage — Maggie should gain Essence.
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const state = makeState([maggie], [e1, e2]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e1"] }).ok, "Bramblelash marks e1");
  assert.equal(hasEssence(maggie), false, "the initial cast alone has not yet produced Essence");
  // New damage to the marked target (a second harmful skill against e1).
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok, "Thornburst deals new damage to e1");
  assert.equal(hasEssence(maggie), true, "new damage to the Bramblelash target grants Maggie Elemental Essence");
});

// -------------------------------------------------------------------------------------------
// maggie2 — Grasping Vines
// -------------------------------------------------------------------------------------------

test("maggie2: no instant damage on cast; the prepared 15 lands on Maggie's following turn", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const e = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie2", targets: ["e"] }).ok, "Grasping Vines prepared");
  assert.equal(e.hp, 100, "Grasping Vines deals no damage on the turn it is cast");
  endTurn(state); // A ends turn 1 (birth for the schedule)
  endTurn(state); // B ends turn 2
  assert.equal(e.hp, 100, "still not yet — the hit is scheduled for Maggie's following turn");
  endTurn(state); // A ends turn 3 -> scheduled 15 fires
  assert.equal(e.hp, 85, "15 damage lands the following Maggie turn");
});

test("maggie2: a target that uses a skill during the window is stunned 1 turn; an unmarked enemy is not", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const e = makeUnit({ id: "e", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  e.skills = [skill("estab", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })];
  e2.skills = [skill("e2stab", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful"], cost: { generic: 0, specific: 0 } })];
  const state = makeState([maggie], [e, e2]);
  state.teams.A.energy = fullEnergy();
  state.teams.B.energy = { generic: 10 };
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie2", targets: ["e"] }).ok, "Grasping Vines on e");

  // CONTROL — the unmarked enemy uses a skill: no stun.
  assert.ok(performAction(state, { unit: "e2", skillId: "e2stab", targets: ["maggie"] }).ok);
  assert.equal(hasStun(e2), false, "an enemy without the Grasping Vines mark is not stunned for acting");

  // POSITIVE — the marked target uses a skill: stunned for 1 turn.
  assert.ok(performAction(state, { unit: "e", skillId: "estab", targets: ["maggie"] }).ok);
  assert.equal(hasStun(e), true, "the Grasping Vines target is stunned for using a skill during the window");
});

test("maggie2: the target of Grasping Vines is invisible to the opponent, but visible to the caster's side", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  const e = makeUnit({ id: "e", team: "B" });
  const state = makeState([maggie], [e]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie2", targets: ["e"] }).ok);

  const foeView = redactState(state, "B"); // the target's own team must NOT see it was targeted
  assert.equal(hasGVmark(foeView.units["e"]!), false, "opponent cannot see the Grasping Vines mark on the target");
  assert.equal(foeView.scheduled.length, 0, "the pending (invisible) Grasping Vines payload is hidden from the opponent");

  const ownView = redactState(state, "A"); // the caster's side sees its own hidden effect
  assert.equal(hasGVmark(ownView.units["e"]!), true, "Maggie's side still sees the Grasping Vines mark");
  assert.equal(ownView.scheduled.length, 1, "Maggie's side still sees the pending payload");
});

test("maggie2: the effect is cancelled if Maggie is stunned — mark removed and the delayed 15 does not land", () => {
  // POSITIVE — Maggie is stunned after preparing the Vines: the mark is stripped and no delayed hit.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie2", targets: ["e"] }).ok);
    assert.equal(hasGVmark(e), true, "precondition: e carries the pending Grasping Vines mark");
    // Maggie gets stunned (a stun lands on her).
    maggie.statuses.push(status("stun", { duration: 1, appliedBy: "e", appliedTurn: 0 }));
    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "stun" });
    assert.equal(hasGVmark(e), false, "being stunned cancels the pending Grasping Vines (mark removed)");
    endTurn(state); endTurn(state); endTurn(state); // advance past when the hit would have fired
    assert.equal(e.hp, 100, "the cancelled Grasping Vines deals no delayed damage");
  }

  // CONTROL — no stun on Maggie: the mark stands and the delayed 15 lands.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie2", targets: ["e"] }).ok);
    endTurn(state); endTurn(state); endTurn(state);
    assert.equal(e.hp, 85, "an un-cancelled Grasping Vines still deals its 15");
  }
});

// -------------------------------------------------------------------------------------------
// maggie3 — Thornburst
// -------------------------------------------------------------------------------------------

test("maggie3: 30 to one enemy with < 3 Curse stacks; all enemies at 3+ stacks", () => {
  // CONTROL — 2 stacks: single target only.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    seedCurse(maggie, 2);
    const e1 = makeUnit({ id: "e1", team: "B" });
    const e2 = makeUnit({ id: "e2", team: "B" });
    const state = makeState([maggie], [e1, e2]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
    assert.equal(e1.hp, 70, "30 to the chosen enemy");
    assert.equal(e2.hp, 100, "with only 2 stacks the other enemy is untouched");
  }

  // POSITIVE — 3 stacks: strikes all enemies for 30.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    seedCurse(maggie, 3);
    const e1 = makeUnit({ id: "e1", team: "B" });
    const e2 = makeUnit({ id: "e2", team: "B" });
    const e3 = makeUnit({ id: "e3", team: "B" });
    const state = makeState([maggie], [e1, e2, e3]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie3", targets: ["e1"] }).ok);
    assert.equal(e1.hp, 70, "targeted enemy takes 30");
    assert.equal(e2.hp, 70, "3+ stacks => every enemy takes 30");
    assert.equal(e3.hp, 70, "3+ stacks => every enemy takes 30");
  }
});

// -------------------------------------------------------------------------------------------
// maggie4 — Cursed Resistance
// -------------------------------------------------------------------------------------------

test("maggie4: grants 10 permanent shield per Curse of Thorns stack; scales with stacks; 0 stacks => none", () => {
  // 3 stacks => 30 shield.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    seedCurse(maggie, 3);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie4", targets: ["maggie"] }).ok);
    assert.equal(totalShield(maggie), 30, "10 x 3 stacks = 30 shield");
    // Permanent: strip the self-Curse DoT (so it can't nibble the shield) and advance — the shield stays.
    maggie.statuses = maggie.statuses.filter((s) => s.kind !== "dot");
    endTurn(state); endTurn(state); endTurn(state); endTurn(state);
    assert.equal(totalShield(maggie), 30, "the shield is permanent — it does not decay over time");
  }
  // 1 stack => 10 shield (scaling).
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    seedCurse(maggie, 1);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie4", targets: ["maggie"] }).ok);
    assert.equal(totalShield(maggie), 10, "10 x 1 stack = 10 shield");
  }
  // 0 stacks => 0 shield.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie4", targets: ["maggie"] }).ok);
    assert.equal(totalShield(maggie), 0, "no stacks => no shield");
  }
});

// -------------------------------------------------------------------------------------------
// maggie5 — The Thornborn Witch
// -------------------------------------------------------------------------------------------

test("maggie5: deals Curse damage (5/stack) to all targetable enemies AND allies each turn, sparing Maggie and untargetable units", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  seedCurse(maggie, 2); // 5 x 2 = 10 per hit at cast
  const ally = makeUnit({ id: "ally", team: "A" });
  const e1 = makeUnit({ id: "e1", team: "B" });
  const e2 = makeUnit({ id: "e2", team: "B" });
  const e3 = makeUnit({ id: "e3", team: "B", statuses: [status("untargetable", {})] });
  const state = makeState([maggie, ally], [e1, e2, e3]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie5", targets: ["maggie"] }).ok);
  assert.equal(e1.hp, 90, "enemy takes 5 x 2 stacks = 10");
  assert.equal(e2.hp, 90, "every targetable enemy is hit");
  assert.equal(ally.hp, 90, "allies are hit too (the curse spreads to everyone)");
  assert.equal(e3.hp, 100, "an untargetable unit is spared");
  assert.equal(maggie.hp, 100, "Maggie herself is not hit by her own spread");
});

test("maggie5: the spread recurs on Maggie's following turn ('each turn')", () => {
  const maggie = loadHero(heroById("maggie"), "A", "maggie");
  seedCurse(maggie, 2);
  const e2 = makeUnit({ id: "e2", team: "B" });
  const state = makeState([maggie], [e2]);
  state.teams.A.energy = fullEnergy();
  assert.ok(performAction(state, { unit: "maggie", skillId: "maggie5", targets: ["maggie"] }).ok);
  assert.equal(e2.hp, 90, "immediate tick: 5 x 2 stacks (stacks before this cast) = 10");
  // This cast is a skill use, so Maggie now holds 3 Curse stacks; the next-turn tick uses her current
  // Curse damage (5 x 3 = 15), per "damage equal to her Curse of Thorns damage ... each turn".
  endTurn(state); // A ends turn 1 (birth for the schedule)
  endTurn(state); // B ends turn 2
  endTurn(state); // A ends turn 3 -> scheduled recurrence fires
  assert.equal(e2.hp, 75, "a second tick lands the following Maggie turn (5 x 3 stacks = 15)");
});

test("maggie5: Maggie ignores Curse of Thorns damage for the duration; without it she takes it", () => {
  // POSITIVE — Maggie casts The Thornborn Witch while carrying Curse of Thorns: her own Curse DoT is ignored.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    // Two skill uses build the Curse (2 stacks); the ult is the 3rd use => 3 stacks, DoT = 15/turn.
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie5", targets: ["maggie"] }).ok);
    const hpAfterCast = maggie.hp;
    endTurn(state); endTurn(state); endTurn(state); // reach Maggie's next turn-end
    assert.equal(maggie.hp, hpAfterCast, "the Curse of Thorns DoT deals no damage while The Thornborn Witch is up");
  }

  // CONTROL — same 3-stack Curse, but no ult: Maggie takes the 15 Affliction on her next turn.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const e = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [e]);
    state.teams.A.energy = fullEnergy();
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.ok(performAction(state, { unit: "maggie", skillId: "maggie1", targets: ["e"] }).ok);
    assert.equal(maggie.hp, 100, "no self-damage yet on the use turn");
    endTurn(state); endTurn(state); endTurn(state);
    assert.equal(maggie.hp, 85, "3 stacks => 15 Affliction on Maggie's next turn without the ult's ignore");
  }
});
