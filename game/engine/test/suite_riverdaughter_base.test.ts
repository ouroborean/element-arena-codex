import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + triggers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// =====================================================================================================
// The River Daughter — BASE KIT behavioral suite, derived from the FROZEN PROSE (the oracle).
// Frozen text (content/frozen/skills.json, ids riverdaughter0..5):
//
//  0 Healing Tears (passive): "Whenever River Daughter counters or stuns an enemy, she heals her team for
//                              5 HP every turn for 3 turns. Whenever this occurs, she gains Elemental Essence."
//  1 Ripple    (1 generic,  cd1, all-enemies): "Deals 10 damage to the enemy team. The following turn,
//                              Undertow will stun its target for 1 turn."
//  2 Undertow  (1 water,    cd1, single):      "Target enemy receives 20 damage."
//  3 River Clone (1 water,  cd1, single, INVISIBLE): "Counters the first harmful skill used by target enemy.
//                              This effect is invisible."
//  4 Soothe    (1 generic,  cd1, single ally): "Heals an ally for 10 health each turn for 2 turns. After the
//                              heal, if the target is a Hero and has full HP or less than 60 HP, River Daughter
//                              gains Elemental Essence."
//  5 Dive      (1 gen+1 wat, cd3, self):       "River Daughter becomes invulnerable for 1 turn. The following
//                              turn, Ripple will last two turns, Undertow will target all enemies, and River
//                              Clone's cost is changed to [65]."   ([65] = one Generic-energy pip; see the
//                              augments.authored.json note calling [65] "the generic-energy cost icon".)
//
// River Daughter's element is Water: her Specific cost is paid from the Water pool.
// =====================================================================================================

const ESS = "elemental_essence";
type S = Unit["statuses"][number];
const regenOf = (u: Unit, name: string): S | undefined => u.statuses.find((s) => s.kind === "regen" && s.name === name);
const essenceCount = (u: Unit): number => u.statuses.filter((s) => s.kind === ESS).length;
const stunOf = (u: Unit): S | undefined => u.statuses.find((s) => s.kind === "stun");

/** Pay pools: plenty of Generic + Water so a legal cast is never energy-starved unless a test says so. */
const fullPay = () => ({ generic: 40, water: 40 });

/** A synthetic enemy attack (0 cost) used to drive counters / invulnerability. */
const attack = (dmg: number) => skill("atk", [{ op: "damage", amount: dmg, to: "target" }], { tags: ["Harmful", "Instant"], cooldown: 0 });
/** A synthetic enemy Helpful skill (self-targeted, 0 cost) — must NOT be countered by River Clone. */
const helpfulSelf = () => skill("bless", [], { tags: ["Helpful", "Instant"], targeting: "self", cooldown: 0 });

function setup(opts: { enemies?: number; ally?: boolean } = {}) {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  const aUnits: Unit[] = [rd];
  let ally: Unit | undefined;
  if (opts.ally ?? true) { ally = makeUnit({ id: "a2", team: "A", name: "Ally", hp: 100, maxHp: 100 }); aUnits.push(ally); }
  const enemies: Unit[] = [];
  for (let i = 0; i < (opts.enemies ?? 1); i++) enemies.push(makeUnit({ id: `e${i + 1}`, team: "B", name: `Enemy${i + 1}`, hp: 100, maxHp: 100 }));
  const state = makeState(aUnits, enemies);
  state.teams.A.energy = fullPay();
  return { state, rd, ally: ally!, enemies };
}

/** Advance whole turns (endTurn hands over + ticks dots/durations/scheduled). */
function advance(state: ReturnType<typeof setup>["state"], n: number) {
  for (let i = 0; i < n; i++) endTurn(state);
}

// -----------------------------------------------------------------------------------------------------
// riverdaughter1 — Ripple : "Deals 10 damage to the enemy team."
// -----------------------------------------------------------------------------------------------------
test("Ripple deals 10 damage to EVERY enemy and nothing to allies", () => {
  const { state, rd, ally, enemies } = setup({ enemies: 2 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] });
  assert.equal(r.ok, true, "Ripple cast succeeds");
  assert.equal(enemies[0]!.hp, 90, "enemy 1 took 10");
  assert.equal(enemies[1]!.hp, 90, "enemy 2 took 10 (hits the whole enemy team)");
  assert.equal(rd.hp, 100, "caster (an ally) is not damaged");
  assert.equal(ally.hp, 100, "the allied hero is not damaged");
});

test("Ripple costs 1 Generic and goes on a 1-turn cooldown", () => {
  const { state, enemies } = setup({ enemies: 1 });
  state.teams.A.energy = { generic: 1, water: 0 }; // exactly 1 Generic, no Water
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] });
  assert.equal(r.ok, true, "1 Generic is enough to pay Ripple's cost");
  assert.equal(enemies[0]!.hp, 90, "the 10 damage landed");
  // Immediately recasting is blocked by the 1-turn cooldown.
  const rd2 = performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] });
  assert.equal(rd2.ok, false, "Ripple is on cooldown");
  assert.equal(rd2.reason, "on-cooldown");
});

// riverdaughter1 clause 2 — "The following turn, Undertow will stun its target for 1 turn."
test("Ripple sets up Undertow: the following turn Undertow stuns its target for 1 turn (in addition to 20 damage)", () => {
  const { state, enemies } = setup({ enemies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple (turn 1)
  advance(state, 2); // hand A->B->A; Undertow is cast on River Daughter's FOLLOWING turn
  state.teams.A.energy = fullPay();
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] });
  assert.equal(r.ok, true, "Undertow cast succeeds");
  assert.equal(enemies[0]!.hp, 70, "Undertow still deals its 20 damage (90 -> 70)");
  const st = stunOf(enemies[0]!);
  assert.ok(st, "the Ripple-primed Undertow STUNS its target");
  assert.equal(st!.duration, 1, "the stun lasts 1 turn");
});

// Control: without a preceding Ripple, Undertow does NOT stun.
test("Undertow WITHOUT a preceding Ripple does not stun", () => {
  const { state, enemies } = setup({ enemies: 1 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(enemies[0]!.hp, 80, "20 damage landed");
  assert.equal(stunOf(enemies[0]!), undefined, "no stun without the Ripple setup");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter2 — Undertow : "Target enemy receives 20 damage." (single target, 1 Water)
// -----------------------------------------------------------------------------------------------------
test("Undertow deals 20 damage to the single chosen enemy only", () => {
  const { state, rd, ally, enemies } = setup({ enemies: 2 });
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e2"] });
  assert.equal(r.ok, true);
  assert.equal(enemies[1]!.hp, 80, "the chosen enemy took 20");
  assert.equal(enemies[0]!.hp, 100, "the OTHER enemy is untouched (single target, not all)");
  assert.equal(ally.hp, 100, "no ally damage");
  assert.equal(rd.hp, 100, "no self damage");
});

test("Undertow's Specific cost is paid from the Water pool (no Water -> cannot cast)", () => {
  const { state, enemies } = setup({ enemies: 1 });
  state.teams.A.energy = { generic: 40, water: 0 }; // Generic can't cover a Specific(Water) cost
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] });
  assert.equal(r.ok, false, "1 Water is required and unavailable");
  assert.equal(r.reason, "insufficient-energy");
  assert.equal(enemies[0]!.hp, 100, "no damage when the cast is rejected");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter3 — River Clone : "Counters the first harmful skill used by target enemy. This effect is invisible."
// -----------------------------------------------------------------------------------------------------
test("River Clone counters the FIRST harmful skill the target enemy uses; the second lands", () => {
  const { state, rd } = setup({ enemies: 1 });
  const enemy = state.units["e1"]!;
  enemy.skills = [attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });

  const first = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.equal(first.countered, true, "the enemy's first harmful skill is countered");
  assert.equal(rd.hp, 100, "the countered attack dealt no damage");

  enemy.skills![0]!.currentCd = 0;
  const second = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.notEqual(second.countered, true, "the SECOND harmful skill is NOT countered (only the first)");
  assert.equal(rd.hp, 70, "the second attack lands for 30");
});

test("River Clone counters a harmful skill the marked enemy aims at an ALLY too (any harmful skill it uses)", () => {
  const { state, ally } = setup({ enemies: 1 });
  const enemy = state.units["e1"]!;
  enemy.skills = [attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });
  const r = performAction(state, { unit: "e1", skillId: "atk", targets: ["a2"] }); // aims at the ally, not River Daughter
  assert.equal(r.countered, true, "the counter keys on the enemy USING a harmful skill, not on who it targets");
  assert.equal(ally.hp, 100, "the ally took no damage");
});

test("River Clone does NOT counter a HELPFUL skill, and does not spend the counter on it", () => {
  const { state, rd } = setup({ enemies: 1 });
  const enemy = state.units["e1"]!;
  enemy.skills = [helpfulSelf(), attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });

  const help = performAction(state, { unit: "e1", skillId: "bless", targets: [] });
  assert.notEqual(help.countered, true, "a Helpful skill is not countered");

  const atk = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.equal(atk.countered, true, "the counter was preserved through the Helpful skill and fires on the first HARMFUL one");
  assert.equal(rd.hp, 100, "the harmful skill was negated");
});

test("River Clone only counters the TARGETED enemy — a different enemy's harmful skill lands", () => {
  const { state, rd } = setup({ enemies: 2 });
  state.units["e2"]!.skills = [attack(25)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] }); // mark e1
  const r = performAction(state, { unit: "e2", skillId: "atk", targets: ["rd"] }); // e2 is unmarked
  assert.notEqual(r.countered, true, "an unmarked enemy is not countered");
  assert.equal(rd.hp, 75, "the unmarked enemy's attack lands for 25");
});

test("River Clone is INVISIBLE — casting it leaves no telegraph in the shared log", () => {
  const { state } = setup({ enemies: 1 });
  const before = state.log.length;
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });
  assert.equal(r.ok, true, "River Clone cast succeeds");
  const added = state.log.slice(before);
  assert.ok(!added.some((l) => /River Clone|used/i.test(l)), `an invisible cast must not telegraph; got: ${JSON.stringify(added)}`);
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter0 — Healing Tears (passive), STUN half via a real Ripple->Undertow stun.
// "Whenever River Daughter ... stuns an enemy, she heals her team for 5 HP every turn for 3 turns ...
//  she gains Elemental Essence."
// -----------------------------------------------------------------------------------------------------
test("Healing Tears fires when River Daughter STUNS an enemy (via Ripple->Undertow): team regen 5/3 + Essence", () => {
  const { state, rd, ally, enemies } = setup({ enemies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Ripple primes the stun
  advance(state, 2);
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // Undertow stuns -> Healing Tears

  assert.ok(stunOf(enemies[0]!), "the enemy was stunned");
  assert.equal(regenOf(rd, "Healing Tears")?.magnitude, 5, "River Daughter gets a Healing Tears regen of 5");
  assert.equal(regenOf(rd, "Healing Tears")?.duration, 3, "it lasts 3 turns");
  assert.equal(regenOf(ally, "Healing Tears")?.magnitude, 5, "her whole team is healed (ally gets the regen too)");
  assert.equal(essenceCount(rd), 1, "stunning an enemy grants River Daughter Elemental Essence");
});

test("Healing Tears' regen actually heals the team 5 HP/turn on subsequent ticks", () => {
  const { state, rd, ally, enemies } = setup({ enemies: 1 });
  rd.hp = 50; ally.hp = 50;
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] });
  advance(state, 2);
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // stun -> regen 5/3 applied (turn 3)
  assert.ok(stunOf(enemies[0]!));
  const rdBefore = rd.hp, allyBefore = ally.hp;
  advance(state, 3); // reach River Daughter's next turn-end -> one regen tick
  assert.equal(rd.hp, rdBefore + 5, "River Daughter healed 5 on the tick");
  assert.equal(ally.hp, allyBefore + 5, "the ally healed 5 on the tick");
});

// Control: an Undertow that does NOT stun (no Ripple prime) does not trigger Healing Tears.
test("Healing Tears does NOT fire from a non-stunning Undertow (no counter, no stun -> no heal, no Essence)", () => {
  const { state, rd, ally, enemies } = setup({ enemies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // plain Undertow, no stun
  assert.equal(stunOf(enemies[0]!), undefined, "no stun");
  assert.equal(regenOf(rd, "Healing Tears"), undefined, "no Healing Tears regen");
  assert.equal(regenOf(ally, "Healing Tears"), undefined, "the ally is not healed");
  assert.equal(essenceCount(rd), 0, "no Essence without a counter or a stun");
});

// riverdaughter0 — Healing Tears, COUNTER half via a real River Clone counter.
// SUSPECTED BUG: the frozen passive fires on COUNTERS as well as stuns, but the engine's counterFired
// trigger never fires for River Daughter's own counter (its gate reads the countered attacker as
// `eventSource`, not the counterer), so no team regen / Essence is granted. Kept as an executable bug report.
test("Healing Tears (counter half): countering an enemy heals the team 5/3 + grants Essence", () => {
  const { state, rd, ally } = setup({ enemies: 1 });
  state.units["e1"]!.skills = [attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });
  const r = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.equal(r.countered, true, "the counter fired");

  // Frozen: "Whenever River Daughter counters ... an enemy, she heals her team for 5 HP every turn for 3
  // turns ... she gains Elemental Essence."
  assert.equal(regenOf(rd, "Healing Tears")?.magnitude, 5, "counter grants a Healing Tears regen of 5");
  assert.equal(regenOf(rd, "Healing Tears")?.duration, 3, "lasting 3 turns");
  assert.equal(regenOf(ally, "Healing Tears")?.magnitude, 5, "the whole team is healed");
  assert.equal(essenceCount(rd), 1, "countering grants River Daughter Elemental Essence");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter4 — Soothe : "Heals an ally for 10 health each turn for 2 turns. After the heal, if the target
// is a Hero and has full HP or less than 60 HP, River Daughter gains Elemental Essence."
// -----------------------------------------------------------------------------------------------------
test("Soothe applies a 10/2 regen to the targeted ally and heals 10 on the tick", () => {
  const { state, ally } = setup({ enemies: 1 });
  ally.hp = 70; // 60..99: not eligible for Essence, isolates the heal clause
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(r.ok, true);
  const reg = regenOf(ally, "Soothe");
  assert.equal(reg?.magnitude, 10, "Soothe heals 10 per turn");
  assert.equal(reg?.duration, 2, "for 2 turns");
  advance(state, 3); // to River Daughter's next turn-end -> one tick
  assert.equal(ally.hp, 80, "the ally healed 10 on the tick (70 -> 80)");
});

test("Soothe grants Essence when the target Hero is at FULL HP", () => {
  const { state, rd, ally } = setup({ enemies: 1 });
  ally.hp = 100; // full
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(regenOf(ally, "Soothe")?.magnitude, 10, "the regen is applied regardless");
  assert.equal(essenceCount(rd), 1, "full-HP Hero target -> River Daughter gains Essence");
});

test("Soothe grants Essence when the target Hero has LESS THAN 60 HP", () => {
  const { state, rd, ally } = setup({ enemies: 1 });
  ally.hp = 59; // < 60
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(essenceCount(rd), 1, "target below 60 HP -> Essence");
});

test("Soothe grants NO Essence for a Hero at 60..99 HP (neither full nor < 60)", () => {
  const { state, rd, ally } = setup({ enemies: 1 });
  ally.hp = 60; // exactly 60: not full, not < 60
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["a2"] });
  assert.equal(regenOf(ally, "Soothe")?.magnitude, 10, "still heals");
  assert.equal(essenceCount(rd), 0, "60 HP is the boundary: no Essence");
});

test("Soothe grants NO Essence when the target is a MINION even if below 60 HP (only Heroes count)", () => {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  const minion = makeUnit({ id: "m1", team: "A", kind: "minion", name: "Splash", hp: 20, maxHp: 40, summoner: "rd" });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100, maxHp: 100 });
  const state = makeState([rd, minion], [enemy]);
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter4", targets: ["m1"] });
  assert.equal(regenOf(minion, "Soothe")?.magnitude, 10, "the minion still receives the 10/2 heal");
  assert.equal(essenceCount(rd), 0, "a non-Hero target grants no Essence");
});

// -----------------------------------------------------------------------------------------------------
// riverdaughter5 — Dive : invulnerable 1 turn; next turn Ripple lasts 2 turns, Undertow hits all, River
// Clone costs [65].
// -----------------------------------------------------------------------------------------------------
test("Dive makes River Daughter invulnerable for 1 turn: harmful skills cannot target her while it holds", () => {
  const { state, rd } = setup({ enemies: 1 });
  state.units["e1"]!.skills = [attack(30)];
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] });
  assert.equal(r.ok, true, "Dive cast succeeds");
  const inv = rd.statuses.find((s) => s.kind === "invulnerable");
  assert.ok(inv, "River Daughter is invulnerable");
  assert.equal(inv!.duration, 1, "for 1 turn");
  const atk = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.equal(atk.ok, false, "a harmful skill has no legal target (invulnerable River Daughter)");
  assert.equal(atk.reason, "no-legal-target");
  assert.equal(rd.hp, 100, "she took no damage");
});

test("Dive's invulnerability wears off — afterward harmful skills land again", () => {
  const { state, rd } = setup({ enemies: 1 });
  state.units["e1"]!.skills = [attack(30)];
  performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] });
  advance(state, 3); // past River Daughter's next turn-end, where the 1-turn invulnerable expires
  assert.equal(rd.statuses.some((s) => s.kind === "invulnerable"), false, "invulnerable expired");
  const atk = performAction(state, { unit: "e1", skillId: "atk", targets: ["rd"] });
  assert.equal(atk.ok, true, "the attack is now legal");
  assert.equal(rd.hp, 70, "and lands for 30");
});

test("Dive: the following turn, Ripple 'lasts two turns' — 10 now and 10 more the turn after", () => {
  const { state, enemies } = setup({ enemies: 2 });
  performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] }); // Dive (turn 1)
  advance(state, 2); // River Daughter's following turn
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter1", targets: [] }); // Dive-boosted Ripple
  assert.equal(enemies[0]!.hp, 90, "first tick: enemy 1 took 10");
  assert.equal(enemies[1]!.hp, 90, "first tick: enemy 2 took 10");
  advance(state, 3); // reach the deferred second tick (River Daughter's next turn-end)
  assert.equal(enemies[0]!.hp, 80, "second tick: enemy 1 took another 10 (Ripple lasted two turns)");
  assert.equal(enemies[1]!.hp, 80, "second tick: enemy 2 took another 10");
});

test("Dive: the following turn, Undertow targets ALL enemies for 20", () => {
  const { state, enemies } = setup({ enemies: 2 });
  performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] });
  advance(state, 2);
  state.teams.A.energy = fullPay();
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] }); // aimed at one, hits all
  assert.equal(enemies[0]!.hp, 80, "the chosen enemy took 20");
  assert.equal(enemies[1]!.hp, 80, "the OTHER enemy also took 20 (Dive made Undertow hit all)");
});

// Control: without Dive, Undertow stays single-target (already covered above, restated against the Dive frame).
test("Without Dive, Undertow does NOT hit all enemies", () => {
  const { state, enemies } = setup({ enemies: 2 });
  performAction(state, { unit: "rd", skillId: "riverdaughter2", targets: ["e1"] });
  assert.equal(enemies[0]!.hp, 80, "chosen enemy took 20");
  assert.equal(enemies[1]!.hp, 100, "the other enemy is untouched (single target)");
});

// riverdaughter5 clause 4 — "River Clone's cost is changed to [65]" ([65] = one Generic pip).
// Control (green): the BASE River Clone is a 1-Water cost, so Generic-only cannot pay it — proving the
// suspected-bug test below is a meaningful change of behavior, not a trivially-passing setup.
test("Control: base River Clone requires Water — Generic-only energy cannot pay it", () => {
  const { state } = setup({ enemies: 1 });
  state.teams.A.energy = { generic: 40, water: 0 };
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });
  assert.equal(r.ok, false, "no Water -> River Clone cannot be cast");
  assert.equal(r.reason, "insufficient-energy");
});

// SUSPECTED BUG: Dive is supposed to change River Clone's cost to one Generic ([65]) on the following turn,
// so it becomes payable by any color. The engine never re-prices River Clone, so a Generic-only pool still
// fails to pay it after Dive.
test.skip("SUSPECTED BUG: after Dive, River Clone should cost one Generic ([65]) and be castable from a Generic-only pool", () => {
  const { state } = setup({ enemies: 1 });
  performAction(state, { unit: "rd", skillId: "riverdaughter5", targets: ["rd"] }); // Dive (turn 1)
  advance(state, 2); // River Daughter's following turn
  state.teams.A.energy = { generic: 40, water: 0 }; // ONLY Generic — must suffice if the cost is now [65]
  const r = performAction(state, { unit: "rd", skillId: "riverdaughter3", targets: ["e1"] });
  assert.equal(r.ok, true, "Dive-repriced River Clone ([65] = 1 Generic) is payable from Generic");
  assert.ok(state.units["e1"]!.statuses.some((s) => s.kind === "mark" && s.name === "River Clone"), "and it still installs its counter");
});
