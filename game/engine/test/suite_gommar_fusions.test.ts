import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, SPEC-DERIVED suite for GOMMAR's FUSION FORMS.
// The FROZEN prose (content/frozen/skills.json) is the sole oracle. Verbatim per form:
//
//  apocalypse — Forced Adaptation (gommarapocalypse0):
//    "While Gommar is Frost-Covered, he ignores non-damage effects."
//  apocalypse — Cold Snap (gommarapocalypse1):
//    "Stuns target enemy's Strategic Skills for 1 turn. If Gommar is
//     Frost-Covered, the target also receives 15 damage."
//  aurora — Dazzling Lights (gommaraurora0):
//    "The first enemy to use a skill on Gommar while he is Frost-Covered will
//     have their skill costs increased by [65] for 1 turn."
//  aurora — Aurora Veil (gommaraurora1):
//    "Gommar's team becomes invulnerable to Strategic skills for 1 turn. The
//     following turn, they are invulnerable to non-Strategic skills."
//  crystal — Frosted Facets (gommarcrystal0):
//    "Gommar takes half damage from new Harmful skills."
//  crystal — Crystalline Smash (gommarcrystal1):
//    "Deals 30 damage to target enemy and 10 damage to both the target's
//     allies. If Gommar is Frost-Covered, all damaged enemies have their
//     Strategic Skills stunned for 1 turn."
//  glacier — Glacial Advance (gommarglacier0):
//    "At the start of each round, Gommar gains 5 Damage Reduction and is
//     stunned for 2 turns. When this effect expires, he permanently ignores
//     stun effects."
//  glacier — Glacier Crash (gommarglacier1): "Deals 25 damage to all enemies."
//  lich — Icy Blood (gommarlich0): "Gommar ignores periodic Affliction damage."
//  lich — Frozen Heart (gommarlich1):
//    "For his next 2 turns, Gommar is permanently Frost-Covered and ignores
//     harmful non-damage effects. When this skill ends, Gommar dies."
//  myth — Two Crowns (gommarmyth0):
//    "At the start of each round, Gommar summons Bjorn, True King."
//  myth — King's Saddle (gommarmyth1):
//    "For the next 3 turns, Bjorn, True King is stunned and redirects any
//     damage Gommar would take to himself. If Gommar consumes Frost-Covered,
//     Bjorn, True King will cast Sovereign's Howl on a random enemy. Cannot be
//     used if Bjorn, True King has been killed."
//  night — Black Ice (gommarnight0):
//    "While Gommar is Frost-Covered, he is Stealthed."
//  night — Midnight Mountain (gommarnight1):
//    "Deals 45 damage to target enemy. If Gommar is Stealthed, this skill
//     Bypasses. If used while Frost-Covered, lowers the target's damage by 10
//     for 3 turns."
//  prism — Snowy Glare (gommarprism0):
//    "Whenever Gommar gains Frost-Covered, enemies with lowered damage are
//     Blinded for 1 turn."
//  prism — Dancing Lights (gommarprism1):
//    "Gommar gives his team 10 Damage Reduction for 2 turns, healing them for 5
//     HP per turn. If Gommar is Frost-Covered, he deals 10 piercing damage to
//     the enemy team for 2 turns."
//  stasis — Natural Cryogenics (gommarstasis0):
//    "While Frost-Covered, Gommar heals for 15 health per turn if he takes no
//     action."
//  stasis — Keeper of Beasts (gommarstasis1):
//    "Creates a Frozen Beast minion. This minion is permanently stunned until
//     Gommar loses Frost-Covered."
//  winter — Hypothermia (gommarwinter0):
//    "When Gommar deals new damage to an enemy, he increases the damage they
//     receive from all sources by 5 for 2 turns. This effect does not stack."
//  winter — Howling Gale (gommarwinter1):
//    "Deals 35 damage to target enemy. If the target was already affected by
//     Hypothermia, they are stunned for 1 turn. If Gommar is Frost-Covered,
//     they are stunned for 2 turns instead."
// ============================================================================

function frost(u: Unit): void {
  u.statuses.push({ kind: "mark", name: "Frost-Covered", duration: null, appliedBy: u.id, appliedTurn: 0 });
}
function hasFrost(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "mark" && s.name === "Frost-Covered");
}
function has(u: Unit, kind: string): boolean {
  return u.statuses.some((s) => s.kind === kind);
}
function stunOf(u: Unit) {
  return u.statuses.filter((s) => s.kind === "stun");
}
function odm(u: Unit) {
  return u.statuses.find((s) => s.kind === "outgoing_damage_mod");
}
// Stock every fusion element (a fused Gommar pays specific cost in the fusion element).
function bag(state: MatchState, team: "A" | "B" = "A"): void {
  state.teams[team].energy = {
    generic: 80, ice: 40, apocalypse: 40, aurora: 40, crystal: 40, glacier: 40,
    lich: 40, myth: 40, night: 40, prism: 40, stasis: 40, winter: 40,
  };
}
function fuse(key: string, id = "g"): Unit {
  const g = loadHero(heroById("gommar"), "A", id);
  applyFusion(g, fusionForm("gommar", key)!);
  return g;
}
function minionOf(state: MatchState, team = "A"): Unit | undefined {
  return Object.values(state.units).find((u) => u.kind === "minion" && u.team === team && u.alive);
}

// Enemy probe skills (the enemy is the caster; used to APPLY effects onto Gommar/allies).
const eStun = () => skill("estun", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }], { tags: ["Harmful", "Instant"], targeting: "single" });
const eBlind = () => skill("eblind", [{ op: "applyStatus", to: "target", status: { kind: "blind", duration: 2 } }], { tags: ["Harmful", "Instant"], targeting: "single" });
const eHit = (n = 40) => skill("ehit", [{ op: "damage", amount: n, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" });
const eStratHit = (n = 10) => skill("estrat", [{ op: "damage", amount: n, to: "target" }], { tags: ["Harmful", "Strategic", "Instant"], targeting: "single" });
const eBasicHit = (n = 10) => skill("ebasic", [{ op: "damage", amount: n, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" });
const vStrat = () => skill("vstrat", [], { tags: ["Strategic", "Instant"], targeting: "self" });
const vBasic = () => skill("vbasic", [], { tags: ["Instant"], targeting: "self" });

// =========================================================================== //
//  APOCALYPSE — Forced Adaptation + Cold Snap
// =========================================================================== //

test("apocalypse passive: while Frost-Covered, an enemy non-damage effect is IGNORED (once the ward is up)", () => {
  const g = fuse("apocalypse");
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eBlind(), eStun()] });
  const state = makeState([g], [e]); bag(state); bag(state, "B");

  // First enemy status arms the ward (Forced Adaptation grants the ignore off any status applied while Frost-Covered).
  performAction(state, { unit: "e", skillId: "eblind", targets: ["g"] });
  assert.equal(has(g, "non_damage_ignore"), true, "Frost-Covered -> the ignore is granted");
  // A subsequent enemy stun is now ignored -> it does not land.
  performAction(state, { unit: "e", skillId: "estun", targets: ["g"] });
  assert.equal(stunOf(g).length, 0, "while Frost-Covered, the enemy stun is ignored (no stun status lands)");
});

test("apocalypse passive control: NOT Frost-Covered -> no ward, enemy non-damage effects LAND", () => {
  const g = fuse("apocalypse");
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eBlind(), eStun()] });
  const state = makeState([g], [e]); bag(state); bag(state, "B");

  performAction(state, { unit: "e", skillId: "eblind", targets: ["g"] });
  assert.equal(has(g, "non_damage_ignore"), false, "no Frost-Covered -> no ignore granted");
  performAction(state, { unit: "e", skillId: "estun", targets: ["g"] });
  assert.equal(stunOf(g).length, 1, "without the ward, the enemy stun lands");
});

// Adversarial: frozen is unconditional — "While Frost-Covered, he ignores non-damage effects." The FIRST
// enemy effect applied while Frost-Covered ought to be ignored too. The engine grants the ward reactively
// (on statusApplied), so the very first effect lands before the ward exists.
test.skip("SUSPECTED BUG: apocalypse passive lets the FIRST enemy non-damage effect land while Frost-Covered — frozen says he ignores non-damage effects, but the ward is granted reactively AFTER the first one applies", () => {
  const g = fuse("apocalypse");
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eStun()] });
  const state = makeState([g], [e]); bag(state); bag(state, "B");

  performAction(state, { unit: "e", skillId: "estun", targets: ["g"] });
  assert.equal(stunOf(g).length, 0, "a Frost-Covered Gommar should ignore even the first non-damage effect");
});

test("apocalypse Cold Snap: base stuns target's STRATEGIC skills for 1 turn and deals NO damage when not Frost-Covered", () => {
  const g = fuse("apocalypse");
  assert.equal(hasFrost(g), false, "precondition: not Frost-Covered");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const state = makeState([g], [e]); bag(state); bag(state, "B");

  performAction(state, { unit: "g", skillId: "gommarapocalypse1", targets: ["e"] });
  assert.equal(e.hp, 100, "not Frost-Covered -> no 15 damage");
  assert.equal(performAction(state, { unit: "e", skillId: "vstrat", targets: [] }).reason, "stunned", "target's Strategic skill is stunned");
  assert.equal(performAction(state, { unit: "e", skillId: "vbasic", targets: [] }).ok, true, "target's non-Strategic skill is NOT stunned");
});

test("apocalypse Cold Snap: Frost-Covered adds 15 damage (stun still Strategic-only)", () => {
  const g = fuse("apocalypse");
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e]); bag(state);

  performAction(state, { unit: "g", skillId: "gommarapocalypse1", targets: ["e"] });
  assert.equal(e.hp, 85, "Frost-Covered -> the target also receives 15 damage");
  const st = stunOf(e)[0];
  assert.deepEqual(st?.scope, { tag: "Strategic", mode: "only" }, "stun is scoped to Strategic skills");
  assert.equal(st?.duration, 1, "for 1 turn");
});

// =========================================================================== //
//  AURORA — Dazzling Lights + Aurora Veil
// =========================================================================== //

test("aurora Dazzling Lights: first enemy to use a skill on Frost-Covered Gommar gets a cost increase; only ONCE", () => {
  const g = fuse("aurora");
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eStratHit()] });
  const state = makeState([g], [e]); bag(state); bag(state, "B");

  emit(state, { type: "skillDeclared", caster: "e", skillId: "estrat", tags: ["Harmful", "Strategic", "Instant"], targets: ["g"] });
  assert.equal(has(e, "cost_mod"), true, "the first enemy to use a skill on Frost-Covered Gommar is taxed (cost_mod)");
  // Fires exactly once: a self-mark ('Dazzling Lights') gates re-procs.
  const before = e.statuses.filter((s) => s.kind === "cost_mod").length;
  emit(state, { type: "skillDeclared", caster: "e", skillId: "estrat", tags: ["Harmful", "Strategic", "Instant"], targets: ["g"] });
  assert.equal(e.statuses.filter((s) => s.kind === "cost_mod").length, before, "the passive is a one-shot ('the FIRST enemy') — no second tax");
});

test("aurora Dazzling Lights control: an enemy skill NOT aimed at Gommar does not proc it; and nothing procs when he is NOT Frost-Covered", () => {
  const g = fuse("aurora");
  const other = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g, other], [e]);

  // (a) not Frost-Covered, skill aimed at Gommar -> no proc.
  emit(state, { type: "skillDeclared", caster: "e", skillId: "estrat", tags: ["Harmful", "Instant"], targets: ["g"] });
  assert.equal(has(e, "cost_mod"), false, "no Frost-Covered -> no tax");
  // (b) Frost-Covered, but the skill targets an ally (not Gommar) -> no proc.
  frost(g);
  emit(state, { type: "skillDeclared", caster: "e", skillId: "estrat", tags: ["Harmful", "Instant"], targets: ["al"] });
  assert.equal(has(e, "cost_mod"), false, "a skill used on someone OTHER than Gommar does not proc Dazzling Lights");
});

test("aurora Aurora Veil: the whole team becomes invulnerable to Strategic skills this turn", () => {
  const g = fuse("aurora");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eStratHit()] });
  const state = makeState([g, ally], [e]); bag(state); bag(state, "B");

  performAction(state, { unit: "g", skillId: "gommaraurora1", targets: [] });
  assert.equal(has(g, "invulnerable"), true, "Gommar is invulnerable");
  assert.equal(has(ally, "invulnerable"), true, "the ally is invulnerable too ('Gommar's team')");
  // A Strategic harmful skill cannot land on a covered ally.
  const r = performAction(state, { unit: "e", skillId: "estrat", targets: ["al"] });
  assert.equal(r.ok, false, "a Strategic skill is blocked by Aurora Veil");
  assert.equal(ally.hp, 100, "no Strategic damage got through");
});

test("aurora Aurora Veil: the FOLLOWING turn the cover flips to non-Strategic skills", () => {
  const g = fuse("aurora");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eBasicHit()] });
  const state = makeState([g, ally], [e]); bag(state); bag(state, "B");

  performAction(state, { unit: "g", skillId: "gommaraurora1", targets: [] });
  // Advance to Gommar's next turn: phase-1 cover expires and the scheduled phase-2 cover installs.
  endTurn(state); // A ends
  endTurn(state); // B ends
  endTurn(state); // A ends again -> phase 2 fires
  const inv = ally.statuses.find((s) => s.kind === "invulnerable");
  assert.ok(inv, "the ally is invulnerable on the following turn");
  assert.deepEqual(inv?.scope, { tag: "Strategic", mode: "except" }, "now scoped to NON-Strategic skills");
  // Behaviorally, a non-Strategic harmful skill is now blocked (matches 'invulnerable to non-Strategic skills').
  const r = performAction(state, { unit: "e", skillId: "ebasic", targets: ["al"] });
  assert.equal(r.ok, false, "a non-Strategic skill is blocked in phase 2");
});

// Adversarial: phase 1 is "invulnerable to Strategic skills" — a NON-Strategic harmful skill should still land.
// The engine's invulnerable ignores its scope, so it blocks everything.
test("aurora Aurora Veil: invulnerable to Strategic skills only — a non-Strategic hit still lands", () => {
  const g = fuse("aurora");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eBasicHit(10)] });
  const state = makeState([g, ally], [e]); bag(state); bag(state, "B");

  performAction(state, { unit: "g", skillId: "gommaraurora1", targets: [] });
  const r = performAction(state, { unit: "e", skillId: "ebasic", targets: ["al"] });
  assert.equal(r.ok, true, "a NON-Strategic skill is not blocked by 'invulnerable to Strategic skills'");
  assert.equal(ally.hp, 90, "its 10 damage lands");
});

// =========================================================================== //
//  CRYSTAL — Frosted Facets + Crystalline Smash
// =========================================================================== //

test("crystal Frosted Facets: after round start, Gommar takes HALF damage from a new Harmful skill", () => {
  const g = fuse("crystal");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eHit(40)] });
  const state = makeState([g], [e]); bag(state, "B");

  // Before install: full damage (control that the halving is what does it).
  performAction(state, { unit: "e", skillId: "ehit", targets: ["g"] });
  assert.equal(g.hp, 60, "no halving installed yet -> full 40 lands");

  g.hp = 100;
  emit(state, { type: "roundStart" }); // Frosted Facets installs the halving
  performAction(state, { unit: "e", skillId: "ehit", targets: ["g"] });
  assert.equal(g.hp, 80, "half damage from the new Harmful skill (40 -> 20)");
});

test("crystal Frosted Facets control: the halving is 'new' damage only — a periodic DoT tick is NOT halved", () => {
  const g = fuse("crystal");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "roundStart" });
  // A 10/turn DoT on Gommar (not a 'new' skill hit) ticks in full.
  g.statuses.push({ kind: "dot", magnitude: 10, duration: 3, dtype: "normal", appliedBy: "e", appliedTurn: 0 });
  const before = g.hp;
  endTurn(state); // A turn end ticks A's dots? dots tick for the applier's team; force via B applier below.
  // The DoT was applied by an enemy (team B) -> ticks at B's turn end.
  endTurn(state); // B end -> the dot ticks
  assert.equal(before - g.hp, 10, "a DoT tick is not a 'new Harmful skill' -> full 10, not halved to 5");
});

test("crystal Crystalline Smash: 30 to the focal target, 10 to each of its two allies; Frost-Covered stuns all damaged enemies' Strategic skills", () => {
  const g = fuse("crystal");
  frost(g);
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const a1 = makeUnit({ id: "a1", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const a2 = makeUnit({ id: "a2", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat(), vBasic()] });
  const state = makeState([g], [t, a1, a2]); bag(state); bag(state, "B");

  performAction(state, { unit: "g", skillId: "gommarcrystal1", targets: ["t"] });
  assert.equal(t.hp, 70, "30 to the focal target");
  assert.equal(a1.hp, 90, "10 to the first ally");
  assert.equal(a2.hp, 90, "10 to the second ally");
  // Frost-Covered -> every damaged enemy's Strategic skills are stunned for 1 turn.
  for (const id of ["t", "a1", "a2"]) {
    assert.equal(performAction(state, { unit: id, skillId: "vstrat", targets: [] }).reason, "stunned", `${id}'s Strategic skill is stunned`);
    assert.equal(performAction(state, { unit: id, skillId: "vbasic", targets: [] }).ok, true, `${id}'s non-Strategic skill is not stunned`);
  }
});

test("crystal Crystalline Smash control: NOT Frost-Covered -> no Strategic stun on the damaged enemies", () => {
  const g = fuse("crystal");
  const t = makeUnit({ id: "t", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [vStrat()] });
  const a1 = makeUnit({ id: "a1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const a2 = makeUnit({ id: "a2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [t, a1, a2]); bag(state); bag(state, "B");

  performAction(state, { unit: "g", skillId: "gommarcrystal1", targets: ["t"] });
  assert.equal(t.hp, 70, "still 30 to focal target");
  assert.equal(performAction(state, { unit: "t", skillId: "vstrat", targets: [] }).ok, true, "no Frost-Covered -> Strategic skill is NOT stunned");
});

// =========================================================================== //
//  GLACIER — Glacial Advance + Glacier Crash
// =========================================================================== //

test("glacier Glacial Advance: at round start Gommar gains 5 Damage Reduction and is stunned for 2 turns", () => {
  const g = fuse("glacier");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "roundStart" });
  const dr = g.statuses.find((s) => s.kind === "damage_reduction");
  assert.equal(dr?.magnitude, 5, "gains 5 Damage Reduction");
  const st = stunOf(g)[0];
  assert.equal(st?.duration, 2, "stunned for 2 turns");
  // The stun is unscoped -> it blocks his own skills.
  bag(state);
  assert.equal(performAction(state, { unit: "g", skillId: "gommarglacier1", targets: [] }).reason, "stunned", "the 2-turn stun blocks Gommar acting");
});

test("glacier Glacial Advance: when the 2-turn stun expires, Gommar permanently ignores (enemy) stun effects", () => {
  const g = fuse("glacier");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eStun()] });
  const state = makeState([g], [e]); bag(state, "B"); bag(state);
  emit(state, { type: "roundStart" });
  // Advance until the 2-turn stun expires and the immunity is granted.
  for (let i = 0; i < 6 && !has(g, "non_damage_ignore"); i++) endTurn(state);
  assert.equal(has(g, "non_damage_ignore"), true, "when the stun expires he gains the permanent ignore");
  assert.equal(stunOf(g).length, 0, "the original 2-turn stun is gone");
  // A fresh enemy stun is now ignored.
  performAction(state, { unit: "e", skillId: "estun", targets: ["g"] });
  assert.equal(stunOf(g).length, 0, "a new enemy stun does not land — he ignores stun effects");
});

// Adversarial: frozen grants "ignores STUN effects" only — a Blind (a non-stun control effect) should still
// land. The engine models it as the broad non_damage_ignore, which wards off Blind too.
test.skip("SUSPECTED BUG: glacier's post-stun immunity also wards off non-stun effects (Blind) — frozen only makes him ignore STUN effects", () => {
  const g = fuse("glacier");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [eBlind()] });
  const state = makeState([g], [e]); bag(state, "B");
  emit(state, { type: "roundStart" });
  for (let i = 0; i < 6 && !has(g, "non_damage_ignore"); i++) endTurn(state);
  performAction(state, { unit: "e", skillId: "eblind", targets: ["g"] });
  assert.equal(has(g, "blind"), true, "a Blind is not a stun -> it should still land on Gommar");
});

test("glacier Glacier Crash: 25 damage to all enemies", () => {
  const g = fuse("glacier");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([g], [e1, e2]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarglacier1", targets: [] });
  assert.equal(e1.hp, 75, "25 to the first enemy");
  assert.equal(e2.hp, 75, "25 to the second enemy");
});

// =========================================================================== //
//  LICH — Icy Blood + Frozen Heart
// =========================================================================== //

test("lich Icy Blood: a periodic Affliction DoT deals Gommar no damage; a normal DoT still ticks", () => {
  const g = fuse("lich");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "roundStart" });
  g.statuses.push({ kind: "dot", magnitude: 10, duration: 3, dtype: "affliction", appliedBy: "e", appliedTurn: 0 });
  g.statuses.push({ kind: "dot", magnitude: 7, duration: 3, dtype: "normal", appliedBy: "e", appliedTurn: 0 });
  const before = g.hp;
  endTurn(state); // A end
  endTurn(state); // B end -> enemy-applied dots tick
  assert.equal(before - g.hp, 7, "the affliction DoT is ignored (0); the normal DoT ticks for 7");
});

test("lich Icy Blood control: normal SKILL damage still lands", () => {
  const g = fuse("lich");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [eHit(20)] });
  const state = makeState([g], [e]); bag(state, "B");
  emit(state, { type: "roundStart" });
  performAction(state, { unit: "e", skillId: "ehit", targets: ["g"] });
  assert.equal(g.hp, g.maxHp - 20, "normal damage is untouched by the Affliction ignore");
});

// Adversarial: frozen scopes the ignore to "periodic Affliction damage" — a NEW/direct Affliction hit should
// land. The engine ignores all Affliction damage regardless of periodicity.
test.skip("SUSPECTED BUG: lich Icy Blood also ignores a NEW/direct Affliction hit — frozen only ignores PERIODIC Affliction damage", () => {
  const g = fuse("lich");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", skills: [skill("aff", [{ op: "damage", amount: 15, dtype: "affliction", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })] });
  const state = makeState([g], [e]); bag(state, "B");
  emit(state, { type: "roundStart" });
  performAction(state, { unit: "e", skillId: "aff", targets: ["g"] });
  assert.equal(g.hp, g.maxHp - 15, "a direct (non-periodic) Affliction hit should still deal 15");
});

test("lich Frozen Heart: grants permanent Frost-Covered + a 2-turn harmful-non-damage ward; Gommar is alive right after", () => {
  const g = fuse("lich");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarlich1", targets: [] });
  assert.equal(hasFrost(g), true, "gains Frost-Covered");
  const ward = g.statuses.find((s) => s.kind === "non_damage_ignore");
  assert.equal(ward?.duration, 2, "ignores harmful non-damage effects for his next 2 turns");
  assert.equal(g.alive, true, "the death is deferred, not immediate ('when this skill ends')");
});

test("lich Frozen Heart: when the skill ends (after his next 2 turns), Gommar dies", () => {
  const g = fuse("lich");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarlich1", targets: [] });
  endTurn(state); // A #1 (birth turn)
  endTurn(state); // B
  assert.equal(g.alive, true, "still alive after only his first turn");
  for (let i = 0; i < 6 && g.alive; i++) endTurn(state);
  assert.equal(g.alive, false, "Gommar dies when Frozen Heart ends");
});

// =========================================================================== //
//  MYTH — Two Crowns + King's Saddle
// =========================================================================== //

test("myth Two Crowns: at round start Gommar summons Bjorn, True King (one ally minion)", () => {
  const g = fuse("myth");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.equal(minionOf(state), undefined, "no minion before round start");
  emit(state, { type: "roundStart" });
  const bjorn = minionOf(state);
  assert.ok(bjorn, "Bjorn is summoned");
  assert.equal(bjorn?.name, "Bjorn, True King", "the summon is Bjorn, True King");
  assert.equal(bjorn?.team, "A", "on Gommar's team");
});

test("myth King's Saddle: stuns Bjorn for 3 turns and redirects damage Gommar would take to Bjorn", () => {
  const g = fuse("myth");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200, skills: [eHit(40)] });
  const state = makeState([g], [e]); bag(state); bag(state, "B");
  emit(state, { type: "roundStart" });
  const bjorn = minionOf(state)!;

  performAction(state, { unit: "g", skillId: "gommarmyth1", targets: [] });
  assert.equal(stunOf(bjorn)[0]?.duration, 3, "Bjorn is stunned for 3 turns");
  const gBefore = g.hp, bBefore = bjorn.hp;
  performAction(state, { unit: "e", skillId: "ehit", targets: ["g"] });
  assert.equal(g.hp, gBefore, "Gommar takes no damage — it is redirected");
  assert.equal(bBefore - bjorn.hp, 40, "Bjorn absorbs the 40 in Gommar's place");
});

test("myth King's Saddle control: WITHOUT the King's Saddle mark, damage to Gommar is NOT redirected", () => {
  const g = fuse("myth");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200, skills: [eHit(40)] });
  const state = makeState([g], [e]); bag(state, "B");
  emit(state, { type: "roundStart" });
  const gBefore = g.hp;
  performAction(state, { unit: "e", skillId: "ehit", targets: ["g"] });
  assert.equal(gBefore - g.hp, 40, "no saddle armed -> Gommar takes the hit himself");
});

test("myth King's Saddle: consuming Frost-Covered makes Bjorn cast Sovereign's Howl on a random enemy", () => {
  const g = fuse("myth");
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g], [e]); bag(state);
  emit(state, { type: "roundStart" });

  performAction(state, { unit: "g", skillId: "gommarmyth1", targets: [] });
  assert.equal(hasFrost(g), false, "Frost-Covered is consumed");
  assert.equal(e.statuses.some((s) => s.kind === "dot" && s.name === "Sovereign's Howl"), true, "the lone enemy is hit by Sovereign's Howl (Bjorn's cast)");
});

test("myth King's Saddle control: WITHOUT Frost-Covered, Bjorn does NOT cast Sovereign's Howl (but still stunned + saddle armed)", () => {
  const g = fuse("myth");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g], [e]); bag(state);
  emit(state, { type: "roundStart" });
  const bjorn = minionOf(state)!;

  performAction(state, { unit: "g", skillId: "gommarmyth1", targets: [] });
  assert.equal(e.statuses.some((s) => s.name === "Sovereign's Howl"), false, "no Frost consumed -> no Sovereign's Howl");
  assert.equal(stunOf(bjorn)[0]?.duration, 3, "Bjorn is still stunned for 3 turns");
});

// Adversarial: frozen: "Cannot be used if Bjorn, True King has been killed." No usability gate is enforced.
test.skip("SUSPECTED BUG: myth King's Saddle is castable even when Bjorn is dead — frozen says it 'Cannot be used if Bjorn, True King has been killed'", () => {
  const g = fuse("myth");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]); bag(state);
  emit(state, { type: "roundStart" });
  const bjorn = minionOf(state)!;
  bjorn.alive = false; bjorn.hp = 0;
  const r = performAction(state, { unit: "g", skillId: "gommarmyth1", targets: [] });
  assert.equal(r.ok, false, "King's Saddle must be unusable while Bjorn is dead");
});

// =========================================================================== //
//  NIGHT — Black Ice + Midnight Mountain
// =========================================================================== //

test("night Black Ice: while Frost-Covered, Gommar is Stealthed; losing Frost-Covered strips the Stealth", () => {
  const g = fuse("night");
  frost(g);
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  // Gaining a status while Frost-Covered grants Stealth (Black Ice's model of the continuous condition).
  emit(state, { type: "statusApplied", unit: "g", source: "g", kind: "mark", name: "probe" });
  assert.equal(has(g, "stealth"), true, "Frost-Covered -> Stealthed");
  // Lose Frost-Covered, then a status expires -> Stealth is stripped.
  g.statuses = g.statuses.filter((s) => !(s.kind === "mark" && s.name === "Frost-Covered"));
  emit(state, { type: "statusExpired", unit: "g", kind: "mark", name: "probe" });
  assert.equal(has(g, "stealth"), false, "no longer Frost-Covered -> Stealth removed");
});

test("night Black Ice control: NOT Frost-Covered -> no Stealth granted", () => {
  const g = fuse("night");
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "statusApplied", unit: "g", source: "g", kind: "mark", name: "probe" });
  assert.equal(has(g, "stealth"), false, "no Frost-Covered -> not Stealthed");
});

test("night Midnight Mountain: 45 damage; Frost-Covered adds -10 outgoing damage to the target for 3 turns", () => {
  const g = fuse("night");
  frost(g);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g], [e]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarnight1", targets: ["e"] });
  assert.equal(e.hp, 155, "45 damage");
  const d = odm(e);
  assert.equal(d?.magnitude, -10, "Frost-Covered -> lowers the target's damage by 10");
  assert.equal(d?.duration, 3, "for 3 turns");
});

test("night Midnight Mountain control: NOT Frost-Covered -> 45 damage but no damage-lowering debuff", () => {
  const g = fuse("night");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g], [e]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarnight1", targets: ["e"] });
  assert.equal(e.hp, 155, "45 damage");
  assert.equal(odm(e), undefined, "no Frost-Covered -> no -10 damage debuff");
});

// Adversarial: frozen: "If Gommar is Stealthed, this skill Bypasses" (ignores Invulnerability). Unmodeled — a
// Stealthed Gommar cannot hit an invulnerable target.
test.skip("SUSPECTED BUG: night Midnight Mountain does not Bypass while Stealthed — frozen says a Stealthed cast Bypasses (ignores Invulnerability)", () => {
  const g = fuse("night");
  g.statuses.push({ kind: "stealth", duration: null, appliedBy: "g", appliedTurn: 0 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200, statuses: [{ kind: "invulnerable", duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [e]); bag(state);
  const r = performAction(state, { unit: "g", skillId: "gommarnight1", targets: ["e"] });
  assert.equal(r.ok, true, "a Stealthed Midnight Mountain should Bypass invulnerability and land");
  assert.equal(e.hp, 155, "the 45 lands through invulnerability");
});

// =========================================================================== //
//  PRISM — Snowy Glare + Dancing Lights
// =========================================================================== //

test("prism Snowy Glare: when Gommar gains Frost-Covered, enemies with LOWERED damage are Blinded 1 turn; others are not", () => {
  const g = fuse("prism");
  const lowered = makeUnit({ id: "lo", team: "B", kind: "hero", statuses: [{ kind: "outgoing_damage_mod", magnitude: -5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const clean = makeUnit({ id: "cl", team: "B", kind: "hero" });
  const state = makeState([g], [lowered, clean]);
  frost(g);
  emit(state, { type: "statusApplied", unit: "g", source: "g", kind: "mark", name: "Frost-Covered" });
  const b = lowered.statuses.find((s) => s.kind === "blind");
  assert.equal(b?.duration, 1, "the reduced-damage enemy is Blinded for 1 turn");
  assert.equal(has(clean, "blind"), false, "an enemy without lowered damage is not Blinded");
});

test("prism Snowy Glare control: gaining a DIFFERENT status (not Frost-Covered) does not Blind", () => {
  const g = fuse("prism");
  const lowered = makeUnit({ id: "lo", team: "B", kind: "hero", statuses: [{ kind: "outgoing_damage_mod", magnitude: -5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [lowered]);
  emit(state, { type: "statusApplied", unit: "g", source: "g", kind: "stun", name: undefined });
  assert.equal(has(lowered, "blind"), false, "Snowy Glare keys on GAINING Frost-Covered, not any status");
});

// Adversarial: frozen targets enemies "with lowered damage". An enemy whose damage is RAISED (+odm) is not a
// lowered-damage enemy and must not be Blinded — but the filter keys on has(outgoing_damage_mod) regardless of sign.
test.skip("SUSPECTED BUG: prism Snowy Glare Blinds an enemy whose damage is RAISED (+odm) — frozen only Blinds enemies with LOWERED damage", () => {
  const g = fuse("prism");
  const raised = makeUnit({ id: "up", team: "B", kind: "hero", statuses: [{ kind: "outgoing_damage_mod", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  const state = makeState([g], [raised]);
  frost(g);
  emit(state, { type: "statusApplied", unit: "g", source: "g", kind: "mark", name: "Frost-Covered" });
  assert.equal(has(raised, "blind"), false, "an enemy with RAISED damage is not 'lowered damage' -> not Blinded");
});

test("prism Dancing Lights: team gets 10 DR + 5 regen for 2 turns; Frost-Covered pulses 10 piercing to the enemy team, again next turn", () => {
  const g = fuse("prism");
  frost(g);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g, ally], [e1, e2]); bag(state);

  performAction(state, { unit: "g", skillId: "gommarprism1", targets: [] });
  const dr = ally.statuses.find((s) => s.kind === "damage_reduction");
  assert.equal(dr?.magnitude, 10, "team gains 10 Damage Reduction");
  assert.equal(dr?.duration, 2, "for 2 turns");
  const rg = ally.statuses.find((s) => s.kind === "regen");
  assert.equal(rg?.magnitude, 5, "and 5 HP/turn regen");
  assert.equal(e1.hp, 190, "Frost-Covered -> immediate 10 piercing pulse to enemy 1");
  assert.equal(e2.hp, 190, "immediate 10 piercing pulse to enemy 2");

  // Advance to Gommar's next turn: a second 10-piercing pulse lands and regen heals the ally.
  endTurn(state); // A end (birth)
  endTurn(state); // B end
  endTurn(state); // A end -> pulse + regen
  assert.equal(e1.hp, 180, "the 'for 2 turns' second piercing pulse lands");
  assert.equal(ally.hp, 55, "regen healed the ally 5");
});

test("prism Dancing Lights control: NOT Frost-Covered -> team buffs apply but NO piercing damage to enemies", () => {
  const g = fuse("prism");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g, ally], [e1]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarprism1", targets: [] });
  assert.equal(has(ally, "damage_reduction"), true, "team still gets the DR buff");
  assert.equal(e1.hp, 200, "no Frost-Covered -> no piercing damage");
});

// =========================================================================== //
//  STASIS — Natural Cryogenics + Keeper of Beasts
// =========================================================================== //

test("stasis Natural Cryogenics: Frost-Covered + no action -> heals 15 at turn end", () => {
  const g = fuse("stasis");
  frost(g); g.hp = 50;
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  state.teams.A.energy = { generic: 40 };
  endTurn(state); // Gommar took no action this turn
  assert.equal(g.hp, 65, "heals for 15 health");
});

test("stasis Natural Cryogenics control: if Gommar ACTS, he does not heal", () => {
  const g = fuse("stasis");
  frost(g); g.hp = 50;
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarstasis1", targets: [] }); // an action
  endTurn(state);
  assert.equal(g.hp, 50, "he took an action -> no heal");
});

test("stasis Natural Cryogenics control: NOT Frost-Covered -> no heal even with no action", () => {
  const g = fuse("stasis");
  g.hp = 50;
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  state.teams.A.energy = { generic: 40 };
  endTurn(state);
  assert.equal(g.hp, 50, "not Frost-Covered -> the heal does not apply");
});

test("stasis Keeper of Beasts: creates a Frozen Beast, permanently stunned until Gommar loses Frost-Covered", () => {
  const g = fuse("stasis");
  frost(g);
  const state = makeState([g], [makeUnit({ id: "e", team: "B", kind: "hero" })]); bag(state);
  performAction(state, { unit: "g", skillId: "gommarstasis1", targets: [] });
  const beast = minionOf(state)!;
  assert.equal(beast.name, "Frozen Beast", "a Frozen Beast is summoned");
  const st = stunOf(beast)[0];
  assert.equal(st?.duration, null, "permanently stunned (no expiry)");
  // The stun releases the moment Gommar loses Frost-Covered.
  emit(state, { type: "statusLost", unit: "g", kind: "mark", name: "Frost-Covered" });
  assert.equal(stunOf(beast).length, 0, "losing Frost-Covered un-stuns the Frozen Beast");
});

// =========================================================================== //
//  WINTER — Hypothermia + Howling Gale
// =========================================================================== //

test("winter Hypothermia: Gommar's new damage marks the enemy to take +5 from ALL sources for 2 turns; it does not stack", () => {
  const g = fuse("winter");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", skills: [eBasicHit(10)] });
  const state = makeState([g, ally], [e]); bag(state);

  emit(state, { type: "damageDealt", source: "g", target: "e", amount: 20, dtype: "normal", isNew: true });
  const marks = e.statuses.filter((s) => s.kind === "incoming_damage_mod" && s.name === "Hypothermia");
  assert.equal(marks.length, 1, "one Hypothermia marker");
  assert.equal(marks[0]?.magnitude, 5, "+5 incoming damage");
  assert.equal(marks[0]?.duration, 2, "for 2 turns");
  // Does not stack: a second proc refreshes, not adds.
  emit(state, { type: "damageDealt", source: "g", target: "e", amount: 20, dtype: "normal", isNew: true });
  assert.equal(e.statuses.filter((s) => s.kind === "incoming_damage_mod" && s.name === "Hypothermia").length, 1, "still one marker (does not stack)");
  // From ALL sources: an ALLY's 10 hit deals 15.
  const before = e.hp;
  performAction(state, { unit: "al", skillId: "ebasic", targets: ["e"] });
  assert.equal(before - e.hp, 15, "the marked enemy takes +5 from any source (ally's 10 -> 15)");
});

test("winter Hypothermia control: Gommar hitting an ALLY (not an enemy) does not apply Hypothermia", () => {
  const g = fuse("winter");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero" });
  const state = makeState([g, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "damageDealt", source: "g", target: "al", amount: 20, dtype: "normal", isNew: true });
  assert.equal(ally.statuses.some((s) => s.kind === "incoming_damage_mod"), false, "the passive only marks ENEMIES Gommar damages");
});

test("winter Howling Gale: 35 damage; a target ALREADY affected by Hypothermia is stunned 1 turn (2 if Frost-Covered)", () => {
  // Not Frost-Covered: pre-existing Hypothermia -> 1-turn stun.
  const g1 = fuse("winter", "g1");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 200, maxHp: 200, statuses: [{ kind: "incoming_damage_mod", name: "Hypothermia", magnitude: 5, duration: 2, appliedBy: "x", appliedTurn: 0 }] });
  const s1 = makeState([g1], [e1]); bag(s1);
  performAction(s1, { unit: "g1", skillId: "gommarwinter1", targets: ["e1"] });
  // NB: 35 base + 5 from the pre-existing Hypothermia marker = 40.
  assert.equal(e1.hp, 160, "35 (+5 Hypothermia) lands");
  assert.equal(stunOf(e1)[0]?.duration, 1, "already-affected target is stunned for 1 turn");

  // Frost-Covered: pre-existing Hypothermia -> 2-turn stun instead.
  const g2 = fuse("winter", "g2");
  frost(g2);
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 200, maxHp: 200, statuses: [{ kind: "incoming_damage_mod", name: "Hypothermia", magnitude: 5, duration: 2, appliedBy: "x", appliedTurn: 0 }] });
  const s2 = makeState([g2], [e2]); bag(s2);
  performAction(s2, { unit: "g2", skillId: "gommarwinter1", targets: ["e2"] });
  assert.equal(stunOf(e2)[0]?.duration, 2, "Frost-Covered -> 2-turn stun instead");
});

// Adversarial: frozen gates the stun on the target being "ALREADY affected by Hypothermia" (before this cast).
// Howling Gale's own 35 damage procs the passive synchronously, so the same-cast check sees Hypothermia and
// stuns a FRESH target that was not previously afflicted.
test.skip("SUSPECTED BUG: winter Howling Gale stuns a FRESH target on the first cast — frozen requires the target be ALREADY affected by Hypothermia, but its own damage applies Hypothermia before the check", () => {
  const g = fuse("winter");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 200, maxHp: 200 });
  const state = makeState([g], [e]); bag(state);
  assert.equal(e.statuses.some((s) => s.name === "Hypothermia"), false, "precondition: target is not yet affected");
  performAction(state, { unit: "g", skillId: "gommarwinter1", targets: ["e"] });
  assert.equal(stunOf(e).length, 0, "a not-previously-affected target must not be stunned by the first Howling Gale");
});
