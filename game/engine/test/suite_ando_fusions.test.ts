import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startRound } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { stackCount } from "../src/status.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, spec-derived FUSION-FORM suite for ANDO. The FROZEN PROSE
// (content/frozen/skills.json) is the oracle for every assertion; authored content
// (fusions.authored.json) is read only to learn how to DRIVE (element keys, skill ids,
// costs, targeting, status/mark names). Ando has 10 fusion forms; each installs a
// passive + one active skill (inserted at slot 3). Frozen text per form is quoted
// inline above each section.
//
// Global drive facts: applyFusion re-elements Ando to the form element and REPLACES the
// base passive triggers with the fusion passive's (so the base "Stored Charge" auto-advance
// is gone on a fused Ando — charge gains are driven here directly). Fusion actives carry
// their form element as the Specific cost currency (paid in currentElement = the form
// element). We fund both teams generously across every element.
// ===========================================================================

const ELEMENTS = [
  "generic", "lightning", "aurora", "battery", "current", "ion",
  "magnet", "plasma", "reanimation", "storm", "thunder", "vengeance", "fire",
];
function fund(st: MatchState): void {
  const pool: Record<string, number> = {};
  for (const e of ELEMENTS) pool[e] = 40;
  st.teams.A.energy = { ...pool };
  st.teams.B.energy = { ...pool };
}

function fuse(form: string): Unit {
  const a = loadHero(heroById("ando"), "A", "ando");
  applyFusion(a, fusionForm("ando", form)!);
  return a;
}

function enemy(id: string, extra: Partial<Unit> & { shield?: number } = {}): Unit {
  return makeUnit({ id, team: "B", hp: 100, maxHp: 100, kind: "hero", ...extra });
}

// ---- status readers ----
const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const markDur = (u: Unit, name: string): number | null | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === name)?.duration;
const has = (u: Unit, kind: string): boolean => u.statuses.some((s) => s.kind === kind);
const statOf = (u: Unit, kind: string) => u.statuses.find((s) => s.kind === kind);
const omod = (u: Unit): number =>
  u.statuses.filter((s) => s.kind === "outgoing_damage_mod").reduce((n, s) => n + (s.magnitude ?? 0), 0);
const shieldTotal = (u: Unit): number => (u.shields ?? []).reduce((n, s) => n + s.amount, 0);
const dr = (m: number) => status("damage_reduction", { magnitude: m });

// Drive a "charge gain": place the mark and announce it, exactly the reactive hook the fusion
// passives listen for (statusApplied of a Charged/Supercharged mark on Ando).
function gainCharge(state: MatchState, u: Unit, name: "Charged" | "Supercharged", dur = 1): void {
  u.statuses.push(status("mark", { name, duration: dur, appliedBy: u.id, appliedTurn: state.turn }));
  emit(state, { type: "statusApplied", unit: u.id, source: u.id, kind: "mark", name });
}

// ===========================================================================
// AURORA — Modular Core (passive) + Slicing Spectrum (andoaurora1)
//   Modular Core: "While Charged or Supercharged, Ando ignores non-damage effects."
//   Slicing Spectrum: "Deals 15 Damage to the enemy team, along with an additional random
//     effect from among: Deals 10 additional Affliction damage to all targets, Lowers all
//     targets' damage by 5 for their next turn, Grants all allies 10 Shield, or Increases
//     Ando's damage by 10 for his next turn."
// ===========================================================================

test("Modular Core: while Charged, an enemy-applied non-damage effect (stun) is ignored; damage still lands", () => {
  const ando = fuse("aurora");
  const e1 = enemy("e1");
  e1.skills = [
    skill("estun", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { tags: ["Harmful", "Control"], targeting: "single" }),
    skill("ehit", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful"], targeting: "single" }),
  ];
  const state = makeState([ando], [e1]);
  fund(state);

  gainCharge(state, ando, "Charged"); // Modular Core installs non_damage_ignore on this gain
  assert.equal(has(ando, "non_damage_ignore"), true, "Charged Ando holds the non-damage-ignore ward");

  performAction(state, { unit: "e1", skillId: "estun", targets: ["ando"] });
  assert.equal(has(ando, "stun"), false, "the enemy stun (a non-damage harmful effect) is IGNORED while Charged");

  // Control within the same state: DAMAGE is not a non-damage effect and still lands.
  performAction(state, { unit: "e1", skillId: "ehit", targets: ["ando"] });
  assert.equal(ando.hp, 80, "damage is unaffected by Modular Core — Ando still takes the 20");
});

test("Modular Core control: an UN-charged Ando is stunned normally (the ward requires Charged/Supercharged)", () => {
  const ando = fuse("aurora");
  const e1 = enemy("e1");
  e1.skills = [skill("estun", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { tags: ["Harmful", "Control"], targeting: "single" })];
  const state = makeState([ando], [e1]);
  fund(state);

  assert.equal(has(ando, "non_damage_ignore"), false, "no ward without a charge");
  performAction(state, { unit: "e1", skillId: "estun", targets: ["ando"] });
  assert.equal(has(ando, "stun"), true, "an un-charged Ando IS stunned (control)");
});

test("Slicing Spectrum: 15 to the whole enemy team, plus exactly ONE of the four random side-effects", () => {
  const ando = fuse("aurora");
  const ally = loadHero(heroById("ando"), "A", "ally"); // a second ally to witness the 'all allies' shield branch
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const e3 = enemy("e3");
  const state = makeState([ando, ally], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "andoaurora1", targets: [] }); // all-enemies, specific 1 aurora

  // Base clause: 15 to EVERY enemy (affliction branch adds another 10, so an enemy is at 75 or 85).
  for (const e of [e1, e2, e3]) assert.ok(e.hp === 85 || e.hp === 75, `every enemy took the base 15 (hp ${e.hp})`);

  const branchAffliction = [e1, e2, e3].every((e) => e.hp === 75); // 15 + 10 affliction
  const branchWeaken = [e1, e2, e3].every((e) => omod(e) === -5) && [e1, e2, e3].every((e) => e.hp === 85);
  const branchShield = [ando, ally].every((u) => shieldTotal(u) === 10);
  const branchAndoBuff = omod(ando) === 10;

  const fired = [branchAffliction, branchWeaken, branchShield, branchAndoBuff].filter(Boolean).length;
  assert.equal(fired, 1, "exactly one of the four random side-effects manifested");
  // When it is NOT the affliction branch, every enemy sits at exactly 15 taken.
  if (!branchAffliction) for (const e of [e1, e2, e3]) assert.equal(e.hp, 85, "non-affliction branch: enemies took exactly 15");
});

// ===========================================================================
// BATTERY — Capacitor Upgrade (passive) + Rev (andobattery1)
//   Capacitor Upgrade: "Expel Energy deals 5 more damage each time Ando gains Charged or
//     Supercharged. This effect stacks and is removed when Expel Energy is used."
//   Rev: "Deals 15 Damage to target enemy and generating another stack of Capacitor Upgrade.
//     Every use of this skill will generate an additional stack, up to 3."
// ===========================================================================

test("Capacitor Upgrade: each Charged/Supercharged gain adds +5 to Expel Energy; using Expel spends the stacks", () => {
  const ando = fuse("battery");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  // Two charge gains -> two stacks -> +10 to Expel Energy (ando3 base = 10 from uncharged; charge state
  // is gone on a fused Ando so no +10/+20 charge branch, isolating the Capacitor bonus).
  gainCharge(state, ando, "Charged");
  gainCharge(state, ando, "Supercharged");
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 2, "two charge gains -> two Capacitor stacks");
  // Charge marks were only a vehicle for the gain event; drop them so Expel sees an uncharged base of 10.
  ando.statuses = ando.statuses.filter((s) => !(s.kind === "mark" && (s.name === "Charged" || s.name === "Supercharged")));

  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] }); // Expel Energy
  assert.equal(e1.hp, 80, "Expel base 10 + 2*5 Capacitor bonus = 20 damage");
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 0, "Capacitor Upgrade is removed when Expel Energy is used");
});

test("Capacitor Upgrade control: with NO charge gains, Expel Energy deals only its base 10", () => {
  const ando = fuse("battery");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 0, "no stacks without a charge gain");
  performAction(state, { unit: "ando", skillId: "ando3", targets: ["e1"] });
  assert.equal(e1.hp, 90, "base Expel Energy = 10, no Capacitor bonus");
});

test("Rev: 15 damage and an escalating number of Capacitor stacks per use (1, then 2, then 3, capped at 3)", () => {
  const ando = fuse("battery");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "andobattery1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "Rev deals 15");
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 1, "1st Rev generates 1 Capacitor stack");

  performAction(state, { unit: "ando", skillId: "andobattery1", targets: ["e1"] });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 3, "2nd Rev generates 2 more (total 3)");

  performAction(state, { unit: "ando", skillId: "andobattery1", targets: ["e1"] });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 6, "3rd Rev generates 3 more (total 6)");

  performAction(state, { unit: "ando", skillId: "andobattery1", targets: ["e1"] });
  assert.equal(stackCount(ando, "Capacitor Upgrade"), 9, "4th Rev is capped at 3 per use (total 9, not 10)");
  assert.equal(e1.hp, 40, "each Rev dealt 15 (4 * 15 = 60)");
});

// ===========================================================================
// CURRENT — Conductive Combo (passive) + Rising Geyser (andocurrent1)
//   Conductive Combo: "Electroblade's Mark effect now lasts for Ando's next three turns."
//   Rising Geyser: "Deals 20 Damage to target enemy and marks them with Rising Geyser for 3
//     turns. Targets marked by Rising Geyser replicate all new damage they receive to other
//     marked targets."
// ===========================================================================

test("Conductive Combo: an Electroblade mark Ando applies now lasts 3 turns (base is permanent/null)", () => {
  // control: a base (un-fused) Ando's Electroblade mark is permanent.
  const base = loadHero(heroById("ando"), "A", "ando");
  const be = enemy("e1");
  const bs = makeState([base], [be]);
  fund(bs);
  performAction(bs, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(markDur(be, "Electroblade"), null, "base Electroblade mark is permanent (duration null)");

  const ando = fuse("current");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(hasMark(e1, "Electroblade"), true, "target is Electroblade-marked");
  assert.equal(markDur(e1, "Electroblade"), 3, "Conductive Combo sets the mark to last 3 turns");
});

test("Rising Geyser: 20 damage + a 3-turn Rising Geyser mark; marked targets replicate NEW damage to each other", () => {
  const ando = fuse("current");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const e3 = enemy("e3"); // control: never marked
  const state = makeState([ando], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "andocurrent1", targets: ["e1"] });
  assert.equal(e1.hp, 80, "Rising Geyser deals 20 to the target");
  assert.equal(hasMark(e1, "Rising Geyser"), true, "target gains the Rising Geyser mark");
  assert.equal(markDur(e1, "Rising Geyser"), 3, "mark lasts 3 turns");

  performAction(state, { unit: "ando", skillId: "andocurrent1", targets: ["e2"] }); // mark e2 as well
  assert.equal(hasMark(e2, "Rising Geyser"), true, "e2 is now also marked");

  const e1Before = e1.hp, e2Before = e2.hp, e3Before = e3.hp;
  // A fresh, independent damage on e1 (Electroblade, 15) must replicate to the other marked target e2.
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.equal(e1Before - e1.hp, 15, "e1 takes the direct 15");
  assert.equal(e2Before - e2.hp, 15, "the 15 is replicated to the other Rising-Geyser target e2");
  assert.equal(e3.hp, e3Before, "an unmarked enemy receives no replicated damage");
});

// ===========================================================================
// ION — Ionic Cloaking (passive) + Singularity (andoion1)
//   Ionic Cloaking: "Ando is Stealthed while Supercharged. (He will not trigger enemy effects.)"
//   Singularity: "For the next 2 turns, Ando will cast Electroblade on any enemy who attempts
//     to become Invulnerable, and will cast Flash Step on any enemy who uses a harmful skill."
// ===========================================================================

test("Ionic Cloaking: gaining Supercharged Stealths Ando for the Supercharge's duration", () => {
  const ando = fuse("ion");
  const state = makeState([ando], [enemy("e1")]);
  fund(state);

  assert.equal(has(ando, "stealth"), false, "no stealth before Supercharge");
  gainCharge(state, ando, "Supercharged", 2);
  assert.equal(has(ando, "stealth"), true, "Supercharged Ando is Stealthed");
  assert.equal(statOf(ando, "stealth")?.duration, 2, "stealth window tracks the Supercharge duration (2)");
});

test("Ionic Cloaking control: merely Charged (not Supercharged) does NOT Stealth Ando", () => {
  const ando = fuse("ion");
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  gainCharge(state, ando, "Charged");
  assert.equal(has(ando, "stealth"), false, "Charged is not Supercharged — no stealth");
});

test("Singularity: an enemy who uses a Harmful skill is Flash-Stepped (Shattered) by Ando; a control enemy is not", () => {
  const ando = fuse("ion");
  const e1 = enemy("e1");
  const e2 = enemy("e2"); // control: acts BEFORE the window / never harmful
  e1.skills = [skill("ehit", [{ op: "damage", amount: 5, to: "target" }], { tags: ["Harmful"], targeting: "single" })];
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "andoion1", targets: [] }); // self; opens the 2-turn watch
  assert.equal(hasMark(ando, "Singularity"), true, "Singularity mark is placed on Ando");
  assert.equal(markDur(ando, "Singularity"), 2, "the watch runs for 2 turns");

  performAction(state, { unit: "e1", skillId: "ehit", targets: ["ando"] }); // e1 uses a Harmful skill
  assert.equal(has(e1, "shatter"), true, "Ando retaliates with Flash Step — e1 is Shattered");
  assert.equal(has(e2, "shatter"), false, "an enemy that did NOT use a harmful skill is untouched");
});

// ===========================================================================
// MAGNET — Charge Absorption (passive) + Opposites Attract (andomagnet1, hidden)
//   Charge Absorption: "Whenever Ando's skills gain additional targets, he gains 10 Shield for
//     each extra target affected."
//   Opposites Attract: "For 1 turn, any helpful skill used on target enemy will be reflected to
//     Ando, and any damaging skills used on Ando will be reflected to target enemy. This skill
//     is invisible."
// ===========================================================================

test("Charge Absorption: a Supercharged Electroblade spreading to 3 enemies grants 10 Shield per extra target", () => {
  const ando = fuse("magnet");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const e3 = enemy("e3");
  const state = makeState([ando], [e1, e2, e3]);
  fund(state);

  // Give Ando Supercharged so base Electroblade (single-target) spreads to ALL enemies: 3 affected,
  // base targeting is 1 -> 2 EXTRA targets -> 10*2 = 20 Shield.
  ando.statuses.push(status("mark", { name: "Supercharged", duration: 2, appliedBy: "ando", appliedTurn: 1 }));
  assert.equal(shieldTotal(ando), 0, "no shield before the spread");
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] });
  assert.ok(e2.hp < 100 && e3.hp < 100, "Supercharged Electroblade did spread to the other enemies");
  assert.equal(shieldTotal(ando), 20, "10 Shield per extra target (2 extra) = 20");
});

test("Charge Absorption control: a normal single-target skill (no extra targets) grants NO shield", () => {
  const ando = fuse("magnet");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // uncharged: hits only e1
  assert.equal(e2.hp, 100, "no spread");
  assert.equal(shieldTotal(ando), 0, "no extra targets -> no Charge Absorption shield");
});

test("Opposites Attract: a damaging skill used on Ando is reflected to the marked enemy; control Ando takes it", () => {
  const ando = fuse("magnet");
  const e1 = enemy("e1"); // the marked target
  const e2 = enemy("e2"); // the attacker
  e2.skills = [skill("ebig", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful"], targeting: "single" })];
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "andomagnet1", targets: ["e1"] }); // mark e1
  assert.equal(hasMark(e1, "Opposites Attract"), true, "e1 carries the Opposites Attract mark");

  const andoBefore = ando.hp;
  performAction(state, { unit: "e2", skillId: "ebig", targets: ["ando"] }); // damaging skill on Ando
  assert.equal(ando.hp, andoBefore, "the damage aimed at Ando is reflected away — Ando is unharmed");
  assert.equal(e1.hp, 80, "the 20 damage lands on the marked enemy instead");
});

// ===========================================================================
// PLASMA — Laser Edge (passive) + Burning Crescent (andoplasma1)
//   Laser Edge: "Enemies marked by Electroblade receive 5 Affliction Damage each turn."
//   Burning Crescent: "Deals 35 Damage to target enemy. This skill Bypasses on targets marked
//     by Electroblade, and deals 10 additional damage to Shattered enemies."
// ===========================================================================

test("Laser Edge: an Electroblade-marked enemy takes 5 Affliction each of Ando's turns; an unmarked enemy does not", () => {
  const ando = fuse("plasma");
  const e1 = enemy("e1");
  const e2 = enemy("e2"); // control: never marked
  const state = makeState([ando], [e1, e2]);
  fund(state);

  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // marks e1 with Electroblade (15 direct)
  assert.equal(e1.hp, 85, "the direct Electroblade hit for 15");
  assert.ok(e1.statuses.some((s) => s.kind === "dot" && s.name === "Laser Edge"), "marked enemy carries the Laser Edge dot");

  // The dot ticks at Ando's (team A) turn-ends, skipping its birth turn. Cycle to Ando's next turn.
  endTurn(state); // end A turn 1 (birth turn — no tick)
  endTurn(state); // end B turn 2
  assert.equal(e1.hp, 85, "no tick on the birth turn / opponent's turn");
  endTurn(state); // end A turn 3 (Ando's next turn) — Laser Edge deals 5 Affliction
  assert.equal(e1.hp, 80, "marked enemy takes 5 Affliction on Ando's turn");
  assert.equal(e2.hp, 100, "an unmarked enemy takes no Laser Edge damage");
});

test("Burning Crescent (base): 35 normal damage — reduced by Damage Reduction on an unmarked target", () => {
  const ando = fuse("plasma");
  const e1 = enemy("e1", { statuses: [dr(10)] });
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andoplasma1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "35 normal minus 10 DR = 25 lost (not Bypassing an unmarked target)");
});

test("Burning Crescent vs Electroblade-marked: ignores DR (Bypass semantics on the DR side)", () => {
  const ando = fuse("plasma");
  const e1 = enemy("e1", { statuses: [status("mark", { name: "Electroblade" }), dr(10)] });
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andoplasma1", targets: ["e1"] });
  assert.equal(e1.hp, 65, "vs an Electroblade-marked target the 10 DR is ignored: full 35 to HP");
});

// SUSPECTED BUG — andoplasma1 frozen: "This skill Bypasses on targets marked by Electroblade."
// "Bypasses" is a defined term meaning ignore Damage Reduction AND Shield. The engine implements the
// Electroblade branch as dtype Piercing (authored fusions), which ignores DR but NOT Shield — so against
// a shielded Electroblade target the shield still absorbs the hit instead of being bypassed.
test.skip("SUSPECTED BUG: Burning Crescent 'Bypasses' should ignore Shield on Electroblade targets, not just DR", () => {
  const ando = fuse("plasma");
  // Electroblade-marked target holding a Shield: a true Bypass ignores the shield entirely.
  const e1 = enemy("e1", { shield: 20, statuses: [status("mark", { name: "Electroblade" }), dr(10)] });
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andoplasma1", targets: ["e1"] });
  assert.equal(e1.hp, 65, "Bypass ignores the 10 DR and the 20 Shield: full 35 to HP");
  assert.equal(shieldTotal(e1), 20, "Bypass does not spend the shield");
});

test("Burning Crescent vs Shattered: +10 additional damage", () => {
  const ando = fuse("plasma");
  const e1 = enemy("e1", { statuses: [status("shatter", { duration: 2 })] }); // no DR: isolate the +10
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andoplasma1", targets: ["e1"] });
  assert.equal(e1.hp, 55, "35 + 10 vs Shattered = 45 lost");
});

// ===========================================================================
// REANIMATION — Lightning Revenant (passive) + Mannequin Protocol (andoreanimation1)
//   Lightning Revenant: "Ando is permanently Isolated. If Ando gains Charged, he heals for 5
//     Health. If he gains Supercharged, he heals for 10 Health."
//   Mannequin Protocol: "Deals 25 Damage to target enemy. This skill cannot be stunned. If used
//     while Stunned, this skill Bypasses and cannot be Countered or Reflected."
// ===========================================================================

test("Lightning Revenant: permanently Isolated at round start; heals 5 on Charged, 10 on Supercharged", () => {
  const ando = fuse("reanimation");
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  startRound(state); // roundStart trigger installs the permanent Isolated
  assert.equal(has(ando, "isolated"), true, "Ando is Isolated after round start");
  assert.equal(statOf(ando, "isolated")?.duration, null, "the Isolation is permanent (duration null)");

  ando.hp = 50;
  gainCharge(state, ando, "Charged");
  assert.equal(ando.hp, 55, "gaining Charged heals 5");
  gainCharge(state, ando, "Supercharged");
  assert.equal(ando.hp, 65, "gaining Supercharged heals 10");
});

test("Lightning Revenant control: an unrelated mark gain heals nothing", () => {
  const ando = fuse("reanimation");
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  ando.hp = 50;
  ando.statuses.push(status("mark", { name: "Something Else", duration: 1, appliedBy: "ando", appliedTurn: 1 }));
  emit(state, { type: "statusApplied", unit: "ando", source: "ando", kind: "mark", name: "Something Else" });
  assert.equal(ando.hp, 50, "an unrelated mark is neither Charged nor Supercharged — no heal");
});

test("Mannequin Protocol: unstunnable — a stunned Ando can still cast it; used while Stunned it Bypasses", () => {
  const ando = fuse("reanimation");
  ando.statuses.push(status("stun", { duration: 1, appliedBy: "e1", appliedTurn: 1 }));
  const e1 = enemy("e1", { statuses: [dr(10)] });
  const state = makeState([ando], [e1]);
  fund(state);

  const res = performAction(state, { unit: "ando", skillId: "andoreanimation1", targets: ["e1"] });
  assert.equal(res.ok, true, "Mannequin Protocol cannot be stunned — the cast goes through");
  // Used while Stunned it Bypasses -> ignores the 10 DR -> full 25.
  assert.equal(e1.hp, 75, "25 Bypassing damage ignores DR while Stunned");
});

test("Mannequin Protocol control: NOT stunned, it is ordinary 25 damage (DR applies)", () => {
  const ando = fuse("reanimation");
  const e1 = enemy("e1", { statuses: [dr(10)] });
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andoreanimation1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "25 normal minus 10 DR = 15 lost (no Bypass when not Stunned)");
});

// ===========================================================================
// STORM — Erratic Programming (passive) + Tempest (andostorm1)
//   Erratic Programming: "Ando is permanently Blinded, but he deals 10 Piercing damage to an
//     additional random target whenever he uses a Harmful skill."
//   Tempest: "Ando deals 15 damage to a random enemy. For the next 3 turns, he will repeat this
//     damage on another random target."
// ===========================================================================

test("Erratic Programming: Ando is permanently Blinded at round start", () => {
  const ando = fuse("storm");
  const state = makeState([ando], [enemy("e1")]);
  fund(state);
  startRound(state);
  assert.equal(has(ando, "blind"), true, "Ando is Blinded after round start");
  assert.equal(statOf(ando, "blind")?.duration, null, "the Blind is permanent (duration null)");
});

test("Erratic Programming: using a Harmful skill deals 10 Piercing to an additional random enemy", () => {
  const ando = fuse("storm");
  const e1 = enemy("e1", { statuses: [dr(5)] }); // single enemy -> the 'additional random target' is e1
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando1", targets: ["e1"] }); // Harmful (Electroblade 15 normal)
  // 15 normal - 5 DR = 10, plus the passive's 10 Piercing (ignores DR) = 20 lost.
  assert.equal(e1.hp, 80, "Electroblade 10-after-DR + Erratic Programming's 10 Piercing = 20 lost");
});

// SUSPECTED BUG — andostorm0 frozen: "...he deals 10 Piercing damage to an additional random target
// whenever he uses a HARMFUL skill." The passive's skillUsed trigger carries no class scoping, so it
// fires on ANY skill Ando uses. Focus Power (ando4) is Strategic, not Harmful, and deals nothing to an
// unmarked enemy — yet the passive still lands its 10 Piercing.
test.skip("SUSPECTED BUG: Erratic Programming fires on ANY skill, not only Harmful ones", () => {
  const ando = fuse("storm");
  const e1 = enemy("e1"); // unmarked, so Focus Power itself deals nothing
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "ando4", targets: [] }); // Focus Power: Strategic, not Harmful
  assert.equal(e1.hp, 100, "frozen: only a HARMFUL skill triggers the extra hit — a Strategic skill does not");
});

test("Tempest: 15 to a random enemy now, then repeats 15 on each of Ando's next 3 turns", () => {
  const ando = fuse("storm");
  const e1 = enemy("e1"); // single enemy -> every 'random' pick is e1 (deterministic)
  const state = makeState([ando], [e1]);
  fund(state);
  startRound(state); // Ando is now Blinded (irrelevant to Tempest's random targeting)

  performAction(state, { unit: "ando", skillId: "andostorm1", targets: [] });
  // Immediate: Tempest 15 + Erratic Programming's 10 Piercing (Tempest is Harmful) = 25.
  assert.equal(e1.hp, 75, "immediate Tempest 15 + passive 10 = 25 taken");

  // Scheduled repeats fire at Ando's (team A) turn-ends, once elapsed past the birth turn.
  endTurn(state); // end A turn (birth turn: nothing fires)
  endTurn(state); // end B turn
  assert.equal(e1.hp, 75, "no repeat yet on the birth turn / opponent's turn");
  endTurn(state); // end A turn -> first scheduled 15 (no passive on scheduled effects)
  assert.equal(e1.hp, 60, "first repeat: -15");
  endTurn(state); endTurn(state); // B then A -> second repeat
  assert.equal(e1.hp, 45, "second repeat: -15");
  endTurn(state); endTurn(state); // B then A -> third repeat
  assert.equal(e1.hp, 30, "third repeat: -15 (three repeats total)");
});

// ===========================================================================
// THUNDER — God of Thunder (passive) + Split the Heavens (andothunder1)
//   God of Thunder: "Ando permanently deals 5 additional damage with all of his abilities
//     whenever he uses a Supercharged skill."
//   Split the Heavens: "Deals 30 Piercing damage to all enemies. This skill receives double
//     benefit from God of Thunder."
// ===========================================================================

test("God of Thunder: using a skill while Supercharged permanently adds +5 outgoing damage", () => {
  const ando = fuse("thunder");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  ando.statuses.push(status("mark", { name: "Supercharged", duration: 3, appliedBy: "ando", appliedTurn: 1 }));

  assert.equal(omod(ando), 0, "no bonus before any Supercharged skill use");
  performAction(state, { unit: "ando", skillId: "andothunder1", targets: [] }); // a Supercharged skill use
  assert.equal(omod(ando), 5, "one Supercharged skill use -> permanent +5 outgoing");
});

// SUSPECTED BUG — andothunder0 frozen: "Ando permanently deals 5 ADDITIONAL damage with all of his
// abilities whenever he uses a Supercharged skill." Each Supercharged skill use should add another +5
// (cumulative). The passive applies a nameless outgoing_damage_mod via plain applyStatus, which REFRESHES
// the single slot to +5 rather than accumulating — so repeated Supercharged uses stay at +5, not +10/+15.
test.skip("SUSPECTED BUG: God of Thunder does not STACK across multiple Supercharged skill uses", () => {
  const ando = fuse("thunder");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  ando.statuses.push(status("mark", { name: "Supercharged", duration: 3, appliedBy: "ando", appliedTurn: 1 }));

  performAction(state, { unit: "ando", skillId: "andothunder1", targets: [] });
  performAction(state, { unit: "ando", skillId: "andothunder1", targets: [] });
  assert.equal(omod(ando), 10, "two Supercharged skill uses -> +10 (cumulative)");
});

test("God of Thunder control: using a skill while NOT Supercharged grants no outgoing bonus", () => {
  const ando = fuse("thunder");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andothunder1", targets: [] });
  assert.equal(omod(ando), 0, "no Supercharge -> no God of Thunder bonus");
});

test("Split the Heavens: 30 Piercing to all enemies, taking DOUBLE benefit from a God of Thunder +5", () => {
  const ando = fuse("thunder");
  const e1 = enemy("e1", { statuses: [dr(10)] });
  const e2 = enemy("e2", { statuses: [dr(10)] });
  const state = makeState([ando], [e1, e2]);
  fund(state);
  // A single accumulated God of Thunder point (+5 outgoing). A normal skill would gain +5; Split doubles it (+10).
  ando.statuses.push(status("outgoing_damage_mod", { magnitude: 5, duration: null, appliedBy: "ando", appliedTurn: 1 }));

  performAction(state, { unit: "ando", skillId: "andothunder1", targets: [] });
  // 30 + 5 (auto) + 5 (double) = 40 Piercing, ignoring the 10 DR, on EVERY enemy.
  assert.equal(e1.hp, 60, "40 Piercing to enemy 1 (double God of Thunder)");
  assert.equal(e2.hp, 60, "40 Piercing to enemy 2 (hits all enemies)");
});

test("Split the Heavens baseline: with no God of Thunder, it is a flat 30 Piercing to all enemies", () => {
  const ando = fuse("thunder");
  const e1 = enemy("e1", { statuses: [dr(10)] });
  const e2 = enemy("e2");
  const state = makeState([ando], [e1, e2]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andothunder1", targets: [] });
  assert.equal(e1.hp, 70, "30 Piercing ignores the 10 DR");
  assert.equal(e2.hp, 70, "30 to every enemy");
});

// ===========================================================================
// VENGEANCE — Silent Avenger (passive) + Penance (andovengeance1)
//   Silent Avenger: "Ando will immediately become Supercharged if an allied hero is killed.
//     This Supercharge lasts for his next two turns and is not consumed by his abilities."
//   Penance: "Deals 30 damage to target enemy. If used during Silent Avenger, this skill first
//     removes all Shield from the target and its damage becomes Piercing."
// ===========================================================================

test("Silent Avenger: an allied hero's death immediately Supercharges Ando for 2 turns", () => {
  const ando = fuse("vengeance");
  const ally = loadHero(heroById("ando"), "A", "ally");
  const e1 = enemy("e1");
  const state = makeState([ando, ally], [e1]);
  fund(state);

  assert.equal(hasMark(ando, "Supercharged"), false, "not Supercharged before any death");
  ally.alive = false;
  emit(state, { type: "unitDied", unit: "ally", killer: "e1" });
  assert.equal(hasMark(ando, "Supercharged"), true, "an allied hero dying immediately Supercharges Ando");
  assert.equal(markDur(ando, "Supercharged"), 2, "the Supercharge lasts his next two turns");
});

test("Silent Avenger control: an ENEMY hero dying does not Supercharge Ando", () => {
  const ando = fuse("vengeance");
  const e1 = enemy("e1");
  const state = makeState([ando], [e1]);
  fund(state);
  e1.alive = false;
  emit(state, { type: "unitDied", unit: "e1", killer: "ando" });
  assert.equal(hasMark(ando, "Supercharged"), false, "an enemy death is not an allied-hero death");
});

test("Penance (base, no Silent Avenger): 30 normal damage — DR applies, shield is not stripped", () => {
  const ando = fuse("vengeance");
  const e1 = enemy("e1", { shield: 40 });
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andovengeance1", targets: ["e1"] });
  assert.equal(shieldTotal(e1), 10, "normal 30 is absorbed by the 40 Shield (10 remains)");
  assert.equal(e1.hp, 100, "no HP lost — the shield ate it; shield was NOT pre-stripped");
});

test("Penance during Silent Avenger: strips all target Shield first, then deals 30 Piercing to HP", () => {
  const ando = fuse("vengeance");
  ando.statuses.push(status("mark", { name: "Silent Avenger", duration: 2, appliedBy: "ando", appliedTurn: 1 }));
  const e1 = enemy("e1", { shield: 40, statuses: [dr(10)] });
  const state = makeState([ando], [e1]);
  fund(state);
  performAction(state, { unit: "ando", skillId: "andovengeance1", targets: ["e1"] });
  assert.equal(shieldTotal(e1), 0, "Silent Avenger Penance removes all of the target's Shield first");
  assert.equal(e1.hp, 70, "then 30 Piercing (ignores the 10 DR) lands on HP");
});
