import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts"; // side-effect: imports ROSTER (registers Slime template)
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// =====================================================================================================
// The River Daughter — FUSION FORMS behavioral suite, derived from the FROZEN PROSE (the oracle).
//
// Base kit (content/frozen/skills.json, riverdaughter0..5) that the forms build on:
//   0 Healing Tears (passive): "Whenever River Daughter counters or stuns an enemy, she heals her team for
//        5 HP every turn for 3 turns. Whenever this occurs, she gains Elemental Essence."
//   1 Ripple (all-enemies): "Deals 10 damage to the enemy team. The following turn, Undertow will stun ..."
//   2 Undertow (single):    "Target enemy receives 20 damage."
//   4 Soothe (single ally): "Heals an ally for 10 health each turn for 2 turns ..."
//   5 Dive (self):          "River Daughter becomes invulnerable for 1 turn ..."
//
// A fused hero's currentElement becomes the fusion element, so EVERY specific cost (base skills included)
// is paid from that element's pool — fullPay() stocks every color so a legal cast never starves.
// =====================================================================================================

const ESS = "elemental_essence";
type S = Unit["statuses"][number];
const regenOf = (u: Unit, name: string): S | undefined => u.statuses.find((s) => s.kind === "regen" && s.name === name);
const regensNamed = (u: Unit, name: string): S[] => u.statuses.filter((s) => s.kind === "regen" && s.name === name);
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === ESS).length;
const hasEssence = (u: Unit): boolean => u.statuses.some((s) => s.kind === ESS);
const markOf = (u: Unit, name: string): S | undefined => u.statuses.find((s) => s.kind === "mark" && s.name === name);
const idmodOf = (u: Unit): S | undefined => u.statuses.find((s) => s.kind === "incoming_damage_mod");
const odmodOf = (u: Unit): S | undefined => u.statuses.find((s) => s.kind === "outgoing_damage_mod");

/** Stock every color so a fused hero's specific cost (always paid in its fusion element) is coverable. */
const fullPay = (): Record<string, number> => ({
  generic: 40, water: 40, alchemy: 40, anointment: 40, blood: 40, current: 40,
  glacier: 40, mirror: 40, mist: 40, ocean: 40, serum: 40, slime: 40,
});

/** Synthetic enemy/ally skills used to drive declarations and reactions (all 0 cost). */
const attack = (dmg: number, id = "atk") =>
  skill(id, [{ op: "damage", amount: dmg, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], cooldown: 0 });
const strategicSelf = (id = "strat") => skill(id, [], { tags: ["Strategic", "Instant"], targeting: "self", cooldown: 0 });
const helpfulSelf = (id = "bless") => skill(id, [], { tags: ["Helpful", "Instant"], targeting: "self", cooldown: 0 });

interface SetupOpts { enemies?: number; allies?: number; minion?: boolean; }
function setup(key: string, opts: SetupOpts = {}) {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  const form = fusionForm("riverdaughter", key);
  assert.ok(form, `fusion form riverdaughter:${key} must exist`);
  applyFusion(rd, form as FusionForm);

  const aUnits: Unit[] = [rd];
  const allies: Unit[] = [];
  for (let i = 0; i < (opts.allies ?? 1); i++) {
    const a = makeUnit({ id: `a${i + 2}`, team: "A", name: `Ally${i + 1}`, hp: 100, maxHp: 100 });
    allies.push(a); aUnits.push(a);
  }
  let minion: Unit | undefined;
  if (opts.minion) {
    minion = makeUnit({ id: "am1", team: "A", name: "Splash", kind: "minion", hp: 20, maxHp: 40, summoner: "rd" });
    aUnits.push(minion);
  }
  const enemies: Unit[] = [];
  for (let i = 0; i < (opts.enemies ?? 1); i++) enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", name: `Enemy${i + 1}`, hp: 100, maxHp: 100 }));

  const state = makeState(aUnits, enemies);
  state.teams.A.energy = fullPay();
  state.teams.B.energy = fullPay();
  return { state, rd, allies, ally: allies[0]!, minion, enemies };
}

/** Advance whole turns via endTurn (hands over + ticks dots/durations/scheduled). */
function advance(state: ReturnType<typeof setup>["state"], n: number) {
  for (let i = 0; i < n; i++) endTurn(state);
}

// =====================================================================================================
// ALCHEMY — Unstable Waters (passive) + Mystic Essence (active)
// =====================================================================================================

// riverdaughteralchemy0 — "Undertow now increases the damage taken by the target by 5 for 2 turns."
test("Alchemy/Unstable Waters: Undertow makes its target take +5 damage; a later Ripple hits it for 15, others for 10", () => {
  const { state, enemies } = setup("alchemy", { enemies: 2 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // Undertow on e1
  assert.equal(r.ok, true, "Undertow cast succeeds");
  assert.equal(enemies[0]!.hp, 80, "Undertow's OWN hit is 20 (its +5 vulnerability applies to LATER hits, not itself)");
  const mod = idmodOf(enemies[0]!);
  assert.equal(mod?.magnitude, 5, "the target gained a +5 incoming-damage modifier");
  assert.equal(mod?.duration, 2, "lasting 2 turns");
  assert.equal(idmodOf(enemies[1]!), undefined, "the un-Undertow'd enemy has no vulnerability");

  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple: 10 base to all
  assert.equal(enemies[0]!.hp, 65, "the marked enemy took 10+5 = 15 (80 -> 65)");
  assert.equal(enemies[1]!.hp, 90, "the unmarked enemy took only 10 (100 -> 90)");
});

test("Alchemy/Unstable Waters: the +5 vulnerability WEARS OFF after 2 turns", () => {
  const { state, enemies } = setup("alchemy", { enemies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] });
  assert.equal(idmodOf(enemies[0]!)?.duration, 2, "duration 2 at application");
  advance(state, 5); // well past River Daughter's 2 subsequent turn-ends
  assert.equal(idmodOf(enemies[0]!), undefined, "the +5 incoming-damage modifier expired");
});

// riverdaughteralchemy1 — "Heals an ally for 10 health and increases all of their damage by 5 for 2 turns."
test("Alchemy/Mystic Essence: heals the ally 10 and boosts its damage by +5 for 2 turns; a non-target ally gets neither", () => {
  const { state, allies, enemies } = setup("alchemy", { enemies: 1, allies: 2 });
  const buffed = allies[0]!, control = allies[1]!;
  buffed.hp = 50; control.hp = 50;
  buffed.skills = [attack(20, "aatk")];
  control.skills = [attack(20, "aatk")];

  const r = performAction(state, { unit: "rd", skillId: "riverdaughteralchemy1", targets: ["a2"] });
  assert.equal(r.ok, true, "Mystic Essence cast succeeds");
  assert.equal(buffed.hp, 60, "the target healed 10 (50 -> 60)");
  assert.equal(odmodOf(buffed)?.magnitude, 5, "the target gained a +5 outgoing-damage modifier");
  assert.equal(odmodOf(buffed)?.duration, 2, "lasting 2 turns");
  assert.equal(control.hp, 50, "the untargeted ally is not healed");
  assert.equal(odmodOf(control), undefined, "the untargeted ally gets no damage boost");

  performAction(state, { unit: "a2", skillId: "aatk", targets: ["e1"] });
  assert.equal(enemies[0]!.hp, 75, "the buffed ally deals 20+5 = 25 (100 -> 75)");
  enemies[0]!.hp = 100;
  performAction(state, { unit: "a3", skillId: "aatk", targets: ["e1"] });
  assert.equal(enemies[0]!.hp, 80, "the control ally deals only 20 (100 -> 80)");
});

// =====================================================================================================
// ANOINTMENT — Fountain of Youth (passive) + Waters of Life (active)
// =====================================================================================================

// riverdaughteranointment0 — "The target of Soothe is now also cleansed of all enemy effects."
test("Anointment/Fountain of Youth: Soothe cleanses enemy-applied debuffs from its target; ally-applied buffs and other allies survive", () => {
  const { state, allies } = setup("anointment", { enemies: 1, allies: 2 });
  const target = allies[0]!, bystander = allies[1]!;
  // Target carries an ENEMY-applied stun + dot (should be cleansed) and an ALLY-applied buff (should stay).
  target.statuses.push({ kind: "stun", duration: 2, appliedBy: "e1", appliedTurn: 0 });
  target.statuses.push({ kind: "dot", magnitude: 5, duration: 3, appliedBy: "e1", appliedTurn: 0 });
  target.statuses.push({ kind: "damage_reduction", magnitude: 5, duration: 3, appliedBy: "rd", appliedTurn: 0 });
  // A DIFFERENT ally also holds an enemy debuff — Soothe targets only `target`, so this must be untouched.
  bystander.statuses.push({ kind: "stun", duration: 2, appliedBy: "e1", appliedTurn: 0 });

  const r = performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(r.ok, true, "Soothe cast succeeds");
  assert.equal(target.statuses.some((s) => s.kind === "stun"), false, "the enemy-applied stun was cleansed");
  assert.equal(target.statuses.some((s) => s.kind === "dot"), false, "the enemy-applied dot was cleansed");
  assert.ok(target.statuses.some((s) => s.kind === "damage_reduction"), "the ally-applied buff survives (only ENEMY effects are cleansed)");
  assert.ok(regenOf(target, "Soothe"), "Soothe still applies its own regen");
  assert.ok(bystander.statuses.some((s) => s.kind === "stun"), "a non-targeted ally keeps its enemy debuff");
});

// riverdaughteranointment1 — "Heals all allies and minions for 10 health for the next 3 turns."
test("Anointment/Waters of Life: 10/3 regen to every allied hero AND minion (incl. self); enemies get nothing", () => {
  const { state, rd, ally, minion, enemies } = setup("anointment", { enemies: 1, allies: 1, minion: true });
  rd.hp = 50; ally.hp = 50; minion!.hp = 10;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughteranointment1", targets: [] });
  assert.equal(r.ok, true, "Waters of Life cast succeeds");
  assert.equal(regenOf(rd, "Waters of Life")?.magnitude, 10, "River Daughter (self) gets the 10 regen");
  assert.equal(regenOf(rd, "Waters of Life")?.duration, 3, "for 3 turns");
  assert.equal(regenOf(ally, "Waters of Life")?.magnitude, 10, "the allied hero gets it");
  assert.equal(regenOf(minion!, "Waters of Life")?.magnitude, 10, "the allied minion gets it too");
  assert.equal(regenOf(enemies[0]!, "Waters of Life"), undefined, "the enemy gets nothing");

  advance(state, 3); // one tick at River Daughter's next turn-end
  assert.equal(ally.hp, 60, "the ally healed 10 on the tick (50 -> 60)");
  assert.equal(minion!.hp, 20, "the minion healed 10 on the tick (10 -> 20)");
});

// =====================================================================================================
// BLOOD — Blood in the Water (passive) + Run Red (active)
// =====================================================================================================

// riverdaughterblood0 — "River Daughter stores all of the damage she deals to the enemy team. Whenever
// Healing Tears triggers, she heals her team for 10 additional health for every 40 damage stored,
// emptying the stored damage."
test("Blood/Blood in the Water: 40 stored -> Healing Tears adds +10 team heal (base regen 5/3 preserved) and empties the store", () => {
  const { state, rd, ally } = setup("blood", { enemies: 1, allies: 1 });
  rd.hp = 50; ally.hp = 50;
  // Store 40 damage dealt to an enemy (drives the passive's damageDealt store).
  emit(state, { type: "damageDealt", source: "rd", target: "e1", amount: 40, dtype: "normal", isNew: true });
  // Healing Tears triggers when she stuns an enemy.
  emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

  assert.equal(regenOf(rd, "Healing Tears")?.magnitude, 5, "base Healing Tears regen 5 preserved");
  assert.equal(regenOf(ally, "Healing Tears")?.magnitude, 5, "ally gets the base regen too");
  assert.equal(hasEssence(rd), true, "River Daughter gains Elemental Essence (base Healing Tears)");
  assert.equal(rd.hp, 60, "the +10 (10 per 40 of 40 stored) instant heal landed (50 -> 60)");
  assert.equal(ally.hp, 60, "the ally got the +10 instant heal too");
});

test("Blood/Blood in the Water: damage dealt to an ALLY is not stored (no bonus on the next Healing Tears)", () => {
  const { state, rd, ally } = setup("blood", { enemies: 1, allies: 1 });
  rd.hp = 50; ally.hp = 50;
  emit(state, { type: "damageDealt", source: "rd", target: "a2", amount: 40, dtype: "normal", isNew: true }); // to an ally
  emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });
  assert.equal(regenOf(rd, "Healing Tears")?.magnitude, 5, "base Healing Tears still fires (stun)");
  assert.equal(rd.hp, 50, "but NO stored-damage bonus (damage to an ally is not stored)");
  assert.equal(ally.hp, 50, "ally got no bonus heal either");
});

// riverdaughterblood1 — "Deals 20 damage to target enemy, increased by 10 for every 20 damage stored in
// Blood in the Water, emptying the stored damage."
test("Blood/Run Red: 40 stored -> deals 20 + 10*floor(40/20) = 40, then empties the store", () => {
  const { state, enemies } = setup("blood", { enemies: 1 });
  emit(state, { type: "damageDealt", source: "rd", target: "e1", amount: 40, dtype: "normal", isNew: true }); // store 40
  enemies[0]!.hp = 100;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughterblood1", targets: ["e1"] });
  assert.equal(r.ok, true, "Run Red cast succeeds");
  assert.equal(enemies[0]!.hp, 60, "Run Red deals 20 + 20 = 40 (100 -> 60)");
  // Store emptied: a second stun-triggered Healing Tears grants no bonus heal.
  const { state: s2, rd } = setup("blood", { enemies: 1 });
  rd.hp = 50;
  emit(s2, { type: "damageDealt", source: "rd", target: "e1", amount: 40, dtype: "normal", isNew: true });
  performAction(s2, { unit: "rd", skillId: "riverdaughterblood1", targets: ["e1"] }); // empties the store
  emit(s2, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });
  assert.equal(rd.hp, 50, "after Run Red emptied the store, Healing Tears grants no +10 bonus");
});

test("Blood/Run Red: with NOTHING stored, deals just its base 20", () => {
  const { state, enemies } = setup("blood", { enemies: 1 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughterblood1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(enemies[0]!.hp, 80, "base 20 with no stored damage (100 -> 80)");
});

// =====================================================================================================
// CURRENT — Conducted Emotion (passive) + Catalytic Nova (active)
// =====================================================================================================

// riverdaughtercurrent0 — "Healing Tears now lasts one turn and heals 10 health, but it also activates
// whenever she gains Elemental Essence from another source. Triggering Healing Tears this way will not
// give River Daughter Elemental Essence."
test("Current/Conducted Emotion: stunning an enemy (via Ripple->Undertow) heals the team 10/1 + Essence", () => {
  const { state, rd, ally, enemies } = setup("current", { enemies: 1, allies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple primes Undertow's stun
  advance(state, 2);
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // Undertow stuns -> Healing Tears
  assert.ok(enemies[0]!.statuses.some((s) => s.kind === "stun"), "the enemy was stunned");
  assert.equal(regenOf(rd, "Healing Tears")?.magnitude, 10, "Conducted Emotion: heals 10 (not 5)");
  assert.equal(regenOf(rd, "Healing Tears")?.duration, 1, "and lasts 1 turn (not 3)");
  assert.equal(regenOf(ally, "Healing Tears")?.magnitude, 10, "the team is healed");
  assert.equal(essenceCount(rd), 1, "stunning grants exactly one Elemental Essence");
});

test("Current/Conducted Emotion: gaining Essence from ANOTHER source re-triggers Healing Tears (heal only, no extra Essence)", () => {
  const { state, rd, ally } = setup("current", { enemies: 1, allies: 1 });
  rd.statuses.push({ kind: ESS, duration: null, appliedBy: "e1", appliedTurn: 0 }); // gained from an external source
  emit(state, { type: "statusApplied", unit: "rd", source: "e1", kind: ESS });
  assert.equal(regenOf(rd, "Healing Tears")?.magnitude, 10, "external Essence re-triggers Healing Tears (heal 10)");
  assert.equal(regenOf(ally, "Healing Tears")?.magnitude, 10, "the whole team is healed");
  assert.equal(essenceCount(rd), 1, "no ADDITIONAL Essence from triggering it this way (still the one she gained)");
});

test("Current/Conducted Emotion: Essence she grants HERSELF does not re-trigger Healing Tears (no loop)", () => {
  const { state, rd, ally } = setup("current", { enemies: 1, allies: 1 });
  rd.statuses.push({ kind: ESS, duration: null, appliedBy: "rd", appliedTurn: 0 }); // self-granted
  emit(state, { type: "statusApplied", unit: "rd", source: "rd", kind: ESS });
  assert.equal(regenOf(rd, "Healing Tears"), undefined, "self-granted Essence (source==self) must not re-fire");
  assert.equal(regenOf(ally, "Healing Tears"), undefined, "no team heal from her own Essence grant");
});

// riverdaughtercurrent1 — "Deals 10 damage to the enemy team and increases the damage of your next Ripple
// by 10, stacking infinitely. If this skill is used again on the following turn, River Daughter gains
// Elemental Essence"
test("Current/Catalytic Nova: deals 10 to the whole enemy team; allies untouched", () => {
  const { state, rd, ally, enemies } = setup("current", { enemies: 2, allies: 1 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughtercurrent1", targets: [] });
  assert.equal(r.ok, true, "Catalytic Nova cast succeeds");
  assert.equal(enemies[0]!.hp, 90, "enemy 1 took 10");
  assert.equal(enemies[1]!.hp, 90, "enemy 2 took 10 (hits the enemy team)");
  assert.equal(ally.hp, 100, "allied hero untouched");
  assert.equal(rd.hp, 100, "caster untouched");
});

test("Current/Catalytic Nova: used again on the FOLLOWING turn grants Elemental Essence; a single cast does not", () => {
  // Positive — two consecutive casts.
  {
    const { state, rd } = setup("current", { enemies: 1 });
    performAction(state, { unit: "rd", skillId: "riverdaughtercurrent1", targets: [] }); // turn 1: no chain yet
    assert.equal(essenceCount(rd), 0, "first Catalytic Nova grants no Essence");
    advance(state, 2); // River Daughter's following turn (chain window still open)
    state.teams.A.energy = fullPay();
    performAction(state, { unit: "rd", skillId: "riverdaughtercurrent1", targets: [] }); // turn 3: chained
    assert.equal(essenceCount(rd), 1, "using it again the following turn grants Essence");
  }
  // Control — a single cast never grants Essence.
  {
    const { state, rd } = setup("current", { enemies: 1 });
    performAction(state, { unit: "rd", skillId: "riverdaughtercurrent1", targets: [] });
    assert.equal(essenceCount(rd), 0, "one Catalytic Nova, no chain -> no Essence");
  }
});

// riverdaughtercurrent1 clause 2 — "increases the damage of your next Ripple by 10, stacking infinitely."
// SUSPECTED BUG: Catalytic Nova adds a "Catalytic Nova" bonus stack, but base Ripple (riverdaughter1)
// deals a FLAT 10 and never reads that stack — so the "next Ripple +10" bonus is unwired. Frozen expects
// the primed Ripple to deal 20; the engine deals only 10.
test("Current/Catalytic Nova increases the next Ripple's damage by 10 (stacking)", () => {
  const { state, enemies } = setup("current", { enemies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughtercurrent1", targets: [] }); // Nova: -10 (100 -> 90), arms +10 Ripple
  const before = enemies[0]!.hp;
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple should hit for 10 + 10 = 20
  assert.equal(before - enemies[0]!.hp, 20, "the primed Ripple deals 20 (10 base + 10 from Catalytic Nova)");
});

// =====================================================================================================
// GLACIER — Winter Flow (passive) + Spring Thaw (active)
// =====================================================================================================

// riverdaughterglacier0 — "Soothe now heals the ally for 5 health on the first turn, 10 health on the
// second, and 15 on the third turn."
test("Glacier/Winter Flow: Soothe heals 5 immediately (the first turn's heal)", () => {
  const { state, ally } = setup("glacier", { enemies: 1, allies: 1 });
  ally.hp = 50;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(r.ok, true, "Soothe cast succeeds");
  assert.equal(ally.hp, 55, "the first-turn heal of 5 lands immediately (50 -> 55)");
});

// The escalating 5/10/15 REPLACES Soothe's base flat 10/turn-for-2 regen ("Soothe NOW heals ...").
// SUSPECTED BUG: the glacier form ADDS the escalating heal on top of Soothe's base 10/2 regen instead of
// replacing it (the base skill's regen is never suppressed). Frozen says Soothe "now heals 5/10/15", i.e.
// a redefinition — so the ally should NOT also carry the base 10/2 regen (which would double the healing).
test("Glacier/Winter Flow escalation REPLACES Soothe's base 10/2 regen with 5/10/15", () => {
  const { state, ally } = setup("glacier", { enemies: 1, allies: 1 });
  ally.hp = 50;
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(regenOf(ally, "Soothe"), undefined, "no flat 10/2 'Soothe' regen — the escalating heal replaces it");
});

// riverdaughterglacier1 — "Grants an ally 20 shield for 1 turn. The following turn, they gain 10 shield for 1 turn."
test("Glacier/Spring Thaw: 20 shield now, then +10 shield the following turn; a non-target ally gets none", () => {
  const { state, allies } = setup("glacier", { enemies: 1, allies: 2 });
  const target = allies[0]!, control = allies[1]!;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughterglacier1", targets: ["a2"] });
  assert.equal(r.ok, true, "Spring Thaw cast succeeds");
  assert.equal(totalShield(target), 20, "the ally gains 20 shield immediately");
  assert.equal(totalShield(control), 0, "the untargeted ally gets no shield");

  advance(state, 3); // River Daughter's following turn-end fires the scheduled +10 (the first 20 has expired)
  assert.equal(totalShield(target), 10, "the following turn the ally gains 10 shield (the initial 20 wore off)");
});

// =====================================================================================================
// MIRROR — Reflection of Kindness (passive) + Party Crasher (active)
// =====================================================================================================

// riverdaughtermirror0 — "River Daughter stores all healing received by the enemy team. Each time she
// accumulates 50 total healing, she gains Elemental Essence and deals 15 Affliction damage to all enemies."
// SUSPECTED BUG: the 15 Affliction is dealt TWICE per 50 accumulated. The generated passive runs an inline
// `damage 15 affliction` AND then calls `spendStack`, whose while-loop ALSO deals 15 affliction to every
// enemy for each 50 consumed. Frozen says "deals 15 Affliction damage to all enemies" (once per 50) — the
// engine deals 30. (Essence is deduped to one, so only the damage over-fires.)
test("Mirror/Reflection of Kindness deals 15 Affliction to all enemies once per 50 stored", () => {
  const { state, rd, enemies } = setup("mirror", { enemies: 2 });
  emit(state, { type: "healReceived", unit: "e1", source: "e2", amount: 30, overheal: 0 }); // tally 30 — not yet
  assert.equal(hasEssence(rd), false, "under 50 accumulated: no Essence yet");
  assert.equal(enemies[0]!.hp, 100, "no Affliction yet");
  emit(state, { type: "healReceived", unit: "e1", source: "e2", amount: 30, overheal: 0 }); // tally 60 -> crosses 50
  assert.equal(hasEssence(rd), true, "crossing 50 accumulated grants Elemental Essence");
  assert.equal(enemies[0]!.hp, 85, "enemy 1 took 15 Affliction");
  assert.equal(enemies[1]!.hp, 85, "enemy 2 took 15 Affliction (ALL enemies)");
});

test("Mirror/Reflection of Kindness: healing on an ALLY is not stored (only the enemy team counts)", () => {
  const { state, rd, enemies } = setup("mirror", { enemies: 1, allies: 1 });
  emit(state, { type: "healReceived", unit: "a2", source: "rd", amount: 90, overheal: 0 }); // ally healing
  assert.equal(hasEssence(rd), false, "ally healing does not accumulate");
  assert.equal(enemies[0]!.hp, 100, "no Affliction from ally healing");
});

// riverdaughtermirror1 — "Deals 20 damage to target enemy." (base clause)
test("Mirror/Party Crasher: deals 20 to the target enemy", () => {
  const { state, enemies } = setup("mirror", { enemies: 2 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughtermirror1", targets: ["e1"] });
  assert.equal(r.ok, true, "Party Crasher cast succeeds");
  assert.equal(enemies[0]!.hp, 80, "the target took 20 (100 -> 80)");
  assert.equal(enemies[1]!.hp, 100, "the other enemy is untouched (single target)");
});

// riverdaughtermirror1 clause 2 — "This skill deals bonus damage equal to the healing the target received
// last round."
// SUSPECTED BUG: the bonus reads a `var healingReceivedLastRound`, but nothing in the engine ever tracks or
// writes per-unit healing-received-last-round — `ctx.vars` is always a fresh {} — so the bonus is always 0.
// Frozen expects 20 + (healing last round); the engine deals only the flat 20.
test("Mirror/Party Crasher adds the target's last-round healing as bonus damage", () => {
  const { state, enemies } = setup("mirror", { enemies: 1 });
  // e1 received 30 healing "last round".
  emit(state, { type: "healReceived", unit: "e1", source: "e1", amount: 30, overheal: 0 });
  state.round += 1; // now it is the NEXT round
  enemies[0]!.hp = 100;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughtermirror1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(enemies[0]!.hp, 50, "20 base + 30 (healing received last round) = 50 damage (100 -> 50)");
});

// =====================================================================================================
// MIST — Shallows Dance (passive) + Shallow Slash (active)
// =====================================================================================================

// riverdaughtermist0 — "River Daughter starts each round under the effect of Dive, but it no longer makes
// her invulnerable. ..."
test("Mist/Shallows Dance: at round start she is under Dive but NOT invulnerable", () => {
  const { state, rd } = setup("mist", { enemies: 1 });
  emit(state, { type: "roundStart" });
  assert.ok(markOf(rd, "Dive"), "River Daughter starts the round under Dive");
  assert.equal(rd.statuses.some((s) => s.kind === "invulnerable"), false, "Dive no longer grants invulnerability");
});

// "Instead, while Dive is active, River Daughter deals 10 piercing damage to any enemy that uses a harmful skill."
test("Mist/Shallows Dance: while under Dive, an enemy's Harmful skill takes 10 piercing back; a non-harmful skill does not", () => {
  // Positive — enemy uses a Harmful skill.
  {
    const { state, enemies } = setup("mist", { enemies: 1 });
    emit(state, { type: "roundStart" }); // grants Dive
    enemies[0]!.skills = [attack(20)];
    performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
    assert.equal(enemies[0]!.hp, 90, "the attacker took 10 piercing (100 -> 90)");
  }
  // Control (skill kind) — enemy uses a Helpful skill: no reflect.
  {
    const { state, enemies } = setup("mist", { enemies: 1 });
    emit(state, { type: "roundStart" });
    enemies[0]!.skills = [helpfulSelf()];
    performAction(state, { unit: "e1", skillId: "bless", targets: [] });
    assert.equal(enemies[0]!.hp, 100, "a non-harmful skill provokes no reflect");
  }
  // Control (no Dive) — without the Dive stance, a Harmful skill is not punished.
  {
    const { state, enemies } = setup("mist", { enemies: 1 }); // no roundStart -> no Dive
    enemies[0]!.skills = [attack(20)];
    performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
    assert.equal(enemies[0]!.hp, 100, "no Dive -> no reflect");
  }
});

// riverdaughtermist1 — "Deals 15 piercing damage to target enemy. If used from Dive, this skill reactivates Dive."
test("Mist/Shallow Slash: 15 piercing to the target; reactivates Dive when used from Dive, and does not create Dive otherwise", () => {
  // Used from Dive: 15 piercing + Dive stays active.
  {
    const { state, rd, enemies } = setup("mist", { enemies: 2 });
    emit(state, { type: "roundStart" }); // Dive
    const r = performAction(state, { unit: "rd", skillId: "riverdaughtermist1", targets: ["e1"] });
    assert.equal(r.ok, true, "Shallow Slash cast succeeds");
    assert.equal(enemies[0]!.hp, 85, "the target took 15 (100 -> 85)");
    assert.equal(enemies[1]!.hp, 100, "the other enemy is untouched (single target)");
    assert.ok(markOf(rd, "Dive"), "used from Dive -> Dive remains active (reactivated)");
  }
  // NOT from Dive: still 15 damage, but Dive is NOT conjured.
  {
    const { state, rd, enemies } = setup("mist", { enemies: 1 }); // no roundStart -> no Dive
    const r = performAction(state, { unit: "rd", skillId: "riverdaughtermist1", targets: ["e1"] });
    assert.equal(r.ok, true);
    assert.equal(enemies[0]!.hp, 85, "still deals 15 piercing");
    assert.equal(markOf(rd, "Dive"), undefined, "not used from Dive -> no Dive granted (it only REactivates)");
  }
});

// =====================================================================================================
// OCEAN — Triton's Blessing (passive) + Atlantean Assault (active)
// =====================================================================================================

// riverdaughterocean0 — "Healing Tears is now triggered whenever an enemy uses a Strategic skill. Heroes
// can only have one heal-over-time effect from Triton's Blessing at a time."
test("Ocean/Triton's Blessing: an enemy using a Strategic skill grants a team 'Triton's Blessing' regen 5/3 + Essence", () => {
  const { state, rd, ally } = setup("ocean", { enemies: 1, allies: 1 });
  state.units["e1"]!.skills = [strategicSelf()];
  performAction(state, { unit: "e1", skillId: "strat", targets: [] });
  assert.equal(regenOf(rd, "Triton's Blessing")?.magnitude, 5, "self healed: Triton's Blessing 5");
  assert.equal(regenOf(rd, "Triton's Blessing")?.duration, 3, "for 3 turns");
  assert.equal(regenOf(ally, "Triton's Blessing")?.magnitude, 5, "the ally is healed too");
  assert.equal(hasEssence(rd), true, "River Daughter gains Elemental Essence");
});

test("Ocean/Triton's Blessing: an enemy's non-Strategic (Harmful) skill does NOT trigger it", () => {
  const { state, rd } = setup("ocean", { enemies: 1 });
  state.units["e1"]!.skills = [attack(10)];
  performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.equal(regenOf(rd, "Triton's Blessing"), undefined, "a Harmful skill does not trigger Triton's Blessing");
  assert.equal(hasEssence(rd), false, "no Essence from a Harmful enemy skill");
});

test("Ocean/Triton's Blessing: a hero holds only ONE Triton's Blessing at a time (re-application refreshes, not stacks)", () => {
  const { state, rd } = setup("ocean", { enemies: 1 });
  state.units["e1"]!.skills = [strategicSelf()];
  performAction(state, { unit: "e1", skillId: "strat", targets: [] });
  state.units["e1"]!.skills![0]!.currentCd = 0;
  performAction(state, { unit: "e1", skillId: "strat", targets: [] }); // trigger it a second time
  assert.equal(regensNamed(rd, "Triton's Blessing").length, 1, "still only one Triton's Blessing regen (single-copy)");
});

// riverdaughterocean1 — "Deals 20 damage to target enemy until River Daughter stops Channeling."
test("Ocean/Atlantean Assault: 20 on cast, re-runs 20 each River Daughter turn, and stops when she acts otherwise", () => {
  const { state, enemies } = setup("ocean", { enemies: 1 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughterocean1", targets: ["e1"] });
  assert.equal(r.ok, true, "Atlantean Assault cast succeeds");
  assert.equal(enemies[0]!.hp, 80, "the initial hit deals 20 (100 -> 80)");
  assert.ok(state.units["rd"]!.statuses.some((s) => s.kind === "channeling"), "she is now Channeling");

  advance(state, 2); // hand A->B->A
  startTurn(state); // River Daughter's turn start re-runs the channel
  assert.equal(enemies[0]!.hp, 60, "the channel re-ran for another 20 (80 -> 60)");

  // Acting otherwise stops the channel.
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // Undertow interrupts the channel
  assert.equal(state.units["rd"]!.statuses.some((s) => s.kind === "channeling"), false, "casting another skill stops the channel");
  const afterUndertow = enemies[0]!.hp;
  advance(state, 2);
  startTurn(state);
  assert.equal(enemies[0]!.hp, afterUndertow, "with the channel stopped, no further 20 damage ticks");
});

// =====================================================================================================
// SERUM — Toxic Waste (passive) + Chemical Bath (active)
// =====================================================================================================

// riverdaughterserum0 — "Any overhealing done by River Daughter is dealt to a random enemy as Affliction damage."
test("Serum/Toxic Waste: overheal by River Daughter is dealt to a random enemy as Affliction; no overheal -> nothing", () => {
  // Positive — she overheals an ally by 15; some enemy loses 15.
  {
    const { state, enemies } = setup("serum", { enemies: 2, allies: 1 });
    emit(state, { type: "healReceived", unit: "a2", source: "rd", amount: 5, overheal: 15 });
    const totalLost = enemies.reduce((sum, e) => sum + (100 - e.hp), 0);
    assert.equal(totalLost, 15, "exactly 15 Affliction was dealt across the enemy team (to one random enemy)");
  }
  // Control — a heal with no overheal deals nothing.
  {
    const { state, enemies } = setup("serum", { enemies: 1, allies: 1 });
    emit(state, { type: "healReceived", unit: "a2", source: "rd", amount: 10, overheal: 0 });
    assert.equal(enemies[0]!.hp, 100, "no overheal -> no Affliction");
  }
  // Control — overheal from a NON-River-Daughter healer is not redirected.
  {
    const { state, enemies } = setup("serum", { enemies: 1, allies: 1 });
    emit(state, { type: "healReceived", unit: "a2", source: "a2", amount: 5, overheal: 15 });
    assert.equal(enemies[0]!.hp, 100, "overheal by someone else does not trigger Toxic Waste");
  }
});

// riverdaughterserum1 — "Stuns target enemy's Strategic skills for 1 turn. If used from Dive, this skill
// stuns for 2 turns instead."
// SUSPECTED BUG: Chemical Bath applies a `silence` status scoped to Strategic, but the engine's `silence`
// only suppresses Elemental Essence income (see types.ts) — it never blocks skill casting (isStunnedFor
// checks `stun`, not `silence`). Frozen says the target's Strategic skills are STUNNED (uncastable) for a
// turn; the engine still lets the target cast Strategic skills freely.
test("Serum/Chemical Bath: stuns the target Strategic skills (scoped stun, 1 turn / 2 from Dive)", () => {
  const { state } = setup("serum", { enemies: 1 });
  const enemy = state.units["e1"]!;
  enemy.skills = [strategicSelf("estrat"), attack(10, "eatk")];
  const r = performAction(state, { unit: "rd", skillId: "riverdaughterserum1", targets: ["e1"] });
  assert.equal(r.ok, true, "Chemical Bath cast succeeds");
  const strat = performAction(state, { unit: "e1", skillId: "estrat", targets: [] });
  assert.equal(strat.ok, false, "the enemy's Strategic skill is stunned (blocked)");
  const harm = performAction(state, { unit: "e1", skillId: "eatk", targets: ["rd"] });
  assert.equal(harm.ok, true, "a non-Strategic skill is still usable");
});

// =====================================================================================================
// SLIME — Bubbling Mire (passive) + Congeal (active)
// =====================================================================================================

// riverdaughterslime0 — "River Daughter begins each round with two Slime minions. ..."
test("Slime/Bubbling Mire: she begins each round with exactly two Slime minions on her side", () => {
  const { state } = setup("slime", { enemies: 1 });
  emit(state, { type: "roundStart" });
  const slimes = Object.values(state.units).filter((u) => u.kind === "minion" && u.team === "A" && u.name === "Slime");
  assert.equal(slimes.length, 2, "two Slime minions are summoned on River Daughter's side");
});

// "Enemies who deal new damage to Slime minions receive 5 Affliction damage."
test("Slime/Bubbling Mire: an enemy that damages a Slime takes 5 Affliction; an ally attacker or a hero target does not", () => {
  // Positive — enemy damages a Slime minion.
  {
    const { state } = setup("slime", { enemies: 1 });
    const slime = makeUnit({ id: "sl1", team: "A", name: "Slime", kind: "minion", hp: 15, maxHp: 15, summoner: "rd" });
    state.units["sl1"] = slime; state.teams.A.units.push("sl1");
    emit(state, { type: "damageDealt", source: "e1", target: "sl1", amount: 10, dtype: "normal", isNew: true });
    assert.equal(state.units["e1"]!.hp, 95, "the enemy attacker took 5 Affliction (100 -> 95)");
  }
  // Control — an ALLY dealing damage to a Slime provokes nothing.
  {
    const { state } = setup("slime", { enemies: 1, allies: 1 });
    const slime = makeUnit({ id: "sl1", team: "A", name: "Slime", kind: "minion", hp: 15, maxHp: 15, summoner: "rd" });
    state.units["sl1"] = slime; state.teams.A.units.push("sl1");
    emit(state, { type: "damageDealt", source: "a2", target: "sl1", amount: 10, dtype: "normal", isNew: true });
    assert.equal(state.units["e1"]!.hp, 100, "an ally attacker is not punished");
  }
  // Control — an enemy damaging a HERO (not a minion) provokes nothing.
  {
    const { state } = setup("slime", { enemies: 1 });
    emit(state, { type: "damageDealt", source: "e1", target: "rd", amount: 10, dtype: "normal", isNew: true });
    assert.equal(state.units["e1"]!.hp, 100, "damaging a hero (not a Slime minion) is not punished");
  }
});

// riverdaughterslime1 — "Restores 15HP to all Slime Minions. Any healing past max is added as Max HP."
test("Slime/Congeal: heals every Slime +15 (overheal -> Max HP); a non-Slime ally is not healed", () => {
  const { state } = setup("slime", { enemies: 1 });
  const damaged = makeUnit({ id: "sl1", team: "A", name: "Slime", kind: "minion", hp: 5, maxHp: 15, summoner: "rd" });
  const full = makeUnit({ id: "sl2", team: "A", name: "Slime", kind: "minion", hp: 15, maxHp: 15, summoner: "rd" });
  const other = makeUnit({ id: "sp1", team: "A", name: "Splash", kind: "minion", hp: 5, maxHp: 15, summoner: "rd" });
  for (const m of [damaged, full, other]) { state.units[m.id] = m; state.teams.A.units.push(m.id); }

  const r = performAction(state, { unit: "rd", skillId: "riverdaughterslime1", targets: [] });
  assert.equal(r.ok, true, "Congeal cast succeeds");
  assert.equal(damaged.hp, 20, "the damaged Slime healed +15 (5 -> 20)");
  assert.equal(damaged.maxHp, 20, "the 5 overheal became Max HP");
  assert.equal(full.hp, 30, "the full Slime's +15 all overheals (15 -> 30)");
  assert.equal(full.maxHp, 30, "raising its Max HP to 30");
  assert.equal(other.hp, 5, "a non-Slime minion is NOT healed by Congeal");
});
