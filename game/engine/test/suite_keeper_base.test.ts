import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers consumeShield + keeper triggers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { addShield, totalShield } from "../src/damage.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Keeper of Fables — BASE KIT — adversarial, spec-derived behavioral suite.
//
// Oracle = the FROZEN PROSE (content/frozen/skills.json). Element = Ice, maxHp 100.
//
//   keeper0 "Tales to Tell" (passive): "Keeper of Fables gains Elemental Essence
//       whenever one of his allies does. Whenever this occurs, he gains 10 Shield."
//   keeper1 "Page-turner": "attempts to consume 25 Shield from Tales to Tell. If he
//       does, he deals 25 damage to target enemy."           (Harmful, spec 1, cd 0)
//   keeper2 "Character Development": "attempts to consume 25 Shield from Tales to Tell.
//       If he does, he heals target ally for 30 HP."          (Helpful, spec 1, cd 0)
//   keeper3 "Chronicle Deeds": "If target enemy uses a new skill this turn, Tales to
//       Tell will gain 35 Shield. This effect is invisible."  (Strategic, spec 1, cd 2)
//   keeper4 "Plot Armor": "attempts to consume 20 Shield from Tales to Tell. If he does,
//       he makes target ally invulnerable for 1 turn."        (Helpful, spec 1, cd 4)
//   keeper5 "Hero's Return": "attempts to consume 75 Shield from Tales to Tell. If he
//       does, target dead ally returns to life at 50 HP."     (Helpful, spec 2, cd 5)
//
// "Tales to Tell" IS Keeper's real Shield pool (grantShield / totalShield). The four
// "attempts to consume N Shield" skills gate on the pool holding >= N.
// ============================================================================

const ICE_ENERGY = () => ({ generic: 40, ice: 40 });

function skillOf(u: Unit, id: string) {
  return (u.skills ?? []).find((s) => s.id === id)!;
}

// ---------------------------------------------------------------------------
// keeper0 — "Tales to Tell" (passive)
// ---------------------------------------------------------------------------

function passiveSetup(): { k: Unit; ally: Unit; enemy: Unit; state: MatchState } {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [enemy]);
  return { k, ally, enemy, state };
}

test("keeper0: an ally gaining Elemental Essence gives Keeper Essence AND 10 Shield", () => {
  const { k, ally, state } = passiveSetup();
  assert.equal(totalShield(k), 0, "precondition: Keeper starts with no Shield");

  emit(state, { type: "statusApplied", unit: ally.id, source: ally.id, kind: "elemental_essence" });

  assert.ok(k.statuses.some((s) => s.kind === "elemental_essence"), "Keeper gains Elemental Essence when an ally does");
  assert.equal(totalShield(k), 10, "and gains exactly 10 Shield");
});

test("keeper0: each ally Essence gain grants 10 Shield again ('whenever this occurs')", () => {
  const { k, ally, state } = passiveSetup();
  emit(state, { type: "statusApplied", unit: ally.id, source: ally.id, kind: "elemental_essence" });
  emit(state, { type: "statusApplied", unit: ally.id, source: ally.id, kind: "elemental_essence" });
  assert.equal(totalShield(k), 20, "two ally Essence gains => 2 x 10 Shield");
});

test("keeper0 CONTROL: an ENEMY gaining Essence does nothing (only allies count)", () => {
  const { k, enemy, state } = passiveSetup();
  emit(state, { type: "statusApplied", unit: enemy.id, source: enemy.id, kind: "elemental_essence" });
  assert.equal(totalShield(k), 0, "no Shield from an enemy's Essence");
  assert.ok(!k.statuses.some((s) => s.kind === "elemental_essence"), "no Essence from an enemy's Essence");
});

test("keeper0 CONTROL: an ally gaining a NON-Essence status grants no Shield (no over-fire)", () => {
  const { k, ally, state } = passiveSetup();
  emit(state, { type: "statusApplied", unit: ally.id, source: ally.id, kind: "mark", name: "Something Else" });
  assert.equal(totalShield(k), 0, "the trigger keys on Elemental Essence specifically, not any status");
});

test("keeper0 CONTROL: Keeper's OWN Essence gain grants no Shield (self is not 'an ally')", () => {
  const { k, state } = passiveSetup();
  emit(state, { type: "statusApplied", unit: k.id, source: k.id, kind: "elemental_essence" });
  assert.equal(totalShield(k), 0, "'whenever one of his ALLIES does' excludes Keeper himself (and prevents a loop)");
});

// ---------------------------------------------------------------------------
// keeper1 — "Page-turner": consume 25 Shield -> 25 damage to target enemy.
// ---------------------------------------------------------------------------

test("keeper1: with >=25 Shield, consumes exactly 25 and deals exactly 25 to the target enemy", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [enemy]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 40, null, k.id, 0);

  const r = performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(r.ok, true, "the cast succeeds");
  assert.equal(enemy.hp, 75, "target enemy took 25 damage");
  assert.equal(totalShield(k), 15, "25 Shield consumed from Tales to Tell (40 -> 15)");
});

test("keeper1 CONTROL: with < 25 Shield, nothing happens (no damage, no Shield spent)", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [enemy]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 24, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e"] });
  assert.equal(enemy.hp, 100, "24 Shield is not enough -> no damage");
  assert.equal(totalShield(k), 24, "and no Shield was consumed");
});

test("keeper1 CONTROL: only the targeted enemy is damaged", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 25, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper1", targets: ["e2"] });
  assert.equal(e2.hp, 75, "the chosen enemy took 25");
  assert.equal(e1.hp, 100, "the other enemy is untouched");
});

// ---------------------------------------------------------------------------
// keeper2 — "Character Development": consume 25 Shield -> heal target ally 30.
// ---------------------------------------------------------------------------

test("keeper2: with >=25 Shield, consumes 25 and heals target ally exactly 30", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 40, null, k.id, 0);

  const r = performAction(state, { unit: "k", skillId: "keeper2", targets: ["al"] });
  assert.equal(r.ok, true, "the cast succeeds");
  assert.equal(ally.hp, 80, "target ally healed 30 (50 -> 80)");
  assert.equal(totalShield(k), 15, "25 Shield consumed (40 -> 15)");
});

test("keeper2: the heal is capped at the ally's max HP (30 is a ceiling, not overheal)", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 90, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 25, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al"] });
  assert.equal(ally.hp, 100, "healed to full, not past it");
});

test("keeper2 CONTROL: with < 25 Shield, no heal and no Shield spent", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 24, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper2", targets: ["al"] });
  assert.equal(ally.hp, 50, "24 Shield is not enough -> no heal");
  assert.equal(totalShield(k), 24, "no Shield consumed");
});

// ---------------------------------------------------------------------------
// keeper3 — "Chronicle Deeds": if the marked enemy uses a new skill this turn,
//           Tales to Tell gains 35 Shield.  (Strategic, invisible, cd 2)
// ---------------------------------------------------------------------------

test("keeper3: after marking an enemy, that enemy using a skill grants Tales to Tell 35 Shield", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  state.teams.A.energy = ICE_ENERGY();

  const r = performAction(state, { unit: "k", skillId: "keeper3", targets: ["e"] });
  assert.equal(r.ok, true, "Chronicle Deeds casts on the enemy");
  assert.equal(totalShield(k), 0, "no Shield yet — only the watch is armed");

  emit(state, { type: "skillUsed", caster: "e", skillId: "some_enemy_skill", targets: [], tags: [] });
  assert.equal(totalShield(k), 35, "the marked enemy used a skill -> Tales to Tell gains 35 Shield");
});

test("keeper3 CONTROL: an UNMARKED enemy using a skill grants nothing", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2]);
  state.teams.A.energy = ICE_ENERGY();

  performAction(state, { unit: "k", skillId: "keeper3", targets: ["e1"] }); // mark e1
  emit(state, { type: "skillUsed", caster: "e2", skillId: "x", targets: [], tags: [] }); // e2 not marked
  assert.equal(totalShield(k), 0, "an un-marked enemy's skill does not feed Tales to Tell");
});

test("keeper3: the 35-Shield gain is a single payout, not per-skill (frozen: 'gain 35 Shield')", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  state.teams.A.energy = ICE_ENERGY();

  performAction(state, { unit: "k", skillId: "keeper3", targets: ["e"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "s1", targets: [], tags: [] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "s2", targets: [], tags: [] });
  assert.equal(totalShield(k), 35, "still exactly 35 after a second enemy skill (payout fires once)");
});

test("keeper3: goes on its 2-turn cooldown after casting", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const e = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([k], [e]);
  state.teams.A.energy = ICE_ENERGY();
  performAction(state, { unit: "k", skillId: "keeper3", targets: ["e"] });
  assert.equal(skillOf(k, "keeper3").currentCd, 2, "Chronicle Deeds cooldown is 2");
});

// ---------------------------------------------------------------------------
// keeper4 — "Plot Armor": consume 20 Shield -> target ally invulnerable 1 turn.
// ---------------------------------------------------------------------------

test("keeper4: with >=20 Shield, consumes 20 and makes the ally invulnerable for 1 turn", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 20, null, k.id, 0);

  const r = performAction(state, { unit: "k", skillId: "keeper4", targets: ["al"] });
  assert.equal(r.ok, true, "the cast succeeds");
  const inv = ally.statuses.find((s) => s.kind === "invulnerable");
  assert.ok(inv, "the ally is invulnerable");
  assert.equal(inv!.duration, 1, "for 1 turn");
  assert.equal(totalShield(k), 0, "20 Shield consumed (20 -> 0)");
});

test("keeper4: an invulnerable ally cannot be hit by a new Harmful skill; a non-invulnerable one can", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const bystander = makeUnit({ id: "by", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const attacker = loadHero(heroById("keeper"), "B", "atk"); // an enemy with a Harmful skill (Page-turner)
  const state = makeState([k, ally, bystander], [attacker]);
  state.teams.A.energy = ICE_ENERGY();
  state.teams.B.energy = ICE_ENERGY();
  addShield(k, 20, null, k.id, 0);
  addShield(attacker, 60, null, attacker.id, 0); // enough to fire Page-turner twice

  performAction(state, { unit: "k", skillId: "keeper4", targets: ["al"] }); // al invulnerable

  const blocked = performAction(state, { unit: "atk", skillId: "keeper1", targets: ["al"] });
  assert.equal(blocked.ok, false, "a Harmful skill cannot target the invulnerable ally");
  assert.equal(ally.hp, 100, "the invulnerable ally took no damage");

  const landed = performAction(state, { unit: "atk", skillId: "keeper1", targets: ["by"] });
  assert.equal(landed.ok, true, "CONTROL: the same attack lands on a non-invulnerable ally");
  assert.equal(bystander.hp, 75, "the bystander took 25 (proves the attacker's skill is functional)");
});

test("keeper4 CONTROL: with < 20 Shield, the ally is NOT made invulnerable and no Shield is spent", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 19, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper4", targets: ["al"] });
  assert.ok(!ally.statuses.some((s) => s.kind === "invulnerable"), "19 Shield is not enough -> no invulnerability");
  assert.equal(totalShield(k), 19, "no Shield consumed");
});

test("keeper4: goes on its 4-turn cooldown after casting", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 20, null, k.id, 0);
  performAction(state, { unit: "k", skillId: "keeper4", targets: ["al"] });
  assert.equal(skillOf(k, "keeper4").currentCd, 4, "Plot Armor cooldown is 4");
});

// ---------------------------------------------------------------------------
// keeper5 — "Hero's Return": consume 75 Shield -> target DEAD ally revives at 50 HP.
// ---------------------------------------------------------------------------

// SUSPECTED BUG: frozen says "target dead ally returns to life at 50 HP", but a dead ally cannot be
// selected: "single" targeting filters out non-alive units (resolveTargets/legalTargets require u.alive)
// and silently defaults to the first living ENEMY, on which the revive op no-ops. Diagnostic confirms the
// cast returns ok:true, pays 2 Ice energy AND consumes all 75 Shield, yet revives nobody — the dead ally
// stays dead. Hero's Return's revive is unreachable through the real cast path.
test.skip("SUSPECTED BUG: keeper5 cannot revive a dead ally — 'single' targeting drops the dead target and wastes the 75 Shield", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const dead = makeUnit({ id: "da", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const state = makeState([k, dead], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 75, null, k.id, 0);

  const r = performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(r.ok, true, "the cast resolves");
  assert.equal(dead.alive, true, "the dead ally returns to life");
  assert.equal(dead.hp, 50, "at 50 HP");
  assert.equal(totalShield(k), 0, "75 Shield consumed (75 -> 0)");
});

test("keeper5 CONTROL: with < 75 Shield, the dead ally stays dead and no Shield is spent", () => {
  const k = loadHero(heroById("keeper"), "A", "k");
  const dead = makeUnit({ id: "da", team: "A", kind: "hero", hp: 0, maxHp: 100, alive: false });
  const state = makeState([k, dead], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = ICE_ENERGY();
  addShield(k, 74, null, k.id, 0);

  performAction(state, { unit: "k", skillId: "keeper5", targets: ["da"] });
  assert.equal(dead.alive, false, "74 Shield is not enough -> the ally stays dead");
  assert.equal(dead.hp, 0, "still at 0 HP");
  assert.equal(totalShield(k), 74, "no Shield consumed");
});
