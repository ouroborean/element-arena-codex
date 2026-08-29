import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, canUse } from "../src/scheduler.ts";
import { startRound } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates (via match import chain)
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------------------------- //
// Titania, Laughing Princess — BASE kit adversarial suite. The FROZEN prose is the oracle:
//   titania0 Whimsy        (passive) "Titania's skills do not trigger effects with their use or damage."
//   titania1 Thorn Prick   "Deals 10 damage to one enemy and 5 affliction damage permanently."
//   titania2 Laughing Powder "Target enemy has their strategic skills stunned for 2 turns and takes 5
//                            affliction damage per turn. Anyone who uses a new skill on that character is
//                            afflicted by Laughing Powder for 2 turns."
//   titania3 Barbed Wit    "Titania taunts target enemy for 3 turns. This effect will end if they use a
//                            new harmful skill on Titania"
//   titania4 Prance        "Titania gains Elemental Essence. For one turn, the first unit to use a new
//                            skill on Titania gains Elemental Essence."
//   titania5 Summer Clique "For each time Titania has gained or given Elemental Essence with Prance this
//                            game, she creates a Summer Courtesan minion. Stacks will reset on use."
// Element = poison, so a Specific cost is paid in poison.
// ---------------------------------------------------------------------------------------------- //

const mkTitania = (id = "t", team: "A" | "B" = "A"): Unit => loadHero(heroById("titania"), team, id);

const fund = (st: MatchState) => {
  st.teams.A.energy = { generic: 40, poison: 40 };
  st.teams.B.energy = { generic: 40, poison: 40, fire: 40 };
};

const minionCount = (st: MatchState, team: string): number =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive).length;

const hasKind = (u: Unit, kind: string, name?: string): boolean =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));

const stackMag = (u: Unit, name: string): number => {
  const s = u.statuses.find((x) => x.kind === "stack" && x.name === name);
  return s?.magnitude ?? 0;
};

const dmgSkill = (id: string, amount: number, cost = { generic: 0, specific: 0 }) =>
  skill(id, [{ op: "damage", amount, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single", cost, cooldown: 0 });

// =============================================================================================== //
// titania1 — Thorn Prick
// =============================================================================================== //

test("Thorn Prick: deals 10 immediate damage to the chosen enemy", () => {
  const t = mkTitania();
  const e = makeUnit({ id: "e", team: "B" });
  const other = makeUnit({ id: "e2", team: "B" });
  const st = makeState([t], [e, other]);
  fund(st);

  const r = performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(r.ok, true, "Thorn Prick resolves");
  assert.equal(e.hp, 90, "10 normal damage lands on the target (100 -> 90)");
  assert.equal(other.hp, 100, "the non-targeted enemy is untouched (single target)");
});

test("Thorn Prick: applies a permanent (non-expiring) affliction DoT named 'Thorn Prick'", () => {
  const t = mkTitania();
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [e]);
  fund(st);
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });

  const dot = e.statuses.find((s) => s.kind === "dot" && s.name === "Thorn Prick");
  assert.ok(dot, "a Thorn Prick DoT is applied");
  assert.equal(dot!.magnitude, 5, "the DoT ticks 5");
  assert.equal(dot!.dtype, "affliction", "the DoT is affliction damage");
  assert.equal(dot!.duration, null, "'permanently' = a non-expiring (null-duration) effect");
});

// FROZEN: "5 affliction damage permanently" applies on EACH cast, so repeated casts stack the DoT (5 -> 10 ->
// 15). Modeled on Maggie's Curse of Thorns: the dot grows +5 per later cast (magnitude never resets appliedTurn)
// and a parallel 'Thorn Prick' stack carries the count the web display renders.
test("Thorn Prick: repeated casts STACK the affliction DoT (+5 each) and carry a matching stack count", () => {
  const t = mkTitania();
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [e]);
  fund(st);
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  const dot = e.statuses.find((s) => s.kind === "dot" && s.name === "Thorn Prick");
  assert.equal(dot!.magnitude, 10, "two casts stack the affliction DoT to 10/turn (5 + 5)");
  const stk = e.statuses.find((s) => s.kind === "stack" && s.name === "Thorn Prick");
  assert.equal(stk?.magnitude, 2, "a parallel 'Thorn Prick' stack of 2 drives the display's x-count");
});

// FROZEN: "5 affliction damage permanently" — a permanent per-turn affliction. Faithfully, the DoT must
// keep dealing 5/turn. The engine's tickDots() skips null-duration DoTs, so this permanent tick never fires.
test("Thorn Prick: the permanent affliction DoT deals 5 per turn (null-duration DoTs tick)", () => {
  const t = mkTitania();
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [e]);
  fund(st);
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] }); // e: 100 -> 90 + permanent 5/turn DoT

  const before = e.hp; // 90
  endTurn(st); // A birth turn: no tick
  endTurn(st); // B turn
  endTurn(st); // A turn: tickDots(A) should deal the permanent 5
  assert.equal(before - e.hp, 5, "the permanent affliction deals 5 on Titania's next turn");
});

// =============================================================================================== //
// titania2 — Laughing Powder
// =============================================================================================== //

test("Laughing Powder: stuns the target's Strategic skills but leaves non-Strategic skills usable", () => {
  const t = mkTitania();
  const strat = skill("estrat", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Buffed", duration: null } }], { tags: ["Strategic", "Instant"], targeting: "self", cost: { generic: 0, specific: 0 }, cooldown: 0 });
  const harm = dmgSkill("eharm", 5);
  const e = makeUnit({ id: "e", team: "B", skills: [strat, harm] });
  const st = makeState([t], [e]);
  fund(st);

  assert.equal(canUse(st, e, e.skills![0]!), true, "control: the Strategic skill is usable before the powder");

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] });

  const stun = e.statuses.find((s) => s.kind === "stun");
  assert.ok(stun, "a stun is applied");
  assert.equal(stun!.duration, 2, "stunned for 2 turns");
  assert.deepEqual(stun!.scope, { tag: "Strategic", mode: "only" }, "the stun is scoped to Strategic skills only");

  assert.equal(canUse(st, e, e.skills![0]!), false, "the Strategic skill is now stunned");
  const rs = performAction(st, { unit: "e", skillId: "estrat", targets: [] });
  assert.equal(rs.ok, false, "casting the Strategic skill is rejected");
  assert.equal(rs.reason, "stunned", "...specifically because it is stunned");

  const rh = performAction(st, { unit: "e", skillId: "eharm", targets: ["t"] });
  assert.equal(rh.ok, true, "a non-Strategic (Harmful) skill is NOT stunned and still resolves");
});

test("Laughing Powder: the primary DoT is 5 affliction/turn — bypasses DR and Shield", () => {
  const t = mkTitania();
  const e = makeUnit({
    id: "e",
    team: "B",
    shield: 20,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }],
  });
  const st = makeState([t], [e]);
  fund(st);
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] });
  assert.equal(e.hp, 100, "Laughing Powder deals no immediate damage");

  const before = e.hp;
  const shieldBefore = e.shields.reduce((a, s) => a + s.amount, 0);
  endTurn(st); // A birth turn: no tick
  endTurn(st); // B turn
  endTurn(st); // A turn: DoT ticks
  assert.equal(before - e.hp, 5, "the affliction DoT deals exactly 5 to HP, ignoring the 10 DR");
  assert.equal(e.shields.reduce((a, s) => a + s.amount, 0), shieldBefore, "affliction ignores the Shield (Shield untouched)");
});

test("Laughing Powder spread: a THIRD unit that uses a skill on the powdered target is afflicted with Laughing Powder (2 turns); not the stun", () => {
  const t = mkTitania();
  const ally = makeUnit({ id: "a", team: "A", skills: [dmgSkill("ahit", 5)] });
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t, ally], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder e
  assert.equal(hasKind(ally, "dot", "Laughing Powder"), false, "control: the ally is clean before interacting");

  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] }); // ally uses a new skill ON the powdered e
  const spread = ally.statuses.find((s) => s.kind === "dot" && s.name === "Laughing Powder");
  assert.ok(spread, "the interacting unit is afflicted by Laughing Powder");
  assert.equal(spread!.magnitude, 5, "the spread DoT ticks 5");
  assert.equal(spread!.duration, 2, "the spread lasts 2 turns");
  assert.equal(hasKind(ally, "stun"), false, "only the affliction spreads — NOT the Strategic stun");
});

test("Laughing Powder spread (regression): an AoE that hits the powdered target at a NON-first slot still afflicts the actor (index-0 fix)", () => {
  const t = mkTitania();
  const ally = makeUnit({ id: "a", team: "A", skills: [skill("aoe", [{ op: "damage", amount: 5, dtype: "normal", to: { faction: "enemies" } }], { targeting: "all-enemies", tags: ["Harmful"] })] });
  const clean = makeUnit({ id: "e2", team: "B" });   // slot 0 — the FIRST declared target
  const powdered = makeUnit({ id: "e", team: "B" });  // slot 1 — powdered, but NOT eventTargets[0]
  const st = makeState([t, ally], [clean, powdered]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder the 2nd-slot enemy
  assert.ok(hasKind(powdered, "dot", "Laughing Powder"), "precondition: e is powdered");
  performAction(st, { unit: "a", skillId: "aoe" }); // ally AoE hits [e2, e] — the powdered e is second
  assert.ok(hasKind(ally, "dot", "Laughing Powder"),
    "the actor is afflicted even though the powdered target was 2nd in the AoE (was missed under the eventTargets[0] read)");
});

test("Laughing Powder spread: using a skill on a DIFFERENT (un-powdered) character does NOT afflict the actor", () => {
  const t = mkTitania();
  const ally = makeUnit({ id: "a", team: "A", skills: [dmgSkill("ahit", 5)] });
  const powdered = makeUnit({ id: "e", team: "B" });
  const clean = makeUnit({ id: "e2", team: "B" });
  const st = makeState([t, ally], [powdered, clean]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder e only
  performAction(st, { unit: "a", skillId: "ahit", targets: ["e2"] }); // ally hits the CLEAN enemy
  assert.equal(hasKind(ally, "dot", "Laughing Powder"), false, "no spread from interacting with a non-powdered unit");
});

// =============================================================================================== //
// titania3 — Barbed Wit
// =============================================================================================== //

test("Barbed Wit: taunts the target onto Titania for 3 turns; forces its single-target Harmful skill onto her", () => {
  const t = mkTitania();
  const ally = makeUnit({ id: "a", team: "A", hp: 100, maxHp: 100 });
  const e = makeUnit({ id: "e", team: "B", skills: [dmgSkill("ehit", 10)] });
  const st = makeState([t, ally], [e]);
  fund(st);

  // control: before the taunt, the enemy hits whom it chooses
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] });
  assert.equal(ally.hp, 90, "control: without a taunt the enemy strikes the chosen ally");
  assert.equal(t.hp, 100, "control: Titania untouched");

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  const taunt = e.statuses.find((s) => s.kind === "taunt");
  assert.ok(taunt, "a taunt is applied to the enemy");
  assert.equal(taunt!.duration, 3, "taunt lasts 3 turns");
  assert.equal(taunt!.unitRef, "t", "the enemy is forced to target Titania");

  // now the enemy's attack, though aimed at the ally, is redirected onto Titania
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] });
  assert.equal(t.hp, 90, "the taunted enemy's strike is redirected onto Titania (100 -> 90)");
  assert.equal(ally.hp, 90, "the ally the enemy chose is spared (still 90 from the control hit)");
});

test("Barbed Wit: the taunt ENDS after the taunted enemy uses a harmful skill on Titania", () => {
  const t = mkTitania();
  const ally = makeUnit({ id: "a", team: "A" });
  const e = makeUnit({ id: "e", team: "B", skills: [dmgSkill("ehit", 10)] });
  const st = makeState([t, ally], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  assert.ok(e.statuses.some((s) => s.kind === "taunt"), "taunt is on");

  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] }); // forced onto Titania (harmful skill on Titania)
  assert.equal(t.hp, 90, "the forced harmful strike hit Titania");
  assert.equal(e.statuses.some((s) => s.kind === "taunt"), false, "the taunt ends after the enemy's harmful skill on Titania");

  // and, with the taunt gone, the enemy is free to strike its own choice again
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] });
  assert.equal(ally.hp, 90, "post-taunt, the enemy strikes the chosen ally (100 -> 90)");
  assert.equal(t.hp, 90, "Titania takes no further damage once the taunt has ended");
});

test("Barbed Wit: a self-targeted (non-harmful-on-Titania) action does NOT end the taunt", () => {
  const t = mkTitania();
  const selfBuff = skill("ebuff", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Steeled", duration: null } }], { tags: ["Strategic", "Instant"], targeting: "self", cost: { generic: 0, specific: 0 }, cooldown: 0 });
  const e = makeUnit({ id: "e", team: "B", skills: [selfBuff] });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  performAction(st, { unit: "e", skillId: "ebuff", targets: [] }); // acts on itself, not on Titania
  assert.ok(e.statuses.some((s) => s.kind === "taunt"), "the taunt persists — the enemy did not use a harmful skill ON Titania");
});

// =============================================================================================== //
// titania4 — Prance
// =============================================================================================== //

test("Prance: Titania gains Elemental Essence", () => {
  const t = mkTitania();
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  fund(st);
  assert.equal(hasKind(t, "elemental_essence"), false, "control: no Essence before Prance");
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });
  assert.equal(hasKind(t, "elemental_essence"), true, "Titania holds an Elemental Essence charge after Prance");
});

test("Prance: the FIRST unit to use a new skill on Titania gains Elemental Essence; later units do not", () => {
  const t = mkTitania();
  const first = makeUnit({ id: "e1", team: "B", skills: [dmgSkill("h1", 5)] });
  const second = makeUnit({ id: "e2", team: "B", skills: [dmgSkill("h2", 5)] });
  const st = makeState([t], [first, second]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // arm Prance

  performAction(st, { unit: "e1", skillId: "h1", targets: ["t"] }); // first to act on Titania
  assert.equal(hasKind(first, "elemental_essence"), true, "the first unit to act on Titania gains Elemental Essence");

  performAction(st, { unit: "e2", skillId: "h2", targets: ["t"] }); // second to act on Titania
  assert.equal(hasKind(second, "elemental_essence"), false, "only the FIRST unit benefits — the second does not");
});

test("Prance (regression): an AoE that targets Titania at a NON-first slot still credits the actor (index-0 fix)", () => {
  const t = mkTitania();
  const al = makeUnit({ id: "al", team: "A" }); // slot 0 — precedes Titania in target order
  const e = makeUnit({ id: "e", team: "B", skills: [skill("aoe", [{ op: "damage", amount: 5, dtype: "normal", to: { faction: "enemies" } }], { targeting: "all-enemies", tags: ["Harmful"] })] });
  const st = makeState([al, t], [e]);
  fund(st);
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // arm Prance
  performAction(st, { unit: "e", skillId: "aoe" }); // AoE hits [al, t] — Titania is NOT eventTargets[0]
  assert.equal(hasKind(e, "elemental_essence"), true,
    "the actor is credited even though Titania was 2nd in the AoE (was missed under the eventTargets[0] read)");
});

test("Prance: acting on a unit OTHER than Titania grants no Essence, and does not consume the watch", () => {
  const t = mkTitania();
  const ally = makeUnit({ id: "a", team: "A" });
  const e = makeUnit({ id: "e", team: "B", skills: [dmgSkill("h", 5)] });
  const st = makeState([t, ally], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });
  performAction(st, { unit: "e", skillId: "h", targets: ["a"] }); // acts on the ally, not Titania
  assert.equal(hasKind(e, "elemental_essence"), false, "no Essence for acting on a non-Titania target");
});

test("Prance: with no Prance active, acting on Titania grants nothing", () => {
  const t = mkTitania();
  const e = makeUnit({ id: "e", team: "B", skills: [dmgSkill("h", 5)] });
  const st = makeState([t], [e]);
  fund(st);
  performAction(st, { unit: "e", skillId: "h", targets: ["t"] }); // no Prance in play
  assert.equal(hasKind(e, "elemental_essence"), false, "control: the grant requires an active Prance");
});

// =============================================================================================== //
// titania5 — Summer Clique
// =============================================================================================== //

test("Summer Clique: creates one Summer Courtesan per Prance GAIN, then resets the stacks", () => {
  const t = mkTitania();
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // gain #1
  t.skills!.find((s) => s.id === "titania4")!.currentCd = 0; // clear cd to Prance again (test harness)
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // gain #2
  assert.equal(stackMag(t, "Prance"), 2, "two Prance gains accumulate two stacks");

  assert.equal(minionCount(st, "A"), 0, "no minions before Summer Clique");
  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(minionCount(st, "A"), 2, "one Summer Courtesan per stack (2)");
  assert.ok(Object.values(st.units).some((u) => u.kind === "minion" && u.name === "Summer Courtesan"), "the minions are Summer Courtesans");
  assert.equal(stackMag(t, "Prance"), 0, "the Prance stacks reset on use");
});

test("Summer Clique: counts Essence GIVEN via Prance too (gain + give = 2 courtesans)", () => {
  const t = mkTitania();
  const e = makeUnit({ id: "e", team: "B", skills: [dmgSkill("h", 5)] });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // gain (#1)
  performAction(st, { unit: "e", skillId: "h", targets: ["t"] }); // first unit acts on Titania -> Essence GIVEN (#2)
  assert.equal(stackMag(t, "Prance"), 2, "one gain + one give = two stacks");

  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(minionCount(st, "A"), 2, "two courtesans from gain+give");
});

test("Summer Clique: with zero Prance stacks, no minions are created", () => {
  const t = mkTitania();
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  fund(st);
  const r = performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(r.ok, true, "the skill still resolves");
  assert.equal(minionCount(st, "A"), 0, "control: zero stacks -> zero courtesans");
});

// =============================================================================================== //
// titania0 — Whimsy (passive)
// =============================================================================================== //

test("Whimsy: Titania's skill USE and DAMAGE do not trigger an enemy's reactive effect (a non-stealthed ally's identical action does)", () => {
  const t = mkTitania();
  // A plain, non-stealthed ally attacker as the control actor.
  const ally = makeUnit({ id: "a", team: "A", skills: [dmgSkill("ahit", 10)] });
  // Enemy carries two reactive probes: one on being damaged, one on being the target of a skill.
  const e = makeUnit({
    id: "e",
    team: "B",
    triggers: [
      { on: "damageDealt", owner: "e", when: { sameUnit: ["eventTarget", "self"] }, effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "DmgReacted", duration: null } }], source: "probe" },
      { on: "skillUsed", owner: "e", when: { sameUnit: ["eventTargets", "self"] }, effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "UseReacted", duration: null } }], source: "probe" },
    ],
  });
  const st = makeState([t, ally], [e]);
  startRound(st); // realizes the passive: Titania becomes stealthed (does not trigger enemy effects)
  fund(st); // fund AFTER startRound — it wipes pools to an empty fresh-battle start

  // Titania acts on the enemy: her USE + DAMAGE must NOT set off the enemy's probes.
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.ok(e.hp < 100, "sanity: Titania's damage still lands");
  assert.equal(hasKind(e, "mark", "DmgReacted"), false, "Whimsy: Titania's DAMAGE triggers no enemy effect");
  assert.equal(hasKind(e, "mark", "UseReacted"), false, "Whimsy: Titania's skill USE triggers no enemy effect");

  // Control: a non-stealthed ally doing the same kind of thing DOES set off the probes.
  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] });
  assert.equal(hasKind(e, "mark", "DmgReacted"), true, "control: a normal attacker's damage DOES trigger the enemy effect");
  assert.equal(hasKind(e, "mark", "UseReacted"), true, "control: a normal attacker's skill use DOES trigger the enemy effect");
});

// =============================================================================================== //
// Costs, targeting & cooldowns (frozen skill metadata)
// =============================================================================================== //

test("Frozen costs are charged in the right currency (poison = specific)", () => {
  const t = mkTitania();
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);

  // Thorn Prick: 1 generic
  st.teams.A.energy = { generic: 5, poison: 5 };
  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(st.teams.A.energy.generic, 4, "Thorn Prick costs 1 generic");
  assert.equal(st.teams.A.energy.poison, 5, "...and no poison");

  // Laughing Powder: 1 specific (poison)
  st.teams.A.energy = { generic: 5, poison: 5 };
  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] });
  assert.equal(st.teams.A.energy.poison, 4, "Laughing Powder costs 1 poison (specific)");
  assert.equal(st.teams.A.energy.generic, 5, "...and no generic");
});

test("Insufficient energy is rejected", () => {
  const t = mkTitania();
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  st.teams.A.energy = {}; // empty
  const r = performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(r.ok, false, "cannot cast with no energy");
  assert.equal(r.reason, "insufficient-energy");
});

test("Frozen cooldowns are applied when each skill is used", () => {
  const t = mkTitania();
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  fund(st);
  const cd = (id: string) => t.skills!.find((s) => s.id === id)!.currentCd;

  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(cd("titania1"), 0, "Thorn Prick cooldown 0");

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] });
  assert.equal(cd("titania2"), 1, "Laughing Powder cooldown 1");

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  assert.equal(cd("titania3"), 3, "Barbed Wit cooldown 3");

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });
  assert.equal(cd("titania4"), 1, "Prance cooldown 1");

  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(cd("titania5"), 3, "Summer Clique cooldown 3");
});
