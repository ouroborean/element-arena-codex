/**
 * Server-side reconstruction of a networked interleave order (the client's "resolution order" panel). Guards
 * that rebuildTurnOrder places skills/ticks as the client asked, but ONLY ever from the server's own pending
 * ticks — a client can neither inject a tick nor place the opponent's — and that any omitted skill/tick is
 * still appended, so every one resolves exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebuildTurnOrder } from "./session.ts";
import { makeState, makeUnit, status } from "../engine/test/helpers.ts";
import type { Action } from "../engine/src/scheduler.ts";

/** A hero (u1, team A) and an enemy (e) carrying one dot A applied ("Burn") + one the enemy applied ("Rot"). */
function scene() {
  const caster = makeUnit({ id: "u1", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B", statuses: [
    status("dot", { name: "Burn", magnitude: 5, appliedBy: "u1", appliedTurn: 1 }), // A's tick -> eligible
    status("dot", { name: "Rot", magnitude: 3, appliedBy: "e", appliedTurn: 1 }),    // B's own dot -> NOT A's tick
  ] });
  const state = makeState([caster], [enemy]);
  state.turn = 2; // so appliedTurn(1) < turn(2)
  const actions: Action[] = [{ unit: "u1", skillId: "hit", targets: ["e"] }];
  return { state, actions };
}

test("rebuildTurnOrder: absent / empty wire => default (undefined)", () => {
  const { state, actions } = scene();
  assert.equal(rebuildTurnOrder(undefined, actions, "A", state), undefined);
  assert.equal(rebuildTurnOrder([], actions, "A", state), undefined);
});

test("rebuildTurnOrder: interleaves a tick before the skill, matched by identity", () => {
  const { state, actions } = scene();
  const order = rebuildTurnOrder(
    [{ kind: "tick", unit: "e", name: "Burn", by: "u1", regen: false }, { kind: "action" }],
    actions, "A", state,
  )!;
  assert.equal(order.length, 2);
  assert.equal(order[0]!.kind, "tick");
  assert.equal((order[0] as { unitId: string }).unitId, "e");
  assert.equal((order[0] as { status: { name?: string } }).status.name, "Burn");
  assert.deepEqual(order[1], { kind: "action", index: 0 });
});

test("rebuildTurnOrder: a client-named tick that isn't a real pending tick is dropped; the real tick is still appended once", () => {
  const { state, actions } = scene();
  const order = rebuildTurnOrder(
    [{ kind: "action" }, { kind: "tick", unit: "e", name: "Hack", by: "u1", regen: false }], // "Hack" doesn't exist
    actions, "A", state,
  )!;
  assert.deepEqual(order.map((o) => o.kind), ["action", "tick"]);
  assert.equal((order[1] as { status: { name?: string } }).status.name, "Burn"); // the real one, appended — not the fake
});

test("rebuildTurnOrder: cannot place the OPPONENT's tick (only the active team's ticks are matchable)", () => {
  const { state, actions } = scene();
  const order = rebuildTurnOrder(
    [{ kind: "tick", unit: "e", name: "Rot", by: "e", regen: false }, { kind: "action" }], // Rot is B's dot
    actions, "A", state,
  )!;
  // Rot is not one of A's pending ticks -> dropped; the action resolves, then A's real Burn is appended.
  assert.deepEqual(order.map((o) => o.kind), ["action", "tick"]);
  assert.equal((order[1] as { status: { name?: string } }).status.name, "Burn");
});

test("rebuildTurnOrder: extra action markers are ignored and unplaced actions are appended", () => {
  const caster = makeUnit({ id: "u1", team: "A" });
  const other = makeUnit({ id: "u2", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B" });
  const state = makeState([caster, other], [enemy]);
  state.turn = 2;
  const actions: Action[] = [{ unit: "u1", skillId: "a" }, { unit: "u2", skillId: "b" }];
  // three action markers, only two actions -> the third is ignored; both actions placed once, in order.
  const order = rebuildTurnOrder([{ kind: "action" }, { kind: "action" }, { kind: "action" }], actions, "A", state)!;
  assert.deepEqual(order, [{ kind: "action", index: 0 }, { kind: "action", index: 1 }]);
});
