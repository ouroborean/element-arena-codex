import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { performAction, endTurn } from "../src/scheduler.ts";
import { applyDamage } from "../src/damage.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, spec-derived suite for AYANA's BASE kit (ayana0..ayana5).
// The FROZEN prose (../content/frozen/skills.json) is the oracle for WHAT to
// assert; the authored roster is used only to learn HOW to drive each skill
// (id, cost, targeting, and the status/mark names each should produce).
//
// Frozen text (verbatim):
//   ayana0 Revered Daughter (passive): "Ayana gains 5 points of permanent
//       damage reduction for each of her living allies"
//   ayana1 Voice of Light: "Deals 15 damage to one enemy. If that enemy deals
//       new damage this turn, Ayana gains Elemental Essence"
//   ayana2 Chorus: "For Ayana's next 2 turns, Voice of Light and Prayer will
//       affect all valid targets."
//   ayana3 Prayer: "Ayana heals target ally for 10 HP. If they receive new
//       damage next turn, Ayana gains Elemental Essence."
//   ayana4 Cloister: "The Damage Reduction from Revered Daughter is doubled
//       for 1 turn."
//   ayana5 Voice of Glory: "Voice of Light and Prayer permanently last 1
//       additional turn. This effect stacks."
// Ayana's element is Holy — the specific cost is paid in the Holy pool.
// ============================================================================

const ENERGY = { generic: 40, holy: 40 };

function ayanaVs(allyIds: string[], enemyIds: string[]): { state: MatchState; ay: Unit } {
  const ay = loadHero(heroById("ayana"), "A", "ay");
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
const hasEssence = (u: Unit): boolean => u.statuses.some((s) => s.kind === "elemental_essence");
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const markOf = (u: Unit, name: string): Unit["statuses"][number] | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === name);

// ---------------------------------------------------------------------------
// ayana0 — Revered Daughter: 5 DR per LIVING ally (self excluded).
// ---------------------------------------------------------------------------

test("Revered Daughter: DR = 5 * (living hero allies); self is not an ally", () => {
  const { state } = ayanaVs(["a1", "a2"], ["e"]);
  emit(state, { type: "roundStart" });
  // 2 living allies -> 5*2 = 10. (If self were counted it would be 15; if minions/enemies
  // counted it'd differ — 10 pins "each of her living allies", self excluded.)
  assert.equal(drOf(state.units["ay"]!), 10, "2 living allies -> 10 DR");

  // Behavioral confirmation: 30 normal damage is mitigated by the 10 DR -> 20 HP lost.
  const r = applyDamage(state.units["ay"]!, { amount: 30, type: "normal" });
  assert.equal(r.hpLost, 20, "30 dealt - 10 DR = 20 taken");
});

test("Revered Daughter: with no allies DR is 0 (5 * 0)", () => {
  const { state } = ayanaVs([], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 0, "no allies -> 0 DR");
});

test("Revered Daughter: a DEAD ally does not count ('living')", () => {
  const ay = loadHero(heroById("ayana"), "A", "ay");
  const a1 = makeUnit({ id: "a1", team: "A" }); // living
  const a2 = makeUnit({ id: "a2", team: "A", alive: false, hp: 0 }); // dead
  const state = makeState([ay, a1, a2], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 5, "1 living + 1 dead -> 5 DR (dead excluded)");
});

test("Revered Daughter: DR recomputes DOWN when a living ally dies", () => {
  const { state } = ayanaVs(["a1", "a2"], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 10, "start: 2 allies -> 10 DR");
  // a2 dies.
  state.units["a2"]!.alive = false;
  state.units["a2"]!.hp = 0;
  emit(state, { type: "unitDied", unit: "a2", killer: null });
  assert.equal(drOf(state.units["ay"]!), 5, "after an ally dies -> 5 DR (1 living ally left)");
});

// ---------------------------------------------------------------------------
// ayana1 — Voice of Light: 15 damage to one enemy; essence if that enemy deals
// new damage this turn.
// ---------------------------------------------------------------------------

test("Voice of Light: deals exactly 15 to the chosen enemy; no essence merely from casting", () => {
  const { state } = ayanaVs([], ["e"]);
  const r = performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
  assert.ok(r.ok, `cast ok: ${r.reason ?? ""}`);
  assert.equal(state.units["e"]!.hp, 85, "100 - 15 = 85");
  assert.ok(markOf(state.units["e"]!, "Voice of Light"), "struck enemy is tagged Voice of Light");
  assert.equal(essenceCount(state.units["ay"]!), 0, "casting alone grants NO essence yet");
});

test("Voice of Light: essence iff the MARKED enemy deals damage (unmarked source is the control)", () => {
  const { state } = ayanaVs([], ["e1", "e2"]);
  const r = performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e1"] });
  assert.ok(r.ok, `cast ok: ${r.reason ?? ""}`);
  assert.ok(markOf(state.units["e1"]!, "Voice of Light"), "e1 tagged");
  assert.ok(!markOf(state.units["e2"]!, "Voice of Light"), "e2 (not targeted) untagged");

  // Control: an UNMARKED enemy dealing damage grants nothing.
  emit(state, { type: "damageDealt", source: "e2", target: "ay", amount: 7, dtype: "normal", isNew: true });
  assert.equal(essenceCount(state.units["ay"]!), 0, "unmarked enemy dealing damage -> no essence");

  // Positive: the MARKED enemy deals new damage this turn -> Ayana gains Elemental Essence.
  emit(state, { type: "damageDealt", source: "e1", target: "ay", amount: 7, dtype: "normal", isNew: true });
  assert.equal(essenceCount(state.units["ay"]!), 1, "marked enemy dealing damage -> exactly one essence");
});

// ---------------------------------------------------------------------------
// ayana2 — Chorus: for Ayana's next 2 turns, Voice of Light and Prayer affect
// ALL valid targets.
// ---------------------------------------------------------------------------

test("Chorus: Voice of Light hits ALL enemies while active (single-target is the control)", () => {
  // Control: no Chorus -> only the chosen enemy is struck.
  {
    const { state } = ayanaVs([], ["e1", "e2"]);
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e1"] });
    assert.equal(state.units["e1"]!.hp, 85, "e1 struck");
    assert.equal(state.units["e2"]!.hp, 100, "e2 untouched without Chorus");
  }
  // With Chorus -> every enemy is struck for 15 and every enemy is tagged.
  {
    const { state } = ayanaVs([], ["e1", "e2"]);
    const c = performAction(state, { unit: "ay", skillId: "ayana2", targets: [] });
    assert.ok(c.ok, `chorus ok: ${c.reason ?? ""}`);
    assert.equal(markOf(state.units["ay"]!, "Chorus")?.duration, 2, "Chorus lasts Ayana's next 2 turns");
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e1"] });
    assert.equal(state.units["e1"]!.hp, 85, "e1 struck for 15 under Chorus");
    assert.equal(state.units["e2"]!.hp, 85, "e2 ALSO struck for 15 under Chorus (all valid targets)");
    assert.ok(markOf(state.units["e2"]!, "Voice of Light"), "e2 also tagged under Chorus");
  }
});

test("Chorus: Prayer heals ALL allies while active (single-target is the control)", () => {
  // Control: no Chorus -> only the chosen ally heals.
  {
    const { state } = ayanaVs(["a1", "a2"], ["e"]);
    state.units["a1"]!.hp = 50;
    state.units["a2"]!.hp = 50;
    performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
    assert.equal(state.units["a1"]!.hp, 60, "a1 healed 10");
    assert.equal(state.units["a2"]!.hp, 50, "a2 not healed without Chorus");
  }
  // With Chorus -> every allied hero heals 10.
  {
    const { state } = ayanaVs(["a1", "a2"], ["e"]);
    state.units["a1"]!.hp = 50;
    state.units["a2"]!.hp = 50;
    performAction(state, { unit: "ay", skillId: "ayana2", targets: [] });
    performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
    assert.equal(state.units["a1"]!.hp, 60, "a1 healed 10 under Chorus");
    assert.equal(state.units["a2"]!.hp, 60, "a2 ALSO healed 10 under Chorus (all valid targets)");
  }
});

// ---------------------------------------------------------------------------
// ayana3 — Prayer: heal an ally for 10; essence if they receive new damage.
// ---------------------------------------------------------------------------

test("Prayer: heals target ally exactly 10 HP", () => {
  const { state } = ayanaVs(["a1"], ["e"]);
  state.units["a1"]!.hp = 50;
  const r = performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.ok(r.ok, `cast ok: ${r.reason ?? ""}`);
  assert.equal(state.units["a1"]!.hp, 60, "50 + 10 = 60");
  assert.ok(markOf(state.units["a1"]!, "Prayer"), "healed ally is tagged Prayer");
  assert.equal(essenceCount(state.units["ay"]!), 0, "healing alone grants NO essence yet");
});

test("Prayer: essence iff the MARKED ally receives damage (unmarked ally is the control)", () => {
  const { state } = ayanaVs(["a1", "a2"], ["e"]);
  state.units["a1"]!.hp = 50;
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.ok(markOf(state.units["a1"]!, "Prayer"), "a1 tagged");
  assert.ok(!markOf(state.units["a2"]!, "Prayer"), "a2 untagged");

  // Control: an UNMARKED ally receiving damage grants nothing.
  emit(state, { type: "damageDealt", source: "e", target: "a2", amount: 8, dtype: "normal", isNew: true });
  assert.equal(essenceCount(state.units["ay"]!), 0, "unmarked ally receiving damage -> no essence");

  // Positive: the MARKED ally receives new damage -> Ayana gains Elemental Essence.
  emit(state, { type: "damageDealt", source: "e", target: "a1", amount: 8, dtype: "normal", isNew: true });
  assert.equal(essenceCount(state.units["ay"]!), 1, "marked ally receiving damage -> exactly one essence");
});

// ---------------------------------------------------------------------------
// ayana4 — Cloister: doubles Revered Daughter's DR for 1 turn.
// ---------------------------------------------------------------------------

test("Cloister: doubles Revered Daughter DR, then reverts", () => {
  const { state } = ayanaVs(["a1", "a2"], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 10, "base DR with 2 allies = 10");

  const r = performAction(state, { unit: "ay", skillId: "ayana4", targets: [] });
  assert.ok(r.ok, `cloister ok: ${r.reason ?? ""}`);
  assert.equal(drOf(state.units["ay"]!), 20, "Cloister doubles DR: 10 -> 20");

  // "for 1 turn": cycle turns until the Cloister mark lapses; DR must revert to the base 10.
  let guard = 0;
  while (markOf(state.units["ay"]!, "Cloister") && guard++ < 8) endTurn(state);
  assert.ok(!markOf(state.units["ay"]!, "Cloister"), "Cloister mark eventually expires");
  assert.equal(drOf(state.units["ay"]!), 10, "after Cloister lapses DR reverts to base 10");
});

test("Cloister control: without Cloister the DR is the un-doubled 5 * allies", () => {
  const { state } = ayanaVs(["a1"], ["e"]);
  emit(state, { type: "roundStart" });
  assert.equal(drOf(state.units["ay"]!), 5, "1 ally, no Cloister -> 5 DR (not doubled)");
});

// ---------------------------------------------------------------------------
// ayana5 — Voice of Glory: Voice of Light & Prayer permanently last 1 more
// turn per cast (stacks).
// ---------------------------------------------------------------------------

// Base window with zero Voice of Glory stacks (measured, not assumed).
function baseVoLDuration(): number {
  const { state } = ayanaVs([], ["e"]);
  performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
  return markOf(state.units["e"]!, "Voice of Light")!.duration as number;
}
function basePrayerDuration(): number {
  const { state } = ayanaVs(["a1"], ["e"]);
  state.units["a1"]!.hp = 50;
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  return markOf(state.units["a1"]!, "Prayer")!.duration as number;
}

test("Voice of Glory: each cast adds exactly 1 turn to the Voice of Light window (stacks)", () => {
  const base = baseVoLDuration();
  assert.equal(typeof base, "number", "base VoL window is a finite duration");

  // One Voice of Glory -> +1.
  {
    const { state } = ayanaVs([], ["e"]);
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana5", targets: [] }).ok, "cast VoG once");
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(markOf(state.units["e"]!, "Voice of Light")!.duration, base + 1, "1 stack -> base + 1");
  }
  // Two Voice of Glory -> +2 (stacks). (Cooldown reset only to permit a second cast this turn;
  // the stacking clause, not the cooldown, is under test.)
  {
    const { state } = ayanaVs([], ["e"]);
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana5", targets: [] }).ok, "cast VoG #1");
    state.units["ay"]!.skills!.find((s) => s.id === "ayana5")!.currentCd = 0;
    assert.ok(performAction(state, { unit: "ay", skillId: "ayana5", targets: [] }).ok, "cast VoG #2");
    performAction(state, { unit: "ay", skillId: "ayana1", targets: ["e"] });
    assert.equal(markOf(state.units["e"]!, "Voice of Light")!.duration, base + 2, "2 stacks -> base + 2");
  }
});

test("Voice of Glory: also extends the Prayer window by 1 per stack", () => {
  const base = basePrayerDuration();
  const { state } = ayanaVs(["a1"], ["e"]);
  state.units["a1"]!.hp = 50;
  assert.ok(performAction(state, { unit: "ay", skillId: "ayana5", targets: [] }).ok, "cast VoG");
  performAction(state, { unit: "ay", skillId: "ayana3", targets: ["a1"] });
  assert.equal(markOf(state.units["a1"]!, "Prayer")!.duration, base + 1, "1 stack -> Prayer window base + 1");
});
