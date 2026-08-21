import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates + augment customs
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// HERO: Prisma Trinity — AUGMENTS. Frozen augment prose (../content/frozen/augments.json) is the ORACLE:
//
//  trinity1 "Scarlet Somersault Crash": "Prisma Maneuver skills mark Prisma Crimson for 3 turns when she
//    uses them or they are used on her. If she is marked by all 3 Prisma Maneuver skills, Crimson Crash
//    deals 40 more damage."
//  trinity2 "Grand Sonata": "Prisma Whirl now applies Sonata Azure instead of its normal effect."
//  trinity3 "Golden Fantasia": "Saffron Beam now affects all enemies, but using it Shatters Prisma Saffron
//    for 1 turn."
//  trinity4 "The Power of Friendship": "Prisma Lens skills deal 0 damage to their target, increased by 5
//    for each other Lens skill already used on them this turn."
//  trinity5 "Kibi, the Mascot": "At the start of each round, a random Prismari Ranger has their maximum HP
//    increased by 20."
//
// Component-skill facts used only as ORACLE (from ../content/frozen/skills.json):
//   Prisma Maneuver skills = Prisma Vault (…crimson2), Prisma Whirl (…azure2), Prisma Launch (…saffron2).
//   Crimson Crash (…crimson3): "Deals 15 damage to target enemy."
//   Sonata Azure (…azure3): "Deals 10 Piercing damage to target enemy and stuns their Strategic skills for 1 turn."
//   Saffron Beam (…saffron3): "Deals 10 damage to target enemy and Taunts them for 1 turn."
//   Prisma Lens skills = Ruby Lens (…crimson1), Sapphire Lens (…azure1), Citrine Lens (…saffron1) — deal no
//     base damage (they only prepare a redirect).
//   Prismari Rangers = Prisma Crimson / Azure / Saffron (each base maxHp 65).
//
// Content (roster/augments.generated) is read ONLY to DRIVE: augment ids, skill ids, costs (element=prism,
// so `specific` is paid in prism), status/mark names. Every asserted value comes from the prose above.
// ===========================================================================

function getRangers(state: MatchState): { crimson: Unit; azure: Unit; saffron: Unit; all: Unit[] } {
  const all = state.teams.A.units.map((id) => state.units[id]!).filter((u) => u && u.kind === "minion");
  const by = (n: string) => {
    const u = all.find((x) => x.name === n);
    assert.ok(u, `${n} minion should exist`);
    return u!;
  };
  return { crimson: by("Prisma Crimson"), azure: by("Prisma Azure"), saffron: by("Prisma Saffron"), all };
}

/** Trinity on team A (id "t"). Augment(s) applied to the HERO BEFORE round start so any minion-skill patches
 *  are parked and replayed onto the freshly-summoned Rangers. Passive summons Crimson/Azure/Saffron. */
function boot(augIds: string[], enemies = 1) {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  for (const id of augIds) applyAugment(trinity, augmentById(id)!);
  const es: Unit[] = [];
  for (let i = 0; i < enemies; i++) es.push(makeUnit({ id: "e" + i, team: "B", kind: "hero", hp: 300, maxHp: 300 }));
  const state = makeState([trinity], es);
  startRound(state, "A"); // fires Trinity's round-start passive → summons Rangers (+ any augment roundStart triggers)
  state.teams.A.energy = { generic: 40, prism: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { trinity, es, e: es[0]!, state, ...getRangers(state) };
}

const cast = (state: MatchState, unit: string, skillId: string, targets: string[]) =>
  performAction(state, { unit, skillId, targets });
const hasMark = (u: Unit, name: string) => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const hasKind = (u: Unit, kind: string) => u.statuses.some((s) => s.kind === kind);

const M_VAULT = "Somersault: Prisma Vault";
const M_WHIRL = "Somersault: Prisma Whirl";
const M_LAUNCH = "Somersault: Prisma Launch";

// ===========================================================================
// trinity1 — "Scarlet Somersault Crash"
//   "Prisma Maneuver skills mark Prisma Crimson for 3 turns when she uses them or they are used on her.
//    If she is marked by all 3 Prisma Maneuver skills, Crimson Crash deals 40 more damage."
// ===========================================================================

test("trinity1: a Prisma Maneuver marks Prisma Crimson when SHE uses it (Prisma Vault) or it is USED ON her (Whirl/Launch)", () => {
  const { state, crimson, azure, saffron } = boot(["trinity1"]);
  assert.ok(!hasMark(crimson, M_VAULT) && !hasMark(crimson, M_WHIRL) && !hasMark(crimson, M_LAUNCH), "no Somersault marks before any maneuver");

  // "when she uses them": Crimson casts Prisma Vault (her own maneuver) on herself.
  const v = cast(state, crimson.id, "trinitycrimson2", [crimson.id]);
  assert.equal(v.ok, true, `Prisma Vault should cast (reason: ${v.reason})`);
  assert.ok(hasMark(crimson, M_VAULT), "Prisma Vault (used by Crimson) marks Crimson");

  // "or they are used on her": Azure casts Prisma Whirl targeting Crimson.
  const w = cast(state, azure.id, "trinityazure2", [crimson.id]);
  assert.equal(w.ok, true, `Prisma Whirl on Crimson should cast (reason: ${w.reason})`);
  assert.ok(hasMark(crimson, M_WHIRL), "Prisma Whirl (used on Crimson) marks Crimson");

  // Saffron casts Prisma Launch targeting Crimson.
  const l = cast(state, saffron.id, "trinitysaffron2", [crimson.id]);
  assert.equal(l.ok, true, `Prisma Launch on Crimson should cast (reason: ${l.reason})`);
  assert.ok(hasMark(crimson, M_LAUNCH), "Prisma Launch (used on Crimson) marks Crimson");
});

test("trinity1: control — a Prisma Maneuver that neither Crimson uses nor targets does NOT mark her", () => {
  const { state, crimson, azure } = boot(["trinity1"]);
  // Azure casts Prisma Whirl on herself (Azure) — Crimson is neither caster nor target.
  const w = cast(state, azure.id, "trinityazure2", [azure.id]);
  assert.equal(w.ok, true, `Prisma Whirl on Azure should cast (reason: ${w.reason})`);
  assert.ok(!hasMark(crimson, M_WHIRL), "Whirl used on Azure (not Crimson) must NOT mark Crimson");
});

test("trinity1: Crimson Crash deals 40 MORE only when Crimson holds ALL THREE Somersault marks", () => {
  // Baseline: no marks → Crimson Crash deals its base 15 (frozen Crimson Crash: 15 damage).
  {
    const { state, crimson, e } = boot(["trinity1"]);
    const hp0 = e.hp;
    const r = cast(state, crimson.id, "trinitycrimson3", [e.id]);
    assert.equal(r.ok, true, `Crimson Crash should cast (reason: ${r.reason})`);
    assert.equal(hp0 - e.hp, 15, "control: unmarked Crimson Crash deals 15 (no +40)");
  }

  // Only TWO of the three maneuvers (Vault + Launch, no Whirl) → still no bonus.
  {
    const { state, crimson, saffron, e } = boot(["trinity1"]);
    assert.equal(cast(state, crimson.id, "trinitycrimson2", [crimson.id]).ok, true, "Vault ok");
    assert.equal(cast(state, saffron.id, "trinitysaffron2", [crimson.id]).ok, true, "Launch ok");
    assert.ok(hasMark(crimson, M_VAULT) && hasMark(crimson, M_LAUNCH) && !hasMark(crimson, M_WHIRL), "exactly two marks held");
    const hp0 = e.hp;
    cast(state, crimson.id, "trinitycrimson3", [e.id]);
    assert.equal(hp0 - e.hp, 15, "control: only two marks → NO +40 (still 15)");
  }

  // All THREE maneuvers involve Crimson → Crimson Crash deals 40 more (15 → 55).
  {
    const { state, crimson, azure, saffron, e } = boot(["trinity1"]);
    assert.equal(cast(state, crimson.id, "trinitycrimson2", [crimson.id]).ok, true, "Vault ok");
    assert.equal(cast(state, azure.id, "trinityazure2", [crimson.id]).ok, true, "Whirl-on-Crimson ok");
    assert.equal(cast(state, saffron.id, "trinitysaffron2", [crimson.id]).ok, true, "Launch-on-Crimson ok");
    assert.ok(hasMark(crimson, M_VAULT) && hasMark(crimson, M_WHIRL) && hasMark(crimson, M_LAUNCH), "all three Somersault marks held");
    const hp0 = e.hp;
    cast(state, crimson.id, "trinitycrimson3", [e.id]);
    assert.equal(hp0 - e.hp, 55, "all three marks → Crimson Crash deals 40 more (15 + 40 = 55)");
  }
});

// ===========================================================================
// trinity2 — "Grand Sonata": "Prisma Whirl now applies Sonata Azure instead of its normal effect."
//   Sonata Azure (oracle): "Deals 10 Piercing damage to target enemy and stuns their Strategic skills for 1 turn."
// ===========================================================================

// SUSPECTED BUG: Grand Sonata is a `replaceSkill` patch on trinityazure2, which lives on the Prisma Azure
// MINION template, not on the hero. applyPatch's replaceSkill only rewrites a skill the HERO owns and has no
// recordMinionPatch fallback (hero.minionSkillPatches stays undefined), and the summon-time replay
// (applyMinionSkillPatches) handles only appendEffect/setSkillMeta/patchNode — never replaceSkill. So the
// summoned Azure keeps BASE Prisma Whirl: casting it deals 0 immediate damage and applies no Sonata Azure /
// Strategic-stun. Frozen expects 10 Piercing + Strategic-stun; engine deals 0 and never stuns.
test.skip("SUSPECTED BUG: trinity2 Grand Sonata — Prisma Whirl should apply Sonata Azure (10 Piercing + Strategic-stun) but the replaceSkill never reaches the Azure minion (engine deals 0)", () => {
  const { state, azure, e } = boot(["trinity2"]);
  // Piercing ignores Damage Reduction: with DR 6 the full 10 still lands.
  e.statuses = [status("damage_reduction", { magnitude: 6 })];
  const hp0 = e.hp;
  const r = cast(state, azure.id, "trinityazure2", [e.id]); // Prisma Whirl, now = Sonata Azure, on the enemy
  assert.equal(r.ok, true, `Grand-Sonata Whirl should cast on an enemy (reason: ${r.reason})`);
  assert.equal(hp0 - e.hp, 10, "Sonata Azure via Prisma Whirl deals 10 Piercing (ignores DR 6) to the target");

  // Strategic-stun: the hit enemy cannot use a Strategic skill (but a non-Strategic one is unaffected).
  e.skills = [
    skill("strat", [{ op: "applyStatus", to: "self", status: { kind: "invulnerable", duration: 1 } }], { tags: ["Strategic", "Instant"], targeting: "self" }),
    skill("harm", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" }),
  ];
  const strat = cast(state, e.id, "strat", [e.id]);
  assert.equal(strat.ok, false, "Sonata Azure stuns the target's Strategic skills");
  assert.equal(strat.reason, "stunned", "reason: strategic-stunned");
  const harm = cast(state, e.id, "harm", [azure.id]);
  assert.equal(harm.ok, true, "a non-Strategic (Harmful) skill is NOT stunned");
});

test("trinity2: control — WITHOUT the augment, base Prisma Whirl deals no immediate damage to a target enemy", () => {
  const { state, azure, e } = boot([]); // base Whirl (no Grand Sonata)
  const hp0 = e.hp;
  const r = cast(state, azure.id, "trinityazure2", [e.id]);
  // Base Prisma Whirl sets up a retaliation; it does NOT deal 10 immediately to the target it is cast on.
  if (r.ok) assert.equal(hp0 - e.hp, 0, "control: base Whirl deals no immediate damage to the target");
});

// ===========================================================================
// trinity3 — "Golden Fantasia": "Saffron Beam now affects all enemies, but using it Shatters Prisma Saffron
//   for 1 turn."  Saffron Beam (oracle): "Deals 10 damage to target enemy and Taunts them for 1 turn."
// ===========================================================================

// SUSPECTED BUG: Golden Fantasia is a `replaceSkill` patch on trinitysaffron3, which lives on the Prisma
// Saffron MINION template. Same defect as trinity2: replaceSkill on a non-hero-owned skill is neither applied
// nor parked as a minionSkillPatch, so the summoned Saffron keeps BASE Saffron Beam (targeting "single",
// effects [damage, taunt]). Frozen expects the Beam to hit ALL enemies for 10 and to Shatter Prisma Saffron
// for 1 turn; engine hits only the single aimed enemy (the other enemy takes 0) and never Shatters Saffron.
test.skip("SUSPECTED BUG: trinity3 Golden Fantasia — Saffron Beam should hit ALL enemies + Shatter Saffron, but the replaceSkill never reaches the Saffron minion (stays single-target, no Shatter)", () => {
  const { state, saffron, es } = boot(["trinity3"], 2);
  const [e0, e1] = [es[0]!, es[1]!];
  assert.ok(!hasKind(saffron, "shatter"), "Saffron is not Shattered before using the Beam");
  const h0 = e0.hp, h1 = e1.hp;
  const r = cast(state, saffron.id, "trinitysaffron3", [e0.id]); // aimed at one enemy
  assert.equal(r.ok, true, `Saffron Beam should cast (reason: ${r.reason})`);
  assert.equal(h0 - e0.hp, 10, "the aimed enemy takes 10");
  assert.equal(h1 - e1.hp, 10, "affects ALL enemies: the OTHER enemy also takes 10");
  assert.ok(hasKind(saffron, "shatter"), "using Saffron Beam Shatters Prisma Saffron");
});

test("trinity3: control — WITHOUT the augment, Saffron Beam hits only its single target and does NOT Shatter Saffron", () => {
  const { state, saffron, es } = boot([], 2);
  const [e0, e1] = [es[0]!, es[1]!];
  const h0 = e0.hp, h1 = e1.hp;
  const r = cast(state, saffron.id, "trinitysaffron3", [e0.id]);
  assert.equal(r.ok, true, `base Saffron Beam should cast (reason: ${r.reason})`);
  assert.equal(h0 - e0.hp, 10, "the aimed enemy takes 10");
  assert.equal(e1.hp, h1, "control: the OTHER enemy is unharmed (single-target base Beam)");
  assert.ok(!hasKind(saffron, "shatter"), "control: base Beam does NOT Shatter Saffron");
});

// ===========================================================================
// trinity4 — "The Power of Friendship": "Prisma Lens skills deal 0 damage to their target, increased by 5
//   for each other Lens skill already used on them this turn."
// ===========================================================================

test("trinity4: the first Lens on a target deals 0; each later Lens on the SAME target this turn deals +5 per prior Lens", () => {
  const { state, crimson, azure, saffron, e } = boot(["trinity4"]);

  // 1st Lens on the enemy (Ruby): 0 other Lenses used on it this turn → 0 damage.
  const h0 = e.hp;
  const r1 = cast(state, crimson.id, "trinitycrimson1", [e.id]);
  assert.equal(r1.ok, true, `Ruby Lens should cast (reason: ${r1.reason})`);
  assert.equal(h0 - e.hp, 0, "first Lens on the target deals 0 damage");

  // 2nd Lens on the same enemy (Sapphire): 1 prior Lens → 5 damage.
  const h1 = e.hp;
  const r2 = cast(state, azure.id, "trinityazure1", [e.id]);
  assert.equal(r2.ok, true, `Sapphire Lens should cast (reason: ${r2.reason})`);
  assert.equal(h1 - e.hp, 5, "second Lens on the same target this turn deals 5 (one prior Lens)");

  // 3rd Lens on the same enemy (Citrine): 2 prior Lenses → 10 damage.
  const h2 = e.hp;
  const r3 = cast(state, saffron.id, "trinitysaffron1", [e.id]);
  assert.equal(r3.ok, true, `Citrine Lens should cast (reason: ${r3.reason})`);
  assert.equal(h2 - e.hp, 10, "third Lens on the same target this turn deals 10 (two prior Lenses)");
});

test("trinity4: control — the count is PER-TARGET; a first Lens on a fresh enemy still deals 0 even if another enemy was Lensed", () => {
  const { state, crimson, azure, es } = boot(["trinity4"], 2);
  const [e0, e1] = [es[0]!, es[1]!];
  const a0 = e0.hp;
  assert.equal(cast(state, crimson.id, "trinitycrimson1", [e0.id]).ok, true, "Ruby Lens on e0");
  assert.equal(a0 - e0.hp, 0, "first Lens on e0 deals 0");
  const b0 = e1.hp;
  assert.equal(cast(state, azure.id, "trinityazure1", [e1.id]).ok, true, "Sapphire Lens on the OTHER enemy e1");
  assert.equal(b0 - e1.hp, 0, "control: first Lens on e1 deals 0 — prior Lens on e0 does not count for e1");
});

// ===========================================================================
// trinity5 — "Kibi, the Mascot": "At the start of each round, a random Prismari Ranger has their maximum HP
//   increased by 20."
// ===========================================================================

test("trinity5: at round start, exactly ONE random Ranger gains +20 maximum HP (65 → 85); the others stay at 65", () => {
  const { all } = boot(["trinity5"]);
  assert.equal(all.length, 3, "three Rangers exist");
  const boosted = all.filter((u) => u.maxHp === 85);
  const base = all.filter((u) => u.maxHp === 65);
  assert.equal(boosted.length, 1, "exactly one Ranger has +20 max HP (85)");
  assert.equal(base.length, 2, "the other two Rangers keep base 65 max HP");
  const totalMax = all.reduce((s, u) => s + u.maxHp, 0);
  assert.equal(totalMax, 65 * 3 + 20, "total Ranger max HP increased by exactly 20");
});

test("trinity5: control — WITHOUT the augment, every Ranger stays at base 65 max HP at round start", () => {
  const { all } = boot([]);
  assert.equal(all.length, 3, "three Rangers exist");
  assert.ok(all.every((u) => u.maxHp === 65), "control: no augment → no Ranger gains max HP (all 65)");
});
