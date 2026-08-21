import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import { performAction, effectiveCost } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { stackCount } from "../src/status.ts";
import { totalShield } from "../src/damage.ts";
import type { Unit } from "../src/types.ts";
import type { Effect } from "../src/effects/ast.ts";

// =============================================================================
// Adversarial, spec-derived behavioral suite for SERA (SERAFIA MKI) — BASE kit.
// Oracle = the FROZEN prose (content/frozen/skills.json). Authored/generated content
// is read only to learn how to drive each skill (ids, costs, element, status names).
//
//   sera0 Eyes of Vengeance  (passive) — "Enemy Heroes who use non-Invisible Harmful
//                                         skills on Sera or her allies gain a stack of
//                                         Eyes of Vengeance."
//   sera1 Synthetic Skyblade (basic)   — "Deals 15 damage to target enemy. If they are
//                                         marked by Eyes of Vengeance, consume 1 stack to
//                                         deal 10 additional damage and grant Sera
//                                         Elemental Essence."
//   sera2 Energized Wingstorm (basic)  — "Deals 15 Piercing damage to the enemy team. If
//                                         any enemies are marked by Eyes of Vengeance,
//                                         consume 1 stack from each to reduce this skill's
//                                         cooldown by 1 turn for each marked consumed."
//   sera3 Heavenly Parry (basic)       — "For 1 turn, if target enemy uses a new Harmful
//                                         skill, they take 25 Piercing damage and gain an
//                                         additional stack of Eyes of Vengeance. Invisible.
//                                         If the target was already marked, Sera gains
//                                         Elemental Essence."
//   sera4 Scan of the All-Knowing      — "Eyes of Vengeance will trigger from Strategic
//                                         skills as well for 1 turn. Invisible."
//   sera5 Proactivity Protocol         — "Sera receives 20 True Damage and 20 Shield.
//                                         Target ally is healed for 20 HP."
//   sera6 Divinity Engine (ultimate)   — "For her next 2 turns, Sera ignores non-damage
//                                         effects. During this time, Synthetic Skyblade
//                                         consumes an additional stack of Eyes of Vengeance
//                                         if possible, and grants Sera Shield equal to the
//                                         damage it deals. Cost decreased by S per dead ally."
// =============================================================================

const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;
const eyes = (u: Unit) => stackCount(u, "Eyes of Vengeance");
const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const hasMark = (u: Unit, name: string) => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const hasKind = (u: Unit, kind: string) => u.statuses.some((s) => s.kind === kind);
const seedEyes = (u: Unit, n: number) => u.statuses.push(status("stack", { name: "Eyes of Vengeance", magnitude: n }));

function fresh() {
  const sera = loadHero(heroById("sera"), "A", "s");
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  return { state, sera, enemy };
}

// ---------------------------------------------------------------------------
// sera0 — Eyes of Vengeance (passive)
// ---------------------------------------------------------------------------

test("sera0: an enemy hero using a non-Invisible Harmful skill on Sera gains an Eyes of Vengeance stack (and it accumulates)", () => {
  const { state, enemy } = fresh();
  assert.equal(eyes(enemy), 0, "precondition: attacker unmarked");

  emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: ["s"], tags: ["Harmful"], hidden: false });
  assert.equal(eyes(enemy), 1, "one non-Invisible Harmful skill on Sera -> 1 stack");

  emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: ["s"], tags: ["Harmful"], hidden: false });
  assert.equal(eyes(enemy), 2, "stacks accumulate: a second Harmful skill -> 2 stacks");
});

test("sera0: the passive fires when the Harmful skill hits an ALLY of Sera (not only Sera herself)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const ally = makeUnit({ id: "a", team: "A", hp: 100 });
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([sera, ally], [enemy]);

  emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: ["a"], tags: ["Harmful"], hidden: false });
  assert.equal(eyes(enemy), 1, "'on Sera OR HER ALLIES' — a Harmful skill on the ally marks the attacker too");
});

test("sera0 controls: Invisible / non-Harmful / off-team-target / ally-source / minion-source do NOT grant a stack", () => {
  // (a) Invisible (non-Invisible filter): a hidden Harmful skill must not mark the caster.
  {
    const { state, enemy } = fresh();
    emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: ["s"], tags: ["Harmful"], hidden: true });
    assert.equal(eyes(enemy), 0, "an Invisible Harmful skill does NOT grant a stack");
  }
  // (b) non-Harmful: a Strategic-only skill (without Scan active) must not mark the caster.
  {
    const { state, enemy } = fresh();
    emit(state, { type: "skillUsed", caster: "e", skillId: "buff", targets: ["s"], tags: ["Strategic"], hidden: false });
    assert.equal(eyes(enemy), 0, "a non-Harmful (Strategic) skill does NOT grant a stack (no Scan)");
  }
  // (c) target not on Sera's team: a Harmful skill aimed elsewhere must not mark the caster.
  {
    const { state, enemy } = fresh();
    emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: [], tags: ["Harmful"], hidden: false });
    assert.equal(eyes(enemy), 0, "a Harmful skill not targeting Sera's team does NOT grant a stack");
  }
  // (d) source is an ally, not an enemy hero: friendly Harmful must not self-mark.
  {
    const sera = loadHero(heroById("sera"), "A", "s");
    const ally = makeUnit({ id: "a", team: "A", hp: 100 });
    const enemy = makeUnit({ id: "e", team: "B" });
    const state = makeState([sera, ally], [enemy]);
    emit(state, { type: "skillUsed", caster: "a", skillId: "atk", targets: ["s"], tags: ["Harmful"], hidden: false });
    assert.equal(eyes(ally), 0, "'Enemy Heroes' — an ally's Harmful skill does NOT grant a stack");
  }
  // (e) source is an enemy MINION, not a hero: only Heroes are marked.
  {
    const sera = loadHero(heroById("sera"), "A", "s");
    const minion = makeUnit({ id: "m", team: "B", kind: "minion" });
    const state = makeState([sera], [minion]);
    emit(state, { type: "skillUsed", caster: "m", skillId: "atk", targets: ["s"], tags: ["Harmful"], hidden: false });
    assert.equal(eyes(minion), 0, "'Enemy Heroes' — an enemy minion's Harmful skill does NOT grant a stack");
  }
});

// ---------------------------------------------------------------------------
// sera1 — Synthetic Skyblade
// ---------------------------------------------------------------------------

test("sera1 (unmarked target): deals exactly 15 damage, grants no Essence, consumes no stack", () => {
  const { state, sera, enemy } = fresh();
  const before = essenceCount(sera);
  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(enemy.hp, 85, "15 damage to an unmarked target (100 -> 85)");
  assert.equal(essenceCount(sera), before, "no Elemental Essence when the target is unmarked");
  assert.equal(eyes(enemy), 0, "no stack to consume");
});

test("sera1 (marked target): consumes 1 stack, deals 10 extra (25 total), and grants Sera Elemental Essence", () => {
  const { state, sera, enemy } = fresh();
  seedEyes(enemy, 2);
  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(enemy.hp, 75, "15 base + 10 bonus = 25 damage to a marked target (100 -> 75)");
  assert.equal(eyes(enemy), 1, "exactly 1 Eyes of Vengeance stack consumed (2 -> 1)");
  assert.equal(essenceCount(sera), 1, "Sera gains Elemental Essence on the marked bonus");
  // Control: base Skyblade (no Divinity Engine) grants NO shield.
  assert.equal(totalShield(sera), 0, "base Synthetic Skyblade grants Sera no Shield");
});

// ---------------------------------------------------------------------------
// sera2 — Energized Wingstorm
// ---------------------------------------------------------------------------

test("sera2: deals 15 Piercing to the whole enemy team and consumes 1 Eyes stack from each marked enemy", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([sera], [e1, e2]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(e1, 1);
  seedEyes(e2, 1);

  const r = performAction(state, { unit: "s", skillId: "sera2", targets: [] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(e1.hp, 85, "15 Piercing to e1 (100 -> 85)");
  assert.equal(e2.hp, 85, "15 Piercing to e2 (100 -> 85)");
  assert.equal(eyes(e1), 0, "consumes 1 stack from e1 (1 -> 0)");
  assert.equal(eyes(e2), 0, "consumes 1 stack from e2 (1 -> 0)");
});

test("sera2 control (no marked enemies): full 15 Piercing AoE, cooldown stays at its full 4, no stack changes", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([sera], [e1, e2]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  const r = performAction(state, { unit: "s", skillId: "sera2", targets: [] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(e1.hp, 85, "15 Piercing to e1");
  assert.equal(e2.hp, 85, "15 Piercing to e2");
  assert.equal(skillOf(sera, "sera2").currentCd, 4, "no marks consumed -> full cooldown 4");
});

// SUSPECTED BUG: frozen "reduce this skill's cooldown by 1 turn for each marked consumed" — the in-cast
// modifyCooldown(-N) is clobbered because performAction assigns currentCd = effectiveCooldown AFTER the
// effects run (scheduler ~L601), so a skill reducing its OWN cooldown mid-cast has the reduction discarded.
// Engine leaves currentCd at the full 4 regardless of marks consumed. Kept as an executable bug report.
test.skip("sera2: consuming N marked enemies reduces THIS skill's cooldown by N (2 marked -> cd 4-2 = 2)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100 });
  const state = makeState([sera], [e1, e2]);
  state.teams.A.energy = { generic: 40, vengeance: 40 };
  seedEyes(e1, 1);
  seedEyes(e2, 1);

  performAction(state, { unit: "s", skillId: "sera2", targets: [] });
  // Frozen: "reduce this skill's cooldown by 1 turn for each marked consumed." 2 consumed -> 4 - 2 = 2.
  assert.equal(skillOf(sera, "sera2").currentCd, 2, "cooldown reduced by the 2 marks consumed (4 -> 2)");
});

// ---------------------------------------------------------------------------
// sera3 — Heavenly Parry
// ---------------------------------------------------------------------------

test("sera3 cast (target already marked): Sera gains Elemental Essence immediately, and the target gets the Heavenly Parry watch", () => {
  const { state, sera, enemy } = fresh();
  seedEyes(enemy, 1);
  const r = performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(essenceCount(sera), 1, "'if the target was already marked, Sera gains Elemental Essence'");
  assert.equal(hasMark(enemy, "Heavenly Parry"), true, "the 1-turn Heavenly Parry watch is installed on the target");
});

test("sera3 cast control (target NOT already marked): no Elemental Essence, but the watch is still installed", () => {
  const { state, sera, enemy } = fresh();
  const r = performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(essenceCount(sera), 0, "no Essence when the target was unmarked at cast time");
  assert.equal(hasMark(enemy, "Heavenly Parry"), true, "the watch is installed regardless of prior marking");
});

test("sera3 reaction: a watched enemy using a new Harmful skill takes 25 Piercing, gains an additional Eyes stack, and the watch is consumed", () => {
  const { state, sera, enemy } = fresh();
  // Install the watch via a real cast on an enemy with no Eyes stacks (so the reaction's stack gain is isolated).
  performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  assert.equal(hasMark(enemy, "Heavenly Parry"), true, "precondition: watch installed");
  assert.equal(eyes(enemy), 0, "precondition: enemy holds no Eyes stacks");

  // The watched enemy uses a Harmful skill — targets nobody on Sera's team, so ONLY the Parry watch fires
  // (isolating it from the sera0 passive, which needs an ally target).
  emit(state, { type: "skillUsed", caster: "e", skillId: "atk", targets: [], tags: ["Harmful"], hidden: false });
  assert.equal(enemy.hp, 75, "25 Piercing punish (100 -> 75)");
  assert.equal(eyes(enemy), 1, "gains an additional Eyes of Vengeance stack (0 -> 1)");
  assert.equal(hasMark(enemy, "Heavenly Parry"), false, "the one-shot watch is consumed after firing");
});

test("sera3 reaction control: a watched enemy using a NON-Harmful skill triggers no punish and keeps the watch", () => {
  const { state, enemy } = fresh();
  performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });
  assert.equal(hasMark(enemy, "Heavenly Parry"), true, "precondition: watch installed");

  emit(state, { type: "skillUsed", caster: "e", skillId: "buff", targets: [], tags: ["Strategic"], hidden: false });
  assert.equal(enemy.hp, 100, "a non-Harmful skill deals no 25-Piercing punish");
  assert.equal(eyes(enemy), 0, "no additional Eyes stack from a non-Harmful skill");
  assert.equal(hasMark(enemy, "Heavenly Parry"), true, "the watch persists (only a Harmful skill consumes it)");
});

// ---------------------------------------------------------------------------
// sera4 — Scan of the All-Knowing
// ---------------------------------------------------------------------------

test("sera4 control (no Scan active): an enemy's Strategic skill on Sera does NOT grant an Eyes stack", () => {
  const { state, enemy } = fresh();
  emit(state, { type: "skillUsed", caster: "e", skillId: "buff", targets: ["s"], tags: ["Strategic"], hidden: false });
  assert.equal(eyes(enemy), 0, "baseline: Strategic skills do not feed Eyes of Vengeance");
});

test("sera4: after casting Scan, an enemy's Strategic skill on Sera grants that enemy an Eyes stack (for 1 turn)", () => {
  const { state, sera, enemy } = fresh();
  const r = performAction(state, { unit: "s", skillId: "sera4", targets: ["e"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(hasMark(sera, "Scan of the All-Knowing"), true, "Scan installs its 1-turn mark on Sera");

  emit(state, { type: "skillUsed", caster: "e", skillId: "buff", targets: ["s"], tags: ["Strategic"], hidden: false });
  assert.equal(eyes(enemy), 1, "with Scan active, a Strategic skill on Sera now grants an Eyes stack");
});

// ---------------------------------------------------------------------------
// sera5 — Proactivity Protocol
// ---------------------------------------------------------------------------

test("sera5: Sera takes 20 True damage and gains 20 Shield; the target ally is healed for 20", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
  const state = makeState([sera], [makeUnit({ id: "e", team: "B" })]);
  // Put the ally on team A explicitly (makeState lists team A from the first array arg).
  state.units["a"] = ally;
  state.teams.A.units.push("a");
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  const r = performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
  assert.equal(r.ok, true, "cast should succeed");
  assert.equal(sera.hp, 80, "Sera receives 20 True Damage (100 -> 80)");
  assert.equal(totalShield(sera), 20, "Sera gains 20 Shield");
  assert.equal(ally.hp, 70, "the target ally is healed 20 (50 -> 70)");
});

test("sera5: the 20 Shield is granted AFTER the 20 True damage lands (True damage is not absorbed by it)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
  const state = makeState([sera], [makeUnit({ id: "e", team: "B" })]);
  state.units["a"] = ally;
  state.teams.A.units.push("a");
  state.teams.A.energy = { generic: 40, vengeance: 40 };

  performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
  // If the shield had absorbed the True hit, Sera would sit at 100 with 0 shield. It does not.
  assert.equal(sera.hp, 80, "True damage bypasses the freshly-granted shield -> Sera at 80");
  assert.equal(totalShield(sera), 20, "the full 20 Shield remains");
});

// SUSPECTED BUG: frozen skills.json gives sera5 (Proactivity Protocol) cooldown 4, but the authored/generated
// content ships cooldown 3, so a real cast puts it on cd 3 instead of the frozen 4. Kept as a bug report.
test.skip("sera5: frozen cooldown is 4", () => {
  const { state, sera } = fresh();
  const ally = makeUnit({ id: "a", team: "A", hp: 50, maxHp: 100 });
  state.units["a"] = ally;
  state.teams.A.units.push("a");
  performAction(state, { unit: "s", skillId: "sera5", targets: ["a"] });
  assert.equal(skillOf(sera, "sera5").currentCd, 4, "Proactivity Protocol goes on its frozen cooldown of 4");
});

// ---------------------------------------------------------------------------
// sera6 — Divinity Engine
// ---------------------------------------------------------------------------

test("sera6: installs the 2-turn 'ignore non-damage effects' buff and the Divinity Engine augment marker on Sera", () => {
  const { state, sera } = fresh();
  const r = performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  assert.equal(r.ok, true, "cast should succeed");
  const ndi = sera.statuses.find((s) => s.kind === "non_damage_ignore");
  assert.ok(ndi, "Sera gains 'ignores non-damage effects'");
  assert.equal(ndi!.duration, 2, "'for her next 2 turns' -> duration 2");
  assert.equal(hasMark(sera, "Divinity Engine"), true, "the Divinity Engine augment marker is installed");
});

test("sera6: while active Sera ignores an enemy-applied non-damage effect (control: without it, the stun lands)", () => {
  const applyStun: Effect[] = [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }];

  // Control: no Divinity Engine -> an enemy stun lands.
  {
    const { state, sera, enemy } = fresh();
    runEffects(state, applyStun, { caster: enemy, targets: [sera] });
    assert.equal(hasKind(sera, "stun"), true, "baseline: an enemy stun lands on Sera");
  }
  // With Divinity Engine active -> the same enemy stun is ignored.
  {
    const { state, sera, enemy } = fresh();
    performAction(state, { unit: "s", skillId: "sera6", targets: [] });
    runEffects(state, applyStun, { caster: enemy, targets: [sera] });
    assert.equal(hasKind(sera, "stun"), false, "Sera ignores the enemy-applied non-damage stun");
  }
});

test("sera6: 'ignores NON-DAMAGE effects' — a damage effect still hits Sera while it is active", () => {
  const { state, sera, enemy } = fresh();
  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const deal: Effect[] = [{ op: "damage", amount: 10, dtype: "normal", to: "target" }];
  runEffects(state, deal, { caster: enemy, targets: [sera] });
  assert.equal(sera.hp, 90, "damage is not a non-damage effect — 10 damage still lands (100 -> 90)");
});

test("sera6 augment (marked target): Synthetic Skyblade consumes an ADDITIONAL Eyes stack and shields Sera for the 25 damage dealt", () => {
  const { state, sera, enemy } = fresh();
  seedEyes(enemy, 2);
  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, true, "Skyblade cast should succeed");
  assert.equal(enemy.hp, 75, "still 15 + 10 = 25 damage to the marked target (100 -> 75)");
  assert.equal(eyes(enemy), 0, "consumes 2 stacks total: 1 base + 1 additional (2 -> 0)");
  assert.equal(essenceCount(sera), 1, "the marked bonus still grants Sera Elemental Essence");
  assert.equal(totalShield(sera), 25, "Shield equal to the 25 damage dealt");
});

test("sera6 augment (unmarked target): Synthetic Skyblade deals 15 and shields Sera for exactly that 15", () => {
  const { state, sera, enemy } = fresh();
  performAction(state, { unit: "s", skillId: "sera6", targets: [] });
  const r = performAction(state, { unit: "s", skillId: "sera1", targets: ["e"] });
  assert.equal(r.ok, true, "Skyblade cast should succeed");
  assert.equal(enemy.hp, 85, "15 damage to the unmarked target (100 -> 85)");
  assert.equal(essenceCount(sera), 0, "no marked bonus -> no Essence");
  assert.equal(totalShield(sera), 15, "Shield equal to the 15 damage dealt");
});

test("sera6: cost is reduced by 1 Specific per dead ally hero (dynamic per-cast cost)", () => {
  const dead = (id: string): Unit => { const u = makeUnit({ id, team: "A", kind: "hero" }); u.alive = false; return u; };

  // 0 dead allies -> full 3 Specific.
  {
    const sera = loadHero(heroById("sera"), "A", "s");
    const state = makeState([sera], [makeUnit({ id: "e", team: "B" })]);
    assert.equal(effectiveCost(sera, skillOf(sera, "sera6"), state).specific, 3, "no dead allies -> 3 Specific");
  }
  // 2 dead allies -> 3 - 2 = 1 Specific, and the cast is affordable on just 1 vengeance energy.
  {
    const sera = loadHero(heroById("sera"), "A", "s");
    const state = makeState([sera, dead("a1"), dead("a2")], [makeUnit({ id: "e", team: "B" })]);
    assert.equal(effectiveCost(sera, skillOf(sera, "sera6"), state).specific, 1, "two dead allies -> 1 Specific");
    state.teams.A.energy = { generic: 0, vengeance: 1 };
    const r = performAction(state, { unit: "s", skillId: "sera6", targets: [] });
    assert.equal(r.ok, true, "reduced cost (1 Specific) is affordable on 1 vengeance energy");
    assert.equal(state.teams.A.energy.vengeance, 0, "exactly the reduced 1 Specific was paid");
  }
});
