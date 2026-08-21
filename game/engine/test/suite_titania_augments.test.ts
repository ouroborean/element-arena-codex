import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startRound, effectiveCost } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// ---------------------------------------------------------------------------------------------- //
// Titania, Laughing Princess — AUGMENT adversarial suite. The FROZEN AUGMENT PROSE is the oracle:
//  titania1 In On The Joke     "Allies affected by Laughing Powder also gain the effects of Whimsy."
//  titania2 Bloody Humor       "Enemies under the effect of Barbed Wit now receive 15 Affliction damage
//                               when they use a Harmful skill on Titania, and Barbed Wit no longer ends
//                               when this occurs."
//  titania3 Elderwood Sap      "Thorn Prick no longer deals initial damage, but its affliction damage is
//                               doubled."
//  titania4 Persistent Suitor  "Titania starts each round with a Summer Courtesan, but her maximum is
//                               reduced to 1."
//  titania5 Jealousy           "If Prance is triggered by one of Titania's allies, the following turn, the
//                               other ally will have their basic abilities' Specific costs changed to Generic"
//
// Base-kit facts used only to DRIVE (from frozen skills + content): element = poison (Specific = poison);
//  titania1 Thorn Prick {generic:1, Harmful} 10 dmg + 5 affliction/turn permanent; titania2 Laughing Powder
//  {poison:1, Harmful} stun+DoT & spreads on interaction; titania3 Barbed Wit {generic:1, Harmful} 3-turn
//  taunt that ends on a harmful skill on Titania; titania4 Prance {generic:1, self} grants Elemental Essence,
//  arms a 1-turn watch (Prance Watch) — the first unit to use a new skill on Titania gains Essence;
//  titania5 Summer Clique {generic:1, self} makes one Summer Courtesan per Prance stack. Whimsy (passive) =
//  "Titania's skills do not trigger effects with their use or damage" (realized as Stealth).
// ---------------------------------------------------------------------------------------------- //

const mkTitania = (id = "t", team: "A" | "B" = "A"): Unit => loadHero(heroById("titania"), team, id);

function fund(st: MatchState): void {
  st.teams.A.energy = { generic: 40, poison: 40 };
  st.teams.B.energy = { generic: 40, poison: 40, fire: 40 };
}

const hasKind = (u: Unit, kind: string, name?: string): boolean =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));

const minionCount = (st: MatchState, team: string, name?: string): number =>
  Object.values(st.units).filter(
    (u) => u.kind === "minion" && u.team === team && u.alive && (name === undefined || u.name === name),
  ).length;

const dot = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "dot" && s.name === name);

const findSkill = (u: Unit, id: string): SkillInstance => u.skills!.find((s) => s.id === id)!;

// A generic single-target Harmful probe skill (cost 0 by default).
const harm = (id: string, dmg: number, over: Partial<SkillInstance> = {}) =>
  skill(id, [{ op: "damage", amount: dmg, dtype: "normal", to: "target" }], {
    tags: ["Harmful", "Instant"],
    targeting: "single",
    cost: { generic: 0, specific: 0 },
    cooldown: 0,
    klass: "basic",
    ...over,
  });

// A single-target Helpful skill that marks its target (used by an ally to "use a new skill on Titania").
const helpfulMark = (id: string, mark: string) =>
  skill(id, [{ op: "applyStatus", to: "target", status: { kind: "mark", name: mark, duration: null } }], {
    tags: ["Helpful", "Instant"],
    targeting: "single",
    cost: { generic: 0, specific: 0 },
    cooldown: 0,
    klass: "basic",
  });

// =============================================================================================== //
// titania1 — In On The Joke: "Allies affected by Laughing Powder also gain the effects of Whimsy."
//   Whimsy = "Titania's skills do not trigger effects with their use or damage" (Stealth). So an ally
//   afflicted with Laughing Powder must gain that Stealth-effect; a non-afflicted ally must not; and the
//   qualifier is ALLIES only (an enemy afflicted by Laughing Powder must NOT gain it).
// =============================================================================================== //

test("In On The Joke: an ally afflicted with Laughing Powder gains the effects of Whimsy (Stealth)", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania1")!);
  const ally = makeUnit({ id: "a", team: "A", skills: [harm("ahit", 5)] });
  const powdered = makeUnit({ id: "e", team: "B" });
  const st = makeState([t, ally], [powdered]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // Laughing Powder on the enemy
  assert.equal(hasKind(ally, "dot", "Laughing Powder"), false, "control: the ally is clean before interacting");
  assert.equal(hasKind(ally, "stealth"), false, "control: no Whimsy on a clean ally");

  // The ally uses a new skill ON the powdered enemy -> base kit afflicts the ally with Laughing Powder.
  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] });
  assert.ok(hasKind(ally, "dot", "Laughing Powder"), "sanity: the ally is now afflicted with Laughing Powder");
  assert.ok(hasKind(ally, "stealth"), "In On The Joke: the afflicted ally also gains the effects of Whimsy (Stealth)");
});

test("In On The Joke (behavioral): the Whimsy-blessed ally's skill USE + DAMAGE trigger no enemy reactive effect", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania1")!);
  const ally = makeUnit({ id: "a", team: "A", skills: [harm("ahit", 10)] });
  const clean = makeUnit({ id: "a2", team: "A", skills: [harm("chit", 10)] });
  const powdered = makeUnit({ id: "e", team: "B" });
  // A probe enemy that reacts both to being damaged and to being the target of a skill.
  const probe = makeUnit({
    id: "p",
    team: "B",
    triggers: [
      { on: "damageDealt", owner: "p", when: { sameUnit: ["eventTarget", "self"] }, effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "DmgReacted", duration: null } }], source: "probe" },
      { on: "skillUsed", owner: "p", when: { sameUnit: ["eventTargets", "self"] }, effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "UseReacted", duration: null } }], source: "probe" },
    ],
  });
  const st = makeState([t, ally, clean], [powdered, probe]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder e
  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] }); // ally becomes Whimsy-blessed
  assert.ok(hasKind(ally, "stealth"), "sanity: ally holds the Whimsy Stealth effect");

  // The blessed ally strikes the probe: neither its USE nor its DAMAGE may set off the probe.
  performAction(st, { unit: "a", skillId: "ahit", targets: ["p"] });
  assert.ok(probe.hp < 100, "sanity: the ally's damage still lands");
  assert.equal(hasKind(probe, "mark", "DmgReacted"), false, "Whimsy: the blessed ally's DAMAGE triggers no enemy effect");
  assert.equal(hasKind(probe, "mark", "UseReacted"), false, "Whimsy: the blessed ally's USE triggers no enemy effect");

  // Control: a clean (non-blessed) ally doing the same DOES set off both probes.
  performAction(st, { unit: "a2", skillId: "chit", targets: ["p"] });
  assert.equal(hasKind(probe, "mark", "DmgReacted"), true, "control: a normal ally's damage DOES trigger the enemy effect");
  assert.equal(hasKind(probe, "mark", "UseReacted"), true, "control: a normal ally's use DOES trigger the enemy effect");
});

test("In On The Joke: an ENEMY afflicted with Laughing Powder does NOT gain Whimsy (allies only)", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania1")!);
  const enemy = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [enemy]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania2", targets: ["e"] }); // powder the enemy directly
  assert.ok(hasKind(enemy, "dot", "Laughing Powder"), "sanity: the enemy carries Laughing Powder");
  assert.equal(hasKind(enemy, "stealth"), false, "the Whimsy grant is for ALLIES only — the enemy gets no Stealth");
});

// =============================================================================================== //
// titania2 — Bloody Humor: "Enemies under the effect of Barbed Wit now receive 15 Affliction damage when
//   they use a Harmful skill on Titania, and Barbed Wit no longer ends when this occurs."
// =============================================================================================== //

test("Bloody Humor: a Barbed-Wit enemy using a Harmful skill on Titania takes 15 Affliction damage", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania2")!);
  // Enemy carries a shield + DR to prove the 15 is Affliction (ignores both, exactly 15 to HP).
  const e = makeUnit({
    id: "e",
    team: "B",
    shield: 30,
    statuses: [{ kind: "damage_reduction", magnitude: 10, duration: null, appliedBy: "x", appliedTurn: 0 }],
    skills: [harm("ehit", 10)],
  });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] }); // Barbed Wit taunt onto Titania
  assert.ok(hasKind(e, "taunt"), "sanity: the enemy is under Barbed Wit");
  const hpBefore = e.hp; // 100
  const shieldBefore = e.shields.reduce((a, s) => a + s.amount, 0);

  performAction(st, { unit: "e", skillId: "ehit", targets: ["e"] }); // taunt forces the Harmful skill onto Titania
  assert.equal(hpBefore - e.hp, 15, "the enemy takes exactly 15 Affliction damage (bypasses its DR)");
  assert.equal(e.shields.reduce((a, s) => a + s.amount, 0), shieldBefore, "Affliction ignores the enemy's Shield");
});

test("Bloody Humor: Barbed Wit no longer ends when the enemy uses a Harmful skill on Titania", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania2")!);
  const ally = makeUnit({ id: "a", team: "A" });
  const e = makeUnit({ id: "e", team: "B", skills: [harm("ehit", 10)] });
  const st = makeState([t, ally], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] }); // forced onto Titania (harmful on Titania)
  assert.equal(t.hp, 90, "sanity: the forced harmful strike hit Titania");
  assert.ok(hasKind(e, "taunt"), "Bloody Humor: Barbed Wit PERSISTS (unlike the base kit, it does not end here)");

  // Still taunted: a second forced strike lands another 15 Affliction and Titania again.
  const hpBefore = e.hp;
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] });
  assert.equal(t.hp, 80, "the still-taunted enemy is forced onto Titania again");
  assert.equal(hpBefore - e.hp, 15, "and takes another 15 Affliction on the repeat");
});

test("Bloody Humor: an enemy NOT under Barbed Wit takes no 15 Affliction for hitting Titania", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania2")!);
  const e = makeUnit({ id: "e", team: "B", skills: [harm("ehit", 10)] });
  const st = makeState([t], [e]);
  fund(st);

  const hpBefore = e.hp;
  performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] }); // no Barbed Wit in play
  assert.equal(t.hp, 90, "the harmful skill hits Titania");
  assert.equal(e.hp, hpBefore, "control: without Barbed Wit, no 15 Affliction rebounds onto the attacker");
});

test("Bloody Humor: a Barbed-Wit enemy acting on ITSELF (not on Titania) takes no 15 and keeps the taunt", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania2")!);
  const selfBuff = skill("ebuff", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Steeled", duration: null } }], {
    tags: ["Strategic", "Instant"], targeting: "self", cost: { generic: 0, specific: 0 }, cooldown: 0,
  });
  const e = makeUnit({ id: "e", team: "B", skills: [selfBuff] });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania3", targets: ["e"] });
  const hpBefore = e.hp;
  performAction(st, { unit: "e", skillId: "ebuff", targets: [] }); // acts on itself, not on Titania
  assert.equal(e.hp, hpBefore, "no 15 Affliction — the enemy did not use a skill ON Titania");
  assert.ok(hasKind(e, "taunt"), "and the taunt still stands");
});

// =============================================================================================== //
// titania3 — Elderwood Sap: "Thorn Prick no longer deals initial damage, but its affliction damage is
//   doubled." (base = 10 initial + 5 affliction/turn; augmented = 0 initial + 10 affliction/turn.)
// =============================================================================================== //

test("Elderwood Sap: Thorn Prick deals NO initial damage but applies a DOUBLED (10) affliction DoT", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania3")!);
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(e.hp, 100, "Thorn Prick no longer deals its initial 10 damage");
  const d = dot(e, "Thorn Prick");
  assert.ok(d, "a Thorn Prick affliction DoT is still applied");
  assert.equal(d!.magnitude, 10, "the affliction is DOUBLED (5 -> 10)");
  assert.equal(d!.dtype, "affliction", "it is affliction damage");
  assert.equal(d!.duration, null, "still a permanent (non-expiring) DoT");
});

test("Elderwood Sap: control — WITHOUT the augment, Thorn Prick is 10 initial + 5 affliction", () => {
  const t = mkTitania(); // no augment
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] });
  assert.equal(e.hp, 90, "control: base Thorn Prick deals its 10 initial damage");
  assert.equal(dot(e, "Thorn Prick")!.magnitude, 5, "control: base affliction is 5 (undoubled)");
});

test("Elderwood Sap (behavioral): the doubled affliction ticks 10 per turn", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania3")!);
  const e = makeUnit({ id: "e", team: "B" });
  const st = makeState([t], [e]);
  fund(st);

  performAction(st, { unit: "t", skillId: "titania1", targets: ["e"] }); // 0 initial, permanent 10/turn
  const before = e.hp; // 100
  endTurn(st); // A birth turn: no tick
  endTurn(st); // B turn
  endTurn(st); // A turn: the applier's DoT ticks
  assert.equal(before - e.hp, 10, "the doubled Thorn Prick affliction deals 10 on Titania's next turn");
});

// =============================================================================================== //
// titania4 — Persistent Suitor: "Titania starts each round with a Summer Courtesan, but her maximum is
//   reduced to 1."
// =============================================================================================== //

test("Persistent Suitor: Titania starts each round with exactly one Summer Courtesan", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania4")!);
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  fund(st);
  assert.equal(minionCount(st, "A"), 0, "control: no minion before the round starts");

  startRound(st); // fires round-start passives
  assert.equal(minionCount(st, "A", "Summer Courtesan"), 1, "exactly one Summer Courtesan at round start");
  assert.equal(minionCount(st, "A"), 1, "...and no more than one minion in total");
});

test("Persistent Suitor: her maximum is 1 — Summer Clique never pushes past one Courtesan", () => {
  const t = mkTitania();
  applyAugment(t, augmentById("titania4")!);
  const st = makeState([t], [makeUnit({ id: "e", team: "B" })]);
  fund(st);

  // Two Prance gains -> two stacks (base kit would summon TWO courtesans from Summer Clique).
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });
  findSkill(t, "titania4").currentCd = 0;
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });

  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] }); // from 0 courtesans, 2 stacks
  assert.equal(minionCount(st, "A", "Summer Courtesan"), 1, "the cap holds: only ONE Courtesan is made, not two");

  // Cast again while already at the cap of 1 -> still no new Courtesan.
  findSkill(t, "titania5").currentCd = 0;
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // fresh stack
  performAction(st, { unit: "t", skillId: "titania5", targets: ["t"] });
  assert.equal(minionCount(st, "A", "Summer Courtesan"), 1, "still capped at one Courtesan");
});

// =============================================================================================== //
// titania5 — Jealousy: "If Prance is triggered by one of Titania's allies, the following turn, the other
//   ally will have their basic abilities' Specific costs changed to Generic"
// =============================================================================================== //

// Team A: Titania + two allies. a1 will TRIGGER Prance (uses a skill on Titania); a2 is "the other ally".
function jealousyState(): { st: MatchState; t: Unit; a1: Unit; a2: Unit; e: Unit } {
  const t = mkTitania();
  applyAugment(t, augmentById("titania5")!);
  const a1 = makeUnit({
    id: "a1",
    team: "A",
    skills: [helpfulMark("a1touch", "Touched"), harm("a1basic", 5, { cost: { generic: 0, specific: 1 }, klass: "basic" })],
  });
  const a2 = makeUnit({
    id: "a2",
    team: "A",
    skills: [
      harm("a2basic", 5, { cost: { generic: 0, specific: 1 }, klass: "basic" }),
      skill("a2ult", [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "X", duration: null } }], {
        tags: ["Strategic", "Instant"], targeting: "self", cost: { generic: 0, specific: 1 }, klass: "ultimate", cooldown: 0,
      }),
    ],
  });
  const e = makeUnit({ id: "e", team: "B", skills: [harm("ehit", 5)] });
  const st = makeState([t, a1, a2], [e]);
  fund(st);
  return { st, t, a1, a2, e };
}

test("Jealousy: when an ally triggers Prance, the OTHER ally's basic Specific costs become Generic next turn", () => {
  const { st, t, a1, a2 } = jealousyState();

  // Pre-check the untouched costs.
  assert.deepEqual(effectiveCost(a2, findSkill(a2, "a2basic"), st), { generic: 0, specific: 1 }, "control: a2's basic starts as 1 Specific");

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // arm Prance
  performAction(st, { unit: "a1", skillId: "a1touch", targets: ["t"] }); // ally a1 triggers Prance on Titania
  assert.ok(hasKind(a1, "elemental_essence"), "sanity: a1 triggered Prance (gained Elemental Essence)");

  // Advance to the FOLLOWING turn (A -> B -> back to A) and read the other ally's cost there.
  endTurn(st); // end A
  endTurn(st); // end B — now it's team A's following turn
  const c = effectiveCost(a2, findSkill(a2, "a2basic"), st);
  assert.deepEqual(c, { generic: 1, specific: 0 }, "the other ally's basic Specific cost is now payable as Generic");
});

test("Jealousy: only BASIC abilities are remapped — a non-basic Specific skill is untouched", () => {
  const { st, t, a1, a2 } = jealousyState();
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });
  performAction(st, { unit: "a1", skillId: "a1touch", targets: ["t"] });
  endTurn(st);
  endTurn(st);

  assert.deepEqual(effectiveCost(a2, findSkill(a2, "a2basic"), st), { generic: 1, specific: 0 }, "the basic skill is remapped");
  assert.deepEqual(effectiveCost(a2, findSkill(a2, "a2ult"), st), { generic: 0, specific: 1 }, "the non-basic (ultimate) Specific cost is untouched");
});

test("Jealousy: the TRIGGERING ally is not affected, and Titania herself is not affected", () => {
  const { st, t, a1, a2 } = jealousyState();
  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] });
  performAction(st, { unit: "a1", skillId: "a1touch", targets: ["t"] });
  endTurn(st);
  endTurn(st);

  // a2 (the OTHER ally) IS remapped — sanity that the effect fired at all.
  assert.deepEqual(effectiveCost(a2, findSkill(a2, "a2basic"), st), { generic: 1, specific: 0 }, "sanity: the other ally was remapped");
  // a1 is the one who triggered Prance — "the other ally" excludes it.
  assert.deepEqual(effectiveCost(a1, findSkill(a1, "a1basic"), st), { generic: 0, specific: 1 }, "the triggering ally keeps its Specific cost");
  // Titania's own basic (Laughing Powder = 1 poison Specific) is unaffected.
  assert.deepEqual(effectiveCost(t, findSkill(t, "titania2"), st), { generic: 0, specific: 1 }, "Titania's own Specific cost is unaffected");
});

test("Jealousy: an ENEMY triggering Prance does not remap any ally's costs (allies only)", () => {
  const { st, a2, e } = jealousyState();
  const t = st.units["t"]!;

  performAction(st, { unit: "t", skillId: "titania4", targets: ["t"] }); // arm Prance
  performAction(st, { unit: "e", skillId: "ehit", targets: ["t"] }); // an ENEMY triggers Prance on Titania
  assert.ok(hasKind(e, "elemental_essence"), "sanity: the enemy triggered Prance");
  endTurn(st);
  endTurn(st);

  assert.deepEqual(effectiveCost(a2, findSkill(a2, "a2basic"), st), { generic: 0, specific: 1 }, "no ally remap when a non-ally triggers Prance");
});
