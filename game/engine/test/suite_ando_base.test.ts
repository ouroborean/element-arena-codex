import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, spec-derived base-kit suite for ANDO ("Ando-91"), element = lightning.
// The FROZEN PROSE (content/frozen/skills.json) is the oracle for every assertion.
// Frozen text used:
//  ando0 Stored Charge (passive): "Ando's skills Charge him, granting him Elemental
//    Essence and augmenting his skills for 1 turn. Using a skill while Charged will
//    Supercharge him, granting him Elemental Essence and further augmenting his skills
//    for 1 turn."
//  ando1 Electroblade: "Deals 15 damage to target enemy and marks them with Electroblade.
//    While Charged, this skill also strikes any target affected by Electroblade. While
//    Supercharged, this skill targets all enemies and deals 10 additional damage to
//    targets marked by Electroblade."
//  ando2 Flash Step: "Shatters target enemy until the end of Ando's next turn. While
//    Charged, this skill lasts an additional turn. While Supercharged, this skill affects
//    all targets marked by Electroblade."
//  ando3 Expel Energy: "Deals 10 damage to target enemy and removes Ando's charge state.
//    If Ando was Charged, this skill deals 10 additional damage. If Ando was Supercharged,
//    it deals 20 additional damage and becomes Piercing. This skill cannot be stunned and
//    does not advance Ando's Charge state."
//  ando4 Focus Power: "Ando advances to the next Charge state. Afterwards, if he is
//    Charged, he strikes all enemies marked by Electroblade for 5 Piercing damage. If he
//    is Supercharged, he marks a random enemy with Electroblade."
//  ando5 Overclock: "For the next 3 turns, after using a Supercharged skill, Ando will
//    become Charged and gain Elemental Essence. This skill can only be used while
//    Supercharged, and extends the duration of his current Supercharge by 1 turn."
//
// Drive facts (from content only): element lightning; costs — ando1 {generic:1},
// ando2 {lightning:1}, ando3 {lightning:1}, ando4 {0}, ando5 {lightning:1}. Marks used:
// "Charged"/"Supercharged" (self), "Electroblade" (enemies); statuses: shatter, essence.
// ===========================================================================

const mkAndo = (): Unit => loadHero(heroById("ando"), "A", "ando");
function fund(st: MatchState): void {
  st.teams.A.energy = { generic: 40, lightning: 40 };
}

const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const markDur = (u: Unit, name: string): number | null =>
  u.statuses.find((s) => s.kind === "mark" && s.name === name)?.duration ?? null;
const hasEssence = (u: Unit): boolean => u.statuses.some((s) => s.kind === "elemental_essence");
const clearEssence = (u: Unit): void => { u.statuses = u.statuses.filter((s) => s.kind !== "elemental_essence"); };
const hasEB = (u: Unit): boolean => hasMark(u, "Electroblade");
const hasShatter = (u: Unit): boolean => u.statuses.some((s) => s.kind === "shatter");
const shatterDur = (u: Unit): number | null => u.statuses.find((s) => s.kind === "shatter")?.duration ?? null;

const charged = (): Unit["statuses"][number] => status("mark", { name: "Charged", duration: 1, appliedBy: "ando", appliedTurn: 1 });
const supercharged = (d = 1): Unit["statuses"][number] => status("mark", { name: "Supercharged", duration: d, appliedBy: "ando", appliedTurn: 1 });
const eb = (): Unit["statuses"][number] => status("mark", { name: "Electroblade", duration: null, appliedBy: "ando", appliedTurn: 1 });
const dr = (m: number): Unit["statuses"][number] => status("damage_reduction", { magnitude: m });

function enemy(id: string, extra: Partial<Unit> = {}): Unit {
  return makeUnit({ id, team: "B", hp: 100, maxHp: 100, kind: "hero", ...extra });
}

// ===========================================================================
// ando0 — Stored Charge (passive)
// ===========================================================================

test("Stored Charge: using a skill from an uncharged state Charges Ando and grants Elemental Essence", () => {
  const ando = mkAndo();
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  // control: pre-cast Ando holds neither charge mark nor essence.
  assert.equal(hasMark(ando, "Charged"), false, "not Charged before any skill");
  assert.equal(hasMark(ando, "Supercharged"), false, "not Supercharged before any skill");
  assert.equal(hasEssence(ando), false, "no essence before any skill");

  const res = performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(res.ok, true, "cast succeeds");
  assert.equal(hasMark(ando, "Charged"), true, "Ando is Charged after using a skill");
  assert.equal(hasMark(ando, "Supercharged"), false, "one step only — not Supercharged yet");
  assert.equal(hasEssence(ando), true, "gained Elemental Essence on the Charge step");
});

test("Stored Charge: using a skill while Charged Supercharges Ando and grants Elemental Essence", () => {
  const ando = mkAndo();
  const state = makeState([ando], [enemy("e1"), enemy("e2")]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // -> Charged
  assert.equal(hasMark(ando, "Charged"), true, "Charged after 1st skill");
  clearEssence(ando); // isolate the essence granted by the NEXT (Supercharge) step

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e2"] }); // used while Charged -> Supercharged
  assert.equal(hasMark(ando, "Supercharged"), true, "Ando is Supercharged after using a skill while Charged");
  assert.equal(hasMark(ando, "Charged"), false, "Charged is consumed into Supercharged");
  assert.equal(hasEssence(ando), true, "gained Elemental Essence on the Supercharge step");
});

test("Stored Charge: using a skill while Supercharged does NOT advance further and grants no new Essence", () => {
  const ando = mkAndo();
  const state = makeState([ando], [enemy("e1"), enemy("e2")]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // -> Charged
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e2"] }); // -> Supercharged
  assert.equal(hasMark(ando, "Supercharged"), true, "Supercharged reached");
  clearEssence(ando); // the prose grants Essence only on the two named transitions

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // used while Supercharged
  assert.equal(hasMark(ando, "Supercharged"), true, "still Supercharged (no state above Supercharged in the prose)");
  assert.equal(hasMark(ando, "Charged"), false, "did not drop back to Charged");
  assert.equal(hasEssence(ando), false, "no Essence granted for using a skill while already Supercharged");
});

test("Stored Charge: the augment (Charged) lasts 1 turn — through the opponent's turn, expiring at Ando's next turn-end", () => {
  const ando = mkAndo();
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // turn 1 (A): -> Charged
  assert.equal(hasMark(ando, "Charged"), true, "Charged right after the cast");

  endTurn(state); // end A's turn 1 (born-this-turn -> not decremented); now turn 2, B active
  assert.equal(hasMark(ando, "Charged"), true, "still Charged during the opponent's turn");
  endTurn(state); // end B's turn 2 (A-applied marks untouched by B's tick); now turn 3, A active
  assert.equal(hasMark(ando, "Charged"), true, "still Charged at the start of Ando's next turn");
  endTurn(state); // end A's turn 3 (Ando's next turn): the 1-turn mark expires
  assert.equal(hasMark(ando, "Charged"), false, "Charged expired at the end of Ando's next turn");
});

// ===========================================================================
// ando1 — Electroblade
// ===========================================================================

test("Electroblade (base): 15 damage to the target and marks it; a non-target enemy is untouched", () => {
  const ando = mkAndo();
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "target takes 15");
  assert.equal(hasEB(e1), true, "target is marked with Electroblade");
  assert.equal(e2.hp, 100, "non-target takes no damage");
  assert.equal(hasEB(e2), false, "non-target is not marked");
});

test("Electroblade (Charged): also strikes an already-Electroblade-affected enemy for 15", () => {
  const ando = mkAndo();
  ando.statuses.push(charged());
  const e1 = enemy("e1", { statuses: [eb()] }); // already affected by Electroblade
  const e2 = enemy("e2"); // the fresh target
  const e3 = enemy("e3"); // control: unmarked, not targeted
  const state = makeState([ando], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e2"] });
  assert.equal(e2.hp, 85, "target takes its 15");
  assert.equal(hasEB(e2), true, "target becomes marked");
  assert.equal(e1.hp, 85, "the already-affected enemy is also struck for 15");
  assert.equal(e3.hp, 100, "an unaffected non-target is left alone");
  assert.equal(hasEB(e3), false, "and stays unmarked");
});

test("Electroblade (Supercharged): hits all enemies for 15, +10 more to Electroblade-marked ones, and marks all", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged());
  const e1 = enemy("e1", { statuses: [eb()] }); // marked -> should take 15 + 10
  const e2 = enemy("e2"); // unmarked -> 15
  const e3 = enemy("e3"); // unmarked -> 15
  const state = makeState([ando], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "the marked enemy takes 15 + 10 additional = 25");
  assert.equal(e2.hp, 85, "an unmarked enemy takes 15");
  assert.equal(e3.hp, 85, "every enemy is hit (targets all)");
  assert.equal(hasEB(e1) && hasEB(e2) && hasEB(e3), true, "all enemies are marked with Electroblade");
});

// ===========================================================================
// ando2 — Flash Step
// ===========================================================================

test("Flash Step (base): Shatters the target; a non-target enemy is not Shattered", () => {
  const ando = mkAndo();
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] });
  assert.equal(hasShatter(e1), true, "target is Shattered");
  assert.equal(hasShatter(e2), false, "non-target is not Shattered");
});

test("Flash Step (base): the Shatter lasts until the end of Ando's next turn", () => {
  const ando = mkAndo();
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] }); // turn 1 (A)
  assert.equal(hasShatter(e1), true, "Shattered right after the cast");
  endTurn(state); // end turn 1 (A): born this turn -> survives; turn 2, B
  assert.equal(hasShatter(e1), true, "survives into the opponent's turn");
  endTurn(state); // end turn 2 (B): A-applied untouched; turn 3, A (Ando's next turn)
  assert.equal(hasShatter(e1), true, "still present at the start of Ando's next turn");
  endTurn(state); // end turn 3 (A): expires at the end of Ando's next turn
  assert.equal(hasShatter(e1), false, "Shatter has expired");
});

test("Flash Step (Charged): the Shatter lasts an additional turn (duration 2 vs base 1)", () => {
  const base = mkAndo();
  const be = enemy("e1");
  const baseState = makeState([base], [be]);
  fund(baseState);
  performAction(baseState, { unit: "ando", skillId: "ando2", targets: ["e1"] });
  const baseDur = shatterDur(be);

  const ando = mkAndo();
  ando.statuses.push(charged());
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] });

  assert.equal(baseDur, 1, "base Shatter has duration 1 (until end of Ando's next turn)");
  assert.equal(shatterDur(e1), 2, "Charged Shatter lasts one additional turn (duration 2)");
});

test("Flash Step (Supercharged): affects ALL Electroblade-marked enemies; unmarked enemies are not Shattered", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged());
  const e1 = enemy("e1", { statuses: [eb()] }); // marked
  const e2 = enemy("e2", { statuses: [eb()] }); // marked
  const e3 = enemy("e3"); // control: unmarked
  const state = makeState([ando], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] });
  assert.equal(hasShatter(e1), true, "marked enemy #1 is Shattered");
  assert.equal(hasShatter(e2), true, "marked enemy #2 is Shattered (not just the declared target)");
  assert.equal(hasShatter(e3), false, "an unmarked enemy is NOT Shattered");
});

// ===========================================================================
// ando3 — Expel Energy
// ===========================================================================

test("Expel Energy (base/uncharged): deals 10 normal damage and does NOT advance Ando's charge", () => {
  const ando = mkAndo();
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(e1.hp, 90, "target takes 10");
  assert.equal(e2.hp, 100, "non-target untouched");
  // "does not advance Ando's Charge state": unlike every other skill, Expel leaves him uncharged.
  assert.equal(hasMark(ando, "Charged"), false, "Expel does NOT charge Ando");
  assert.equal(hasMark(ando, "Supercharged"), false, "and does not Supercharge him");
});

test("Expel Energy: 'does not advance charge' contrasts with a normal skill that does", () => {
  const ando = mkAndo();
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(hasMark(ando, "Charged"), false, "Expel: still uncharged");

  const ando2 = mkAndo();
  const state2 = makeState([ando2], [enemy("e1")]);
  fund(state2);
  performAction(state2, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(hasMark(ando2, "Charged"), true, "a normal skill (Electroblade) DOES charge — control");
});

test("Expel Energy (Charged): 10 + 10 additional = 20 normal damage; then removes the charge state", () => {
  const ando = mkAndo();
  ando.statuses.push(charged());
  const e1 = enemy("e1", { statuses: [dr(5)] }); // Damage Reduction 5 -> normal damage is reduced by 5
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  // 20 normal, reduced by DR 5 -> 15 hp lost. (If it were Piercing it would ignore DR and deal 20.)
  assert.equal(e1.hp, 85, "20 normal damage minus 5 DR = 15 lost");
  assert.equal(hasMark(ando, "Charged"), false, "removes Ando's charge state");
});

test("Expel Energy (Supercharged): 10 + 20 additional = 30 Piercing (bypasses Damage Reduction); removes charge", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged());
  const e1 = enemy("e1", { statuses: [dr(10)] }); // DR 10 — Piercing must bypass it
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  // 30 Piercing ignores DR -> full 30 lost. (If it were normal, DR 10 would leave 20.)
  assert.equal(e1.hp, 70, "30 Piercing damage bypasses Damage Reduction");
  assert.equal(hasMark(ando, "Supercharged"), false, "removes Ando's charge state");
});

test("Expel Energy baseline: a plain unscoped stun blocks a normal Ando skill (control for the unstunnable clause)", () => {
  const ando = mkAndo();
  ando.statuses.push(status("stun", { duration: 1, appliedBy: "e1", appliedTurn: 1 }));
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  const res = performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(res.ok, false, "a stunned Ando cannot use Electroblade");
  assert.equal(res.reason, "stunned", "blocked by the stun");
});

// SUSPECTED BUG — ando3 frozen: "This skill cannot be stunned." Expel Energy should be castable
// while Ando is stunned. The engine carries no skill-level stun-immunity (its Unstunnable class is
// false and isStunnedFor only exempts Unstunnable-tagged skills / a "Stun Immunity" mark), so a
// stunned Ando is blocked from using Expel just like any other skill.
test("Expel Energy: cannot be stunned — a stunned Ando can still cast it (Unstunnable)", () => {
  const ando = mkAndo();
  ando.statuses.push(status("stun", { duration: 1, appliedBy: "e1", appliedTurn: 1 }));
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  const res = performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(res.ok, true, "frozen: Expel Energy cannot be stunned — the cast must go through");
});

// ===========================================================================
// ando4 — Focus Power
// ===========================================================================

test("Focus Power (from uncharged): advances to Charged, grants Essence, and strikes Electroblade-marked enemies for 5 Piercing", () => {
  const ando = mkAndo();
  const e1 = enemy("e1", { statuses: [eb(), dr(3)] }); // marked + DR 3 to prove Piercing
  const e2 = enemy("e2"); // control: unmarked
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(hasMark(ando, "Charged"), true, "advances to Charged");
  assert.equal(hasMark(ando, "Supercharged"), false, "exactly one step (no double advance)");
  assert.equal(hasEssence(ando), true, "gains Elemental Essence on the Charge step");
  assert.equal(e1.hp, 95, "5 Piercing to the marked enemy, bypassing its DR 3");
  assert.equal(e2.hp, 100, "an unmarked enemy is not struck");
});

test("Focus Power (from Charged): advances to Supercharged and marks a random enemy — no 5-Piercing strike", () => {
  const ando = mkAndo();
  ando.statuses.push(charged());
  const e1 = enemy("e1"); // single enemy -> the 'random' mark is deterministic
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(hasMark(ando, "Supercharged"), true, "advances Charged -> Supercharged");
  assert.equal(hasMark(ando, "Charged"), false, "Charged consumed");
  assert.equal(hasEB(e1), true, "marks a random enemy with Electroblade");
  assert.equal(e1.hp, 100, "the 5-Piercing strike is the Charged branch — it does NOT fire when he ends Supercharged");
});

test("Focus Power (from Supercharged): no further advance, no new Essence, but still marks a random enemy", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged());
  clearEssence(ando);
  const e1 = enemy("e1"); // single enemy -> deterministic mark
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(hasMark(ando, "Supercharged"), true, "stays Supercharged (no state beyond it)");
  assert.equal(hasEssence(ando), false, "no Essence when there is no real charge step");
  assert.equal(hasEB(e1), true, "the Supercharged branch still marks a random enemy");
});

// ===========================================================================
// ando5 — Overclock
// ===========================================================================

test("Overclock: can only be used while Supercharged (requires-gate)", () => {
  // from uncharged -> rejected
  const a1 = mkAndo();
  const s1 = makeState([a1], [enemy("e1")]);
  fund(s1);
  const r1 = performAction(s1, { unit: "ando", skillId: "ando5", targets: [] });
  assert.equal(r1.ok, false, "uncharged: cannot Overclock");
  assert.equal(r1.reason, "requirements-not-met", "gated by the Supercharged requirement");

  // from Charged (but not Supercharged) -> still rejected
  const a2 = mkAndo();
  a2.statuses.push(charged());
  const s2 = makeState([a2], [enemy("e1")]);
  fund(s2);
  const r2 = performAction(s2, { unit: "ando", skillId: "ando5", targets: [] });
  assert.equal(r2.ok, false, "merely Charged is not enough");

  // from Supercharged -> allowed
  const a3 = mkAndo();
  a3.statuses.push(supercharged());
  const s3 = makeState([a3], [enemy("e1")]);
  fund(s3);
  const r3 = performAction(s3, { unit: "ando", skillId: "ando5", targets: [] });
  assert.equal(r3.ok, true, "Supercharged: Overclock is castable");
});

test("Overclock: extends the current Supercharge by 1 turn", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged(1)); // current Supercharge has duration 1
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando5", targets: [] });
  assert.equal(hasMark(ando, "Supercharged"), true, "still Supercharged after Overclock");
  assert.equal(markDur(ando, "Supercharged"), 2, "Supercharge duration extended 1 -> 2");
});

test("Overclock: opens a 3-turn window that converts a Supercharged skill use into Charged + Essence", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged(1));
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando5", targets: [] }); // open the window
  assert.equal(markDur(ando, "Overclock"), 3, "'for the next 3 turns' -> Overclock window duration 3");
  assert.equal(hasMark(ando, "Supercharged"), true, "Overclock's own cast does not self-convert");
  clearEssence(ando); // isolate the essence from the NEXT (converted) skill use

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // a Supercharged skill use, in-window
  assert.equal(hasMark(ando, "Charged"), true, "after using a Supercharged skill, Ando becomes Charged");
  assert.equal(hasMark(ando, "Supercharged"), false, "he drops out of Supercharged");
  assert.equal(hasEssence(ando), true, "and gains Elemental Essence");
});

test("Overclock control: WITHOUT the window, using a Supercharged skill leaves Ando Supercharged (no convert, no essence)", () => {
  const ando = mkAndo();
  ando.statuses.push(supercharged(1));
  clearEssence(ando);
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // Supercharged, but no Overclock window
  assert.equal(hasMark(ando, "Supercharged"), true, "stays Supercharged without the Overclock window");
  assert.equal(hasMark(ando, "Charged"), false, "no conversion to Charged");
  assert.equal(hasEssence(ando), false, "and no Essence (that grant is the Overclock window's, not the base passive's)");
});
