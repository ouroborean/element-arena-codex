import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startTurn, endTurn, effectiveTargeting } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import type { Unit, StatusKind } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Adversarial, spec-derived suite for The Black Knight's BASE kit.
// Oracle = the FROZEN prose (content/frozen/skills.json):
//   blackknight0 Exile (passive):  "When the Black Knight acts alone, his abilities are enhanced
//                                    and he gains Elemental Essence."
//   blackknight1 Oathbreaker Strike: "Deals 15 damage to 1 enemy. While enhanced, deals 10 more
//                                    damage and becomes piercing."
//   blackknight2 Misery:           "For 2 turns, the Black Knight deals 5 additional damage for each
//                                    30 health his team is missing, up to 20. While enhanced, this
//                                    skill lasts an additional turn."
//   blackknight3 Unholy Aura:      "For 2 turns, all allies and enemies deal 5 less damage. While
//                                    enhanced, this skill only targets enemies and affected enemies
//                                    deal 10 less damage."
//   blackknight4 Dead or Alive:    "The Black Knight ignores all new Harmful skills for 1 turn.
//                                    While enhanced, this skill also redirects harmful skills from
//                                    his allies to himself. This effect is invisible."
//   blackknight5 The Nightmare Rides: "For 2 turns, the Black Knight is invulnerable. During this
//                                    time, Oathbreaker Strike will target all enemies and is always
//                                    enhanced."
// Element is Unholy, so Specific cost is paid from the "unholy" pool.
// Glossary ruling (content/rulings.json): Piercing ignores Damage Reduction but NOT Shield.
// The "enhanced" state is produced by the Exile passive as a self mark named "Exile"; per the
// content this is the drive-hook every active skill reads, so we seed it directly to exercise the
// enhanced branches (a permitted "status the skill produces" drive detail).
// ---------------------------------------------------------------------------

function bk(team: "A" | "B", id: string): Unit {
  return loadHero(heroById("blackknight"), team, id);
}
function fund(state: ReturnType<typeof makeState>): void {
  state.teams.A.energy = { generic: 40, unholy: 40 };
  state.teams.B.energy = { generic: 40, unholy: 40 };
}
function seedExile(u: Unit): void {
  u.statuses.push({ kind: "mark", name: "Exile", duration: 1, appliedBy: u.id, appliedTurn: 0 });
}
function find(u: Unit, kind: StatusKind, name?: string) {
  return u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
}

// =====================================================================================
// blackknight1 — Oathbreaker Strike
// =====================================================================================

test("Oathbreaker Strike (un-enhanced): deals exactly 15 normal damage to the single chosen enemy", () => {
  const k = bk("A", "b");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2]);
  fund(state);

  const r = performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(e1.hp, 85, "15 damage to the chosen enemy");
  assert.equal(e2.hp, 100, "un-enhanced Oathbreaker is single-target, not AoE");
});

test("Oathbreaker Strike (un-enhanced): normal damage IS reduced by Damage Reduction (not piercing)", () => {
  const k = bk("A", "b");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(e.hp, 95, "15 normal - 10 DR = 5 damage");
});

test("Oathbreaker Strike (enhanced): deals 25 damage (15 + 10 more) to the target", () => {
  const k = bk("A", "b");
  seedExile(k);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(e.hp, 75, "enhanced deals 10 more: 25");
});

test("Oathbreaker Strike (enhanced) becomes piercing: ignores Damage Reduction", () => {
  const k = bk("A", "b");
  seedExile(k);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(e.hp, 75, "piercing 25 ignores the 10 DR (would be 15 if it respected DR)");
});

test("Oathbreaker Strike (enhanced, no Nightmare) stays SINGLE-target", () => {
  const k = bk("A", "b");
  seedExile(k);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "chosen enemy takes 25");
  assert.equal(e2.hp, 100, "enhancement alone does NOT make it hit all enemies (that is Nightmare)");
});

// =====================================================================================
// blackknight2 — Misery
// =====================================================================================

test("Misery: +5 per 30 team-missing-HP, floored — 60 missing -> +10, duration 2 (un-enhanced)", () => {
  const k = bk("A", "b");
  k.hp = 40; // solo team, missing 60 -> floor(60/30)=2 -> +10
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" });
  const m = find(k, "outgoing_damage_mod", "Misery");
  assert.ok(m, "Misery outgoing buff applied");
  assert.equal(m!.magnitude, 10, "5 * floor(60/30) = 10");
  assert.equal(m!.duration, 2, "un-enhanced lasts 2 turns");
});

test("Misery: below one 30-HP bracket grants +0", () => {
  const k = bk("A", "b");
  k.hp = 80; // missing 20 -> floor(20/30)=0 -> +0
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" });
  const m = find(k, "outgoing_damage_mod", "Misery");
  assert.equal(m!.magnitude, 0, "under 30 missing -> no bonus");
});

test("Misery: bonus is capped at +20 even when raw team-missing would give more", () => {
  const k = bk("A", "b");
  k.hp = 40; // missing 60
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 10, maxHp: 100 }); // missing 90
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" });
  const m = find(k, "outgoing_damage_mod", "Misery");
  // team missing = 150 -> floor(150/30)=5 -> 25 raw, capped to 20.
  assert.equal(m!.magnitude, 20, "cap holds: min(20, 25) = 20");
});

test("Misery: the missing-HP bonus really adds to a subsequent Oathbreaker hit", () => {
  const k = bk("A", "b");
  k.hp = 40; // missing 60 -> +10 (un-enhanced, no Exile mark)
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" });
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(e.hp, 75, "Oathbreaker 15 + Misery 10 = 25");
});

test("Misery (enhanced): lasts an additional turn -> duration 3", () => {
  const k = bk("A", "b");
  seedExile(k);
  k.hp = 70; // missing 30 -> +5
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" });
  const m = find(k, "outgoing_damage_mod", "Misery");
  assert.equal(m!.magnitude, 5, "5 * floor(30/30) = 5 (magnitude unchanged by enhancement)");
  assert.equal(m!.duration, 3, "enhanced lasts an additional turn (2 -> 3)");
});

// =====================================================================================
// blackknight3 — Unholy Aura
// =====================================================================================

test("Unholy Aura (un-enhanced): -5 outgoing on ALL allies AND enemies for 2 turns", () => {
  const k = bk("A", "b");
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight3" });
  const onAlly = find(ally, "outgoing_damage_mod", "Unholy Aura");
  const onEnemy = find(e, "outgoing_damage_mod", "Unholy Aura");
  assert.ok(onAlly, "an ally is affected (all allies deal less)");
  assert.ok(onEnemy, "an enemy is affected (all enemies deal less)");
  assert.equal(onAlly!.magnitude, -5, "-5 outgoing on allies");
  assert.equal(onEnemy!.magnitude, -5, "-5 outgoing on enemies");
  assert.equal(onEnemy!.duration, 2, "for 2 turns");
});

test("Unholy Aura (un-enhanced): the -5 really reduces an enemy's outgoing damage", () => {
  const k = bk("A", "b");
  const e = bk("B", "e"); // enemy black knight can cast Oathbreaker back
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight3" }); // enemy gets -5 outgoing
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["b"] }); // enemy Oathbreaker 15 -> 10
  assert.equal(k.hp, 90, "enemy dealt 15 - 5 = 10 to the Black Knight");
});

test("Unholy Aura (enhanced): -10 on ENEMIES ONLY; allies are NOT affected", () => {
  const k = bk("A", "b");
  seedExile(k);
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight3" });
  const onEnemy = find(e, "outgoing_damage_mod", "Unholy Aura");
  const onAlly = find(ally, "outgoing_damage_mod", "Unholy Aura");
  const onSelf = find(k, "outgoing_damage_mod", "Unholy Aura");
  assert.ok(onEnemy, "enemy affected while enhanced");
  assert.equal(onEnemy!.magnitude, -10, "enhanced: enemies deal 10 less");
  assert.equal(onAlly, undefined, "enhanced only targets enemies — allies untouched");
  assert.equal(onSelf, undefined, "enhanced only targets enemies — the Black Knight himself untouched");
});

// =====================================================================================
// blackknight4 — Dead or Alive
// =====================================================================================

test("Dead or Alive (un-enhanced): the Black Knight ignores an incoming Harmful skill", () => {
  const k = bk("A", "b");
  const e = bk("B", "e");
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight4" });
  assert.ok(find(k, "damage_ignore"), "damage_ignore applied for 1 turn");
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["b"] }); // 15 -> ignored
  assert.equal(k.hp, 100, "the Black Knight ignores the harmful skill (takes 0)");
});

test("Dead or Alive control: WITHOUT it, the same Oathbreaker lands for 15", () => {
  const k = bk("A", "b");
  const e = bk("B", "e");
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["b"] });
  assert.equal(k.hp, 85, "no ignore -> takes the full 15");
});

test("Dead or Alive (enhanced): redirects an ally-targeted harmful skill to the Black Knight, who ignores it", () => {
  const k = bk("A", "b");
  seedExile(k);
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = bk("B", "e");
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight4" }); // enhanced -> ignore + redirect
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["a2"] }); // aimed at the ally
  assert.equal(ally.hp, 100, "the ally is protected — the harmful skill was redirected off him");
  assert.equal(k.hp, 100, "redirected onto the Black Knight, who ignores it");
});

test("Dead or Alive control: un-enhanced does NOT redirect — the ally takes the hit", () => {
  const k = bk("A", "b"); // no Exile mark -> un-enhanced
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = bk("B", "e");
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight4" }); // ignore for self only, no redirect
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["a2"] });
  assert.equal(ally.hp, 85, "un-enhanced: no redirect, ally eats the full 15");
});

// =====================================================================================
// blackknight5 — The Nightmare Rides
// =====================================================================================

test("The Nightmare Rides: grants invulnerability for 2 turns (enemy cannot damage him)", () => {
  const k = bk("A", "b");
  const e = bk("B", "e");
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight5" });
  const inv = find(k, "invulnerable");
  assert.ok(inv, "invulnerable applied");
  assert.equal(inv!.duration, 2, "for 2 turns");
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["b"] });
  assert.equal(k.hp, 100, "invulnerable -> the enemy's harmful skill cannot land");
});

test("The Nightmare Rides: Oathbreaker targets ALL enemies and is always enhanced (25 piercing)", () => {
  const k = bk("A", "b");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const state = makeState([k], [e1, e2]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight5" });
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "hit for 25 despite aiming at a single target");
  assert.equal(e2.hp, 75, "the OTHER enemy is also hit for 25 (targets all) — piercing ignores its 10 DR");
});

// --- The CLIENT-offering seam: effectiveTargeting (what the UI reads to decide which portraits to offer /
// --- highlight / telegraph). The engine's behavioral tests hand performAction explicit targets, so they
// --- verified RESOLUTION but never this seam — which is how "ultimate castable on anyone" and "AoE still
// --- looks single-target" slipped through. effectiveTargeting is the exact value highlightFor/telegraphFor
// --- (client/targeting.ts) now switch on.

test("The Nightmare Rides is SELF-target: effectiveTargeting is 'self' so the client aims it at the caster only (regression: was authored 'single', which fell through to offering the whole board)", () => {
  const k = bk("A", "b");
  const state = makeState([k], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const ult = k.skills!.find((s) => s.id === "blackknight5")!;
  assert.equal(ult.targeting, "self", "authored targeting is 'self'");
  assert.equal(effectiveTargeting(state, k, ult), "self", "the ultimate resolves to self-only for the UI");
});

test("While the ultimate is active, Oathbreaker Strike's effective targeting widens to 'all-enemies' — the seam the client reads to offer/telegraph the AoE (regression: client read the static 'single' and still offered one target)", () => {
  const k = bk("A", "b");
  const state = makeState([k], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  fund(state);
  const s1 = k.skills!.find((s) => s.id === "blackknight1")!;
  assert.equal(effectiveTargeting(state, k, s1), "single", "single-target before the ultimate");
  performAction(state, { unit: "b", skillId: "blackknight5" });
  assert.equal(effectiveTargeting(state, k, s1), "all-enemies", "the ultimate widens Oathbreaker to all enemies");
});

test("Nightmare control: without it, Oathbreaker (un-enhanced) hits one enemy for 15", () => {
  const k = bk("A", "b");
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "single target, 15");
  assert.equal(e2.hp, 100, "other enemy untouched");
});

// =====================================================================================
// blackknight0 — Exile (passive): "acts alone" -> enhanced + Elemental Essence
// =====================================================================================

test("Exile: when the Black Knight is the only ally to act, he gains Elemental Essence", () => {
  const k = bk("A", "b");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" }); // BK acts (alone)
  endTurn(state); // his turn-end evaluates "acts alone"
  assert.ok(find(k, "elemental_essence"), "acting alone grants Elemental Essence");
});

test("Exile control: when an ally also acts, the Black Knight does NOT act alone (no Essence, not enhanced)", () => {
  const k = bk("A", "b");
  const ally = bk("A", "a2");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" });
  performAction(state, { unit: "a2", skillId: "blackknight2" }); // an ally acts this turn
  endTurn(state);
  assert.equal(find(k, "elemental_essence"), undefined, "not alone -> no Essence");
  assert.equal(find(k, "mark", "Exile"), undefined, "not alone -> not enhanced");
});

test("Exile is action-based, not alive-based: an ally who does NOT act still leaves him acting alone", () => {
  const k = bk("A", "b");
  const ally = bk("A", "a2"); // alive, but takes no action
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" }); // only BK acts
  endTurn(state);
  assert.ok(find(k, "elemental_essence"), "an idle ally does not stop him from 'acting alone'");
});

test("Exile: after acting alone, his abilities are enhanced — next Oathbreaker deals 25 (piercing)", () => {
  const k = bk("A", "b");
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" }); // turn 1: acts alone
  endTurn(state); // A end -> enhanced state established; turn 2, B active
  endTurn(state); // B end; turn 3, A active
  startTurn(state); // A income + fresh ledger
  fund(state);
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e"] });
  assert.equal(e.hp, 75, "enhanced: 25 piercing (ignores the 10 DR)");
});
