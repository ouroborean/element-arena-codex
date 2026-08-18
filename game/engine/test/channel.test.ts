import { test } from "node:test";
import assert from "node:assert/strict";
import { endTurn, performAction, startTurn } from "../src/scheduler.ts";
import { applyStatus } from "../src/status.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

// A Channel skill: "each turn, deal 10 to all enemies" until interrupted.
const darken = (over = {}) =>
  skill("darken", [{ op: "damage", amount: 10, to: "target" }], {
    tags: ["Channel", "Harmful", "Instant"], targeting: "all-enemies", ...over,
  });
const isChanneling = (u: ReturnType<typeof makeUnit>) => u.statuses.some((s) => s.kind === "channeling");

/** Advance from team A's turn to team A's next turn (through B). */
function toNextATurn(state: ReturnType<typeof makeState>) {
  endTurn(state); // A -> B
  startTurn(state); endTurn(state); // B
  startTurn(state); // A again (runs channels)
}

test("a Channel skill re-runs on each of the caster's turns", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [darken()] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);

  startTurn(state);
  performAction(state, { unit: "a", skillId: "darken" });
  assert.equal(e.hp, 90, "initial cast");
  assert.ok(isChanneling(a));

  toNextATurn(state);
  assert.equal(e.hp, 80, "channel re-ran on the next A turn");
});

test("the channeling state is queryable by other skills", () => {
  const a = makeUnit({
    id: "a", team: "A",
    skills: [darken(), skill("finisher", [{
      op: "if", cond: { has: "channeling", of: "caster" },
      then: [{ op: "damage", amount: 20, to: "target" }],
      else: [{ op: "damage", amount: 5, to: "target" }],
    }], { tags: ["Harmful"], doesNotInterrupt: true })],
  });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  startTurn(state);
  performAction(state, { unit: "a", skillId: "darken" }); // e -> 90, channeling
  performAction(state, { unit: "a", skillId: "finisher", targets: ["e"] }); // reads channeling -> 20
  assert.equal(e.hp, 70, "finisher saw the channel (20, not 5)");
});

test("using a new (non-opt-out) skill cancels the channel", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [darken(), skill("poke", [{ op: "damage", amount: 5, to: "target" }], { tags: ["Harmful"] })] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  startTurn(state);
  performAction(state, { unit: "a", skillId: "darken" }); // 90, channel
  performAction(state, { unit: "a", skillId: "poke", targets: ["e"] }); // 85, cancels channel
  assert.ok(!isChanneling(a), "channel cancelled by the new skill");
  toNextATurn(state);
  assert.equal(e.hp, 85, "no re-run after cancel");
});

test("a doesNotInterrupt skill leaves the channel running", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [darken(), skill("wink", [{ op: "heal", amount: 1, to: "self" }], { tags: ["Strategic"], doesNotInterrupt: true })] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  startTurn(state);
  performAction(state, { unit: "a", skillId: "darken" });
  performAction(state, { unit: "a", skillId: "wink" });
  assert.ok(isChanneling(a), "channel survived the opt-out skill");
});

test("being Stunned interrupts the channel", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [darken()] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  startTurn(state);
  performAction(state, { unit: "a", skillId: "darken" }); // 90, channel
  applyStatus(a, status("stun", { duration: 5, appliedBy: "e", appliedTurn: state.turn }));
  toNextATurn(state);
  assert.equal(e.hp, 90, "no re-run while stunned");
  assert.ok(!isChanneling(a), "channel cancelled by the stun");
});

test("a finite channel (channelTurns) counts down and ends", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [darken({ channelTurns: 1 })] });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([a], [e]);
  startTurn(state);
  performAction(state, { unit: "a", skillId: "darken" }); // 90
  toNextATurn(state); // re-run 1 -> 80, then ends
  assert.equal(e.hp, 80);
  assert.ok(!isChanneling(a), "channel ended after its turns");
  toNextATurn(state);
  assert.equal(e.hp, 80, "no further re-runs");
});
