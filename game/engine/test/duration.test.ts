import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { applyStatus } from "../src/status.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

const findDot = (u: ReturnType<typeof makeUnit>, name: string) => u.statuses.find((s) => s.kind === "dot" && s.name === name);

test("modifyStatus extends an existing status' remaining duration (durationDelta)", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const e = makeUnit({ id: "e", team: "B" });
  applyStatus(e, status("dot", { name: "Fan the Flames", magnitude: 5, duration: 3, appliedBy: "p", appliedTurn: 0 }));
  const state = makeState([p], [e]);

  // "extend Fan the Flames by 2 turns"
  runEffects(state, [{ op: "modifyStatus", kind: "dot", name: "Fan the Flames", durationDelta: 2, from: "target" }], { caster: p, targets: [e] });
  assert.equal(findDot(e, "Fan the Flames")!.duration, 5);
});

test("modifyStatus reducing duration to <= 0 removes the status", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const e = makeUnit({ id: "e", team: "B" });
  applyStatus(e, status("stun", { duration: 1, appliedBy: "p", appliedTurn: 0 }));
  const state = makeState([p], [e]);
  runEffects(state, [{ op: "modifyStatus", kind: "stun", durationDelta: -1, from: "target" }], { caster: p, targets: [e] });
  assert.ok(!e.statuses.some((s) => s.kind === "stun"), "stun cleared");
});

test("a status duration can be a computed Value (per stack)", () => {
  const p = makeUnit({ id: "p", team: "A" });
  applyStatus(p, status("stack", { name: "Momentum", magnitude: 3, duration: null }));
  const e = makeUnit({ id: "e", team: "B" });
  const state = makeState([p], [e]);

  // "Stun the target for a number of turns equal to my Momentum stacks."
  runEffects(state, [{
    op: "applyStatus", to: "target",
    status: { kind: "stun", duration: { ref: "stackCount", name: "Momentum", of: "caster" } },
  }], { caster: p, targets: [e] });
  assert.equal(e.statuses.find((s) => s.kind === "stun")!.duration, 3);
});

test("statusDuration ref reads remaining turns (e.g. to amplify by time left)", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  applyStatus(e, status("dot", { name: "Fan the Flames", magnitude: 5, duration: 4, appliedBy: "p", appliedTurn: 0 }));
  const state = makeState([p], [e]);

  // "Deal 10 damage per turn remaining on Fan the Flames" -> 4 -> 40.
  runEffects(state, [{
    op: "damage", to: "target",
    amount: { op: "mul", args: [10, { ref: "statusDuration", kind: "dot", name: "Fan the Flames", of: "target" }] },
  }], { caster: p, targets: [e] });
  assert.equal(e.hp, 60);
});
