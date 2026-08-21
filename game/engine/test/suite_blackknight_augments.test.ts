import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startTurn, endTurn } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import type { Unit, StatusKind } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Adversarial, spec-derived suite for The Black Knight's AUGMENTS.
// Oracle = the FROZEN prose (content/frozen/augments.json):
//   blackknight1 Obsidian Duelist:  "If the Black Knight defeats an enemy, his skills are enhanced
//                                     for the following two turns"
//   blackknight2 Ebonsteel Charger: "The turn after activating his passive, The Nightmare Rides
//                                     costs one less [8]."   ([8] = Unholy, TNR's specific element)
//   blackknight3 Devour Strength:   "Oathbreaker Strike deals 15 additional damage to the primary
//                                     target if Unholy Aura is affecting more than 3 targets"
//   blackknight4 Unholy Fortitude:  "If Dead or Alive successfully redirects an ability, the Black
//                                     Knight gains Elemental Essence"
//   blackknight5 Oathbreaker's Blade:"Oathbreaker Strike deals 10 damage to the target's allies
//                                     while enhanced."
//
// Base-kit facts the oracle leans on (content/frozen/skills.json):
//   blackknight0 Exile (passive):    acting alone -> abilities "enhanced" + Elemental Essence.
//   blackknight1 Oathbreaker Strike: 15 to 1 enemy; while enhanced 10 more + piercing. Cost {gen 1}.
//   blackknight3 Unholy Aura:        2 turns, all allies+enemies deal 5 less (all 6 units); while
//                                     enhanced enemies-only for 10 less.
//   blackknight4 Dead or Alive:      ignores new Harmful 1 turn; while enhanced redirects allies'
//                                     harmful onto himself. Cost {spec 1}.
//   blackknight5 The Nightmare Rides: 2 turns invulnerable; Oathbreaker hits all enemies + always
//                                     enhanced. Cost {gen 0, spec 2} (unholy).
// "Enhanced" is produced by the Exile passive as a self mark named "Exile" that every active skill
// reads; per the base suite we seed that mark directly to exercise the enhanced branch (a permitted
// "status the skill produces" drive detail). Element is Unholy, so Specific cost pays from "unholy".
// ---------------------------------------------------------------------------

function bk(team: "A" | "B", id: string): Unit {
  return loadHero(heroById("blackknight"), team, id);
}
function bkAug(team: "A" | "B", id: string, augIds: string[]): Unit {
  const u = bk(team, id);
  for (const a of augIds) applyAugment(u, augmentById(a)!);
  return u;
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
function seedAura(u: Unit): void {
  // Represents a unit "affected by Unholy Aura" — the named outgoing_damage_mod the skill applies.
  u.statuses.push(status("outgoing_damage_mod", { name: "Unholy Aura", magnitude: -5 }));
}

// =====================================================================================
// blackknight1 — Obsidian Duelist:
//   "If the Black Knight defeats an enemy, his skills are enhanced for the following two turns"
// =====================================================================================

test("Obsidian Duelist: defeating an enemy enhances his skills for the FOLLOWING TWO TURNS (Exile flag, dur 2)", () => {
  const k = bkAug("A", "b", ["blackknight1"]);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 10, maxHp: 100 }); // dies to Oathbreaker 15
  const state = makeState([k], [e1]);
  fund(state);

  // The killing blow itself is un-enhanced (no Exile mark yet at cast time).
  const r = performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(e1.alive, false, "the enemy was defeated");

  const mark = find(k, "mark", "Exile");
  assert.ok(mark, "defeating an enemy grants the 'enhanced' state (Exile flag)");
  assert.equal(mark!.duration, 2, "'for the following two turns' -> duration 2");
});

test("Obsidian Duelist: after the kill his abilities really read as enhanced — next Oathbreaker is 25 piercing", () => {
  const k = bkAug("A", "b", ["blackknight1"]);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 10, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const state = makeState([k], [e1, e2]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] }); // kill -> now enhanced
  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e2"] }); // enhanced strike
  assert.equal(e2.hp, 75, "enhanced: 25 damage and piercing (ignores the 10 DR; would be 15 un-enhanced)");
});

test("Obsidian Duelist control: NOT defeating an enemy grants no enhancement", () => {
  const k = bkAug("A", "b", ["blackknight1"]);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // survives the 15
  const state = makeState([k], [e1]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.alive, true, "enemy survived");
  assert.equal(find(k, "mark", "Exile"), undefined, "no kill -> no 'enhanced' flag (checked before any turn-end)");
});

test("Obsidian Duelist control: it must be HIS OWN kill — an ally's kill does not enhance the Black Knight", () => {
  const k = bkAug("A", "b", ["blackknight1"]);
  const ally = bk("A", "a2"); // ally with the same base kit, no augment
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 10, maxHp: 100 });
  const state = makeState([k, ally], [e1]);
  fund(state);

  performAction(state, { unit: "a2", skillId: "blackknight1", targets: ["e1"] }); // the ALLY lands the kill
  assert.equal(e1.alive, false, "the enemy was defeated (by the ally)");
  assert.equal(find(k, "mark", "Exile"), undefined, "'If the Black Knight defeats' — an ally's kill does not enhance HIM");
});

// =====================================================================================
// blackknight2 — Ebonsteel Charger:
//   "The turn after activating his passive, The Nightmare Rides costs one less [8]."
// Passive = Exile (activated by acting alone); the following turn the Exile flag is present. TNR base
// cost is {generic 0, specific 2} unholy -> discounted to one less unholy = {generic 0, specific 1}.
// =====================================================================================

test("Ebonsteel Charger: with the passive-flag up, The Nightmare Rides costs one less unholy (spends 1, not 2)", () => {
  const k = bkAug("A", "b", ["blackknight2"]);
  seedExile(k); // the Exile flag present "the turn after activating his passive"
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  startTurn(state); // the turnStart hook installs the TNR discount while the flag is up
  fund(state);      // 40 unholy after income reset, so the delta is unambiguous

  const r = performAction(state, { unit: "b", skillId: "blackknight5" });
  assert.equal(r.ok, true, "TNR cast");
  assert.equal(state.teams.A.energy.unholy, 39, "spent only 1 unholy (2 - 1 discount)");
});

test("Ebonsteel Charger: the discount lets TNR be cast on a 1-unholy budget that the base cost cannot afford", () => {
  const k = bkAug("A", "b", ["blackknight2"]);
  seedExile(k);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  startTurn(state);
  state.teams.A.energy = { generic: 0, unholy: 1 }; // exactly the discounted cost, one short of base 2

  const r = performAction(state, { unit: "b", skillId: "blackknight5" });
  assert.equal(r.ok, true, "discounted TNR (cost 1 unholy) is affordable on a 1-unholy budget");
  assert.equal(state.teams.A.energy.unholy, 0, "spent the single unholy");
});

test("Ebonsteel Charger control: WITHOUT the passive-flag, TNR costs the full 2 unholy (1 unholy is insufficient)", () => {
  const k = bkAug("A", "b", ["blackknight2"]);
  // no Exile flag -> the "turn after activating his passive" condition is not met
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  startTurn(state); // turnStart hook runs but its gate (Exile flag) is false -> no discount installed
  state.teams.A.energy = { generic: 0, unholy: 1 };

  const r = performAction(state, { unit: "b", skillId: "blackknight5" });
  assert.equal(r.ok, false, "no discount -> TNR still costs 2 unholy, unaffordable on 1");
  assert.equal(r.reason, "insufficient-energy");
});

test("Ebonsteel Charger end-to-end: acting alone one turn discounts TNR the NEXT turn", () => {
  const k = bkAug("A", "b", ["blackknight2"]);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight2" }); // turn 1: acts alone -> activates the passive
  endTurn(state); // A end: Exile passive fires; turn 2 B active
  endTurn(state); // B end; turn 3 A active
  startTurn(state); // A start: passive flag is up -> Ebonsteel installs the TNR discount
  fund(state);

  const r = performAction(state, { unit: "b", skillId: "blackknight5" });
  assert.equal(r.ok, true);
  assert.equal(state.teams.A.energy.unholy, 39, "the turn AFTER activating the passive, TNR spends only 1 unholy");
});

// =====================================================================================
// blackknight3 — Devour Strength:
//   "Oathbreaker Strike deals 15 additional damage to the primary target if Unholy Aura is
//    affecting more than 3 targets"
// "Affecting" = units currently carrying the Unholy Aura effect. We seed that effect directly onto a
// controlled count of units (never onto the Black Knight, so his own outgoing is not reduced) and read
// the clean strike total: base 15 (+15 when the count exceeds 3).
// =====================================================================================

test("Devour Strength: Unholy Aura affecting 4 (>3) targets adds 15 to the primary target's strike (30 total)", () => {
  const k = bkAug("A", "b", ["blackknight3"]);
  const a2 = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const a3 = makeUnit({ id: "a3", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // the primary target
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedAura(a2); seedAura(a3); seedAura(e2); seedAura(e3); // 4 units affected (not the BK, not e1)
  const state = makeState([k, a2, a3], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 70, "Oathbreaker 15 + Devour 15 = 30 (count 4 > 3)");
});

test("Devour Strength boundary: EXACTLY 3 affected is NOT 'more than 3' — no bonus (15 only)", () => {
  const k = bkAug("A", "b", ["blackknight3"]);
  const a2 = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const a3 = makeUnit({ id: "a3", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  seedAura(a2); seedAura(a3); seedAura(e2); // exactly 3 affected
  const state = makeState([k, a2, a3], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "count == 3 is not > 3, so NO +15 — just the base 15");
});

test("Devour Strength control: with Unholy Aura affecting nobody, Oathbreaker is the plain 15", () => {
  const k = bkAug("A", "b", ["blackknight3"]);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "no Unholy Aura in play -> no bonus");
});

// =====================================================================================
// blackknight4 — Unholy Fortitude:
//   "If Dead or Alive successfully redirects an ability, the Black Knight gains Elemental Essence"
// Enhanced Dead or Alive redirects an ally-aimed harmful skill onto the Black Knight (a real redirect,
// skillRedirected). That successful redirect grants him Elemental Essence.
// =====================================================================================

test("Unholy Fortitude: a successful redirect (enhanced Dead or Alive) grants the Black Knight Elemental Essence", () => {
  const k = bkAug("A", "b", ["blackknight4"]);
  seedExile(k); // enhanced -> Dead or Alive also redirects
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = bk("B", "e");
  const state = makeState([k, ally], [e]);
  fund(state);
  assert.equal(find(k, "elemental_essence"), undefined, "precondition: no Essence yet");

  performAction(state, { unit: "b", skillId: "blackknight4" }); // enhanced: ignore + standing redirect
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["a2"] }); // ally-aimed harmful -> redirected onto BK
  assert.equal(ally.hp, 100, "the ally's incoming harmful was pulled off him (redirect happened)");
  assert.ok(find(k, "elemental_essence"), "a successful redirect grants the Black Knight Elemental Essence");
});

test("Unholy Fortitude control: un-enhanced Dead or Alive does NOT redirect -> no Essence", () => {
  const k = bkAug("A", "b", ["blackknight4"]); // no Exile mark -> un-enhanced
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = bk("B", "e");
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight4" }); // ignore for self only, no redirect
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["a2"] }); // ally eats the hit
  assert.equal(ally.hp, 85, "no redirect -> the ally took the full 15");
  assert.equal(find(k, "elemental_essence"), undefined, "no successful redirect -> no Essence");
});

test("Unholy Fortitude control: enhanced but the enemy hits the Black Knight DIRECTLY — nothing to redirect, no Essence", () => {
  const k = bkAug("A", "b", ["blackknight4"]);
  seedExile(k);
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e = bk("B", "e");
  const state = makeState([k, ally], [e]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight4" }); // enhanced: mark + redirect + ignore
  performAction(state, { unit: "e", skillId: "blackknight1", targets: ["b"] }); // already aimed at BK -> no redirect fires
  assert.equal(find(k, "elemental_essence"), undefined, "holding the mark + being attacked is not enough — a REDIRECT must occur");
});

// =====================================================================================
// blackknight5 — Oathbreaker's Blade:
//   "Oathbreaker Strike deals 10 damage to the target's allies while enhanced."
// The target's allies = the enemies OTHER than the primary target. Only while enhanced.
// =====================================================================================

test("Oathbreaker's Blade: while enhanced, the strike splashes 10 to the target's allies (other enemies)", () => {
  const k = bkAug("A", "b", ["blackknight5"]);
  seedExile(k); // enhanced
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // primary
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 75, "primary takes the enhanced 25 (15 + 10), not the splash");
  assert.equal(e2.hp, 90, "the target's ally takes 10");
  assert.equal(e3.hp, 90, "the target's ally takes 10");
});

test("Oathbreaker's Blade: the 10 hits ENEMIES only (the caster's own allies are never splashed)", () => {
  const k = bkAug("A", "b", ["blackknight5"]);
  seedExile(k);
  const myAlly = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k, myAlly], [e1, e2]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e2.hp, 90, "the target's ally (an enemy) takes 10");
  assert.equal(myAlly.hp, 100, "'the target's allies' are the enemy's team — the Black Knight's own ally is untouched");
});

test("Oathbreaker's Blade: the splash is normal damage (reduced by DR), the oracle does not call it piercing", () => {
  const k = bkAug("A", "b", ["blackknight5"]);
  seedExile(k);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // primary
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [status("damage_reduction", { magnitude: 4 })] });
  const state = makeState([k], [e1, e2]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e2.hp, 94, "splash 10 - 4 DR = 6 (normal); a piercing splash would leave 90");
});

test("Oathbreaker's Blade control: UN-enhanced, there is no splash — only the primary is hit", () => {
  const k = bkAug("A", "b", ["blackknight5"]); // no Exile mark, no Nightmare -> not enhanced
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e3 = makeUnit({ id: "e3", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([k], [e1, e2, e3]);
  fund(state);

  performAction(state, { unit: "b", skillId: "blackknight1", targets: ["e1"] });
  assert.equal(e1.hp, 85, "un-enhanced single-target 15");
  assert.equal(e2.hp, 100, "no enhancement -> no splash");
  assert.equal(e3.hp, 100, "no enhancement -> no splash");
});
