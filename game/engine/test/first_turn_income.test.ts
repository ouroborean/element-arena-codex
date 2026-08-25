/**
 * Two round-lifecycle rules:
 *  1. The player who goes FIRST in a round gets reduced opening income — exactly 1 energy of their CENTER
 *     hero's element (first-move compensation) — while the second player gets normal income.
 *  2. Conceding a round awards it to the opponent (roundWinner honors state.concededRound), and startRound
 *     clears the flag so it never bleeds into the next round.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatch } from "../content/match.ts";
import { startRound, startTurn, endTurn, roundWinner, poolTotal, MIDDLE_SLOT } from "../src/scheduler.ts";
import type { Unit } from "../src/types.ts";

const DRAFT = { A: ["pyrrha", "gommar", "jarrik"], B: ["keeper", "riverdaughter", "saya"], seed: 1 };
const center = (state: ReturnType<typeof buildMatch>, side: "A" | "B") =>
  state.teams[side].units.map((id) => state.units[id]).find((u): u is Unit => !!u && u.slot === MIDDLE_SLOT)!;

test("the first player's opening turn grants exactly 1 energy — their center hero's element", () => {
  const state = buildMatch(DRAFT);
  startRound(state); // round 1: activeTeam A, roundStartTurn = state.turn
  startTurn(state);
  const c = center(state, "A");
  assert.equal(poolTotal(state.teams.A.energy), 1, "exactly one pip");
  assert.equal(state.teams.A.energy[c.currentElement], 1, "and it is the center hero's element");
});

test("the second player gets NORMAL income (2 generic + 1 center element for a 3-hero team)", () => {
  const state = buildMatch(DRAFT);
  startRound(state);
  startTurn(state); // A — reduced
  endTurn(state); // → turn 2, activeTeam B
  startTurn(state); // B — normal
  assert.equal(poolTotal(state.teams.B.energy), 3, "three living heroes → three energy");
});

test("every new round's first player again gets the reduced opening income (+1, measured as a delta since the pool persists across rounds)", () => {
  const state = buildMatch(DRAFT);
  startRound(state);
  startTurn(state); // R1 A reduced
  endTurn(state);
  startTurn(state); // R1 B normal
  endTurn(state);
  startRound(state); // R2: roundStartTurn refreshed to the current turn, activeTeam A again
  const c = center(state, "A");
  const before = poolTotal(state.teams.A.energy);
  const beforeEl = state.teams.A.energy[c.currentElement] ?? 0;
  startTurn(state);
  assert.equal(poolTotal(state.teams.A.energy) - before, 1, "only +1 income in round 2");
  assert.equal((state.teams.A.energy[c.currentElement] ?? 0) - beforeEl, 1, "and it is the center hero's element");
});

test("conceding a round awards it to the opponent; startRound clears the flag", () => {
  const state = buildMatch(DRAFT);
  startRound(state);
  assert.equal(roundWinner(state), null, "no winner yet — both teams alive");
  state.concededRound = "A";
  assert.equal(roundWinner(state), "B", "A conceded → B wins the round");
  state.concededRound = "B";
  assert.equal(roundWinner(state), "A", "polarity: the conceding side loses");
  startRound(state);
  assert.equal(state.concededRound, undefined, "concede does not carry into the next round");
  assert.equal(roundWinner(state), null);
});
