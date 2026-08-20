import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { endTurn, startRound } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Engine-fidelity — Dennis "Pain Tolerance" Part B: "If Dennis is damaged, he gains 5 Damage Reduction until
// the end of his next turn. This effect STACKS, but does NOT REFRESH." Previously one shared duration-1 timer
// held all stacks (they expired together = a refresh). Now each hit adds a permanent stack and schedules its
// OWN -1 at Dennis's next turn-end, so every stack expires on its own clock.

const painStacks = (u: Unit): number => u.statuses.find((s) => s.kind === "stack" && s.name === "Pain Tolerance")?.magnitude ?? 0;
const painDR = (u: Unit): number => u.statuses.find((s) => s.kind === "damage_reduction" && s.name === "Pain Tolerance")?.magnitude ?? 0;

const hit = (state: ReturnType<typeof makeState>, targetId: string): void =>
  emit(state, { type: "damageDealt", source: "e", target: targetId, amount: 10, dtype: "normal", isNew: true });

test("Pain Tolerance stacks per hit; a single hit's DR lasts until Dennis's next turn-end, then clears", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B" })]); // turn 1, activeTeam A

  hit(state, "dennis");
  assert.equal(painStacks(dennis), 1, "one hit → one stack");
  assert.equal(painDR(dennis), 5, "DR = 5 x 1");

  endTurn(state); // A end (turn1): the -1 is birth-turn-skipped; turn→2, B active
  endTurn(state); // B end (turn2); turn→3, A active
  assert.equal(painStacks(dennis), 1, "stack still held through the opponent's turn");
  endTurn(state); // A end (turn3 = Dennis's next turn): this hit's scheduled -1 fires
  assert.equal(painStacks(dennis), 0, "expired at the end of his next turn");
  assert.equal(painDR(dennis), 0, "DR recomputed to 0");
});

test("does NOT refresh: a later hit expires on its OWN clock, not extending the earlier stack", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B" })]);

  hit(state, "dennis"); // hit #1 at turn 1 → stack 1, scheduled to drop at end of turn 3
  endTurn(state); endTurn(state); // → turn 3, A active (Dennis's next turn), #1's -1 not yet fired
  assert.equal(painStacks(dennis), 1, "stack #1 still present at the start of turn 3");

  hit(state, "dennis"); // hit #2 at turn 3 → stack 2, scheduled to drop at end of turn 5
  assert.equal(painStacks(dennis), 2, "both stacks held");
  assert.equal(painDR(dennis), 10, "DR = 5 x 2");

  endTurn(state); // A end (turn3): ONLY hit #1's -1 fires (a refresh would have kept both)
  assert.equal(painStacks(dennis), 1, "hit #1 expired independently; hit #2 remains");
  assert.equal(painDR(dennis), 5, "DR back to 5 x 1");

  endTurn(state); endTurn(state); // → end of turn 5 (Dennis's next turn): hit #2's -1 fires
  assert.equal(painStacks(dennis), 0, "hit #2 then expires on its own clock");
});

test("scheduled expiries are round-scoped: an unfired -1 does not leak into the next round", () => {
  const dennis = loadHero(heroById("dennis"), "A", "dennis");
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B" })]);

  hit(state, "dennis"); // schedules a -1 for a future turn
  assert.ok(state.scheduled.length >= 1, "a -1 is pending");

  startRound(state); // fresh battle clears statuses AND pending schedules (turn counter is monotonic)
  assert.equal(state.scheduled.length, 0, "pending schedules cleared at round start");
  assert.equal(painStacks(dennis), 0, "stacks cleared too");

  hit(state, "dennis"); // a fresh hit in the new round
  assert.equal(painStacks(dennis), 1, "one stack");
  endTurn(state); endTurn(state); endTurn(state); // → end of Dennis's next turn
  assert.equal(painStacks(dennis), 0, "the new stack expires exactly once — no stale -1 knocked it out early");
});
