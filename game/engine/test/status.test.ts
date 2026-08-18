import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStatus, stackCount, tickDurationsForTeam } from "../src/status.ts";
import type { MatchState, Unit } from "../src/types.ts";
import { makeUnit, status } from "./helpers.ts";

test("re-applying a status refreshes duration (DEFAULT_STACK_POLICY)", () => {
  const u = makeUnit();
  applyStatus(u, status("damage_reduction", { magnitude: 10, duration: 2 }));
  applyStatus(u, status("damage_reduction", { magnitude: 15, duration: 3 }));
  const drs = u.statuses.filter((s) => s.kind === "damage_reduction");
  assert.equal(drs.length, 1, "refresh, not duplicate");
  assert.equal(drs[0]?.magnitude, 15);
  assert.equal(drs[0]?.duration, 3);
});

test('"stack" resources accumulate a count', () => {
  const u = makeUnit();
  applyStatus(u, status("stack", { name: "Charge", magnitude: 1, duration: null }));
  applyStatus(u, status("stack", { name: "Charge", magnitude: 2, duration: null }));
  assert.equal(stackCount(u, "Charge"), 3);
  assert.equal(u.statuses.filter((s) => s.kind === "stack").length, 1);
});

test("different marks are independent slots", () => {
  const u = makeUnit();
  applyStatus(u, status("mark", { name: "Cinders", duration: 3 }));
  applyStatus(u, status("mark", { name: "Electroblade", duration: 2 }));
  assert.equal(u.statuses.filter((s) => s.kind === "mark").length, 2);
});

// DURATION_ANCHOR: applier's turn-end, but not on the turn of birth.
function miniState(applier: Unit, target: Unit, turn: number): MatchState {
  const units: Record<string, Unit> = { [applier.id]: applier, [target.id]: target };
  return {
    round: 1,
    turn,
    activeTeam: "A",
    units,
    teams: {
      A: { id: "A", units: [applier.id], energy: {}, roundsWon: 0 },
      B: { id: "B", units: [target.id], energy: {}, roundsWon: 0 },
    },
    rngState: 1,
    seed: 1,
    minionSeq: 0,
    scheduled: [],
    actedThisTurn: [],
    log: [],
  };
}

test('"for 1 turn" survives the opponent\'s turn, expires at applier\'s next turn-end', () => {
  const applier = makeUnit({ id: "a", team: "A" });
  const target = makeUnit({ id: "b", team: "B" });
  const state = miniState(applier, target, 4); // applier acts on turn 4

  // A stuns B "for 1 turn" during turn 4.
  applyStatus(target, status("stun", { duration: 1, appliedBy: "a", appliedTurn: 4 }));

  // End of A's turn 4 (birth turn): must NOT decrement.
  tickDurationsForTeam(state, "A");
  assert.equal(target.statuses[0]?.duration, 1, "not ticked on its birth turn");

  // B's turn 5 ends: it is A's status, so B's turn-end does not touch it.
  state.turn = 5;
  tickDurationsForTeam(state, "B");
  assert.equal(target.statuses.length, 1, "still active through opponent's turn");

  // A's next turn (6) ends: now it ticks 1 -> 0 and expires.
  state.turn = 6;
  const expired = tickDurationsForTeam(state, "A");
  assert.equal(target.statuses.length, 0, "expired at applier's next turn-end");
  assert.equal(expired.length, 1);
});

test("round-permanent statuses (duration null) never tick down", () => {
  const applier = makeUnit({ id: "a", team: "A" });
  const target = makeUnit({ id: "b", team: "B" });
  const state = miniState(applier, target, 2);
  applyStatus(target, status("damage_reduction", { magnitude: 5, duration: null, appliedBy: "a", appliedTurn: 1 }));
  state.turn = 4;
  tickDurationsForTeam(state, "A");
  assert.equal(target.statuses[0]?.duration, null);
});
