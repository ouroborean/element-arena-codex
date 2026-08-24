import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound, startTurn, endTurn, effectiveCost } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { totalShield, addShield } from "../src/damage.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, SPEC-DERIVED behavioural suite for Syl, Scourge of the Skies —
// her TEN FUSION FORMS (passive + active for each). Every assertion is anchored
// to the FROZEN prose (content/frozen/skills.json), never the implementation.
//
// Base kit the forms build on (frozen):
//   syl0 Two as One  : begins with a Hatchling Eagle; Syl + Eagle acting the
//                      same turn grants Syl Elemental Essence.
//   syl1 Feed        : heals the Eagle 20 (targetKind minion); at-max -> essence.
//   syl2 Skylance    : 20 Piercing to one enemy.
//   syl3 To the Skies!: empowerment buff.
//   syl5 Leyline Nest: advances the Eagle a growth stage; costs 1 less each turn,
//                      resetting on use (base specific cost 4).
//   Eagle skills: Talon Rake (sylminion1, 15 Piercing, generic 1), Swoop
//     (sylminion2, Adult+; Shatter until end of turn), Soar (sylminion3).
//
// Per-form frozen text is quoted at each form's block below.
// ===========================================================================

type Form =
  | "angel" | "cloud" | "faerie" | "ghost" | "mechanic"
  | "mist" | "ninja" | "nomad" | "storm" | "winter";

const eagleOf = (st: MatchState) =>
  Object.values(st.units).find((u) => u.kind === "minion" && u.name.includes("Eagle") && u.alive)!;
const named = (st: MatchState, name: string) =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.name === name && u.alive);
const essence = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const invulns = (u: Unit) => u.statuses.filter((s) => s.kind === "invulnerable").length;
const stuns = (u: Unit) => u.statuses.filter((s) => s.kind === "stun").length;
const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;
const ready = (u: Unit, id: string) => { skillOf(u, id).currentCd = 0; };
const specificOf = (u: Unit, id: string, st: MatchState) => effectiveCost(u, skillOf(u, id), st).specific;

/** Enemy stand-in with a cheap, always-castable Harmful skill so an enemy can "try to act". */
function foe(id: string, over: Partial<Unit> = {}): Unit {
  return makeUnit({
    id, team: "B", hp: 100, maxHp: 100,
    skills: [{
      id: `${id}_atk`, name: "Jab", element: "fire", targeting: "single",
      effects: [{ op: "damage", amount: 5, to: "target" }],
      cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful"],
    } as any],
    ...over,
  });
}

/** Fuse Syl into `form`, place `enemies` on B, summon her Eagle via the real roundStart passive
 *  (so the fusion's own roundStart triggers also fire), and stock abundant energy in every relevant pool. */
function fuse(form: Form, enemies: Unit[] = [foe("e1")], allies: Unit[] = []) {
  const syl = loadHero(heroById("syl"), "A", "a1");
  applyFusion(syl, fusionForm("syl", form)!);
  const state = makeState([syl, ...allies], enemies, 1);
  state.teams.A.energy = { generic: 90, wind: 90, [form]: 90 } as any;
  state.teams.B.energy = { generic: 90, wind: 90, [form]: 90 } as any;
  emit(state, { type: "roundStart" }); // summons the Hatchling Eagle + runs fusion roundStart passives
  return { syl, state, eagle: eagleOf(state) };
}

/** Turn-cycle variant using the real scheduler (startRound emits roundStart too). Needed for the
 *  turnStart-driven Leyline decay and the turnEnd-driven Flutter cycle. */
function fuseRound(form: Form, enemies: Unit[] = [foe("e1")], allies: Unit[] = []) {
  const syl = loadHero(heroById("syl"), "A", "a1");
  applyFusion(syl, fusionForm("syl", form)!);
  const state = makeState([syl, ...allies], enemies, 1);
  startRound(state, "A");
  state.teams.A.energy = { generic: 90, wind: 90, [form]: 90 } as any;
  state.teams.B.energy = { generic: 90, wind: 90, [form]: 90 } as any;
  return { syl, state, eagle: eagleOf(state) };
}

/** One full Syl turn boundary: A ends, B ends, A begins (fires the team-A turnStart triggers). */
function nextSylTurn(state: MatchState) { endTurn(state); endTurn(state); startTurn(state); }

// =====================================================================================
// ANGEL — Shieldmaiden (sylangel0) + Divine Lance (sylangel1)
//   Passive: "Skylance now taunts its target and gives Syl 10 Shield for 1 turn."
//   Active : "Deals 35 True damage to target enemy. This skill cannot be countered
//            or reflected."  (cost 1 generic + 1 specific, cd 1, tags Uncounterable)
// =====================================================================================

test("angel/Shieldmaiden: Skylance taunts its target onto Syl and gives Syl 10 Shield for 1 turn", () => {
  const { syl, state } = fuse("angel");
  const e1 = state.units["e1"]!;
  assert.equal(totalShield(syl), 0, "no Aerie-style shield before acting");
  assert.equal(e1.statuses.some((s) => s.kind === "taunt"), false, "no taunt before Skylance");

  const r = performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  assert.equal(r.ok, true);
  const taunt = e1.statuses.find((s) => s.kind === "taunt");
  assert.ok(taunt, "Skylance's target is now taunted");
  assert.equal(taunt!.unitRef, syl.id, "taunted specifically onto Syl");
  assert.equal(totalShield(syl), 10, "Syl gains exactly 10 Shield");
  const sh = syl.shields.find((s) => s.amount === 10)!;
  assert.equal(sh.duration, 1, "the Shield lasts 1 turn");
});

test("angel/Shieldmaiden CONTROL: a non-Skylance cast neither taunts nor shields", () => {
  const { syl, state } = fuse("angel");
  const e1 = state.units["e1"]!;
  // Divine Lance (the fusion skill) is not Skylance -> Shieldmaiden must not fire.
  const r = performAction(state, { unit: syl.id, skillId: "sylangel1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(totalShield(syl), 0, "no 10 Shield from a non-Skylance skill");
  assert.equal(e1.statuses.some((s) => s.kind === "taunt"), false, "no taunt from a non-Skylance skill");
});

test("angel/Divine Lance: 35 True damage that ignores the target's Shield", () => {
  const { syl, state } = fuse("angel");
  const e1 = state.units["e1"]!;
  addShield(e1, 50, null, "x", 0);
  const r = performAction(state, { unit: syl.id, skillId: "sylangel1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 65, "35 True damage lands straight on HP (100 -> 65)");
  assert.equal(totalShield(e1), 50, "True damage bypasses Shield — the pool is untouched");
});

test("angel/Divine Lance: carries the Uncounterable class (cannot be countered or reflected)", () => {
  const { syl } = fuse("angel");
  const dl = skillOf(syl, "sylangel1");
  assert.ok(dl.tags.includes("Uncounterable"), "'cannot be countered or reflected' == the Uncounterable tag");
});

// =====================================================================================
// CLOUD — Great Roc (sylcloud0) + Sky Drop (sylcloud1)
//   Passive: "Syl's Eagle minion's skills cost 1 more, but last 1 additional turn."
//   Active : "Deals 25 damage to target enemy and stuns them for 0 turns. This skill
//            deals 10 more damage and stuns for 1 more turn per stage her Eagle has
//            evolved this round."
// =====================================================================================

test("cloud/Great Roc: the Eagle's skills cost 1 more (Syl's own skills are unaffected)", () => {
  const { syl, state, eagle } = fuse("cloud");
  // Talon Rake base generic cost is 1 -> +1 = 2.
  assert.equal(effectiveCost(eagle, skillOf(eagle, "sylminion1"), state).generic, 2, "Eagle's Talon Rake costs 1 more");
  // Syl's own Skylance is not an Eagle skill -> unchanged (base specific 1).
  assert.equal(specificOf(syl, "syl2", state), 1, "Syl's Skylance cost is untouched by Great Roc");
});

test("cloud/Sky Drop: at 0 stages evolved this round it deals 25 damage", () => {
  const { syl, state } = fuse("cloud");
  const e1 = state.units["e1"]!;
  const r = performAction(state, { unit: syl.id, skillId: "sylcloud1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 75, "25 damage at base (no evolution this round)");
});

test("cloud/Sky Drop: +10 damage and +1 stun-turn per stage evolved this round", () => {
  const { syl, state } = fuse("cloud");
  const e1 = state.units["e1"]!;
  const r5 = performAction(state, { unit: syl.id, skillId: "syl5", targets: [] }); // evolve once this round
  assert.equal(r5.ok, true, "Leyline Nest advanced the Eagle a stage");
  const r = performAction(state, { unit: syl.id, skillId: "sylcloud1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 65, "25 + 10 = 35 damage after one evolution");
  assert.equal(stuns(e1), 1, "a real 1-turn stun is applied after one evolution");
});

test("cloud/Sky Drop: 'stuns for 0 turns' at base does NOT stop the target", () => {
  // Frozen: base stun is "0 turns" (+1 per stage). 0 turns == no effective stun, so the target
  // should still be able to act on its turn. The engine applies a stun with duration 0 that
  // nonetheless blocks the enemy's next action (isStunnedFor keys on presence, not duration>0).
  const { syl, state } = fuse("cloud", [foe("e1")]);
  const e1 = state.units["e1"]!;
  performAction(state, { unit: syl.id, skillId: "sylcloud1", targets: [e1.id] }); // 0 stages -> "stun 0 turns"
  endTurn(state); // A ends -> B becomes active; a genuine 0-turn stun is a no-op
  const r = performAction(state, { unit: e1.id, skillId: "e1_atk", targets: [syl.id] });
  assert.equal(r.ok, true, "a 0-turn stun does not prevent the target from acting");
});

test.skip("SUSPECTED BUG cloud/Great Roc: eagle skills should last exactly +1 turn — engine double-applies (+2)", () => {
  // Frozen: the Eagle's skills "last 1 additional turn". Swoop's base Shatter is 'until the end of
  // the turn' (stored duration 0 — proven by a non-Great-Roc form below), so under Great Roc it must
  // last 1 turn. The engine's extendEagleSkillDurations fires twice on the post-evolution Swoop,
  // yielding a 2-turn Shatter.
  const baseline = (() => {
    const { syl, state } = fuse("angel", [foe("b1")]); // a form WITHOUT Great Roc — untouched baseline
    performAction(state, { unit: syl.id, skillId: "syl5", targets: [] });
    const eg = eagleOf(state);
    performAction(state, { unit: eg.id, skillId: "sylminion2", targets: [state.units["b1"]!.id] });
    return state.units["b1"]!.statuses.find((s) => s.kind === "shatter")!.duration;
  })();
  assert.equal(baseline, 0, "baseline Swoop Shatter lasts 'until end of turn' (duration 0)");

  const { syl, state } = fuse("cloud", [foe("e1")]);
  performAction(state, { unit: syl.id, skillId: "syl5", targets: [] });
  const eagle = eagleOf(state);
  performAction(state, { unit: eagle.id, skillId: "sylminion2", targets: [state.units["e1"]!.id] });
  const dur = state.units["e1"]!.statuses.find((s) => s.kind === "shatter")!.duration;
  assert.equal(dur, baseline + 1, "Great Roc adds exactly 1 turn to the Eagle's applied effects");
});

// =====================================================================================
// FAERIE — Harrier (sylfaerie0) + Sparrowrider Cohort (sylfaerie1)
//   Passive: "Syl and her Eagle minion deal 5 less damage with their skills, but any
//            time they damage an enemy, they become Invulnerable to Strategic skills
//            for 1 turn."
//   Active : "Syl summons 2 Sparrowrider minions. Sparrowrider minions count as Syl's
//            Eagle minion for triggering Two as One."
// =====================================================================================

test("faerie/Harrier: Syl and her Eagle deal 5 less damage with their skills", () => {
  const { syl, state, eagle } = fuse("faerie");
  const e1 = state.units["e1"]!;
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] }); // Skylance base 20 Piercing
  assert.equal(e1.hp, 85, "Skylance deals 20 - 5 = 15");

  const e2 = foe("e2"); state.units["e2"] = e2; state.teams.B.units.push("e2");
  performAction(state, { unit: eagle.id, skillId: "sylminion1", targets: [e2.id] }); // Talon Rake base 15 Piercing
  assert.equal(e2.hp, 90, "the Eagle's Talon Rake deals 15 - 5 = 10");
});

test("faerie/Harrier: damaging an enemy grants Invulnerability to Strategic skills — an enemy stun is ignored", () => {
  const { syl, state } = fuse("faerie");
  const e1 = state.units["e1"]!;
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] }); // Syl damages an enemy
  assert.ok(syl.statuses.some((s) => s.kind === "non_damage_ignore"), "Syl is now immune to Strategic (harmful non-damage) skills");
  // An enemy Strategic effect (a stun) applied to Syl must not land.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: e1, self: e1, targets: [syl] });
  assert.equal(stuns(syl), 0, "the enemy stun is ignored while Syl holds the invulnerability");
});

test("faerie/Harrier CONTROL: before damaging an enemy, an enemy stun DOES land on Syl", () => {
  const { syl, state } = fuse("faerie");
  const e1 = state.units["e1"]!;
  assert.equal(syl.statuses.some((s) => s.kind === "non_damage_ignore"), false, "no invulnerability yet");
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: e1, self: e1, targets: [syl] });
  assert.equal(stuns(syl), 1, "with no invulnerability, the enemy stun lands");
});

test("faerie/Sparrowrider Cohort: summons exactly 2 Sparrowriders that count as the Eagle for Two as One", () => {
  const { syl, state, eagle } = fuse("faerie");
  const r = performAction(state, { unit: syl.id, skillId: "sylfaerie1", targets: [syl.id] });
  assert.equal(r.ok, true);
  const sparrows = named(state, "Sparrowrider");
  assert.equal(sparrows.length, 2, "2 Sparrowrider minions summoned");
  assert.ok(sparrows.every((s) => s.team === "A"), "they are Syl's allies");

  // Prove they satisfy Two as One even when the real Eagle does not act: remove the Eagle so only a
  // Sparrowrider can be the "Eagle acting this turn".
  eagle.alive = false;
  assert.equal(essence(syl), 0, "no essence yet this turn");
  ready(syl, "syl2");
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [state.units["e1"]!.id] }); // Syl acts
  performAction(state, { unit: sparrows[0]!.id, skillId: "sylfaerieminion1", targets: [state.units["e1"]!.id] }); // "Eagle" acts
  assert.equal(essence(syl), 1, "Syl + a Sparrowrider on the same turn grants Elemental Essence");
});

// =====================================================================================
// GHOST — Silent Wingbeats (sylghost0) + Forlorn Feathers (sylghost1)
//   Passive: "Syl and her Eagle now Bypass against Isolated targets."
//   Active : "All units are Isolated for 4 turns. During this time, Syl will not gain
//            stacks of Leyline Nest's cost reduction."
// =====================================================================================

test("ghost/Silent Wingbeats: Syl's damage Bypasses (ignores Shield) an Isolated target", () => {
  const { syl, state } = fuse("ghost");
  const e1 = state.units["e1"]!;
  addShield(e1, 50, null, "x", 0);
  e1.statuses.push({ kind: "isolated", duration: 4, appliedBy: "x", appliedTurn: 0 } as any);
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] }); // 20 Piercing, would normally be shielded
  assert.equal(e1.hp, 80, "the 20 lands on HP (Bypass ignores the Shield vs an Isolated target)");
  assert.equal(totalShield(e1), 50, "the Shield pool is untouched (bypassed)");
});

test("ghost/Silent Wingbeats CONTROL: a NON-Isolated target's Shield absorbs the hit", () => {
  const { syl, state } = fuse("ghost");
  const e1 = state.units["e1"]!;
  addShield(e1, 50, null, "x", 0); // not Isolated
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  assert.equal(e1.hp, 100, "no HP lost — no Bypass without Isolated");
  assert.equal(totalShield(e1), 30, "the Shield absorbed the 20 (50 -> 30)");
});

test("ghost/Forlorn Feathers: makes ALL units (both teams) Isolated for 4 turns", () => {
  const { syl, state, eagle } = fuse("ghost");
  const e1 = state.units["e1"]!;
  const r = performAction(state, { unit: syl.id, skillId: "sylghost1", targets: [] });
  assert.equal(r.ok, true);
  for (const u of [syl, eagle, e1]) {
    const iso = u.statuses.find((s) => s.kind === "isolated");
    assert.ok(iso, `${u.id} is Isolated`);
    assert.equal(iso!.duration, 4, `${u.id} Isolated for 4 turns`);
  }
});

test("ghost/Forlorn Feathers: during the window Syl stops accruing Leyline Nest's per-turn cost reduction", () => {
  // Baseline: without Forlorn, Leyline's specific cost decays 1 per turn (4 -> 3).
  {
    const { state } = fuseRound("ghost");
    const syl = state.units["a1"]!;
    assert.equal(specificOf(syl, "syl5", state), 4, "starts at 4");
    nextSylTurn(state);
    assert.equal(specificOf(syl, "syl5", state), 3, "decays to 3 without Forlorn");
  }
  // With Forlorn active, the decay is suppressed.
  {
    const { state } = fuseRound("ghost");
    const syl = state.units["a1"]!;
    performAction(state, { unit: syl.id, skillId: "sylghost1", targets: [] });
    nextSylTurn(state);
    assert.equal(specificOf(syl, "syl5", state), 4, "no cost-reduction stack gained during isolation");
  }
});

// =====================================================================================
// MECHANIC — The Aerie (sylmechanic0) + The Grand Finale (sylmechanic1)
//   Passive: "Syl begins the game with 25 Shield. While this Shield holds, Syl will
//            always trigger Two as One when she uses a skill (even if she acts alone)."
//   Active : "Syl deals 35 Affliction damage to target enemy, plus the value of Shield
//            remaining on The Aerie. After using this skill, if Syl's Eagle has not used
//            Swoop on that same enemy, Syl dies."  (cost 2 generic, cd 3, Affliction)
// =====================================================================================

test("mechanic/The Aerie: Syl begins with 25 Shield and triggers Two as One acting ALONE while it holds", () => {
  const { syl, state } = fuse("mechanic");
  assert.equal(totalShield(syl), 25, "begins with 25 Shield");
  assert.equal(essence(syl), 0, "no essence yet");
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [state.units["e1"]!.id] }); // Syl acts alone
  assert.equal(essence(syl), 1, "essence gained even acting alone while the Aerie Shield holds");
});

test("mechanic/The Aerie CONTROL: with the Shield broken, acting alone grants no essence", () => {
  const { syl, state } = fuse("mechanic");
  syl.shields = []; // Aerie Shield broken
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [state.units["e1"]!.id] });
  assert.equal(essence(syl), 0, "no Two-as-One essence acting alone once the Aerie Shield is gone");
});

test("mechanic/The Grand Finale: 35 Affliction + remaining Aerie Shield value, then Syl dies (no Swoop)", () => {
  const { syl, state } = fuse("mechanic", [foe("e1", { hp: 200, maxHp: 200 })]);
  const e1 = state.units["e1"]!;
  assert.equal(totalShield(syl), 25, "25 Aerie Shield to add to the damage");
  const r = performAction(state, { unit: syl.id, skillId: "sylmechanic1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 140, "35 + 25 = 60 Affliction damage (200 -> 140)");
  assert.equal(syl.alive, false, "with no Swoop on that enemy, Syl dies");
});

test("mechanic/The Grand Finale CONTROL: damage is 35 when the Aerie Shield is 0", () => {
  const { syl, state } = fuse("mechanic", [foe("e1", { hp: 200, maxHp: 200 })]);
  const e1 = state.units["e1"]!;
  syl.shields = [];
  performAction(state, { unit: syl.id, skillId: "sylmechanic1", targets: [e1.id] });
  assert.equal(e1.hp, 165, "35 + 0 = 35 damage (200 -> 165)");
});

test("mechanic/The Grand Finale: Syl SURVIVES if her Eagle used Swoop on that same enemy first", () => {
  const { syl, state } = fuse("mechanic", [foe("e1", { hp: 200, maxHp: 200 })]);
  const e1 = state.units["e1"]!;
  performAction(state, { unit: syl.id, skillId: "syl5", targets: [] }); // evolve to Adult -> Eagle gains Swoop
  const eagle = eagleOf(state);
  performAction(state, { unit: eagle.id, skillId: "sylminion2", targets: [e1.id] }); // Swoop THAT enemy
  const r = performAction(state, { unit: syl.id, skillId: "sylmechanic1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(syl.alive, true, "the Eagle Swooped the target, so Syl does not die");
});

// =====================================================================================
// MIST — Flutter in the Fog (sylmist0) + Falling Leaf (sylmist1)
//   Passive: "At the end of her turn, Syl becomes invulnerable for 1 turn. If she became
//            invulnerable this way on her last turn, her Eagle becomes invulnerable for 1
//            turn instead. The turn after making her Eagle invulnerable, this effect will
//            not activate."
//   Active : "Deals 40 Piercing damage to target enemy. Can only be used on the turn when
//            Flutter in the Fog is inactive."  (cost 2 generic + 1 specific)
// =====================================================================================

test("mist/Flutter in the Fog: cycles Syl-invuln -> Eagle-invuln-instead -> inactive", () => {
  const { syl, state, eagle } = fuseRound("mist");
  const canCastFallingLeaf = () => {
    ready(syl, "sylmist1");
    const before = state.units["e1"]!.hp;
    const r = performAction(state, { unit: syl.id, skillId: "sylmist1", targets: [state.units["e1"]!.id] });
    state.units["e1"]!.hp = before; // undo probe damage
    return r.ok;
  };

  endTurn(state); // Syl's 1st turn ends -> she becomes invulnerable
  assert.equal(invulns(syl), 1, "(1) Syl is invulnerable after her turn");
  assert.equal(invulns(eagle), 0, "the Eagle is not");
  assert.equal(canCastFallingLeaf(), false, "Flutter is active -> Falling Leaf unusable");
  endTurn(state); // B

  endTurn(state); // Syl's 2nd turn ends -> Eagle invuln INSTEAD
  assert.equal(invulns(eagle), 1, "(2) the Eagle is made invulnerable instead");
  endTurn(state); // B

  // (3) During Syl's 3rd turn Flutter is inactive -> Falling Leaf becomes usable.
  assert.equal(canCastFallingLeaf(), true, "(3) Flutter inactive -> Falling Leaf usable");
});

test("mist/Falling Leaf: usable only when Flutter is inactive, and then deals 40 Piercing", () => {
  const { syl, state, eagle } = fuseRound("mist");
  const e1 = state.units["e1"]!;
  // Fresh turn 1: Flutter is active (not yet inactive) -> unusable.
  assert.equal(performAction(state, { unit: syl.id, skillId: "sylmist1", targets: [e1.id] }).ok, false,
    "cannot cast while Flutter is active");
  // Advance to the inactive turn (turn 3).
  endTurn(state); endTurn(state); // turn 1 (A) + B
  endTurn(state); endTurn(state); // turn 2 (A) + B  -> now turn 3, Flutter inactive
  ready(syl, "sylmist1");
  const r = performAction(state, { unit: syl.id, skillId: "sylmist1", targets: [e1.id] });
  assert.equal(r.ok, true, "usable on the inactive turn");
  assert.equal(e1.hp, 60, "40 Piercing damage (100 -> 60)");
  assert.equal(eagle.name.includes("Eagle"), true);
});

// =====================================================================================
// NINJA — Eaglehawk Rider (sylninja0) + Shadow Seekers (sylninja1)
//   Passive: "Using To the Skies! makes Syl invulnerable for 1 turn."
//   Active : "Marks all enemies for 2 turns. During this time, if they receive new damage
//            from Syl or her Eagle minion, their non-Strategic skills will be stunned for 1
//            turn and the mark is removed."
// =====================================================================================

test("ninja/Eaglehawk Rider: using To the Skies! makes Syl invulnerable for 1 turn", () => {
  const { syl, state } = fuse("ninja");
  const r = performAction(state, { unit: syl.id, skillId: "syl3", targets: [] });
  assert.equal(r.ok, true);
  const inv = syl.statuses.find((s) => s.kind === "invulnerable");
  assert.ok(inv, "Syl is invulnerable");
  assert.equal(inv!.duration, 1, "for 1 turn");
});

test("ninja/Eaglehawk Rider CONTROL: another skill does not grant invulnerability", () => {
  const { syl, state } = fuse("ninja");
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [state.units["e1"]!.id] }); // Skylance, not To the Skies!
  assert.equal(invulns(syl), 0, "only To the Skies! triggers Eaglehawk Rider");
});

test("ninja/Shadow Seekers: marks all enemies; Syl's damage stuns non-Strategic skills and clears the mark", () => {
  const e1 = foe("e1"); const e2 = foe("e2");
  const { syl, state } = fuse("ninja", [e1, e2]);
  const r = performAction(state, { unit: syl.id, skillId: "sylninja1", targets: [] });
  assert.equal(r.ok, true);
  for (const e of [e1, e2]) {
    const m = e.statuses.find((s) => s.kind === "mark" && s.name === "Shadow Seekers");
    assert.ok(m, `${e.id} is marked`);
    assert.equal(m!.duration, 2, "for 2 turns");
  }
  // Syl damages a marked enemy -> its non-Strategic skills are stunned, mark removed.
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] });
  const st = e1.statuses.find((s) => s.kind === "stun");
  assert.ok(st, "the marked enemy is stunned by the new damage");
  assert.deepEqual(st!.scope, { tag: "Strategic", mode: "except" }, "scoped to its non-Strategic skills");
  assert.equal(e1.statuses.some((s) => s.kind === "mark" && s.name === "Shadow Seekers"), false, "the mark is removed");
});

test("ninja/Shadow Seekers CONTROL: damage from someone other than Syl or her Eagle does not trigger", () => {
  const other = makeUnit({ id: "o", team: "A", name: "Bystander", kind: "hero" });
  const { syl, state } = fuse("ninja", [foe("e1")], [other]);
  const e1 = state.units["e1"]!;
  performAction(state, { unit: syl.id, skillId: "sylninja1", targets: [] });
  runEffects(state, [{ op: "damage", amount: 10, to: "target" }], { caster: other, self: other, targets: [e1] });
  assert.equal(stuns(e1), 0, "no stun from a third-party's damage");
  assert.ok(e1.statuses.some((s) => s.kind === "mark" && s.name === "Shadow Seekers"), "the mark survives");
});

// =====================================================================================
// NOMAD — Scavenger's Path (sylnomad0) + Pick the Bones (sylnomad1)
//   Passive: "Any time an ally or an enemy dies, they create a Scavenger's Pile minion.
//            If Syl's Eagle minion kills a Scavenger's Pile, her Eagle heals 25 HP and
//            Leyline Nest costs 1 less until it is used."
//   Active : "Deals 15 damage to target enemy. If this skill kills its target, Syl's team
//            gains Elemental Essence. This skill's base damage doubles if it targets a
//            Scavenger's Pile."
// =====================================================================================

const PILE = "sylnomadminion"; // the Scavenger's Pile minion template/name
const pilesOf = (st: MatchState) => Object.values(st.units).filter((u) => u.name === PILE && u.alive);

test("nomad/Scavenger's Path: any unit death creates a Scavenger's Pile", () => {
  const { state } = fuse("nomad");
  const e1 = state.units["e1"]!;
  assert.equal(pilesOf(state).length, 0, "no piles before a death");
  e1.hp = 0; e1.alive = false;
  emit(state, { type: "unitDied", unit: e1.id, killer: "a1" });
  assert.equal(pilesOf(state).length, 1, "a Scavenger's Pile spawned on death");
});

test("nomad/Scavenger's Path: the Eagle killing a Pile heals it 25 and drops Leyline Nest's cost by 1", () => {
  const { syl, state, eagle } = fuse("nomad");
  const e1 = state.units["e1"]!;
  assert.equal(specificOf(syl, "syl5", state), 4, "Leyline Nest starts at 4");
  e1.hp = 0; e1.alive = false;
  emit(state, { type: "unitDied", unit: e1.id, killer: "a1" });
  const pile = pilesOf(state)[0]!;
  eagle.hp = 30;
  const r = performAction(state, { unit: eagle.id, skillId: "sylminion1", targets: [pile.id] }); // Eagle kills the Pile
  assert.equal(r.ok, true);
  assert.equal(pile.alive, false, "the Pile is dead");
  assert.equal(eagle.hp, 55, "the Eagle healed 25 (30 -> 55)");
  assert.equal(specificOf(syl, "syl5", state), 3, "Leyline Nest costs 1 less until used (4 -> 3)");
});

test("nomad/Pick the Bones: 15 damage to an enemy; doubles to 30 against a Scavenger's Pile", () => {
  const { syl, state } = fuse("nomad", [foe("e1"), foe("dead", { hp: 0, alive: false })]);
  const e1 = state.units["e1"]!;
  performAction(state, { unit: syl.id, skillId: "sylnomad1", targets: [e1.id] });
  assert.equal(e1.hp, 85, "15 damage to a normal enemy");

  // Spawn a Pile and give it enough HP to observe the doubled hit.
  emit(state, { type: "unitDied", unit: "dead", killer: "a1" });
  const pile = pilesOf(state)[0]!;
  pile.hp = 100; pile.maxHp = 100;
  ready(syl, "sylnomad1");
  performAction(state, { unit: syl.id, skillId: "sylnomad1", targets: [pile.id] });
  assert.equal(pile.hp, 70, "base damage doubles vs a Pile: 15 * 2 = 30 (100 -> 70)");
});

test("nomad/Pick the Bones: a kill grants Syl's team Elemental Essence", () => {
  const { syl, state } = fuse("nomad", [foe("e1", { hp: 10, maxHp: 100 })]);
  const e1 = state.units["e1"]!;
  assert.equal(essence(syl), 0, "no essence before the kill");
  performAction(state, { unit: syl.id, skillId: "sylnomad1", targets: [e1.id] }); // 15 kills a 10-HP enemy
  assert.equal(e1.alive, false, "target killed");
  assert.equal(essence(syl), 1, "Syl's team gains Elemental Essence on the kill");
});

test("nomad/Pick the Bones CONTROL: no kill -> no team essence", () => {
  const { syl, state } = fuse("nomad", [foe("e1", { hp: 100, maxHp: 100 })]);
  performAction(state, { unit: syl.id, skillId: "sylnomad1", targets: [state.units["e1"]!.id] });
  assert.equal(essence(syl), 0, "target survived -> no essence");
});

// =====================================================================================
// STORM — Stormchaser (sylstorm0) + Lightning Crash (sylstorm1)
//   Passive: "Leyline Nest's cost no longer decreases by 1 each turn. Instead, its cost is
//            decreased by 1 each time she gains Elemental Essence."
//   Active : "Deals 35 Piercing damage to target enemy, Bypassing. For her next 3 turns,
//            Skylance will deal 5 Piercing damage to 2 additional, random targets and grant
//            Syl Elemental Essence."  (cost 2 generic + 1 specific, cd 2, Bypassing)
// =====================================================================================

test("storm/Stormchaser: Leyline Nest no longer decays per turn; it drops 1 per Elemental Essence gained", () => {
  const { state } = fuseRound("storm");
  const syl = state.units["a1"]!;
  assert.equal(specificOf(syl, "syl5", state), 4, "starts at 4");
  nextSylTurn(state);
  assert.equal(specificOf(syl, "syl5", state), 4, "no per-turn decay under Stormchaser");
  runEffects(state, [{ op: "applyStatus", to: "self", status: { kind: "elemental_essence", duration: null } }], { caster: syl, self: syl, targets: [] });
  assert.equal(specificOf(syl, "syl5", state), 3, "gaining Essence drops the cost by 1 (4 -> 3)");
  runEffects(state, [{ op: "applyStatus", to: "self", status: { kind: "elemental_essence", duration: null } }], { caster: syl, self: syl, targets: [] });
  assert.equal(specificOf(syl, "syl5", state), 2, "and again per Essence (3 -> 2)");
});

test("storm/Lightning Crash: deals 35 Piercing to the target", () => {
  const { syl, state } = fuse("storm");
  const e1 = state.units["e1"]!;
  const r = performAction(state, { unit: syl.id, skillId: "sylstorm1", targets: [e1.id] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 65, "35 Piercing (100 -> 65)");
});

test("storm/Lightning Crash: Bypassing damage ignores Shield", () => {
  // Frozen: "Deals 35 Piercing damage to target enemy, Bypassing." Piercing already ignores DR, so
  // 'Bypassing' can only add ignoring Shield. The engine wires the Bypassing class tag to targeting
  // legality only (legalTargets), never to damage mitigation: Lightning Crash's damage op omits
  // bypass:true, so its 35 is absorbed by the target's Shield (35 - 30 = 5 to HP) instead of bypassing it.
  const { syl, state } = fuse("storm");
  const e1 = state.units["e1"]!;
  addShield(e1, 30, null, "x", 0);
  performAction(state, { unit: syl.id, skillId: "sylstorm1", targets: [e1.id] });
  assert.equal(e1.hp, 65, "35 lands on HP (100 -> 65), Bypassing the Shield");
  assert.equal(totalShield(e1), 30, "the Shield is bypassed, not spent");
});

test("storm/Lightning Crash: for the next turns Skylance also deals 5 to 2 additional targets and grants Essence", () => {
  const e1 = foe("e1"); const e2 = foe("e2"); const e3 = foe("e3");
  const { syl, state } = fuse("storm", [e1, e2, e3]);
  performAction(state, { unit: syl.id, skillId: "sylstorm1", targets: [e1.id] }); // arm the buff
  const enemyHpAfterCrash = e1.hp + e2.hp + e3.hp;
  const essBefore = essence(syl);
  ready(syl, "syl2");
  performAction(state, { unit: syl.id, skillId: "syl2", targets: [e1.id] }); // empowered Skylance
  // 20 to the main target + 5 to each of 2 additional targets = 30 total enemy HP removed (RNG-robust aggregate).
  const removed = enemyHpAfterCrash - (e1.hp + e2.hp + e3.hp);
  assert.equal(removed, 30, "Skylance 20 (main) + 5 + 5 (two additional targets) = 30");
  assert.ok(e1.hp <= 45, "the explicit Skylance target took at least its 20");
  assert.equal(essence(syl) - essBefore, 1, "the empowered Skylance grants Syl Elemental Essence");
});

// =====================================================================================
// WINTER — Mountain Rescue Team (sylwinter0) + Search and Rescue (sylwinter1)
//   Passive: "Feed can now target any stunned ally. Swoop can now be used to make a stunned
//            ally invulnerable for 1 turn."
//   Active : "For the next 4 turns, anytime an ally is stunned, Syl will heal them for 20 HP
//            and make them invulnerable for 1 turn."  (cost 2 generic, cd 4)
// =====================================================================================

test("winter/Mountain Rescue Team: Swoop can make a stunned ally invulnerable for 1 turn", () => {
  const allyHero = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100, name: "Ally", kind: "hero" });
  const { syl, state } = fuse("winter", [foe("e1")], [allyHero]);
  performAction(state, { unit: syl.id, skillId: "syl5", targets: [] }); // evolve -> Eagle gains Swoop
  const eagle = eagleOf(state);
  allyHero.statuses.push({ kind: "stun", duration: 2, appliedBy: "e1", appliedTurn: 0 } as any);
  const r = performAction(state, { unit: eagle.id, skillId: "sylminion2", targets: [allyHero.id] });
  assert.equal(r.ok, true, "Swoop may target a stunned ally");
  const inv = allyHero.statuses.find((s) => s.kind === "invulnerable");
  assert.ok(inv, "the stunned ally becomes invulnerable");
  assert.equal(inv!.duration, 1, "for 1 turn");
});

test("winter/Mountain Rescue Team: Feed can target a stunned HERO ally (heals 20)", () => {
  // Frozen: "Feed can now target any stunned ally." A stunned hero teammate is the canonical case
  // (and the sister clause, Swoop-on-a-stunned-hero-ally, works — see the passing test above). The
  // passive rewrites Feed's EFFECTS but never lifts its targetKind:minion, so a stunned hero ally is
  // rejected as no-legal-target.
  const allyHero = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100, name: "Ally", kind: "hero" });
  const { syl, state } = fuse("winter", [foe("e1")], [allyHero]);
  allyHero.statuses.push({ kind: "stun", duration: 2, appliedBy: "e1", appliedTurn: 0 } as any);
  const r = performAction(state, { unit: syl.id, skillId: "syl1", targets: [allyHero.id] });
  assert.equal(r.ok, true, "Feed can target a stunned ally");
  assert.equal(allyHero.hp, 70, "and heals that stunned ally for 20 (50 -> 70)");
});

test("winter/Search and Rescue: for 4 turns, an ally who is stunned is healed 20 and made invulnerable", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 60, maxHp: 100, name: "Ally", kind: "hero" });
  const { syl, state } = fuse("winter", [foe("e1")], [ally]);
  const e1 = state.units["e1"]!;
  const r = performAction(state, { unit: syl.id, skillId: "sylwinter1", targets: [] });
  assert.equal(r.ok, true);
  // Now stun the ally (an enemy applies it) -> Search and Rescue reacts.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: e1, self: e1, targets: [ally] });
  assert.equal(ally.hp, 80, "the newly-stunned ally is healed 20 (60 -> 80)");
  assert.equal(invulns(ally), 1, "and made invulnerable for 1 turn");
});

test("winter/Search and Rescue CONTROL: without the window active, a stunned ally is not rescued", () => {
  const ally = makeUnit({ id: "al", team: "A", hp: 60, maxHp: 100, name: "Ally", kind: "hero" });
  const { state } = fuse("winter", [foe("e1")], [ally]);
  const e1 = state.units["e1"]!;
  // No Search and Rescue cast -> no watch installed.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { caster: e1, self: e1, targets: [ally] });
  assert.equal(ally.hp, 60, "no heal — the rescue window was never opened");
  assert.equal(invulns(ally), 0, "no invulnerability either");
});
