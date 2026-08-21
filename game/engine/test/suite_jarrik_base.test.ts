import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, spec-derived suite for Jarrik Cinderblade's BASE kit.
// Oracle = the FROZEN prose (content/frozen/skills.json), quoted at each block.
// Jarrik's element is Fire, so Specific cost is paid from the team's `fire` pool.
//
//   jarrik0  Cinders (passive)        — "When Jarrik damages an enemy marked by this skill, he
//                                        deals 10 additional Affliction damage and gains Elemental Essence."
//   jarrik1  Blade of Ashes           — "Deals 10 damage to target enemy and permanently marks them with Cinders."
//   jarrik2  Cinderswell              — "Deals 15 damage to all enemies. If any target is marked by
//                                        Cinders, all enemies are Shattered for 2 turns."
//   jarrik3  Call Cinders             — "Deals 5 Affliction damage to all enemies marked by Cinders.
//                                        Those marks are then removed, creating a Cinderling minion for each mark removed."
//   jarrik4  Wall of Sparks           — "Grants Jarrik 15 Shield for 1 turn for each active Cinders mark or Cinderling minion."
//   jarrik5  Blade of Dancing Lights  — "Withdraws all active Cinders marks and consumes any active Cinderling
//                                        minions. For a number of turns equal to the total consumed, Blade of
//                                        Ashes targets all enemies and Jarrik will automatically create a
//                                        Cinderling minion whenever he triggers his Cinders."
// ============================================================================

// ---- drive helpers (names learned only from authored/generated content) ----
const cinders = (appliedBy = "j"): Unit["statuses"][number] =>
  ({ kind: "mark", name: "Cinders", duration: null, appliedBy, appliedTurn: 0 });
const dancingLights = (dur: number): Unit["statuses"][number] =>
  ({ kind: "mark", name: "Dancing Lights", duration: dur, appliedBy: "j", appliedTurn: 0 });

const enemy = (id: string, statuses: Unit["statuses"] = []): Unit =>
  makeUnit({ id, team: "B", hp: 100, maxHp: 100, kind: "hero", statuses });
const fund = (st: MatchState) => { st.teams.A.energy = { generic: 40, fire: 40 }; };

const hasMark = (u: Unit, n: string) => u.statuses.some((s) => s.kind === "mark" && s.name === n);
const markDur = (u: Unit, n: string) => u.statuses.find((s) => s.kind === "mark" && s.name === n)?.duration;
const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const shatters = (u: Unit) => u.statuses.filter((s) => s.kind === "shatter");
const cinderlings = (st: MatchState) =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.name === "Cinderling" && u.alive).length;
const shieldTotal = (u: Unit) => u.shields.reduce((a, s) => a + s.amount, 0);
const jarrik = (id = "j") => loadHero(heroById("jarrik"), "A", id);
const summonCinderlings = (st: MatchState, j: Unit, n: number) =>
  runEffects(st, [{ op: "summon", template: "Cinderling", count: n }], { caster: j, self: j } as never);

// ============================================================================
// jarrik0 — Cinders (passive): "When Jarrik damages an enemy marked by this
// skill, he deals 10 additional Affliction damage and gains Elemental Essence."
// ============================================================================

test("Cinders: damaging a Cinders-marked enemy adds 10 Affliction and grants Jarrik Elemental Essence", () => {
  const j = jarrik();
  const e = enemy("e", [cinders()]);
  const st = makeState([j], [e]);
  fund(st);

  // Blade of Ashes deals its base 10; because the target is ALREADY marked, the passive rider adds +10.
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });

  assert.equal(e.hp, 80, "10 (Blade of Ashes) + 10 (Cinders rider) = 20 total damage");
  assert.ok(essenceCount(j) >= 1, "Jarrik gains Elemental Essence from the proc");
});

test("Cinders: an UNMARKED enemy takes no rider — the mark must already be present when damaged", () => {
  const j = jarrik();
  const e = enemy("e"); // no Cinders yet
  const st = makeState([j], [e]);
  fund(st);

  // Blade of Ashes damages FIRST, then applies Cinders; so at damage-time the enemy is unmarked → no rider.
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });

  assert.equal(e.hp, 90, "only the base 10 lands (no Cinders rider on a mark applied after the hit)");
  assert.equal(essenceCount(j), 0, "no proc → no Elemental Essence");
});

test("Cinders: the rider keys on JARRIK as the damager (an ally's damage does not proc it)", () => {
  const j = jarrik();
  const ally = makeUnit({ id: "al", team: "A", kind: "hero" });
  const e = enemy("e", [cinders()]);
  const st = makeState([j, ally], [e]);

  // POSITIVE — a damage event sourced from Jarrik on the marked enemy fires the passive.
  emit(st, { type: "damageDealt", source: "j", target: "e", amount: 5, dtype: "normal" });
  assert.equal(e.hp, 90, "Jarrik-sourced damage on a marked enemy applies the +10 Affliction rider");
  assert.ok(essenceCount(j) >= 1, "and Jarrik gains Elemental Essence");

  // CONTROL — the SAME marked enemy, but the damage is sourced from an ally, not Jarrik.
  const j2 = jarrik();
  const ally2 = makeUnit({ id: "al", team: "A", kind: "hero" });
  const e2 = enemy("e", [cinders()]);
  const st2 = makeState([j2, ally2], [e2]);
  emit(st2, { type: "damageDealt", source: "al", target: "e", amount: 5, dtype: "normal" });
  assert.equal(e2.hp, 100, "an ally damaging the marked enemy triggers no Cinders rider");
  assert.equal(essenceCount(j2), 0, "and Jarrik gains no Essence from someone else's hit");
});

// ============================================================================
// jarrik1 — Blade of Ashes:
// "Deals 10 damage to target enemy and permanently marks them with Cinders."
// ============================================================================

test("Blade of Ashes: 10 damage to the single target and a PERMANENT Cinders mark", () => {
  const j = jarrik();
  const e = enemy("e");
  const bystander = enemy("b");
  const st = makeState([j], [e, bystander]);
  fund(st);

  const res = performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(res.ok, true, "the cast succeeds");

  assert.equal(e.hp, 90, "target takes exactly 10");
  assert.ok(hasMark(e, "Cinders"), "target is marked with Cinders");
  assert.equal(markDur(e, "Cinders"), null, "the Cinders mark is PERMANENT (duration null)");

  // Control: single-target — the other enemy is untouched and unmarked.
  assert.equal(bystander.hp, 100, "the non-target enemy takes no damage");
  assert.ok(!hasMark(bystander, "Cinders"), "the non-target enemy is not marked");
  const skill = j.skills!.find((s) => s.id === "jarrik1")!;
  assert.equal(skill.currentCd, 0, "Blade of Ashes has no cooldown");
});

// ============================================================================
// jarrik2 — Cinderswell:
// "Deals 15 damage to all enemies. If any target is marked by Cinders, all
//  enemies are Shattered for 2 turns."
// ============================================================================

test("Cinderswell: 15 to all enemies; with NO Cinders present, nobody is Shattered", () => {
  const j = jarrik();
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([j], [e1, e2]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrik2", targets: [] });

  assert.equal(e1.hp, 85, "15 damage to e1");
  assert.equal(e2.hp, 85, "15 damage to e2");
  assert.equal(shatters(e1).length, 0, "no Cinders anywhere → no Shatter");
  assert.equal(shatters(e2).length, 0, "no Cinders anywhere → no Shatter");
});

test("Cinderswell: one marked target Shatters ALL enemies for 2 turns (incl. the unmarked one)", () => {
  const j = jarrik();
  const marked = enemy("e1", [cinders()]);
  const clean = enemy("e2"); // never marked
  const st = makeState([j], [marked, clean]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrik2", targets: [] });

  // The marked target also eats the Cinders passive rider (15 + 10); the clean one takes only 15.
  assert.equal(marked.hp, 75, "marked target: 15 (Cinderswell) + 10 (Cinders rider)");
  assert.equal(clean.hp, 85, "unmarked target: 15 only");

  assert.equal(shatters(marked).length, 1, "marked enemy is Shattered");
  assert.equal(shatters(clean).length, 1, "the UNMARKED enemy is ALSO Shattered (all enemies)");
  assert.equal(shatters(marked)[0]!.duration, 2, "Shatter lasts 2 turns");
  assert.equal(shatters(clean)[0]!.duration, 2, "Shatter lasts 2 turns");

  const skill = j.skills!.find((s) => s.id === "jarrik2")!;
  assert.equal(skill.currentCd, 2, "Cinderswell goes on its 2-turn cooldown");
});

test("Cinderswell: the Cinders rider fires per marked target hit", () => {
  const j = jarrik();
  const e1 = enemy("e1", [cinders()]);
  const e2 = enemy("e2", [cinders()]);
  const st = makeState([j], [e1, e2]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrik2", targets: [] });

  assert.equal(e1.hp, 75, "both marked → each takes 15 + 10");
  assert.equal(e2.hp, 75, "both marked → each takes 15 + 10");
  assert.ok(essenceCount(j) >= 1, "damaging marked enemies grants Jarrik Elemental Essence");
});

// ============================================================================
// jarrik3 — Call Cinders:
// "Deals 5 Affliction damage to all enemies marked by Cinders. Those marks are
//  then removed, creating a Cinderling minion for each mark removed."
// ============================================================================

test("Call Cinders: hits only marked enemies, removes their marks, spawns one Cinderling per mark", () => {
  const j = jarrik();
  const m1 = enemy("e1", [cinders()]);
  const m2 = enemy("e2", [cinders()]);
  const clean = enemy("e3"); // unmarked control
  const st = makeState([j], [m1, m2, clean]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrik3", targets: [] });

  // 5 Affliction from Call Cinders + 10 from the Cinders passive rider (target still marked when damaged).
  assert.equal(m1.hp, 85, "marked enemy 1 takes 5 + 10");
  assert.equal(m2.hp, 85, "marked enemy 2 takes 5 + 10");
  assert.equal(clean.hp, 100, "the UNMARKED enemy takes no damage");

  assert.ok(!hasMark(m1, "Cinders"), "e1's Cinders mark is removed");
  assert.ok(!hasMark(m2, "Cinders"), "e2's Cinders mark is removed");

  assert.equal(cinderlings(st), 2, "one Cinderling per mark removed (2 marks → 2 Cinderlings)");
});

test("Call Cinders: with no Cinders marks present, it deals nothing and makes no Cinderlings", () => {
  const j = jarrik();
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([j], [e1, e2]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrik3", targets: [] });

  assert.equal(e1.hp, 100, "no marks → no damage");
  assert.equal(e2.hp, 100, "no marks → no damage");
  assert.equal(cinderlings(st), 0, "no marks removed → no Cinderlings created");
});

// ============================================================================
// jarrik4 — Wall of Sparks:
// "Grants Jarrik 15 Shield for 1 turn for each active Cinders mark or Cinderling minion."
// ============================================================================

test("Wall of Sparks: 15 Shield per (Cinders mark + Cinderling), for 1 turn", () => {
  const j = jarrik();
  const e1 = enemy("e1", [cinders()]);
  const e2 = enemy("e2", [cinders()]); // 2 active Cinders marks
  const st = makeState([j], [e1, e2]);
  fund(st);
  summonCinderlings(st, j, 1); // + 1 Cinderling minion → total count 3

  performAction(st, { unit: "j", skillId: "jarrik4", targets: ["j"] });

  assert.equal(shieldTotal(j), 45, "15 x (2 marks + 1 Cinderling) = 45 Shield");
  assert.equal(j.shields.length, 1, "granted as a single shield instance");
  assert.equal(j.shields[0]!.duration, 1, "the Shield lasts 1 turn");
});

test("Wall of Sparks: marks alone and Cinderlings alone each contribute; zero of both grants nothing", () => {
  // marks only: 3 marks → 45
  {
    const j = jarrik();
    const st = makeState([j], [enemy("e1", [cinders()]), enemy("e2", [cinders()]), enemy("e3", [cinders()])]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrik4", targets: ["j"] });
    assert.equal(shieldTotal(j), 45, "3 Cinders marks, no minions → 45");
  }
  // Cinderlings only: 2 minions → 30
  {
    const j = jarrik();
    const st = makeState([j], [enemy("e1")]);
    fund(st);
    summonCinderlings(st, j, 2);
    performAction(st, { unit: "j", skillId: "jarrik4", targets: ["j"] });
    assert.equal(shieldTotal(j), 30, "0 marks, 2 Cinderlings → 30");
  }
  // neither → 0
  {
    const j = jarrik();
    const st = makeState([j], [enemy("e1")]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrik4", targets: ["j"] });
    assert.equal(shieldTotal(j), 0, "no marks, no minions → no Shield");
  }
});

// ============================================================================
// jarrik5 — Blade of Dancing Lights:
// "Withdraws all active Cinders marks and consumes any active Cinderling minions.
//  For a number of turns equal to the total consumed, Blade of Ashes targets all
//  enemies and Jarrik will automatically create a Cinderling minion whenever he
//  triggers his Cinders."
// ============================================================================

test("Blade of Dancing Lights: withdraws all Cinders, consumes all Cinderlings, arms for (marks+minions) turns", () => {
  const j = jarrik();
  const e1 = enemy("e1", [cinders()]);
  const e2 = enemy("e2", [cinders()]); // 2 marks
  const st = makeState([j], [e1, e2]);
  fund(st);
  summonCinderlings(st, j, 2); // 2 minions → total consumed = 4

  performAction(st, { unit: "j", skillId: "jarrik5", targets: [] });

  assert.ok(!hasMark(e1, "Cinders"), "e1's Cinders mark is withdrawn");
  assert.ok(!hasMark(e2, "Cinders"), "e2's Cinders mark is withdrawn");
  assert.equal(cinderlings(st), 0, "all active Cinderlings are consumed");
  assert.ok(hasMark(j, "Dancing Lights"), "Jarrik is armed with Dancing Lights");
  assert.equal(markDur(j, "Dancing Lights"), 4, "duration = 2 marks + 2 minions = 4 turns");
});

test("Blade of Dancing Lights: the armed duration is the SUM of marks and minions", () => {
  // 2 marks + 0 minions → 2
  {
    const j = jarrik();
    const st = makeState([j], [enemy("e1", [cinders()]), enemy("e2", [cinders()])]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrik5", targets: [] });
    assert.equal(markDur(j, "Dancing Lights"), 2, "marks-only total counts");
  }
  // 0 marks + 3 minions → 3
  {
    const j = jarrik();
    const st = makeState([j], [enemy("e1")]);
    fund(st);
    summonCinderlings(st, j, 3);
    performAction(st, { unit: "j", skillId: "jarrik5", targets: [] });
    assert.equal(markDur(j, "Dancing Lights"), 3, "minions-only total counts");
  }
});

test("Blade of Ashes is single-target WITHOUT Dancing Lights, but hits ALL enemies WHILE armed", () => {
  // CONTROL — no Dancing Lights: Blade of Ashes strikes only the chosen target.
  {
    const j = jarrik();
    const e1 = enemy("e1");
    const e2 = enemy("e2");
    const st = makeState([j], [e1, e2]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e1"] });
    assert.equal(e1.hp, 90, "target hit for 10");
    assert.equal(e2.hp, 100, "the other enemy is untouched (single target)");
    assert.ok(!hasMark(e2, "Cinders"), "the other enemy is not marked");
  }
  // ARMED — Dancing Lights active: Blade of Ashes hits every enemy (and marks each).
  {
    const j = jarrik();
    j.statuses.push(dancingLights(5) as never);
    const e1 = enemy("e1");
    const e2 = enemy("e2");
    const st = makeState([j], [e1, e2]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e1"] });
    assert.equal(e1.hp, 90, "e1 hit for 10");
    assert.equal(e2.hp, 90, "e2 ALSO hit for 10 (targets all enemies while armed)");
    assert.ok(hasMark(e1, "Cinders") && hasMark(e2, "Cinders"), "both enemies are marked with Cinders");
  }
});

test("Blade of Dancing Lights: while armed, a Cinders proc auto-summons a Cinderling", () => {
  // ARMED — the marked enemy is damaged, the Cinders passive fires, and (because Dancing Lights is
  // active) it also mints a Cinderling.
  {
    const j = jarrik();
    j.statuses.push(dancingLights(5) as never);
    const e = enemy("e", [cinders()]);
    const st = makeState([j], [e]);
    fund(st);
    assert.equal(cinderlings(st), 0, "no Cinderlings before the proc");
    performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
    assert.equal(e.hp, 80, "the proc still deals its +10 (10 base + 10 rider)");
    assert.equal(cinderlings(st), 1, "the Cinders proc while armed auto-creates one Cinderling");
  }
  // CONTROL — identical proc WITHOUT Dancing Lights: rider fires, but no Cinderling is minted.
  {
    const j = jarrik();
    const e = enemy("e", [cinders()]);
    const st = makeState([j], [e]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
    assert.equal(e.hp, 80, "rider still fires (10 + 10)");
    assert.equal(cinderlings(st), 0, "no Dancing Lights → the proc summons nothing");
  }
});

// ============================================================================
// Costs / currency (drive-detail: Specific cost is paid from Jarrik's Fire pool)
// ============================================================================

test("Cinderswell requires 1 Generic + 1 Fire; without Fire energy the cast is refused", () => {
  const j = jarrik();
  const st = makeState([j], [enemy("e")]);
  st.teams.A.energy = { generic: 40, fire: 0 }; // Generic only — the Specific (Fire) cost is unpayable

  const denied = performAction(st, { unit: "j", skillId: "jarrik2", targets: [] });
  assert.equal(denied.ok, false, "no Fire → cannot pay Cinderswell's Specific cost");
  assert.equal(denied.reason, "insufficient-energy", "refused for insufficient energy");

  st.teams.A.energy = { generic: 40, fire: 40 };
  const ok = performAction(st, { unit: "j", skillId: "jarrik2", targets: [] });
  assert.equal(ok.ok, true, "with Fire available the cast succeeds");
});

test("Blade of Dancing Lights costs 2 Fire (Specific) — 1 Fire is not enough", () => {
  const j = jarrik();
  const st = makeState([j], [enemy("e", [cinders()])]);
  st.teams.A.energy = { generic: 40, fire: 1 };

  const denied = performAction(st, { unit: "j", skillId: "jarrik5", targets: [] });
  assert.equal(denied.ok, false, "1 Fire cannot cover the 2-Fire Specific cost");

  st.teams.A.energy = { generic: 40, fire: 2 };
  const ok = performAction(st, { unit: "j", skillId: "jarrik5", targets: [] });
  assert.equal(ok.ok, true, "2 Fire pays the Specific cost");
});
