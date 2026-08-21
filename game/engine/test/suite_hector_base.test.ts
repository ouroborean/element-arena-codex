import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound, tickDots, effectiveCost, effectiveCooldown } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// HERO: Hector the Injector — base kit.
//
// Frozen prose (../content/frozen/skills.json), the ORACLE for every assertion:
//   hector0 "Dennis the Apprentice" (passive): "At the start of each round, Hector summons Dennis the
//     Apprentice. Whenever Hector uses a Serum skill on Dennis, he gains Elemental Essence."
//   hector1 "Burning Blood Serum": "Injects Dennis with Burning Blood Serum, increasing his damage dealt
//     by 10 for 3 turns. This effect stacks, but Dennis takes 10 damage per turn per stack."
//   hector2 "Stoneseal Serum": "Injects Dennis with Stoneseal Serum, healing him for 10 health per turn for
//     3 turns, but increasing his skill costs by 1 Generic energy."
//   hector3 "Mindfog Serum": "Injects Dennis with Mindfog Serum, increasing his cooldowns by 1 and making
//     him ignore stuns and counters for 3 turns. During this time, Lumbering Smash will stun its targets
//     non-Strategic skills for 1 turn."
//   hector4 "Protect Me!": "Reflects all harmful skills used on Hector to Dennis for 1 turn. This skill is
//     invisible."
//   hector5 "Serum Overload": "Refreshes the duration of all Serums affecting Dennis to 3 turns, and removes
//     their negative effects. If Dennis is dead and he was a minion when he died, he returns to life with 50HP."
//
// Content (roster.authored.json / roster.generated.ts) is read ONLY to drive: ids hector1..hector5,
// Dennis's minion skill id "dennis" (Lumbering Smash), costs (Hector's element is poison, so `specific`
// is paid in `poison`), and the produced status/minion names. Assertions come from the prose above.
// ---------------------------------------------------------------------------

const DENNIS = "Dennis the Apprentice";

function getDennis(state: MatchState): Unit {
  const d = Object.values(state.units).find((u) => u.kind === "minion" && u.name === DENNIS);
  assert.ok(d, "Dennis the Apprentice minion should exist");
  return d!;
}
function dennisMinions(state: MatchState): Unit[] {
  return state.teams.A.units.map((id) => state.units[id]!).filter((u) => u && u.kind === "minion" && u.name === DENNIS);
}
function lumberingSmash(dennis: Unit) {
  const s = (dennis.skills ?? []).find((k) => k.id === "dennis");
  assert.ok(s, "Dennis should carry Lumbering Smash (skill id 'dennis')");
  return s!;
}
function findStatus(u: Unit, kind: string, name?: string) {
  return u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
}

/** Hector on team A (id "h") with a fresh Dennis summoned by his round-start passive, plus one enemy. */
function setup(enemyOver: Partial<Unit> = {}) {
  const hector = loadHero(heroById("hector"), "A", "h");
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, ...enemyOver });
  const state = makeState([hector], [enemy]);
  startRound(state, "A"); // fires Hector's round-start passive → summons Dennis
  state.teams.A.energy = { generic: 40, poison: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { state, hector, enemy, dennis: getDennis(state) };
}

// Serum-injection helpers (drive the real cast onto Dennis).
function castSerum(state: MatchState, skillId: string, dennisId: string) {
  const r = performAction(state, { unit: "h", skillId, targets: [dennisId] });
  assert.equal(r.ok, true, `${skillId} should cast onto Dennis (reason: ${r.reason})`);
  return r;
}

// =========================================================================
// hector0 — "Dennis the Apprentice" (passive)
// =========================================================================

test("hector0: Hector summons Dennis the Apprentice at the start of a round", () => {
  const hector = loadHero(heroById("hector"), "A", "h");
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const state = makeState([hector], [enemy]);

  // Control: before any round starts, there is no Dennis.
  assert.equal(dennisMinions(state).length, 0, "no Dennis before the round starts");

  startRound(state, "A");
  const dennises = dennisMinions(state);
  assert.equal(dennises.length, 1, "exactly one Dennis summoned at round start");
  assert.equal(dennises[0]!.kind, "minion", "Dennis is a minion");
  assert.equal(dennises[0]!.team, "A", "Dennis is on Hector's team");
  assert.ok(dennises[0]!.alive, "Dennis is alive");
  assert.equal(dennises[0]!.hp, dennises[0]!.maxHp, "Dennis summoned at full HP");
});

test("hector0: a fresh round re-summons a single Dennis (never a duplicate)", () => {
  const { state } = setup();
  assert.equal(dennisMinions(state).length, 1, "one Dennis after first round");
  startRound(state, "A"); // a new round
  assert.equal(dennisMinions(state).length, 1, "still exactly one Dennis after a second round start");
});

test("hector0: using a Serum skill on Dennis grants Hector Elemental Essence", () => {
  const { state, hector, dennis } = setup();
  assert.equal(findStatus(hector, "elemental_essence"), undefined, "Hector holds no Essence before injecting");

  castSerum(state, "hector1", dennis.id);
  assert.ok(findStatus(hector, "elemental_essence"), "Hector gains Elemental Essence from a Serum on Dennis");
});

test("hector0: a non-Serum self-cast does NOT grant Elemental Essence (control)", () => {
  const { state, hector } = setup();
  // Serum Overload (hector5) is self-targeted, not a Serum injected on Dennis.
  const r = performAction(state, { unit: "h", skillId: "hector5", targets: [] });
  assert.equal(r.ok, true, `Serum Overload should cast (reason: ${r.reason})`);
  assert.equal(findStatus(hector, "elemental_essence"), undefined, "no Essence from a self-cast");
});

// =========================================================================
// hector1 — "Burning Blood Serum": +10 damage dealt for 3 turns, stacks; 10 self-dmg/turn/stack
// =========================================================================

// Isolate Dennis's outgoing-damage delta by comparing Lumbering Smash with vs without the serum.
function smashDamage(nStacks: number): number {
  const { state, dennis, enemy } = setup();
  for (let i = 0; i < nStacks; i++) {
    state.units["h"]!.skills!.find((s) => s.id === "hector1")!.currentCd = 0; // allow repeat casts (stacking under test, not the cooldown)
    castSerum(state, "hector1", dennis.id);
  }
  const before = enemy.hp;
  const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
  assert.equal(r.ok, true, `Lumbering Smash should resolve (reason: ${r.reason})`);
  return before - enemy.hp;
}

test("hector1: Burning Blood increases Dennis's damage dealt by 10 (one stack)", () => {
  const base = smashDamage(0);
  const boosted = smashDamage(1);
  assert.equal(boosted - base, 10, "one Burning Blood stack adds exactly 10 to Dennis's outgoing damage");
});

test("hector1: Burning Blood stacks — two stacks add 20 to Dennis's damage", () => {
  const base = smashDamage(0);
  const two = smashDamage(2);
  assert.equal(two - base, 20, "two Burning Blood stacks add exactly 20 (stacks, +10 each)");
});

test("hector1: Dennis takes 10 damage per turn (one stack)", () => {
  const { state, dennis } = setup();
  castSerum(state, "hector1", dennis.id);
  const before = dennis.hp;
  state.turn += 2; // past the dot's birth turn so it ticks
  tickDots(state, "A");
  assert.equal(before - dennis.hp, 10, "one stack ⇒ 10 self-damage per tick");
});

test("hector1: self-damage scales per stack — two stacks deal 20/turn", () => {
  const { state, dennis } = setup();
  castSerum(state, "hector1", dennis.id);
  state.units["h"]!.skills!.find((s) => s.id === "hector1")!.currentCd = 0;
  castSerum(state, "hector1", dennis.id); // second stack
  const before = dennis.hp;
  state.turn += 2;
  tickDots(state, "A");
  assert.equal(before - dennis.hp, 20, "two stacks ⇒ 20 self-damage per tick");
});

// =========================================================================
// hector2 — "Stoneseal Serum": heals 10/turn for 3 turns; +1 Generic skill cost
// =========================================================================

test("hector2: Stoneseal heals Dennis 10 health per turn", () => {
  const { state, dennis } = setup();
  dennis.hp = dennis.maxHp - 30; // wounded so a heal is visible
  castSerum(state, "hector2", dennis.id);
  const before = dennis.hp;
  state.turn += 2;
  tickDots(state, "A");
  assert.equal(dennis.hp - before, 10, "Stoneseal regenerates 10 HP per tick");
});

test("hector2: without Stoneseal there is no heal (control)", () => {
  const { state, dennis } = setup();
  dennis.hp = dennis.maxHp - 30;
  const before = dennis.hp;
  state.turn += 2;
  tickDots(state, "A");
  assert.equal(dennis.hp, before, "no regen without the serum");
});

test("hector2: Stoneseal increases Dennis's skill costs by 1 Generic energy", () => {
  const { state, dennis } = setup();
  const ls = lumberingSmash(dennis);
  assert.equal(effectiveCost(dennis, ls, state).generic, 0, "baseline Lumbering Smash costs 0 Generic");

  castSerum(state, "hector2", dennis.id);
  const cost = effectiveCost(dennis, lumberingSmash(dennis), state);
  assert.equal(cost.generic, 1, "Stoneseal adds +1 Generic to Dennis's skill cost");
  assert.equal(cost.specific, 0, "the +1 is Generic, not Specific");
});

// =========================================================================
// hector3 — "Mindfog Serum": +1 cooldowns; ignore stuns & counters; Lumbering Smash stuns non-Strategic
// =========================================================================

test("hector3: Mindfog increases Dennis's cooldowns by 1", () => {
  const { state, dennis } = setup();
  const ls = lumberingSmash(dennis);
  const baseCd = effectiveCooldown(dennis, ls);
  castSerum(state, "hector3", dennis.id);
  assert.equal(effectiveCooldown(dennis, lumberingSmash(dennis)), baseCd + 1, "Mindfog raises Dennis's cooldowns by 1");
});

test("hector3: while Mindfogged, Lumbering Smash stuns the target's non-Strategic skills for 1 turn", () => {
  const { state, dennis, enemy } = setup();
  castSerum(state, "hector3", dennis.id);
  const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
  assert.equal(r.ok, true, `Lumbering Smash should resolve (reason: ${r.reason})`);

  const stun = findStatus(enemy, "stun");
  assert.ok(stun, "Mindfogged Lumbering Smash applies a stun to its target");
  assert.equal(stun!.duration, 1, "the stun lasts 1 turn");
  assert.ok(stun!.scope, "the stun is scoped");
  assert.equal(stun!.scope!.tag, "Strategic", "scoped on the Strategic tag");
  assert.equal(stun!.scope!.mode, "except", "it stops skills EXCEPT Strategic ones (i.e. non-Strategic skills)");
});

test("hector3: without Mindfog, Lumbering Smash applies no stun (control)", () => {
  const { state, dennis, enemy } = setup();
  const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
  assert.equal(r.ok, true, `Lumbering Smash should resolve (reason: ${r.reason})`);
  assert.equal(findStatus(enemy, "stun"), undefined, "a plain Lumbering Smash never stuns");
});

test("hector3: the non-Strategic stun blocks a non-Strategic skill but allows a Strategic one", () => {
  const zap = { op: "damage", amount: 5, dtype: "normal", to: "target" } as any;
  const enemy = makeUnit({
    id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [
      { id: "atk", name: "Atk", element: "fire", targeting: "single", effects: [zap], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful", "Instant"] },
      { id: "plan", name: "Plan", element: "fire", targeting: "self", effects: [], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Strategic", "Instant"] },
    ] as any,
  });
  const hector = loadHero(heroById("hector"), "A", "h");
  const state = makeState([hector], [enemy]);
  startRound(state, "A");
  state.teams.A.energy = { generic: 40, poison: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  const dennis = getDennis(state);

  castSerum(state, "hector3", dennis.id);
  performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] }); // stuns non-Strategic

  const nonStrategic = performAction(state, { unit: enemy.id, skillId: "atk", targets: ["h"] });
  assert.equal(nonStrategic.ok, false, "the enemy's non-Strategic skill is stunned");
  assert.equal(nonStrategic.reason, "stunned", "rejected specifically for the stun");

  const strategic = performAction(state, { unit: enemy.id, skillId: "plan", targets: [] });
  assert.equal(strategic.ok, true, "the enemy's Strategic skill is NOT stopped by this scoped stun");
});

// SUSPECTED BUG: Mindfog frozen says it makes Dennis "ignore stuns" for 3 turns, but the engine applies a
// `non_damage_ignore` status that NO code reads (no consumer in isStunnedFor or the applyStatus op), so a
// Mindfogged Dennis is still stopped by a stun. Assertions preserved; the control test above proves the harness.
test("hector3: Mindfog Serum makes its target ignore stuns (an enemy stun does not land)", () => {
  const { state, dennis, enemy } = setup();
  castSerum(state, "hector3", dennis.id);
  // Apply a plain (unscoped) stun to Dennis via the real status-apply path.
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }] as any, {
    caster: enemy, targets: [dennis], skillId: "extstun",
  });
  const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
  assert.equal(r.ok, true, "a Mindfogged Dennis ignores the stun and can act");
});

test("hector3: without Mindfog, a stun stops Dennis (control for the ignore-stuns clause)", () => {
  const { state, dennis, enemy } = setup();
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }] as any, {
    caster: enemy, targets: [dennis], skillId: "extstun",
  });
  const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
  assert.equal(r.ok, false, "an un-Mindfogged Dennis is stopped by the stun");
  assert.equal(r.reason, "stunned", "rejected specifically for the stun");
});

test("hector3: Mindfog makes Dennis ignore counters (his skill can't be countered)", () => {
  const counterTrigger = { owner: "e1", on: "skillDeclared", kind: "counter", when: { eventHasTag: "Harmful" }, effect: [] } as any;
  // Control: no Mindfog ⇒ Dennis's Harmful Lumbering Smash is countered (no damage lands).
  {
    const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, triggers: [counterTrigger] });
    const hector = loadHero(heroById("hector"), "A", "h");
    const state = makeState([hector], [enemy]);
    startRound(state, "A");
    state.teams.A.energy = { generic: 40, poison: 40 };
    const dennis = getDennis(state);
    const before = enemy.hp;
    const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
    assert.equal(r.ok, true, "the cast is declared");
    assert.equal(r.countered, true, "…and countered");
    assert.equal(enemy.hp, before, "no damage lands when countered");
  }
  // With Mindfog ⇒ Dennis is uncounterable, so the smash resolves.
  {
    const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, triggers: [counterTrigger] });
    const hector = loadHero(heroById("hector"), "A", "h");
    const state = makeState([hector], [enemy]);
    startRound(state, "A");
    state.teams.A.energy = { generic: 40, poison: 40 };
    const dennis = getDennis(state);
    castSerum(state, "hector3", dennis.id);
    const before = enemy.hp;
    const r = performAction(state, { unit: dennis.id, skillId: "dennis", targets: [enemy.id] });
    assert.equal(r.ok, true, "the cast resolves");
    assert.notEqual(r.countered, true, "Mindfog makes it uncounterable");
    assert.equal(before - enemy.hp, 10, "the smash lands its damage (not countered)");
  }
});

// =========================================================================
// hector4 — "Protect Me!": reflect all Harmful skills used on Hector to Dennis for 1 turn
// =========================================================================

function enemyWithZap() {
  const zap = { op: "damage", amount: 20, dtype: "normal", to: "target" } as any;
  const hex = { op: "applyStatus", to: "target", status: { kind: "mark", name: "Hex", duration: 2 } } as any;
  return makeUnit({
    id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [
      { id: "zap", name: "Zap", element: "fire", targeting: "single", effects: [zap], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Harmful", "Instant"] },
      { id: "hex", name: "Hex", element: "fire", targeting: "single", effects: [hex], cost: { generic: 0, specific: 0 }, cooldown: 0, currentCd: 0, klass: "basic", tags: ["Strategic", "Instant"] },
    ] as any,
  });
}

test("hector4: Protect Me! reflects a harmful skill used on Hector onto Dennis", () => {
  const enemy = enemyWithZap();
  const hector = loadHero(heroById("hector"), "A", "h");
  const state = makeState([hector], [enemy]);
  startRound(state, "A");
  state.teams.A.energy = { generic: 40, poison: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  const dennis = getDennis(state);

  const pm = performAction(state, { unit: "h", skillId: "hector4", targets: [] });
  assert.equal(pm.ok, true, `Protect Me! should cast (reason: ${pm.reason})`);
  assert.equal(findStatus(hector, "mark", "Protect Me!")?.duration, 1, "Protect Me! is armed for 1 turn");

  const hHp = hector.hp, dHp = dennis.hp;
  const r = performAction(state, { unit: enemy.id, skillId: "zap", targets: ["h"] });
  assert.equal(r.ok, true, "the enemy's harmful skill is declared");
  assert.equal(hector.hp, hHp, "Hector takes no damage — the harmful skill was reflected away");
  assert.equal(dHp - dennis.hp, 20, "Dennis takes the reflected damage instead");
});

test("hector4: without Protect Me!, the harmful skill hits Hector (control)", () => {
  const enemy = enemyWithZap();
  const hector = loadHero(heroById("hector"), "A", "h");
  const state = makeState([hector], [enemy]);
  startRound(state, "A");
  state.teams.B.energy = { generic: 40, fire: 40 };
  const dennis = getDennis(state);

  const hHp = hector.hp, dHp = dennis.hp;
  const r = performAction(state, { unit: enemy.id, skillId: "zap", targets: ["h"] });
  assert.equal(r.ok, true);
  assert.equal(hHp - hector.hp, 20, "with no reflect armed, Hector takes the damage");
  assert.equal(dennis.hp, dHp, "Dennis is untouched");
});

test("hector4: Protect Me! reflects only HARMFUL skills — a Strategic skill still lands on Hector", () => {
  const enemy = enemyWithZap();
  const hector = loadHero(heroById("hector"), "A", "h");
  const state = makeState([hector], [enemy]);
  startRound(state, "A");
  state.teams.A.energy = { generic: 40, poison: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  const dennis = getDennis(state);

  performAction(state, { unit: "h", skillId: "hector4", targets: [] }); // arm Protect Me!
  const r = performAction(state, { unit: enemy.id, skillId: "hex", targets: ["h"] });
  assert.equal(r.ok, true);
  assert.ok(findStatus(hector, "mark", "Hex"), "a non-harmful skill is NOT reflected — its mark lands on Hector");
  assert.equal(findStatus(dennis, "mark", "Hex"), undefined, "…and not on Dennis");
});

// =========================================================================
// hector5 — "Serum Overload": refresh all Serums to 3 turns, strip their negatives; revive dead minion Dennis at 50
// =========================================================================

test("hector5: Serum Overload refreshes Burning Blood to 3 turns and removes its self-damage dot", () => {
  const { state, dennis } = setup();
  castSerum(state, "hector1", dennis.id);
  const odm = findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum")!;
  const dot = findStatus(dennis, "dot", "Burning Blood Serum")!;
  assert.ok(odm && dot, "Burning Blood applied both its boon and its dot");
  odm.duration = 1; // simulate decay so the refresh is observable
  dot.duration = 1;
  const stk = findStatus(dennis, "stack", "Burning Blood Serum");
  if (stk) stk.duration = 1;

  const r = performAction(state, { unit: "h", skillId: "hector5", targets: [] });
  assert.equal(r.ok, true, `Serum Overload should cast (reason: ${r.reason})`);

  assert.equal(findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum")?.duration, 3, "the boon is refreshed to 3 turns");
  assert.equal(findStatus(dennis, "dot", "Burning Blood Serum"), undefined, "the self-damage dot (a negative effect) is removed");
});

test("hector5: Serum Overload refreshes Stoneseal and removes its Generic cost penalty", () => {
  const { state, dennis } = setup();
  castSerum(state, "hector2", dennis.id);
  const regen = findStatus(dennis, "regen", "Stoneseal Serum")!;
  assert.ok(regen, "Stoneseal applied its regen");
  regen.duration = 1;
  assert.equal(effectiveCost(dennis, lumberingSmash(dennis), state).generic, 1, "the cost penalty is active before overload");

  const r = performAction(state, { unit: "h", skillId: "hector5", targets: [] });
  assert.equal(r.ok, true, `Serum Overload should cast (reason: ${r.reason})`);

  assert.equal(findStatus(dennis, "regen", "Stoneseal Serum")?.duration, 3, "regen refreshed to 3 turns");
  assert.equal(findStatus(dennis, "cost_mod", "Stoneseal Serum"), undefined, "the +1 Generic cost penalty is removed");
  assert.equal(effectiveCost(dennis, lumberingSmash(dennis), state).generic, 0, "…so Dennis's cost is back to baseline");
});

test("hector5: Serum Overload refreshes Mindfog and removes its cooldown penalty", () => {
  const { state, dennis } = setup();
  castSerum(state, "hector3", dennis.id);
  const mark = findStatus(dennis, "mark", "Mindfog Serum")!;
  assert.ok(mark, "Mindfog applied its mark");
  mark.duration = 1;
  const baseCd = effectiveCooldown(dennis, lumberingSmash(dennis));
  assert.ok(baseCd >= 1, "the +1 cooldown penalty is active before overload");

  const r = performAction(state, { unit: "h", skillId: "hector5", targets: [] });
  assert.equal(r.ok, true, `Serum Overload should cast (reason: ${r.reason})`);

  assert.equal(findStatus(dennis, "mark", "Mindfog Serum")?.duration, 3, "Mindfog refreshed to 3 turns");
  assert.equal(findStatus(dennis, "cooldown_mod"), undefined, "the +1 cooldown penalty is removed");
});

test("hector5: Serum Overload revives a dead minion Dennis with 50 HP", () => {
  const { state, dennis } = setup();
  dennis.hp = 0;
  dennis.alive = false; // Dennis died as a minion, still on the field
  const r = performAction(state, { unit: "h", skillId: "hector5", targets: [] });
  assert.equal(r.ok, true, `Serum Overload should cast (reason: ${r.reason})`);
  assert.equal(dennis.alive, true, "dead minion Dennis returns to life");
  assert.equal(dennis.hp, 50, "…with 50 HP");
});

test("hector5: Serum Overload does not revive a living Dennis (control)", () => {
  const { state, dennis } = setup();
  dennis.hp = 30; // alive, wounded
  const r = performAction(state, { unit: "h", skillId: "hector5", targets: [] });
  assert.equal(r.ok, true, `Serum Overload should cast (reason: ${r.reason})`);
  assert.equal(dennis.alive, true, "still alive");
  assert.equal(dennis.hp, 30, "a living Dennis is NOT set to 50 HP by the revive clause");
});
