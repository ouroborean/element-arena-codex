import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { performAction } from "../src/scheduler.ts";
import { applyDamage, totalShield } from "../src/damage.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// =====================================================================================================
// AYANA — AUGMENTS adversarial, spec-derived suite. The FROZEN augment prose
// (content/frozen/augments.json) is the ORACLE for WHAT each augment must do; the base skill's frozen
// prose (content/frozen/skills.json) grounds the behavior it modifies. Authored/generated content is
// consulted ONLY for HOW to drive (ids, costs, status/mark names), NEVER to decide what to assert.
//
// Frozen augment text (all Holy, element id 7):
//   ayana1 Honor Guard        — "The base damage reduction per ally is increased to 10"
//   ayana2 Guarded Meditation — "Ayana gains 30 shield for 1 turn when she uses Prayer."
//   ayana3 Stern Reminder     — "If an enemy triggers Voice of Light, it is automatically recast on
//                                them, ignoring invulnerability and counters"
//   ayana4 Answered Prayers   — "Prayer makes its target Invulnerable for 1 turn if used on a target
//                                below 20 HP."
//   ayana5 Harsh Words        — "Prayer and Voice of Light cause 10 more healing or damage, but no
//                                longer have a secondary effect."
//
// Grounding base frozen text:
//   ayana0 Revered Daughter — "Ayana gains 5 points of permanent damage reduction for each of her
//                              living allies"
//   ayana1 Voice of Light   — "Deals 15 damage to one enemy. If that enemy deals new damage this turn,
//                              Ayana gains Elemental Essence"
//   ayana2 Chorus           — "For Ayana's next 2 turns, Voice of Light and Prayer will affect all
//                              valid targets."
//   ayana3 Prayer           — "Ayana heals target ally for 10 HP. If they receive new damage next turn,
//                              Ayana gains Elemental Essence."
//   ayana4 Cloister         — "The Damage Reduction from Revered Daughter is doubled for 1 turn."
// =====================================================================================================

const ENERGY = { generic: 40, holy: 40 };

/** Fresh Ayana (id "ay", team A), optional augment applied, plus named allies/enemies + energy. */
function setup(
  augId: string | null,
  allyIds: string[],
  enemyIds: string[],
): { state: MatchState; ay: Unit } {
  const ay = loadHero(heroById("ayana"), "A", "ay");
  if (augId) applyAugment(ay, augmentById(augId)!);
  const allies = allyIds.map((id) => makeUnit({ id, team: "A" }));
  const enemies = enemyIds.map((id) => makeUnit({ id, team: "B" }));
  const state = makeState([ay, ...allies], enemies);
  state.teams.A.energy = { ...ENERGY };
  return { state, ay };
}

const drOf = (u: Unit): number => {
  const s = u.statuses.find((st) => st.kind === "damage_reduction");
  return s ? s.magnitude ?? 0 : 0;
};
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const markOf = (u: Unit, name: string): Unit["statuses"][number] | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === name);
const isInvuln = (u: Unit): boolean => u.statuses.some((s) => s.kind === "invulnerable");
const invulnDuration = (u: Unit): number | null | undefined =>
  u.statuses.find((s) => s.kind === "invulnerable")?.duration;

// =====================================================================================================
// ayana1 — Honor Guard: Revered Daughter's per-ally base damage reduction goes 5 -> 10.
// =====================================================================================================

test("Honor Guard: DR = 10 * (living hero allies) at roundStart (base 5/ally is the control)", () => {
  // Control: without the augment, 2 allies -> the base 5/ally = 10.
  {
    const { state } = setup(null, ["a1", "a2"], ["e"]);
    emit(state, { type: "roundStart" });
    assert.equal(drOf(state.units["ay"]!), 10, "base Revered Daughter: 5*2 = 10");
  }
  // With Honor Guard: 2 allies -> 10/ally * 2 = 20.
  {
    const { state } = setup("ayana1", ["a1", "a2"], ["e"]);
    emit(state, { type: "roundStart" });
    assert.equal(drOf(state.units["ay"]!), 20, "Honor Guard: 10*2 = 20 DR");
    // Behavioral confirmation: 30 normal damage mitigated by the 20 DR -> 10 lost.
    const r = applyDamage(state.units["ay"]!, { amount: 30, type: "normal" });
    assert.equal(r.hpLost, 10, "30 dealt - 20 DR = 10 taken");
  }
});

test("Honor Guard: with no allies DR is 0 (10 * 0)", () => {
  const { state } = setup("ayana1", [], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 0, "no allies -> 0 DR even at 10/ally");
});

test("Honor Guard: recomputes on ally death using the 10/ally base", () => {
  const { state } = setup("ayana1", ["a1", "a2"], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 20, "start: 2 allies -> 20 DR");
  // a2 dies -> recompute to 1 living ally * 10 = 10.
  state.units["a2"]!.alive = false;
  state.units["a2"]!.hp = 0;
  emit(state, { type: "unitDied", unit: "a2", killer: null });
  assert.equal(drOf(state.units["ay"]!), 10, "after an ally dies -> 10 DR (1 living ally * 10)");
});

test("Honor Guard + Cloister: Revered Daughter's 10/ally is doubled to 20/ally under Cloister", () => {
  // Route through the augment's own (retuned) roundStart recompute while the Cloister mark is up.
  // Control: base 5/ally doubled by Cloister = 10/ally -> 20 for 2 allies.
  {
    const { state } = setup(null, ["a1", "a2"], ["e"]);
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana4", targets: [] }).ok, "cast Cloister");
    assert.ok(markOf(state.units["ay"]!, "Cloister"), "Cloister mark is up");
    emit(state, { type: "roundStart" });
    assert.equal(drOf(state.units["ay"]!), 20, "base under Cloister: 5*2 doubled = 20");
  }
  // With Honor Guard: 10/ally doubled = 20/ally -> 40 for 2 allies.
  {
    const { state } = setup("ayana1", ["a1", "a2"], ["e"]);
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana4", targets: [] }).ok, "cast Cloister");
    assert.ok(markOf(state.units["ay"]!, "Cloister"), "Cloister mark is up");
    emit(state, { type: "roundStart" });
    assert.equal(drOf(state.units["ay"]!), 40, "Honor Guard under Cloister: 10*2 doubled = 40");
  }
});

// Adversarial: Cloister's OWN recompute (fired at cast time) should also reflect Honor Guard's 10/ally
// base. Frozen: Revered Daughter now grants 10/ally (Honor Guard); Cloister doubles that DR -> for 2
// allies 10*2 doubled = 40. If Cloister's recompute still uses the un-augmented 5/ally constant it
// yields 20, contradicting the composed frozen behavior.
test("Honor Guard: Cloister doubles the 10/ally DR to 40 for 2 allies", () => {
  const { state } = setup("ayana1", ["a1", "a2"], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 20, "pre-Cloister: Honor Guard 10*2 = 20");
  assert.ok(performAction(state, { unit: "ay", skillId: "ayana4", targets: [] }).ok, "cast Cloister");
  assert.equal(drOf(state.units["ay"]!), 40, "Cloister doubles the augmented 20 -> 40 (engine actual: 20)");
});

// =====================================================================================================
// ayana2 — Guarded Meditation: Ayana gains 30 shield for 1 turn when she uses Prayer.
// =====================================================================================================

test("Guarded Meditation: casting Prayer grants Ayana exactly 30 shield for 1 turn", () => {
  const { state } = setup("ayana2", ["a1"], ["e"]);
  state.units["a1"]!.hp = 50;
  assert.equal(totalShield(state.units["ay"]!), 0, "no shield before Prayer");
  const r = performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.ok(r.ok, `Prayer ok: ${r.reason ?? ""}`);
  assert.equal(totalShield(state.units["ay"]!), 30, "Prayer grants Ayana 30 shield");
  const sh = state.units["ay"]!.shields.find((s) => s.amount === 30);
  assert.ok(sh, "a 30-shield instance exists on Ayana (self, not the healed ally)");
  assert.equal(sh!.duration, 1, "shield lasts 1 turn");
  // The healed ally is not the one shielded.
  assert.equal(totalShield(state.units["a1"]!), 0, "the healed ally gains no shield");
});

test("Guarded Meditation: NO shield when Ayana casts a non-Prayer skill (Voice of Light control)", () => {
  const { state } = setup("ayana2", ["a1"], ["e"]);
  const r = performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
  assert.ok(r.ok, `Voice of Light ok: ${r.reason ?? ""}`);
  assert.equal(totalShield(state.units["ay"]!), 0, "Voice of Light grants no shield");
});

test("Guarded Meditation: without the augment Prayer grants no shield (control)", () => {
  const { state } = setup(null, ["a1"], ["e"]);
  state.units["a1"]!.hp = 50;
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.equal(totalShield(state.units["ay"]!), 0, "base Prayer grants no shield");
});

// =====================================================================================================
// ayana3 — Stern Reminder: when a Voice-of-Light-marked enemy deals new damage (triggering Voice of
// Light), Voice of Light is automatically recast on it, ignoring invulnerability and counters.
// =====================================================================================================

test("Stern Reminder: a Voice-of-Light-marked enemy that deals damage gets Voice of Light recast on it (+15)", () => {
  // Control: WITHOUT the augment the marked enemy takes no extra damage when it deals damage.
  {
    const { state } = setup(null, [], ["e"]);
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 85, "Voice of Light dealt 15");
    emit(state, { type: "damageDealt", source: "e", target: "ay", amount: 7, dtype: "normal", isNew: true });
    assert.equal(state.units["e"]!.hp, 85, "no augment -> no recast, e stays 85");
    assert.equal(essenceCount(state.units["ay"]!), 1, "base trigger still grants essence");
  }
  // With Stern Reminder: the marked enemy dealing new damage recasts Voice of Light -> another 15.
  {
    const { state } = setup("ayana3", [], ["e"]);
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 85, "initial Voice of Light dealt 15");
    emit(state, { type: "damageDealt", source: "e", target: "ay", amount: 7, dtype: "normal", isNew: true });
    assert.equal(state.units["e"]!.hp, 70, "Stern Reminder recast Voice of Light -> another 15 (85 -> 70)");
  }
});

test("Stern Reminder: does NOT fire when an UNMARKED enemy deals damage (guard control)", () => {
  const { state } = setup("ayana3", [], ["e1", "e2"]);
  // Mark only e1.
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e1"] });
  assert.ok(markOf(state.units["e1"]!, "Voice of Light"), "e1 marked");
  assert.ok(!markOf(state.units["e2"]!, "Voice of Light"), "e2 unmarked");
  const e1before = state.units["e1"]!.hp;
  // e2 (unmarked) deals damage -> no recast anywhere.
  emit(state, { type: "damageDealt", source: "e2", target: "ay", amount: 5, dtype: "normal", isNew: true });
  assert.equal(state.units["e1"]!.hp, e1before, "unmarked enemy dealing damage does not recast on e1");
  assert.equal(state.units["e2"]!.hp, 100, "e2 unaffected");
});

test("Stern Reminder: the recast lands even on an invulnerable enemy (ignores invulnerability)", () => {
  // Establish the baseline: a normal Voice of Light cast against an invulnerable enemy is blocked.
  {
    const { state } = setup("ayana3", [], ["e"]);
    state.units["e"]!.statuses.push(status("invulnerable", { duration: 1 }));
    const r = performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.ok(!r.ok, "a plain Voice of Light on an invulnerable enemy is blocked");
    assert.equal(state.units["e"]!.hp, 100, "invulnerable enemy takes no damage from the blocked cast");
  }
  // The recast bypasses that: mark e while vulnerable, then make it invulnerable; its new damage recasts.
  {
    const { state } = setup("ayana3", [], ["e"]);
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 85, "marked for 15");
    state.units["e"]!.statuses.push(status("invulnerable", { duration: 1 }));
    emit(state, { type: "damageDealt", source: "e", target: "ay", amount: 5, dtype: "normal", isNew: true });
    assert.equal(state.units["e"]!.hp, 70, "recast lands on the invulnerable enemy (ignoring invulnerability)");
  }
});

// =====================================================================================================
// ayana4 — Answered Prayers: Prayer makes its target Invulnerable for 1 turn if used on a target below
// 20 HP.
// =====================================================================================================

test("Answered Prayers: Prayer on a below-20 target grants Invulnerable for 1 turn", () => {
  const { state } = setup("ayana4", ["a1"], ["e"]);
  state.units["a1"]!.hp = 5; // below 20 both before (5) and after (15) the +10 heal
  assert.ok(!isInvuln(state.units["a1"]!), "not invulnerable before Prayer");
  const r = performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.ok(r.ok, `Prayer ok: ${r.reason ?? ""}`);
  assert.equal(state.units["a1"]!.hp, 15, "healed 10 (5 -> 15)");
  assert.ok(isInvuln(state.units["a1"]!), "target below 20 -> Invulnerable");
  assert.equal(invulnDuration(state.units["a1"]!), 1, "Invulnerable lasts 1 turn");
});

test("Answered Prayers: Prayer on a healthy target grants NO invulnerability (threshold control)", () => {
  const { state } = setup("ayana4", ["a1"], ["e"]);
  state.units["a1"]!.hp = 50; // 50 -> 60, never below 20
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.equal(state.units["a1"]!.hp, 60, "healed 10 (50 -> 60)");
  assert.ok(!isInvuln(state.units["a1"]!), "healthy target -> no invulnerability");
});

test("Answered Prayers: without the augment even a below-20 target gets no invulnerability (control)", () => {
  const { state } = setup(null, ["a1"], ["e"]);
  state.units["a1"]!.hp = 5;
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.ok(!isInvuln(state.units["a1"]!), "base Prayer never grants invulnerability");
});

// Adversarial boundary: frozen says "if used ON a target below 20 HP" — the target's HP at the moment
// Prayer is used. A 15-HP ally is below 20 when Prayer is used, so it must become Invulnerable, even
// though the +10 heal lifts it to 25.
test("Answered Prayers: Prayer on a target below 20 HP (at use time) grants Invulnerable", () => {
  const { state } = setup("ayana4", ["a1"], ["e"]);
  state.units["a1"]!.hp = 15; // below 20 at time of use; heals to 25
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.equal(state.units["a1"]!.hp, 25, "healed 10 (15 -> 25)");
  assert.ok(isInvuln(state.units["a1"]!), "target was below 20 when Prayer was used -> Invulnerable");
});

// =====================================================================================================
// ayana5 — Harsh Words: Prayer and Voice of Light do +10 (25 dmg / 20 heal) but lose their secondary
// (Elemental Essence) effect.
// =====================================================================================================

test("Harsh Words: Voice of Light deals 25 (was 15) and leaves no Voice-of-Light mark", () => {
  // Control: base Voice of Light deals 15 and marks the enemy.
  {
    const { state } = setup(null, [], ["e"]);
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 85, "base Voice of Light dealt 15");
    assert.ok(markOf(state.units["e"]!, "Voice of Light"), "base leaves the mark (secondary effect armed)");
  }
  // With Harsh Words: 25 damage, no mark.
  {
    const { state } = setup("ayana5", [], ["e"]);
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(state.units["e"]!.hp, 75, "Harsh Words Voice of Light deals 25 (100 -> 75)");
    assert.ok(!markOf(state.units["e"]!, "Voice of Light"), "no Voice-of-Light mark (secondary effect removed)");
  }
});

test("Harsh Words: Voice of Light no longer grants Essence when the struck enemy deals damage", () => {
  const { state } = setup("ayana5", [], ["e"]);
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
  assert.equal(essenceCount(state.units["ay"]!), 0, "no essence on cast");
  // The struck enemy deals new damage this turn -> base would grant essence; Harsh Words removed it.
  emit(state, { type: "damageDealt", source: "e", target: "ay", amount: 7, dtype: "normal", isNew: true });
  assert.equal(essenceCount(state.units["ay"]!), 0, "no secondary effect -> no Elemental Essence");
});

test("Harsh Words: Prayer heals 20 (was 10) and leaves no Prayer mark", () => {
  // Control: base Prayer heals 10 and marks the ally.
  {
    const { state } = setup(null, ["a1"], ["e"]);
    state.units["a1"]!.hp = 50;
    performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
    assert.equal(state.units["a1"]!.hp, 60, "base Prayer healed 10");
    assert.ok(markOf(state.units["a1"]!, "Prayer"), "base leaves the Prayer mark");
  }
  // With Harsh Words: heals 20, no mark.
  {
    const { state } = setup("ayana5", ["a1"], ["e"]);
    state.units["a1"]!.hp = 50;
    performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
    assert.equal(state.units["a1"]!.hp, 70, "Harsh Words Prayer heals 20 (50 -> 70)");
    assert.ok(!markOf(state.units["a1"]!, "Prayer"), "no Prayer mark (secondary effect removed)");
  }
});

test("Harsh Words: Prayer no longer grants Essence when the healed ally is damaged", () => {
  const { state } = setup("ayana5", ["a1"], ["e"]);
  state.units["a1"]!.hp = 50;
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.equal(essenceCount(state.units["ay"]!), 0, "no essence on cast");
  emit(state, { type: "damageDealt", source: "e", target: "a1", amount: 8, dtype: "normal", isNew: true });
  assert.equal(essenceCount(state.units["ay"]!), 0, "no secondary effect -> no Elemental Essence");
});

test("Harsh Words: the Chorus all-targets branch is preserved with the boosted magnitudes", () => {
  // Voice of Light under Chorus hits every enemy for the boosted 25.
  {
    const { state } = setup("ayana5", [], ["e1", "e2"]);
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana2", targets: [] }).ok, "cast Chorus");
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e1"] });
    assert.equal(state.units["e1"]!.hp, 75, "e1 hit for 25 under Chorus");
    assert.equal(state.units["e2"]!.hp, 75, "e2 also hit for 25 under Chorus (all valid targets)");
  }
  // Prayer under Chorus heals every ally hero for the boosted 20.
  {
    const { state } = setup("ayana5", ["a1", "a2"], ["e"]);
    state.units["a1"]!.hp = 50;
    state.units["a2"]!.hp = 50;
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana2", targets: [] }).ok, "cast Chorus");
    performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
    assert.equal(state.units["a1"]!.hp, 70, "a1 healed 20 under Chorus");
    assert.equal(state.units["a2"]!.hp, 70, "a2 also healed 20 under Chorus (all valid targets)");
  }
});
