import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceCooldowns,
  canPay,
  endRound,
  endTurn,
  grantIncome,
  performAction,
  roundWinner,
  startRound,
  startTurn,
} from "../src/scheduler.ts";
import { applyStatus } from "../src/status.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

const atk = (dmg: number, over = {}) => skill("atk", [{ op: "damage", amount: dmg, to: "target" }], over);

test("energy: shared pool pays specific from element + generic from anything", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [atk(10, { cost: { generic: 1, specific: 1 } })] });
  const target = makeUnit({ id: "b1", team: "B", hp: 100 });
  const state = makeState([caster], [target]);
  state.teams.A.energy = { fire: 1, water: 1 }; // 1 fire (specific) + 1 water (covers generic)

  const r = performAction(state, { unit: "a1", skillId: "atk", targets: ["b1"] });
  assert.equal(r.ok, true);
  assert.equal(target.hp, 90);
  assert.equal(state.teams.A.energy.fire, 0);
  assert.equal(state.teams.A.energy.water, 0);
});

test("energy: insufficient specific is rejected", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [atk(10, { cost: { generic: 0, specific: 1 } })] });
  const state = makeState([caster], [makeUnit({ id: "b1", team: "B" })]);
  state.teams.A.energy = { generic: 5, water: 5 }; // no fire (the caster's element)
  const r = performAction(state, { unit: "a1", skillId: "atk", targets: ["b1"] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "insufficient-energy");
});

test("canPay: generic is covered by any energy type", () => {
  assert.equal(canPay({ fire: 2 }, "fire", { generic: 2, specific: 0 }), true);
  assert.equal(canPay({ fire: 1 }, "fire", { generic: 2, specific: 0 }), false);
  assert.equal(canPay({ fire: 1, water: 2 }, "fire", { generic: 1, specific: 1 }), true);
});

test("cooldown: set on use, blocks reuse, SKIPS its birth turn, then advances (gated by Paralysis)", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [atk(10, { cooldown: 2 })] });
  const state = makeState([caster], [makeUnit({ id: "b1", team: "B", hp: 100 })]);

  assert.equal(performAction(state, { unit: "a1", skillId: "atk", targets: ["b1"] }).ok, true);
  assert.equal(caster.skills![0]!.currentCd, 2);
  assert.equal(performAction(state, { unit: "a1", skillId: "atk", targets: ["b1"] }).reason, "on-cooldown");

  // The cooldown does NOT tick on the turn it was set (its birth turn) — like status durations.
  advanceCooldowns(state, "A");
  assert.equal(caster.skills![0]!.currentCd, 2, "birth turn is skipped");

  // A later turn: now it ticks down.
  state.turn += 1;
  advanceCooldowns(state, "A");
  assert.equal(caster.skills![0]!.currentCd, 1);

  state.turn += 1;
  applyStatus(caster, status("paralysis", { duration: 3 }));
  advanceCooldowns(state, "A");
  assert.equal(caster.skills![0]!.currentCd, 1, "paralysis freezes cooldowns");
});

test("cooldown 1 blocks the caster's NEXT turn, then frees the turn after (real turn cycle)", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [atk(10, { cooldown: 1 })] });
  const state = makeState([caster], [makeUnit({ id: "b1", team: "B", hp: 100 })]);
  const cd = () => caster.skills![0]!.currentCd;
  const use = () => performAction(state, { unit: "a1", skillId: "atk", targets: ["b1"] });

  startTurn(state);                              // A turn 1
  assert.equal(use().ok, true);
  endTurn(state);
  assert.equal(cd(), 1, "not ticked on the use turn (birth skip)");

  startTurn(state); endTurn(state);              // B turn

  startTurn(state);                              // A turn 2 — STILL on cooldown (this is the bug that was fixed)
  assert.equal(use().reason, "on-cooldown");
  endTurn(state);
  assert.equal(cd(), 0, "ticks down at the end of the caster's next turn");

  startTurn(state); endTurn(state);              // B turn

  startTurn(state);                              // A turn 3 — usable again
  assert.equal(use().ok, true, "usable the turn after a cooldown-1 skill");
});

test("stun: 'non-Strategic' scope stops harmful skills but not Strategic ones (Flashbang)", () => {
  const caster = makeUnit({
    id: "a1",
    team: "A",
    skills: [
      atk(10, { tags: ["Harmful", "Instant"] }),
      skill("meditate", [{ op: "heal", amount: 5, to: "self" }], { tags: ["Strategic", "Instant"] }),
    ],
  });
  const state = makeState([caster], [makeUnit({ id: "b1", team: "B", hp: 100 })]);

  // Flashbang stuns "non-Strategic skills": scope Strategic/except.
  applyStatus(caster, status("stun", { scope: { tag: "Strategic", mode: "except" }, duration: 1 }));
  assert.equal(performAction(state, { unit: "a1", skillId: "atk", targets: ["b1"] }).reason, "stunned");
  assert.equal(performAction(state, { unit: "a1", skillId: "meditate" }).ok, true, "Strategic still usable");

  caster.statuses = [];
  applyStatus(caster, status("stun", { duration: 1 })); // unscoped
  assert.equal(performAction(state, { unit: "a1", skillId: "meditate" }).reason, "stunned");
});

test("income: 1/hero — Essence SWAPS generic→element and is consumed; Silence keeps generic+charge; dead give nothing", () => {
  // Slots 0 and 2 so neither test hero is the middle (slot 1), whose permanent essence is covered separately.
  const h1 = makeUnit({ id: "a1", team: "A", slot: 0, currentElement: "fire", statuses: [status("elemental_essence")] });
  const h2 = makeUnit({ id: "a2", team: "A", slot: 2 });
  const dead = makeUnit({ id: "a3", team: "A", slot: 1, alive: false, hp: 0 });
  const state = makeState([h1, h2, dead], [makeUnit({ id: "b1", team: "B", slot: 0 })]);

  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.generic, 1, "only the non-essence hero yields generic");
  assert.equal(state.teams.A.energy.fire, 1, "essence hero yields 1 fire INSTEAD of generic");
  assert.ok(!h1.statuses.some((s) => s.kind === "elemental_essence"), "the essence charge is consumed");

  // Silenced essence-holder: falls back to generic and RETAINS the charge.
  h1.statuses.push(status("elemental_essence"), status("silence"));
  state.teams.A.energy = {};
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.fire, undefined, "silence suppresses the swap");
  assert.equal(state.teams.A.energy.generic, 2, "both heroes yield generic");
  assert.ok(h1.statuses.some((s) => s.kind === "elemental_essence"), "silenced hero keeps its charge");
});

test("income: the MIDDLE hero (slot 1) always yields its element — no charge, never consumed, unless Silenced", () => {
  const mid = makeUnit({ id: "a2", team: "A", slot: 1, currentElement: "water" });
  const edge = makeUnit({ id: "a1", team: "A", slot: 0 });
  const state = makeState([edge, mid], [makeUnit({ id: "b1", team: "B", slot: 0 })]);

  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.water, 1, "middle hero yields 1 of its element with no charge");
  assert.equal(state.teams.A.energy.generic, 1, "the edge hero still yields generic");

  // Permanent: a second turn yields element again (nothing was consumed).
  state.teams.A.energy = {};
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.water, 1, "still elemental the next turn");

  // Silence suppresses even the middle-slot source.
  mid.statuses.push(status("silence"));
  state.teams.A.energy = {};
  grantIncome(state, "A");
  assert.equal(state.teams.A.energy.water, undefined, "silenced middle hero falls back to generic");
  assert.equal(state.teams.A.energy.generic, 2);
});

test('debuff "for 1 turn" survives the opponent\'s turn, expires at applier\'s next turn-end', () => {
  const a1 = makeUnit({ id: "a1", team: "A" });
  const b1 = makeUnit({ id: "b1", team: "B", skills: [atk(10)] });
  const state = makeState([a1], [b1]); // turn 1, active A

  applyStatus(b1, status("stun", { duration: 1, appliedBy: "a1", appliedTurn: state.turn }));

  endTurn(state); // A's turn 1 ends (birth turn) — no tick
  assert.equal(b1.statuses.length, 1);
  endTurn(state); // B's turn 2 ends — not A's status
  assert.equal(b1.statuses.length, 1, "still stunned through opponent's turn");
  endTurn(state); // A's turn 3 ends — expires
  assert.equal(b1.statuses.length, 0);
});

test("a 1v1 round plays to a win condition, deterministically", () => {
  function playMatch() {
    const a1 = makeUnit({ id: "a1", team: "A", name: "A-hero", hp: 100, skills: [atk(25)] });
    const b1 = makeUnit({ id: "b1", team: "B", name: "B-hero", hp: 100, skills: [atk(20)] });
    const state = makeState([a1], [b1]);
    startRound(state, "A");
    let winner = null as string | null;
    for (let i = 0; i < 100 && !winner; i++) {
      startTurn(state);
      const active = state.activeTeam;
      const attacker = active === "A" ? "a1" : "b1";
      const victim = active === "A" ? "b1" : "a1";
      performAction(state, { unit: attacker, skillId: "atk", targets: [victim] });
      winner = roundWinner(state);
      if (!winner) endTurn(state);
    }
    return { winner, aHp: a1.hp, bHp: b1.hp, turns: state.turn };
  }
  const r1 = playMatch();
  const r2 = playMatch();
  // A deals 25 (4 hits kill), B deals 20; A acts first → A wins with 40 HP left.
  assert.equal(r1.winner, "A");
  assert.equal(r1.bHp, 0);
  assert.equal(r1.aHp, 40);
  assert.deepEqual(r1, r2, "fully deterministic");
});

test("3v3: a team is out only when all three heroes are dead", () => {
  const A = [1, 2, 3].map((i) => makeUnit({ id: `a${i}`, team: "A" }));
  const B = [1, 2, 3].map((i) => makeUnit({ id: `b${i}`, team: "B" }));
  const state = makeState(A, B);
  B[0]!.alive = false;
  B[1]!.alive = false;
  assert.equal(roundWinner(state), null, "one B hero still standing");
  B[2]!.alive = false;
  assert.equal(roundWinner(state), "A", "all three B heroes dead");
});

test("round reset restores HP + clears statuses + cooldowns; best-of-N ends the match", () => {
  const a1 = makeUnit({ id: "a1", team: "A", hp: 30, maxHp: 100, skills: [atk(10, { cooldown: 3 })] });
  a1.skills![0]!.currentCd = 3;
  applyStatus(a1, status("damage_reduction", { magnitude: 5, duration: 2 }));
  const state = makeState([a1], [makeUnit({ id: "b1", team: "B" })]);

  startRound(state, "A");
  assert.equal(a1.hp, 100, "HP reset");
  assert.equal(a1.statuses.length, 0, "statuses cleared");
  assert.equal(a1.skills![0]!.currentCd, 0, "cooldowns reset");

  assert.equal(endRound(state, "A", 3), null, "1/3 rounds");
  endRound(state, "A", 3);
  assert.equal(endRound(state, "A", 3), "A", "3/3 wins the match");
});
