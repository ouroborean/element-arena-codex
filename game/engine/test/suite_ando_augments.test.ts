import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { TriggeredEffect } from "../src/events.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, spec-derived AUGMENT suite for ANDO ("Ando-91"), element = lightning.
// The FROZEN AUGMENT PROSE (content/frozen/augments.json) is the oracle for every
// assertion. Frozen augment text used:
//  ando1 Afterimage:        "If Ando uses Flash Step while Uncharged, he becomes
//                            invulnerable to non-strategic skills for 1 turn."
//  ando2 Static Repulsion:  "When Ando uses Focus Power, he gains 5 DR for 2 turns
//                            for each target marked by Electroblade."
//  ando3 Pulse Blade:       "Expel Energy also marks its target and another random
//                            target with Electroblade."
//  ando4 On the Clock:      "Overclock is now permanent, but Ando receives 15
//                            Affliction damage when he uses a Supercharged ability."
//  ando5 Singular Directive:"While Ando is Charged or Supercharged, he ignores
//                            Counters and Reflects."
//
// Drive facts (content only): skill ids — ando1 Electroblade {generic:1, Harmful},
//  ando2 Flash Step {lightning:1}, ando3 Expel Energy {lightning:1, Harmful, single},
//  ando4 Focus Power {0, self}, ando5 Overclock {lightning:1, requires Supercharged}.
//  Marks: "Charged"/"Supercharged" (self), "Electroblade" (enemies). Statuses:
//  invulnerable, damage_reduction, elemental_essence, shatter.
// ===========================================================================

const mkAndo = (): Unit => loadHero(heroById("ando"), "A", "ando");
function fund(st: MatchState): void {
  st.teams.A.energy = { generic: 40, lightning: 40 };
}

const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const markDur = (u: Unit, name: string): number | null | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === name)?.duration;
const hasEB = (u: Unit): boolean => hasMark(u, "Electroblade");
const drTotal = (u: Unit): number =>
  u.statuses.filter((s) => s.kind === "damage_reduction").reduce((t, s) => t + (s.magnitude ?? 0), 0);
const drStatus = (u: Unit) => u.statuses.find((s) => s.kind === "damage_reduction");
const invuln = (u: Unit) => u.statuses.find((s) => s.kind === "invulnerable");
const hasShatter = (u: Unit): boolean => u.statuses.some((s) => s.kind === "shatter");

const charged = (): Unit["statuses"][number] => status("mark", { name: "Charged", duration: 1, appliedBy: "ando", appliedTurn: 1 });
const supercharged = (d = 1): Unit["statuses"][number] => status("mark", { name: "Supercharged", duration: d, appliedBy: "ando", appliedTurn: 1 });
const eb = (): Unit["statuses"][number] => status("mark", { name: "Electroblade", duration: null, appliedBy: "ando", appliedTurn: 1 });

function enemy(id: string, extra: Partial<Unit> = {}): Unit {
  return makeUnit({ id, team: "B", hp: 100, maxHp: 100, kind: "hero", ...extra });
}

// An enemy Harmful skill used to probe Ando's invulnerable scope. `strategic` toggles the
// "Strategic" class tag (the frozen scope keyword). Cost 0 so team B needs no funding.
function harmfulSkill(id: string, dmg: number, strategic: boolean): ReturnType<typeof skill> {
  return skill(id, [{ op: "damage", amount: dmg, to: "target" }], {
    tags: strategic ? ["Harmful", "Strategic", "Instant"] : ["Harmful", "Instant"],
    targeting: "single",
  });
}

// A counter / reflect trigger owned by an enemy, gated on "a Harmful skill was declared at me".
const mkCounter = (owner: string): TriggeredEffect => ({
  on: "skillDeclared", owner, kind: "counter", source: "test-counter",
  when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
  effect: [{ op: "damage", amount: 10, to: "eventSource" }],
});
const mkReflect = (owner: string): TriggeredEffect => ({
  on: "skillDeclared", owner, kind: "reflect", source: "test-reflect",
  when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] },
  redirectTo: "eventSource", effect: [],
});

// ===========================================================================
// ando1 — Afterimage: "If Ando uses Flash Step while Uncharged, he becomes
// invulnerable to non-strategic skills for 1 turn."
// ===========================================================================

test("Afterimage: Flash Step while Uncharged grants an invulnerable status lasting 1 turn", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando1")!);
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  assert.equal(invuln(ando), undefined, "control: not invulnerable before Flash Step");

  const res = performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] });
  assert.equal(res.ok, true, "Flash Step casts");
  assert.equal(hasShatter(e1), true, "base Flash Step still Shatters the target");
  const iv = invuln(ando);
  assert.ok(iv, "Flash Step from Uncharged makes Ando invulnerable");
  assert.equal(iv!.duration, 1, "'for 1 turn' -> the invulnerable has duration 1");
});

test("Afterimage: NO invulnerability if Ando uses Flash Step while Charged (frozen: 'while Uncharged')", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando1")!);
  ando.statuses.push(charged());
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] });
  assert.equal(invuln(ando), undefined, "Charged Flash Step grants no invulnerability");
});

test("Afterimage: NO invulnerability if Ando uses Flash Step while Supercharged (Uncharged = neither charge mark)", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando1")!);
  ando.statuses.push(supercharged());
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] });
  assert.equal(invuln(ando), undefined, "Supercharged Flash Step grants no invulnerability");
});

test("Afterimage: only Flash Step triggers it — using a different skill (Electroblade) while Uncharged does NOT", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando1")!);
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  // Electroblade while Uncharged: a valid Uncharged skill use, but not Flash Step.
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(invuln(ando), undefined, "the augment is scoped to Flash Step only");
});

test("Afterimage (behavioral): while invulnerable, an incoming NON-Strategic Harmful skill is blocked (no damage)", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando1")!);
  const e1 = enemy("e1", { skills: [harmfulSkill("hit", 20, false)] });
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] }); // Uncharged -> invulnerable
  assert.ok(invuln(ando), "precondition: Ando is invulnerable");
  const before = ando.hp;
  const atk = performAction(state, { unit: "e1", skillId: "hit", targets: ["ando"] });
  assert.equal(atk.ok, false, "a non-Strategic Harmful skill cannot land on the invulnerable Ando");
  assert.equal(ando.hp, before, "Ando takes no damage from the non-Strategic skill");
});

// SUSPECTED BUG — Afterimage frozen: "invulnerable to NON-STRATEGIC skills". A STRATEGIC
// Harmful skill should therefore STILL hit Ando. The shipped augment applies an *unscoped*
// invulnerable (applyStatus {kind:"invulnerable", duration:1} with no {tag:"Strategic",
// mode:"except"} scope), so invulnerableBlocks() blocks EVERY Harmful skill — Strategic ones
// included. The engine blocks the Strategic hit that the frozen text says must land.
test.skip("SUSPECTED BUG: Afterimage invulnerability is only vs non-Strategic; a Strategic Harmful skill must still hit", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando1")!);
  const e1 = enemy("e1", { skills: [harmfulSkill("strat", 20, true)] });
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando2", targets: ["e1"] }); // Uncharged -> invulnerable
  assert.ok(invuln(ando), "precondition: Ando is invulnerable");
  const before = ando.hp;
  const atk = performAction(state, { unit: "e1", skillId: "strat", targets: ["ando"] });
  // Frozen: invulnerability does NOT cover Strategic skills, so this must resolve and deal 20.
  assert.equal(atk.ok, true, "a STRATEGIC Harmful skill is not blocked by 'invulnerable to non-strategic skills'");
  assert.equal(ando.hp, before - 20, "the Strategic hit lands for 20");
});

// ===========================================================================
// ando2 — Static Repulsion: "When Ando uses Focus Power, he gains 5 DR for 2 turns
// for each target marked by Electroblade."
// ===========================================================================

test("Static Repulsion: Focus Power with 2 Electroblade-marked enemies grants 10 DR (5 x 2) for 2 turns", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando2")!);
  const e1 = enemy("e1", { statuses: [eb()] });
  const e2 = enemy("e2", { statuses: [eb()] });
  const state = makeState([ando], [e1, e2]); // Ando Uncharged -> Focus Power adds no marks/random-mark
  fund(state);

  assert.equal(drTotal(ando), 0, "control: no DR before Focus Power");
  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(drTotal(ando), 10, "5 DR per Electroblade target x2 marked enemies = 10");
  assert.equal(drStatus(ando)!.duration, 2, "'for 2 turns' -> DR duration 2");
});

test("Static Repulsion: DR scales per marked target — 1 marked enemy grants 5 DR", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando2")!);
  const e1 = enemy("e1", { statuses: [eb()] });
  const e2 = enemy("e2"); // unmarked control -> not counted
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(drTotal(ando), 5, "exactly one Electroblade-marked enemy -> 5 DR");
});

test("Static Repulsion: with NO Electroblade-marked enemies, Focus Power grants 0 DR", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando2")!);
  const state = makeState([ando], [enemy("e1"), enemy("e2")]); // none marked
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(drTotal(ando), 0, "'for each target marked' with 0 marked = 0 DR");
});

test("Static Repulsion: the DR is the augment's — base Focus Power (no augment) grants no DR", () => {
  const ando = mkAndo(); // no augment
  const e1 = enemy("e1", { statuses: [eb()] });
  const e2 = enemy("e2", { statuses: [eb()] });
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando4", targets: [] });
  assert.equal(drTotal(ando), 0, "unaugmented Focus Power gives no Damage Reduction");
});

// ===========================================================================
// ando3 — Pulse Blade: "Expel Energy also marks its target and another random target
// with Electroblade."
// ===========================================================================

test("Pulse Blade: Expel Energy marks its target with Electroblade", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando3")!);
  const e1 = enemy("e1"); // the declared target
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(e1.hp, 90, "base Expel still deals 10 to its target");
  assert.equal(hasEB(e1), true, "Pulse Blade marks the Expel target with Electroblade");
});

// SUSPECTED BUG — Pulse Blade frozen: "marks its target and ANOTHER random target". "Another" means a
// SECOND, DISTINCT enemy. The shipped augment draws the second mark from `{pick:"random",
// from:{faction:"enemies"}}` — a pool that still INCLUDES the just-marked primary target (no `without`
// exclusion of the Electroblade mark it just applied). So the "random" pick can (and here, with the
// default seed and exactly one other enemy, does) land back on the target, leaving the second enemy
// unmarked: only ONE enemy ends marked instead of the frozen's two distinct targets.
test.skip("SUSPECTED BUG: Pulse Blade's 'another random target' must be a distinct 2nd enemy (target + another = 2 marked)", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando3")!);
  const e1 = enemy("e1"); // the declared target
  const e2 = enemy("e2"); // the only other enemy -> the 'another random target' must be e2
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(hasEB(e1), true, "the target is marked with Electroblade");
  const marked = [e1, e2].filter(hasEB).length;
  assert.equal(marked, 2, "target + a DISTINCT 'another' = two Electroblade-marked enemies");
  assert.equal(hasEB(e2), true, "the second (random) mark must land on the OTHER enemy, not the target again");
});

test("Pulse Blade: 'another random target' marks exactly one additional enemy (target + 1 among several)", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando3")!);
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const e3 = enemy("e3");
  const state = makeState([ando], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(hasEB(e1), true, "the declared target is always marked");
  const othersMarked = [e2, e3].filter(hasEB).length;
  assert.equal(othersMarked, 1, "exactly one OTHER enemy is marked ('another random target')");
});

test("Pulse Blade: the marks are the augment's — base Expel Energy (no augment) marks nobody", () => {
  const ando = mkAndo(); // no augment
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(hasEB(e1), false, "unaugmented Expel does not mark its target");
  assert.equal(hasEB(e2), false, "and marks no other enemy");
});

// ===========================================================================
// ando4 — On the Clock: "Overclock is now permanent, but Ando receives 15 Affliction
// damage when he uses a Supercharged ability."
// ===========================================================================

test("On the Clock (clause 1): Overclock's window is now PERMANENT (duration null, vs base 3)", () => {
  const base = mkAndo(); // base Overclock -> 3-turn window
  base.statuses.push(supercharged(1));
  const bs = makeState([base], [enemy("e1")]);
  fund(bs);
  performAction(bs, { unit: "ando", skillId: "ando5", targets: [] });
  assert.equal(markDur(base, "Overclock"), 3, "control: base Overclock window lasts 3 turns");

  const ando = mkAndo();
  applyAugment(ando, augmentById("ando4")!);
  ando.statuses.push(supercharged(1));
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando5", targets: [] });
  assert.equal(hasMark(ando, "Overclock"), true, "augmented Overclock still opens the window");
  assert.equal(markDur(ando, "Overclock"), null, "'now permanent' -> the Overclock mark has no expiry (null)");
});

test("On the Clock (clause 1): the permanent Overclock window survives many turns", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando4")!);
  ando.statuses.push(supercharged(3));
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando5", targets: [] });

  for (let i = 0; i < 6; i++) endTurn(state); // 3 of Ando's own turn-ends would expire a base 3-turn window
  assert.equal(hasMark(ando, "Overclock"), true, "a permanent Overclock window does not expire over time");
});

test("On the Clock (clause 2): using a Supercharged ability deals Ando 15 Affliction self-damage", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando4")!);
  ando.statuses.push(supercharged());
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  const before = ando.hp;
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // a Supercharged Electroblade
  assert.equal(ando.hp, before - 15, "Ando takes 15 self-damage for using a Supercharged ability");
});

test("On the Clock (clause 2): NO self-damage when the ability is used while Uncharged (not Supercharged)", () => {
  // Uncharged Ando uses Electroblade -> becomes Charged; at no point is he Supercharged, so no self-damage.
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando4")!);
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  const before = ando.hp;
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(hasMark(ando, "Charged"), true, "the Uncharged use advanced him to Charged (not Supercharged)");
  assert.equal(ando.hp, before, "a non-Supercharged ability use costs Ando no HP");
});

// SUSPECTED BUG — On the Clock frozen: 15 Affliction "when he uses a SUPERCHARGED ability". A skill used
// while CHARGED is a Charged ability (it gets Electroblade's Charged augmentation, not the Supercharged
// AOE) — using it merely ADVANCES Ando to Supercharged. Frozen therefore should NOT charge the 15 here.
// But the added trigger checks `has Supercharged` at skillUsed time, which fires AFTER the passive has
// already advanced Charged -> Supercharged, so the engine wrongly applies 15 to a Charged ability use.
test.skip("SUSPECTED BUG: a CHARGED ability use (which advances to Supercharged) must NOT incur the 15 Affliction", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando4")!);
  ando.statuses.push(charged());
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  const before = ando.hp;
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // a CHARGED Electroblade
  assert.equal(hasMark(ando, "Supercharged"), true, "the cast advanced Charged -> Supercharged (as a RESULT)");
  assert.equal(ando.hp, before, "the ability used was Charged, not Supercharged -> no 15 Affliction");
});

test("On the Clock (clause 2): the 15 is Affliction — it bypasses Ando's own Shield", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando4")!);
  ando.statuses.push(supercharged());
  ando.shields = [{ amount: 40, duration: null, appliedBy: "x", appliedTurn: 0 }];
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  const before = ando.hp;
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(ando.hp, before - 15, "Affliction damage bypasses the Shield and reaches HP for the full 15");
  assert.equal(ando.shields.reduce((t, s) => t + s.amount, 0), 40, "the Shield is untouched (Affliction ignored it)");
});

test("On the Clock (clause 2): the self-damage is the augment's — base Ando takes none for a Supercharged ability", () => {
  const ando = mkAndo(); // no augment
  ando.statuses.push(supercharged());
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  const before = ando.hp;
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(ando.hp, before, "unaugmented Ando pays no HP for a Supercharged ability");
});

// ===========================================================================
// ando5 — Singular Directive: "While Ando is Charged or Supercharged, he ignores
// Counters and Reflects."
// ===========================================================================

test("Singular Directive: while Charged, Ando ignores a Counter — the skill resolves and the counter does not fire", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando5")!);
  ando.statuses.push(charged());
  const e1 = enemy("e1");
  e1.triggers = [mkCounter("e1")]; // counters the next Harmful skill aimed at it, punishing the caster for 10
  const state = makeState([ando], [e1]);
  fund(state);

  const res = performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // Charged Electroblade
  assert.notEqual(res.countered, true, "Charged: the Counter is ignored, the skill is not negated");
  assert.equal(e1.hp, 85, "Electroblade resolves — 15 damage lands");
  assert.equal(ando.hp, 100, "the Counter's 10-damage punish never happens");
});

test("Singular Directive (control): while Uncharged, the Counter fires normally", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando5")!); // augment applied, but Ando is neither Charged nor Supercharged
  const e1 = enemy("e1");
  e1.triggers = [mkCounter("e1")];
  const state = makeState([ando], [e1]);
  fund(state);

  const res = performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(res.countered, true, "Uncharged: the Counter still negates Ando's skill");
  assert.equal(e1.hp, 100, "the countered Electroblade deals no damage");
  assert.equal(ando.hp, 90, "the Counter punishes Ando for 10");
});

test("Singular Directive: while Supercharged, Ando ignores a Reflect — the skill is not redirected", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando5")!);
  ando.statuses.push(supercharged());
  const e1 = enemy("e1");
  e1.triggers = [mkReflect("e1")]; // would bounce the Harmful skill back onto Ando
  const state = makeState([ando], [e1]);
  fund(state);

  const res = performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] }); // Supercharged Expel = 30 Piercing
  assert.notEqual(res.countered, true, "not cancelled");
  assert.equal(e1.hp, 70, "the Reflect is ignored — Expel resolves on the enemy for 30");
  assert.equal(ando.hp, 100, "nothing was bounced back onto Ando");
});

test("Singular Directive (control): while Uncharged, the Reflect fires — the skill is bounced back at Ando", () => {
  const ando = mkAndo();
  applyAugment(ando, augmentById("ando5")!);
  const e1 = enemy("e1");
  e1.triggers = [mkReflect("e1")];
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] }); // Uncharged Expel = 10, reflected onto Ando
  assert.equal(e1.hp, 100, "Uncharged: the Reflect redirects the skill off the enemy");
  assert.equal(ando.hp, 90, "the redirected Expel hits Ando for 10");
});
