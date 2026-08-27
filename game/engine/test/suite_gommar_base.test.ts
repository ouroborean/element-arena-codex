import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, SPEC-DERIVED base-kit suite for GOMMAR, Frostfang Chieftain.
// The FROZEN prose (content/frozen/skills.json) is the sole oracle. Verbatim:
//
//  gommar0 Frost-Covered (passive):
//    "At the start of each round, Gommar gains Frost-Covered, enhancing his
//     skills. If Gommar damages an enemy with reduced damage, he gains
//     Elemental Essence."
//  gommar1 Iceblood Hammer:
//    "Deals 20 damage to one enemy and lower their damage by 5 for 3 turns. If
//     Gommar is Frost-Covered, he then deals 10 damage to the enemy team."
//  gommar2 Foot of the Mountain:
//    "Deals 20 damage to the enemy team. If Gommar is Frost-Covered, enemies
//     have their strategic skills stunned for 1 turn."
//  gommar3 Breath of the North:
//    "Deals 25 damage to one enemy and lowers their damage by 5 until the end
//     of Gommar's next turn. If Gommar is Frost-Covered, this skill cannot be
//     countered and deals Piercing damage."
//  gommar4 Ice Body:
//    "Makes Gommar invulnerable to non-strategic skills for 1 turn and regains
//     Frost-Covered. If he was already Frost-Covered, he gains Elemental
//     Essence."
//  gommar5 Absolute Zero:
//    "All enemies and allies have their non-Strategic skills stunned for 1
//     turn. If Gommar is not Frost-Covered, he is also stunned."
// ============================================================================

function frost(u: Unit): void {
  u.statuses.push({ kind: "mark", name: "Frost-Covered", duration: null, appliedBy: u.id, appliedTurn: 0 });
}
function hasFrost(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "mark" && s.name === "Frost-Covered");
}
function hasEssence(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "elemental_essence");
}
function odm(u: Unit) {
  return u.statuses.find((s) => s.kind === "outgoing_damage_mod");
}
function giveEnergy(state: ReturnType<typeof makeState>, team: "A" | "B" = "A"): void {
  state.teams[team].energy = { generic: 40, ice: 40, fire: 40 };
}

// Crafted probe skills for the acting-unit under a stun / invulnerability test.
const vStrat = () => skill("vstrat", [], { tags: ["Strategic", "Instant"], targeting: "self" });
const vBasic = () => skill("vbasic", [], { tags: ["Instant"], targeting: "self" });
const vHit = () => skill("vhit", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" });
const vStratHit = () => skill("vstrathit", [{ op: "damage", amount: 10, to: "target" }], { tags: ["Harmful", "Strategic", "Instant"], targeting: "single" });

// --------------------------------------------------------------------------- //
//  PASSIVE — Frost-Covered (gommar0)
// --------------------------------------------------------------------------- //

test("passive clause 1: Gommar gains Frost-Covered at the start of each round", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(hasFrost(g), false, "a freshly-loaded Gommar has no Frost-Covered yet");

  startRound(state, "A");
  assert.equal(hasFrost(g), true, "round start grants Frost-Covered");
});

test("passive clause 2: damaging an enemy with REDUCED damage grants Elemental Essence", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  // An enemy whose OWN outgoing damage is reduced by 5 (== \"reduced damage\").
  const reduced = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "outgoing_damage_mod", magnitude: -5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [reduced]);
  giveEnergy(state);

  // Gommar is NOT Frost-Covered -> plain 25 damage; the enemy already carries reduced damage.
  performAction(state, { unit: "g", skillId: "gommar3", targets: ["e"] });
  assert.equal(reduced.hp, 75, "25 landed");
  assert.equal(hasEssence(g), true, "damaging a reduced-damage enemy grants Elemental Essence");
});

test("passive clause 2 control: damaging an enemy WITHOUT reduced damage grants no Essence", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const clean = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [clean]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["e"] });
  assert.equal(clean.hp, 75, "25 landed");
  assert.equal(hasEssence(g), false, "no pre-existing reduced damage at hit time -> no Essence");
});

// Adversarial: \"reduced damage\" means the enemy's damage is LOWERED. An enemy whose damage is
// INCREASED (a positive outgoing_damage_mod) is NOT a reduced-damage enemy, so hitting it must
// NOT grant Essence.
test("gommar0: Essence only when the damaged enemy has REDUCED (negative) damage, not increased", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const buffed = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "outgoing_damage_mod", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [buffed]);

  emit(state, { type: "damageDealt", source: "g", target: "e", amount: 10, dtype: "normal", isNew: true });
  assert.equal(hasEssence(g), false, "an enemy whose damage is raised (+5) is not 'reduced damage' -> no Essence");
});

test("passive clause 2 control: an UNRELATED attacker hitting a reduced-damage enemy grants Gommar nothing", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const reduced = makeUnit({ id: "e", team: "B", kind: "hero",
    statuses: [{ kind: "outgoing_damage_mod", magnitude: -5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g, makeUnit({ id: "ally", team: "A" })], [reduced]);

  emit(state, { type: "damageDealt", source: "ally", target: "e", amount: 10, dtype: "normal", isNew: true });
  assert.equal(hasEssence(g), false, "the passive keys on GOMMAR being the damage source");
});

// --------------------------------------------------------------------------- //
//  gommar1 — Iceblood Hammer
// --------------------------------------------------------------------------- //

test("gommar1 base: 20 to one enemy + lower their damage by 5 for 3 turns; NO team splash when not Frost-Covered", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const other = makeUnit({ id: "o", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [t, other]);
  giveEnergy(state);
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");

  performAction(state, { unit: "g", skillId: "gommar1", targets: ["t"] });
  assert.equal(t.hp, 80, "20 damage to the single target");
  assert.equal(other.hp, 100, "no Frost-Covered -> no 10 splash to the rest of the team");
  const d = odm(t);
  assert.equal(d?.magnitude, -5, "target's damage lowered by 5");
  assert.equal(d?.duration, 3, "for 3 turns");
  assert.equal(odm(other), undefined, "the debuff is single-target only");
});

test("gommar1 Frost-Covered: after the single hit it deals 10 to the WHOLE enemy team", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g);
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const b = makeUnit({ id: "b", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const c = makeUnit({ id: "c", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [t, b, c]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar1", targets: ["t"] });
  assert.equal(t.hp, 70, "primary target takes 20 (single) + 10 (team splash)");
  assert.equal(b.hp, 90, "other enemy takes the 10 splash");
  assert.equal(c.hp, 90, "other enemy takes the 10 splash");
  // No self-trigger of Frost-Covered's Essence passive: the -5 damage debuff is applied AFTER both the 20 and
  // the 10 land, so neither damage point hits a target that Iceblood Hammer itself just reduced.
  assert.equal(hasEssence(g), false, "Iceblood Hammer does not grant Essence off its own -5 debuff");
});

// --------------------------------------------------------------------------- //
//  gommar2 — Foot of the Mountain
// --------------------------------------------------------------------------- //

test("gommar2 base: 20 to the whole enemy team; NO stun when not Frost-Covered", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]);
  giveEnergy(state);
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");

  performAction(state, { unit: "g", skillId: "gommar2", targets: [] });
  assert.equal(e1.hp, 80, "20 to each enemy");
  assert.equal(e2.hp, 80, "20 to each enemy");
  // Not Frost-Covered -> no strategic-stun; the enemy may still use its Strategic skill.
  assert.equal(performAction(state, { unit: "e1", skillId: "vstrat", targets: [] }).ok, true,
    "no Frost-Covered -> the enemy's Strategic skill is NOT stunned");
});

test("gommar2 Frost-Covered: STRATEGIC skills stunned 1 turn; non-Strategic skills unaffected", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const state = makeState([g], [e1]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar2", targets: [] });
  assert.equal(e1.hp, 80, "still deals its 20");
  assert.equal(performAction(state, { unit: "e1", skillId: "vstrat", targets: [] }).reason, "stunned",
    "Frost-Covered -> the enemy's STRATEGIC skill is stunned");
  assert.equal(performAction(state, { unit: "e1", skillId: "vbasic", targets: [] }).ok, true,
    "a non-Strategic skill is NOT stunned by the strategic-only stun");
});

// --------------------------------------------------------------------------- //
//  gommar3 — Breath of the North
// --------------------------------------------------------------------------- //

test("gommar3 base: 25 to one enemy + lower their damage by 5 (until the end of Gommar's next turn)", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [t]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["t"] });
  assert.equal(t.hp, 75, "25 damage");
  assert.equal(odm(t)?.magnitude, -5, "target's damage lowered by 5");

  // \"until the end of Gommar's next turn\": survives Gommar's CURRENT turn end and the enemy turn,
  // then expires at the end of Gommar's NEXT turn.
  endTurn(state); // Gommar's (team A) current turn ends — debuff survives (its birth turn)
  assert.equal(odm(t)?.magnitude, -5, "still present through Gommar's current turn end");
  endTurn(state); // enemy (team B) turn ends — not Gommar's applier team, no tick
  assert.equal(odm(t)?.magnitude, -5, "still present at the start of Gommar's next turn");
  endTurn(state); // Gommar's NEXT turn ends — debuff expires now
  assert.equal(odm(t), undefined, "gone at the end of Gommar's next turn");
});

test("gommar3 base is normal (non-Piercing) damage when not Frost-Covered — Damage Reduction applies", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [t]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["t"] });
  assert.equal(t.hp, 85, "25 normal - 10 Damage Reduction = 15 landed");
});

test("gommar3 Frost-Covered: PIERCING damage ignores Damage Reduction", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g);
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [t]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar3", targets: ["t"] });
  assert.equal(t.hp, 75, "Piercing bypasses the 10 Damage Reduction -> full 25 landed");
});

test("gommar3 Frost-Covered: cannot be countered", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g);
  const d = makeUnit({ id: "d", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  d.triggers = [{
    on: "skillDeclared", owner: "d", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    effect: [],
  }];
  const state = makeState([g], [d]);
  giveEnergy(state);

  const r = performAction(state, { unit: "g", skillId: "gommar3", targets: ["d"] });
  assert.notEqual(r.countered, true, "Frost-Covered -> the skill cannot be countered");
  assert.equal(d.hp, 75, "the 25 landed (uncountered)");
});

test("gommar3 base control: WITHOUT Frost-Covered it CAN be countered", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const d = makeUnit({ id: "d", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  d.triggers = [{
    on: "skillDeclared", owner: "d", kind: "counter", source: "test",
    when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
    effect: [],
  }];
  const state = makeState([g], [d]);
  giveEnergy(state);

  const r = performAction(state, { unit: "g", skillId: "gommar3", targets: ["d"] });
  assert.equal(r.countered, true, "not Frost-Covered -> the counter negates it");
  assert.equal(d.hp, 100, "no damage landed (countered)");
});

// --------------------------------------------------------------------------- //
//  gommar4 — Ice Body
// --------------------------------------------------------------------------- //

test("gommar4: makes Gommar invulnerable for 1 turn and regains Frost-Covered", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vHit()] });
  const state = makeState([g], [enemy]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar4", targets: [] });
  assert.ok(g.statuses.some((s) => s.kind === "invulnerable"), "Gommar is invulnerable");
  assert.equal(hasFrost(g), true, "Gommar regains Frost-Covered");

  // The invulnerability blocks an incoming (non-strategic) Harmful skill.
  const r = performAction(state, { unit: "e", skillId: "vhit", targets: ["g"] });
  assert.equal(r.ok, false, "a Harmful skill cannot target invulnerable Gommar");
  assert.equal(g.hp, 100, "no damage got through");
});

test("gommar4: if he was ALREADY Frost-Covered, he gains Elemental Essence (and still holds the mark)", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g);
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar4", targets: [] });
  assert.equal(hasEssence(g), true, "already Frost-Covered -> gains Elemental Essence");
  assert.equal(hasFrost(g), true, "and still Frost-Covered afterward");
});

test("gommar4 control: if he was NOT Frost-Covered, he regains the mark but gains no Essence", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");
  const state = makeState([g], [makeUnit({ id: "e", team: "B" })]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar4", targets: [] });
  assert.equal(hasFrost(g), true, "regains Frost-Covered");
  assert.equal(hasEssence(g), false, "was not already Frost-Covered -> no Elemental Essence");
});

// Adversarial: the frozen carve-out is \"invulnerable to NON-strategic skills\" — a STRATEGIC skill
// should still land on Gommar while Ice Body is up.
test("gommar4 Ice Body: invulnerable to NON-strategic skills only — a Strategic harmful skill still lands", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStratHit()] });
  const state = makeState([g], [enemy]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar4", targets: [] });
  assert.ok(g.statuses.some((s) => s.kind === "invulnerable"), "Gommar is invulnerable");

  const r = performAction(state, { unit: "e", skillId: "vstrathit", targets: ["g"] });
  assert.equal(r.ok, true, "a Strategic skill is NOT blocked by Ice Body's non-strategic invulnerability");
  assert.equal(g.hp, 90, "the Strategic skill's 10 damage lands");
});

// --------------------------------------------------------------------------- //
//  gommar5 — Absolute Zero
// --------------------------------------------------------------------------- //

test("gommar5: all enemies AND allies have their NON-Strategic skills stunned for 1 turn", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g); // Frost-Covered so Gommar himself is NOT additionally full-stunned (isolates the AoE scope)
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const enemy = makeUnit({ id: "en", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const state = makeState([g, ally], [enemy]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar5", targets: [] });

  // Enemy
  assert.equal(performAction(state, { unit: "en", skillId: "vbasic", targets: [] }).reason, "stunned",
    "enemy's non-Strategic skill is stunned");
  assert.equal(performAction(state, { unit: "en", skillId: "vstrat", targets: [] }).ok, true,
    "enemy's Strategic skill is NOT stunned");
  // Ally
  assert.equal(performAction(state, { unit: "al", skillId: "vbasic", targets: [] }).reason, "stunned",
    "ally's non-Strategic skill is stunned too ('allies')");
  assert.equal(performAction(state, { unit: "al", skillId: "vstrat", targets: [] }).ok, true,
    "ally's Strategic skill is NOT stunned");
});

test("gommar5 self-clause: while Frost-Covered, Gommar keeps his STRATEGIC skill but loses non-Strategic ones", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  frost(g);
  const enemy = makeUnit({ id: "en", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [enemy]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar5", targets: [] });
  // The 'all' non-Strategic stun hits Gommar too -> his non-Strategic skills are stunned...
  assert.equal(performAction(state, { unit: "g", skillId: "gommar1", targets: ["en"] }).reason, "stunned",
    "Gommar's own non-Strategic Iceblood Hammer is caught by the AoE");
  // ...but he was Frost-Covered, so he is NOT additionally full-stunned -> Strategic Ice Body still usable.
  assert.equal(performAction(state, { unit: "g", skillId: "gommar4", targets: [] }).ok, true,
    "Frost-Covered -> Gommar's Strategic Ice Body is NOT stunned");
});

test("gommar5: when not Frost-Covered, the full stun fully stuns Gommar (his Strategic Ice Body is stunned too)", () => {
  const g = loadHero(heroById("gommar"), "A", "g");
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");
  const enemy = makeUnit({ id: "en", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [enemy]);
  giveEnergy(state);

  performAction(state, { unit: "g", skillId: "gommar5", targets: [] });
  assert.equal(performAction(state, { unit: "g", skillId: "gommar4", targets: [] }).reason, "stunned",
    "not Frost-Covered -> Gommar is also stunned, losing even his Strategic Ice Body");
});
