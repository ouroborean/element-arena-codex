import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn, startRound } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// Adversarial, spec-derived FUSION-FORM suite for TARYN. The FROZEN PROSE
// (content/frozen/skills.json) is the oracle for every assertion; authored content
// (fusions.authored.json) is read only to learn how to DRIVE (element keys, skill ids,
// costs, targeting, status/mark names). Taryn has 10 fusion forms; each installs a
// passive + one active skill (inserted at slot 3, keeping the base kit taryn1..taryn5).
//
// Global drive facts: applyFusion re-elements Taryn to the form element and REPLACES the
// base passive triggers (Protector of the Song + Banner-of-Harmony reflect) with the fusion
// passive's. Costs' Specific channel is paid in the form element (currentElement). We fund
// both teams across every element. Frozen text per form is quoted inline above each section.
// ===========================================================================

const ELEMENTS = [
  "generic", "holy", "angel", "anointment", "antidote", "divine", "judgment",
  "prism", "sanctuary", "vengeance", "vigilante", "zealot", "fire",
];
function fund(st: MatchState): void {
  const pool: Record<string, number> = {};
  for (const e of ELEMENTS) pool[e] = 40;
  st.teams.A.energy = { ...pool };
  st.teams.B.energy = { ...pool };
}

function fuseTaryn(form: string): Unit {
  const t = loadHero(heroById("taryn"), "A", "taryn");
  applyFusion(t, fusionForm("taryn", form)!);
  return t;
}

function ally(id: string, extra: Partial<Unit> & { shield?: number } = {}): Unit {
  return makeUnit({ id, team: "A", kind: "hero", hp: 100, maxHp: 100, ...extra });
}
function enemy(id: string, extra: Partial<Unit> & { shield?: number } = {}): Unit {
  return makeUnit({ id, team: "B", kind: "hero", hp: 100, maxHp: 100, ...extra });
}

// ---- status readers ----
const has = (u: Unit, kind: string): boolean => u.statuses.some((s) => s.kind === kind);
const statusOf = (u: Unit, kind: string) => u.statuses.find((s) => s.kind === kind);
const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);
const markDur = (u: Unit, name: string): number | null | undefined =>
  u.statuses.find((s) => s.kind === "mark" && s.name === name)?.duration;
const drTotal = (u: Unit): number =>
  u.statuses.filter((s) => s.kind === "damage_reduction").reduce((n, s) => n + (s.magnitude ?? 0), 0);
const omod = (u: Unit): number =>
  u.statuses.filter((s) => s.kind === "outgoing_damage_mod").reduce((n, s) => n + (s.magnitude ?? 0), 0);
const shieldTotal = (u: Unit): number => (u.shields ?? []).reduce((n, s) => n + s.amount, 0);
const essence = (u: Unit): boolean => u.statuses.some((s) => s.kind === "elemental_essence");

// Synthetic drive skills (no coupling to any other hero's kit).
const harm = (id: string, amt = 20) =>
  skill(id, [{ op: "damage", amount: amt, to: "target", id: `${id}.d` }], {
    tags: ["Harmful"], element: "fire", targeting: "single", cost: { generic: 0, specific: 0 },
  });
const help = (id: string) =>
  skill(id, [{ op: "heal", amount: 1, to: "target", id: `${id}.h` }], {
    tags: ["Helpful"], element: "fire", targeting: "single", cost: { generic: 0, specific: 0 },
  });
const noop = (id: string) =>
  skill(id, [{ op: "heal", amount: 0, to: "self", id: `${id}.n` }], {
    tags: ["Strategic"], element: "fire", targeting: "self", cost: { generic: 0, specific: 0 },
  });

// Push an enemy-applied status directly (appliedBy = an enemy unit id).
const enemyStatus = (name: string, by: string, over = {}) =>
  status("mark", { name, appliedBy: by, duration: null, ...over });

// ===========================================================================
// ANGEL — Skyward Shield (passive) + Hand of Michael (tarynangel1)
//   Skyward Shield: "Stalwart Shield now makes Taryn and any targeted allies
//     Invulnerable for 1 turn, and gives Taryn Elemental Essence."
//   Hand of Michael: "The following turn, target enemy will receive 30 Damage. If the
//     enemy uses a harmful skill during this time it will be Countered, and Hand of
//     Michael will deal an additional 15 damage."
// ===========================================================================

test("Skyward Shield: Stalwart Shield makes Taryn + its targeted ally Invulnerable 1 turn and gives Taryn Essence", () => {
  const t = fuseTaryn("angel");
  const a1 = ally("a1");
  const a2 = ally("a2");
  const state = makeState([t, a1, a2], [enemy("e")]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a1"] }); // Stalwart Shield -> ally a1

  const inv = (u: Unit) => u.statuses.find((s) => s.kind === "invulnerable");
  assert.equal(inv(t)?.duration, 1, "Taryn is Invulnerable for 1 turn");
  assert.equal(inv(a1)?.duration, 1, "the targeted ally is Invulnerable for 1 turn");
  assert.equal(essence(t), true, "Taryn gains Elemental Essence");
  assert.equal(has(a2, "invulnerable"), false, "an UN-targeted ally is NOT made Invulnerable (control)");
});

test("Skyward Shield: the Invulnerability actually blocks a new Harmful skill aimed at the protected ally", () => {
  const t = fuseTaryn("angel");
  const a1 = ally("a1");
  const a2 = ally("a2"); // never protected — the control target
  const e = enemy("e", { skills: [harm("ehit", 25)] });
  const state = makeState([t, a1, a2], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a1"] });

  const blocked = performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] });
  assert.equal(blocked.ok, false, "a Harmful skill cannot target the Invulnerable ally");
  assert.equal(blocked.reason, "no-legal-target");
  assert.equal(a1.hp, 100, "the Invulnerable ally took no damage");

  const landed = performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(landed.ok, true, "the un-protected ally is still a legal target (control)");
  assert.equal(a2.hp, 75, "the un-protected ally took the 25");
});

test("Skyward Shield control: without casting Stalwart Shield, Taryn is NOT Invulnerable and gains no Essence", () => {
  const t = fuseTaryn("angel");
  const state = makeState([t, ally("a1")], [enemy("e")]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // Inspiring Thrust, not Stalwart Shield
  assert.equal(has(t, "invulnerable"), false, "a non-Stalwart-Shield cast grants no Invulnerability");
});

test("Hand of Michael: target enemy receives 30 Damage the following turn (guaranteed delayed strike)", () => {
  const t = fuseTaryn("angel");
  const e = enemy("e");
  const state = makeState([t], [e]);
  state.activeTeam = "A"; state.turn = 1;
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynangel1", targets: ["e"] });
  assert.equal(e.hp, 100, "no immediate damage on cast");

  endTurn(state); // A end (turn 1) — scheduled not yet due
  endTurn(state); // B end
  assert.equal(e.hp, 100, "still no damage before Taryn's following turn resolves");
  endTurn(state); // A end again — the following turn: the 30 lands
  assert.equal(e.hp, 70, "the enemy received exactly 30 Damage the following turn");
});

test("Hand of Michael: an enemy Harmful skill during the window is Countered and deals it an additional 15", () => {
  const t = fuseTaryn("angel");
  const e = enemy("e", { skills: [harm("ehit", 40)] }); // would deal 40 to Taryn if it landed
  const state = makeState([t], [e]);
  state.activeTeam = "A"; state.turn = 1;
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynangel1", targets: ["e"] });
  endTurn(state); // hand over to B — the counter window is open on Taryn

  const res = performAction(state, { unit: "e", skillId: "ehit", targets: ["taryn"] });
  assert.equal(res.countered, true, "the enemy's Harmful skill was Countered");
  assert.equal(t.hp, 100, "the Countered skill dealt Taryn no damage");
  assert.equal(e.hp, 85, "Hand of Michael dealt the enemy an additional 15 (100 -> 85)");
});

// ===========================================================================
// ANOINTMENT — Flow of Inspiration (passive) + Font of Glory (tarynanointment1)
//   Flow of Inspiration: "Inspiring Thrust now lasts for 2 turns, and also heals allies
//     who activate its effect for 10 Health."
//   Font of Glory: "Taryn grants target ally Elemental Essence."
// ===========================================================================

test("Flow of Inspiration: Inspiring Thrust's mark now lasts 2 turns (base is 1)", () => {
  const t = fuseTaryn("anointment");
  const e = enemy("e");
  const state = makeState([t], [e]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(markDur(e, "Inspiring Thrust"), 2, "the Inspiring Thrust mark now lasts 2 turns");
});

test("Flow of Inspiration: an ally who activates the effect (new Harmful on the marked target) heals 10 + gains Essence", () => {
  const t = fuseTaryn("anointment");
  const a1 = ally("a1", { hp: 80, skills: [harm("ahit", 10)] });
  const marked = enemy("e");
  const unmarked = enemy("e2");
  const state = makeState([t, a1], [marked, unmarked]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // marks `marked`
  performAction(state, { unit: "a1", skillId: "ahit", targets: ["e"] }); // ally activates on the marked target
  assert.equal(essence(a1), true, "the activating ally gains Elemental Essence");
  assert.equal(a1.hp, 90, "the activating ally heals 10 (80 -> 90)");

  a1.statuses = a1.statuses.filter((s) => s.kind !== "elemental_essence");
  a1.hp = 80;
  performAction(state, { unit: "a1", skillId: "ahit", targets: ["e2"] }); // control: hits an UNMARKED enemy
  assert.equal(essence(a1), false, "no Essence when the struck target is not Inspiring-Thrust-marked");
  assert.equal(a1.hp, 80, "no heal when the struck target is not Inspiring-Thrust-marked");
});

test("Font of Glory: Taryn grants a target ally Elemental Essence", () => {
  const t = fuseTaryn("anointment");
  const a1 = ally("a1");
  const a2 = ally("a2");
  const state = makeState([t, a1, a2], [enemy("e")]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "tarynanointment1", targets: ["a1"] });
  assert.equal(essence(a1), true, "the targeted ally has Elemental Essence");
  assert.equal(essence(a2), false, "an un-targeted ally gains nothing (control)");
});

// ===========================================================================
// ANTIDOTE — Purifying Shield (passive) + That Which Ails Me (tarynantidote1)
//   Purifying Shield: "When Stalwart Shield ends, Taryn and any affected allies are healed
//     5 health for each enemy effect affecting them."
//   That Which Ails Me: "Deals 25 Piercing damage to target enemy and cleanses them of one
//     beneficial effect."
// ===========================================================================

test("Purifying Shield: when Taryn's Stalwart-Shield Shield breaks, he heals 5 per enemy effect on him", () => {
  const t = fuseTaryn("antidote");
  const e = enemy("e", { skills: [harm("ehit", 25)] });
  const state = makeState([t], [e]);
  fund(state);
  t.hp = 50;
  t.shields = [{ amount: 20, duration: null, appliedBy: "taryn", appliedTurn: 0 }]; // the Stalwart Shield pool
  t.statuses.push(enemyStatus("Hex A", "e"), enemyStatus("Hex B", "e")); // 2 enemy-applied effects

  performAction(state, { unit: "e", skillId: "ehit", targets: ["taryn"] }); // 25 breaks the 20 Shield (5 to HP)
  // 50 - 5 overflow = 45, then +5*2 = +10 heal -> 55.
  assert.equal(shieldTotal(t), 0, "the Shield is gone (broken)");
  assert.equal(t.hp, 55, "healed 5 per enemy effect (2 effects -> +10) after the 5 overflow");
});

test("Purifying Shield control: with NO enemy effects on Taryn, the Shield break heals nothing", () => {
  const t = fuseTaryn("antidote");
  const e = enemy("e", { skills: [harm("ehit", 25)] });
  const state = makeState([t], [e]);
  fund(state);
  t.hp = 50;
  t.shields = [{ amount: 20, duration: null, appliedBy: "taryn", appliedTurn: 0 }];
  performAction(state, { unit: "e", skillId: "ehit", targets: ["taryn"] });
  assert.equal(t.hp, 45, "only the 5 overflow was taken; zero enemy effects -> zero heal");
});

test("That Which Ails Me: 25 Piercing (ignores DR) and cleanses ONE beneficial effect; a harmful status survives", () => {
  const t = fuseTaryn("antidote");
  const e = enemy("e");
  e.statuses.push(status("damage_reduction", { magnitude: 10 })); // beneficial
  e.statuses.push(status("stun", { duration: 3 })); // NOT beneficial — must survive the cleanse
  const state = makeState([t], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynantidote1", targets: ["e"] });
  assert.equal(e.hp, 75, "25 Piercing ignored the 10 DR (100 -> 75)");
  assert.equal(has(e, "damage_reduction"), false, "the beneficial DR was cleansed");
  assert.equal(has(e, "stun"), true, "a non-beneficial status was NOT cleansed (control)");
});

test("That Which Ails Me: cleanses exactly ONE beneficial effect (a second beneficial one remains)", () => {
  const t = fuseTaryn("antidote");
  const e = enemy("e");
  e.statuses.push(status("damage_reduction", { magnitude: 10 }));
  e.statuses.push(status("regen", { magnitude: 5, name: "Mending" }));
  const state = makeState([t], [e]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "tarynantidote1", targets: ["e"] });
  const remaining = e.statuses.filter((s) => s.kind === "damage_reduction" || s.kind === "regen").length;
  assert.equal(remaining, 1, "exactly one of the two beneficial effects was cleansed");
});

// ===========================================================================
// DIVINE — Divine Hymn (passive) + Holy Word: Peace (taryndivine1)
//   Divine Hymn: "The Damage Reduction from Protector of the Song now lasts for 2 turns
//     and affects both of Taryn's allies as well."
//   Holy Word: Peace: "Target enemy has their Harmful skills stunned for 2 turns. If the
//     target receives new damage during this time, the stun will end. This skill is cast
//     in place of Refrain during Radiant Glory."
// ===========================================================================

test("Divine Hymn: a skill reflected onto Taryn grants 10 DR for 2 turns to Taryn AND both allies (+ Taryn Essence)", () => {
  const t = fuseTaryn("divine");
  const a1 = ally("a1");
  const a2 = ally("a2");
  const state = makeState([t, a1, a2], [enemy("e")]);
  fund(state);

  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "a1", to: "taryn" });
  const dr = (u: Unit) => u.statuses.find((s) => s.kind === "damage_reduction" && s.magnitude === 10);
  assert.equal(dr(t)?.duration, 2, "Taryn's DR now lasts 2 turns");
  assert.equal(dr(a1)?.duration, 2, "ally 1 also gains the 10 DR for 2 turns");
  assert.equal(dr(a2)?.duration, 2, "ally 2 also gains the 10 DR for 2 turns");
  assert.equal(essence(t), true, "Taryn still gains Elemental Essence");
});

test("Divine Hymn control: a redirect onto a NON-Taryn unit grants nobody DR", () => {
  const t = fuseTaryn("divine");
  const a1 = ally("a1");
  const state = makeState([t, a1], [enemy("e")]);
  fund(state);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "a1" });
  assert.equal(has(t, "damage_reduction"), false, "Taryn gets no DR");
  assert.equal(has(a1, "damage_reduction"), false, "the ally gets no DR");
});

test("Holy Word: Peace stuns the enemy's Harmful skills for 2 turns (a non-Harmful skill still resolves)", () => {
  const t = fuseTaryn("divine");
  const e = enemy("e", { skills: [harm("ehit", 20), help("eheal")] });
  const state = makeState([t], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryndivine1", targets: ["e"] });
  const st = statusOf(e, "stun");
  assert.equal(st?.duration, 2, "the stun lasts 2 turns");
  assert.equal(st?.scope?.tag, "Harmful", "the stun is scoped to Harmful skills");
  assert.equal(st?.scope?.mode, "only");

  const harmful = performAction(state, { unit: "e", skillId: "ehit", targets: ["taryn"] });
  assert.equal(harmful.reason, "stunned", "the enemy's Harmful skill is stunned");
  const helpful = performAction(state, { unit: "e", skillId: "eheal", targets: ["e"] });
  assert.equal(helpful.ok, true, "a non-Harmful skill is NOT stunned");
});

test("Holy Word: Peace — the stun ends the first time the target takes new damage", () => {
  const t = fuseTaryn("divine");
  const e = enemy("e", { skills: [harm("ehit", 20)] });
  const state = makeState([t], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryndivine1", targets: ["e"] });
  assert.equal(has(e, "stun"), true, "stunned right after Holy Word");
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] }); // Banner of Harmony: 15 new damage
  assert.equal(has(e, "stun"), false, "the stun ended when the enemy received new damage");
});

test("Holy Word: Peace is cast in place of Refrain during Radiant Glory (Inspiring Thrust then applies the 2-turn stun, not Refrain's 1)", () => {
  const t = fuseTaryn("divine");
  const e = enemy("e");
  const state = makeState([t], [e]);
  fund(state);
  emit(state, { type: "roundStart" }); // runs the divine repoint of taryn3/taryn4's Refrain auto-cast

  performAction(state, { unit: "taryn", skillId: "taryn5", targets: ["taryn"] }); // Radiant Glory (mark, 3 turns)
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // Inspiring Thrust -> auto-casts Holy Word
  const st = statusOf(e, "stun");
  assert.equal(st?.duration, 2, "the auto-cast was Holy Word (2-turn stun), not Refrain (1)");
  assert.equal(st?.scope?.tag, "Harmful", "Holy Word's Harmful-scoped stun");
});

// ===========================================================================
// JUDGMENT — Forced Harmony (passive) + Trial by Fire (tarynjudgment1)
//   Forced Harmony: "If a target affected by Banner of Harmony deals new damage to Taryn's
//     allies, they receive double damage from Taryn's next Inspiring Thrust."
//   Trial by Fire: "Deals 15 Damage to target enemy for the next 2 turns. During this time,
//     the target is Isolated."
// ===========================================================================

test("Forced Harmony: a Banner-marked enemy that damages an ally takes DOUBLE Inspiring Thrust (20 base -> 40)", () => {
  const t = fuseTaryn("judgment");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 10)] });
  const state = makeState([t, a1], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] }); // Banner of Harmony mark on e
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] }); // enemy damages Taryn's ally
  assert.equal(hasMark(e, "Forced Harmony"), true, "the enemy is flagged for doubled Inspiring Thrust");

  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // Inspiring Thrust
  // base 20 + doubled bonus 20 = 40. Enemy took 15 (Banner) earlier -> 100-15-40 = 45.
  assert.equal(e.hp, 45, "Inspiring Thrust dealt 40 (doubled) to the flagged enemy");
  assert.equal(hasMark(e, "Forced Harmony"), false, "the Forced Harmony flag is consumed");
});

test("Forced Harmony control: an UN-Bannered enemy that damages an ally takes only base Inspiring Thrust (20)", () => {
  const t = fuseTaryn("judgment");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 10)] });
  const state = makeState([t, a1], [e]);
  fund(state);

  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] }); // damages ally but is NOT Bannered
  assert.equal(hasMark(e, "Forced Harmony"), false, "no flag without a Banner of Harmony mark");
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(e.hp, 80, "Inspiring Thrust dealt only its base 20 (100 -> 80)");
});

test("Trial by Fire: 15 damage per turn for 2 turns (30 total over the applier's next two turns)", () => {
  const t = fuseTaryn("judgment");
  const e = enemy("e");
  const state = makeState([t], [e]);
  state.activeTeam = "A"; state.turn = 1;
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynjudgment1", targets: ["e"] });
  const dot = statusOf(e, "dot");
  assert.equal(dot?.magnitude, 15, "the DoT ticks 15");
  assert.equal(dot?.duration, 2, "for 2 turns");
  assert.equal(e.hp, 100, "no immediate damage — Trial by Fire is a DoT");

  endTurn(state); // A (turn 1) — birth turn, no tick
  endTurn(state); // B
  endTurn(state); // A — tick 1
  assert.equal(e.hp, 85, "first tick dealt 15");
  endTurn(state); // B
  endTurn(state); // A — tick 2
  assert.equal(e.hp, 70, "second tick dealt 15 (30 total)");
});

test("Trial by Fire: the target is Isolated (cannot be targeted by a Helpful skill)", () => {
  const t = fuseTaryn("judgment");
  const e = enemy("e");
  const e2 = enemy("e2", { skills: [help("eheal")] }); // an enemy medic
  const state = makeState([t], [e, e2]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynjudgment1", targets: ["e"] });
  assert.equal(has(e, "isolated"), true, "the target is Isolated");
  const blocked = performAction(state, { unit: "e2", skillId: "eheal", targets: ["e"] });
  assert.equal(blocked.ok, false, "a Helpful skill cannot target the Isolated enemy");
  assert.equal(blocked.reason, "no-legal-target");
});

// ===========================================================================
// PRISM — Refracted Refrain (passive) + Do Unto Others (tarynprism1)
//   Refracted Refrain: "Healing from Refrain now affects Taryn's entire team."
//   Do Unto Others: "Target ally gains 20 Shield. If the targeted ally is affected by
//     Refrain, this skill will affect all allies. This extra effect ignores Isolation."
// ===========================================================================

test("Refracted Refrain: a Refrain-marked ally using a skill heals Taryn's ENTIRE team 15 (not just the mark-holder)", () => {
  const t = fuseTaryn("prism");
  const a1 = ally("a1", { hp: 80, skills: [noop("an1")] });
  const a2 = ally("a2", { hp: 80 });
  a1.statuses.push(status("mark", { name: "Refrain", duration: 2, appliedBy: "taryn" }));
  t.hp = 80;
  const state = makeState([t, a1, a2], [enemy("e")]);
  fund(state);

  performAction(state, { unit: "a1", skillId: "an1", targets: ["a1"] }); // the Refrain-marked ally uses a skill
  assert.equal(t.hp, 95, "Taryn healed 15");
  assert.equal(a1.hp, 95, "the mark-holder healed 15");
  assert.equal(a2.hp, 95, "the OTHER ally also healed 15 (team-wide)");
});

test("Refracted Refrain control: an UN-marked ally using a skill heals no one", () => {
  const t = fuseTaryn("prism");
  const a1 = ally("a1", { hp: 80, skills: [noop("an1")] });
  t.hp = 80;
  const state = makeState([t, a1], [enemy("e")]);
  fund(state);
  performAction(state, { unit: "a1", skillId: "an1", targets: ["a1"] });
  assert.equal(t.hp, 80, "no heal without a Refrain mark on the actor");
  assert.equal(a1.hp, 80, "no heal without a Refrain mark on the actor");
});

test("Do Unto Others: without Refrain, only the targeted ally gains 20 Shield", () => {
  const t = fuseTaryn("prism");
  const a1 = ally("a1");
  const a2 = ally("a2");
  const state = makeState([t, a1, a2], [enemy("e")]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "tarynprism1", targets: ["a1"] });
  assert.equal(shieldTotal(a1), 20, "the targeted ally gains 20 Shield");
  assert.equal(shieldTotal(a2), 0, "another ally gains nothing");
  assert.equal(shieldTotal(t), 0, "Taryn gains nothing");
});

test("Do Unto Others: if the targeted ally has Refrain, ALL allies gain 20 Shield — even an Isolated one", () => {
  const t = fuseTaryn("prism");
  const a1 = ally("a1"); // the target — bears Refrain
  const a2 = ally("a2"); // Isolated: the team-wide branch must still reach it
  a1.statuses.push(status("mark", { name: "Refrain", duration: 2, appliedBy: "taryn" }));
  a2.statuses.push(status("isolated", { duration: 3 }));
  const state = makeState([t, a1, a2], [enemy("e")]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynprism1", targets: ["a1"] });
  assert.equal(shieldTotal(a1), 20, "the Refrain-marked target gains 20");
  assert.equal(shieldTotal(t), 20, "Taryn gains 20 (all allies)");
  assert.equal(shieldTotal(a2), 20, "the Isolated ally still gains 20 (the extra effect ignores Isolation)");
});

// ===========================================================================
// SANCTUARY — Guardian at the Gates (passive) + Banner of Consecration (tarynsanctuary1)
//   Guardian at the Gates: "Protector of the Song now activates every turn. This effect is
//     disabled for 1 turn if Taryn deals damage."
//   Banner of Consecration: "For 2 turns, damaging Taryn or his allies will cause the
//     attacker to receive 10 damage. This damage will not disable Guardian at the Gates."
// ===========================================================================

test("Guardian at the Gates: Protector of the Song activates every turn (10 DR + Essence at turn start)", () => {
  const t = fuseTaryn("sanctuary");
  const state = makeState([t], [enemy("e")]);
  fund(state);
  emit(state, { type: "turnStart", team: "A" });
  assert.equal(drTotal(t), 10, "Taryn gains 10 DR on turn start");
  assert.equal(statusOf(t, "damage_reduction")?.duration, 1, "for 1 turn");
  assert.equal(essence(t), true, "and Elemental Essence");
});

test("Guardian at the Gates: dealing damage disables the every-turn activation for 1 turn", () => {
  const t = fuseTaryn("sanctuary");
  const e = enemy("e");
  const state = makeState([t], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // Taryn deals damage
  assert.equal(hasMark(t, "Guardian Suppressed"), true, "dealing damage sets the suppression flag");
  t.statuses = t.statuses.filter((s) => s.kind !== "damage_reduction"); // clear any prior DR

  emit(state, { type: "turnStart", team: "A" });
  assert.equal(drTotal(t), 0, "no DR is granted while suppressed");
});

test("Banner of Consecration: for 2 turns, an enemy that damages Taryn or an ally takes 10 retaliation", () => {
  const t = fuseTaryn("sanctuary");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 15)] });
  const state = makeState([t, a1], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynsanctuary1", targets: [] });
  assert.equal(hasMark(t, "Banner of Consecration"), true, "the aura marks Taryn");
  assert.equal(hasMark(a1, "Banner of Consecration"), true, "and his ally");

  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] }); // enemy damages the ally
  assert.equal(a1.hp, 85, "the ally still took the enemy's 15");
  assert.equal(e.hp, 90, "the attacker received 10 retaliation");
});

test("Banner of Consecration control: without the aura, damaging an ally causes no retaliation", () => {
  const t = fuseTaryn("sanctuary");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 15)] });
  const state = makeState([t, a1], [e]);
  fund(state);
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] });
  assert.equal(e.hp, 100, "no retaliation without Banner of Consecration");
});

test("Banner of Consecration's retaliation does NOT disable Guardian at the Gates", () => {
  const t = fuseTaryn("sanctuary");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 15)] });
  const state = makeState([t, a1], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynsanctuary1", targets: [] });
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] }); // triggers the 10 retaliation
  assert.equal(e.hp, 90, "retaliation landed");
  assert.equal(hasMark(t, "Guardian Suppressed"), false, "the retaliation did NOT set Guardian's suppression flag");

  emit(state, { type: "turnStart", team: "A" });
  assert.equal(drTotal(t), 10, "Guardian at the Gates still activates (10 DR) after retaliation");
});

// ===========================================================================
// VENGEANCE — Wingman (passive) + Not Today (tarynvengeance1)
//   Wingman: "Stalwart Shield no longer grants Taryn Shield, is fully Invisible, and
//     reflects skills back at their user instead."
//   Not Today: "Taryn reflects all harmful skills from target ally to himself for 1 turn.
//     This skill is invisible."
// ===========================================================================

test("Wingman: a Harmful skill aimed at a Stalwart-Shield-protected ally is reflected back at its USER", () => {
  const t = fuseTaryn("vengeance");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 20)] });
  const state = makeState([t, a1], [e]);
  fund(state);
  emit(state, { type: "roundStart" }); // run Wingman's Stalwart Shield patch

  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a1"] }); // marks the ally
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] }); // enemy attacks the protected ally
  assert.equal(a1.hp, 100, "the protected ally took no damage");
  assert.equal(e.hp, 80, "the skill was reflected back onto its user (the attacker took its own 20)");
});

test("Wingman: Stalwart Shield no longer grants Taryn Shield (and its skill instance is flagged Invisible)", () => {
  const t = fuseTaryn("vengeance");
  const a1 = ally("a1");
  const state = makeState([t, a1], [enemy("e")]);
  fund(state);
  emit(state, { type: "roundStart" }); // run Wingman's patch (strips the grantShield, sets isHidden)

  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a1"] });
  assert.equal(shieldTotal(t), 0, "Stalwart Shield no longer grants Taryn Shield");
  const ss = (t.skills ?? []).find((s) => s.id === "taryn4");
  assert.equal(ss?.isHidden, true, "Stalwart Shield is now fully Invisible");
});

test("Not Today: Harmful skills aimed at the target ally are reflected onto Taryn for 1 turn", () => {
  const t = fuseTaryn("vengeance");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 20)] });
  const state = makeState([t, a1], [e]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynvengeance1", targets: ["a1"] });
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] });
  assert.equal(a1.hp, 100, "the target ally took no damage");
  assert.equal(t.hp, 90, "Taryn absorbed the reflected skill, blunted by Protector of the Song's retained 10 DR (took 10, 100 -> 90)");
});

test("Not Today control: without it, the ally takes the hit and Taryn does not", () => {
  const t = fuseTaryn("vengeance");
  const a1 = ally("a1");
  const e = enemy("e", { skills: [harm("ehit", 20)] });
  const state = makeState([t, a1], [e]);
  fund(state);
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a1"] });
  assert.equal(a1.hp, 80, "the ally took the hit");
  assert.equal(t.hp, 100, "Taryn was not involved");
});

// ===========================================================================
// VIGILANTE — Glorious Justice (passive) + Restrain (tarynvigilante1)
//   Glorious Justice: "If Taryn's team has fewer living Heroes than the enemy team, his
//     skills deal 10 additional damage and have their damage changed to Piercing."
//   Restrain: "Stuns Taryn and target enemy for 1 turn. If Taryn receives new damage during
//     this time, Restrain will permanently last 1 turn longer on the damaging enemy."
// ===========================================================================

test("Glorious Justice: while outnumbered, Taryn's damage is +10 and Piercing (ignores enemy DR)", () => {
  const t = fuseTaryn("vigilante"); // team A: 1 hero
  const e = enemy("e", { statuses: [status("damage_reduction", { magnitude: 10 })] });
  const e2 = enemy("e2");
  const state = makeState([t], [e, e2]); // 1 vs 2 -> outnumbered
  fund(state);

  emit(state, { type: "turnStart", team: "A" }); // Glorious Justice re-evaluates
  assert.equal(omod(t), 10, "+10 outgoing damage while outnumbered");
  assert.equal(statusOf(t, "outgoing_dtype_override")?.dtype, "piercing", "damage changed to Piercing");

  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // base 20
  assert.equal(e.hp, 70, "Piercing 30 ignored the enemy's 10 DR (100 -> 70)");
});

test("Glorious Justice control: NOT outnumbered — no bonus, damage stays Normal (DR applies)", () => {
  const t = fuseTaryn("vigilante");
  const a1 = ally("a1"); // team A: 2 heroes
  const e = enemy("e", { statuses: [status("damage_reduction", { magnitude: 10 })] });
  const e2 = enemy("e2");
  const state = makeState([t, a1], [e, e2]); // 2 vs 2 -> not outnumbered
  fund(state);

  emit(state, { type: "turnStart", team: "A" });
  assert.equal(omod(t), 0, "no outgoing bonus when not outnumbered");
  assert.equal(has(t, "outgoing_dtype_override"), false, "no Piercing conversion");

  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // base 20 normal - 10 DR
  assert.equal(e.hp, 90, "Normal 20 was reduced by the 10 DR (100 -> 90)");
});

test("Restrain: stuns BOTH Taryn and the target enemy for 1 turn", () => {
  const t = fuseTaryn("vigilante");
  const e = enemy("e");
  const state = makeState([t], [e]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "tarynvigilante1", targets: ["e"] });
  assert.equal(statusOf(t, "stun")?.duration, 1, "Taryn is stunned for 1 turn");
  assert.equal(statusOf(e, "stun")?.duration, 1, "the target enemy is stunned for 1 turn");
});

test("Restrain: if Taryn takes new damage during it, the damaging enemy's Restrain lasts 1 turn longer", () => {
  const t = fuseTaryn("vigilante");
  const e = enemy("e");
  const e2 = enemy("e2"); // an un-Restrained enemy — the control damager
  const state = makeState([t], [e, e2]);
  state.activeTeam = "A"; state.turn = 1;
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynvigilante1", targets: ["e"] }); // Restrain e (stun 1)
  emit(state, { type: "damageDealt", source: "e", target: "taryn", amount: 5, dtype: "normal", isNew: true });
  assert.equal(statusOf(e, "stun")?.duration, 2, "the damaging (Restrained) enemy's stun extended to 2");

  emit(state, { type: "damageDealt", source: "e2", target: "taryn", amount: 5, dtype: "normal", isNew: true });
  assert.equal(has(e2, "stun"), false, "an un-Restrained damager is NOT newly stunned (only existing Restrain extends)");
});

// ===========================================================================
// ZEALOT — Flag of Inquisition (passive) + Verse of Accusation (tarynzealot1)
//   Flag of Inquisition: "Protector of the Song no longer gives Taryn Damage Reduction,
//     instead increasing his damage by 10 until the end of his next turn. This effect can
//     stack."
//   Verse of Accusation: "Taryn activates Protector of the Song and until the end of his
//     next turn, Banner of Harmony will affect all enemies."
// ===========================================================================

test("Flag of Inquisition: a reflect onto Taryn grants +10 damage (NOT DR) + Essence", () => {
  const t = fuseTaryn("zealot");
  const state = makeState([t], [enemy("e")]);
  fund(state);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "taryn" });
  assert.equal(omod(t), 10, "+10 outgoing damage");
  assert.equal(has(t, "damage_reduction"), false, "no Damage Reduction (the passive replaced it)");
  assert.equal(essence(t), true, "Essence is still granted");
});

// SUSPECTED BUG — Flag of Inquisition frozen: "increasing his damage by 10 until the end of his next
// turn. This effect can stack." Each reflect onto Taryn should add another +10 (cumulative). The passive
// applies a nameless outgoing_damage_mod via plain applyStatus, which REFRESHES the single slot to +10
// rather than accumulating (sameSlot() has no per-instance key for outgoing_damage_mod) — so repeated
// reflects stay at +10, not +20/+30. Same systemic limitation the ando suite flags on God of Thunder.
test("Flag of Inquisition's +10 damage STACKS across reflects (+10 -> +20)", () => {
  const t = fuseTaryn("zealot");
  const state = makeState([t], [enemy("e")]);
  fund(state);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "taryn" });
  emit(state, { type: "skillRedirected", caster: "e", skillId: "y", from: "e", to: "taryn" });
  assert.equal(omod(t), 20, "two reflects stack to +20 outgoing damage");
});

test("Flag of Inquisition control: a reflect onto a non-Taryn unit grants Taryn nothing", () => {
  const t = fuseTaryn("zealot");
  const a1 = ally("a1");
  const state = makeState([t, a1], [enemy("e")]);
  fund(state);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "a1" });
  assert.equal(omod(t), 0, "no bonus when the reflect is not onto Taryn");
});

test("Verse of Accusation: activates Protector of the Song (zealot form -> +10 damage + Essence)", () => {
  const t = fuseTaryn("zealot");
  const state = makeState([t], [enemy("e")]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "tarynzealot1", targets: ["taryn"] });
  assert.equal(omod(t), 10, "+10 outgoing damage from the activated Protector of the Song");
  assert.equal(essence(t), true, "and Elemental Essence");
});

test("Verse of Accusation: Banner of Harmony then hits ALL enemies (control: normally single-target)", () => {
  const t = fuseTaryn("zealot");
  const e = enemy("e");
  const e2 = enemy("e2");
  const state = makeState([t], [e, e2]);
  fund(state);

  performAction(state, { unit: "taryn", skillId: "tarynzealot1", targets: ["taryn"] }); // opens the window
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] }); // Banner of Harmony
  // Verse grants +10 outgoing, so Banner's 15 lands as 25 on each enemy.
  assert.equal(e.hp, 75, "the chosen enemy took Banner damage");
  assert.equal(e2.hp, 75, "the OTHER enemy also took Banner damage (all enemies)");
  assert.equal(hasMark(e, "Banner of Harmony"), true, "e is Banner-marked");
  assert.equal(hasMark(e2, "Banner of Harmony"), true, "e2 is Banner-marked too");
});

test("Banner of Harmony control: a plain zealot Taryn (no Verse) hits only a single enemy", () => {
  const t = fuseTaryn("zealot");
  const e = enemy("e");
  const e2 = enemy("e2");
  const state = makeState([t], [e, e2]);
  fund(state);
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] });
  assert.equal(e.hp, 85, "the chosen enemy took the 15");
  assert.equal(e2.hp, 100, "the other enemy is untouched (single-target without Verse)");
});
