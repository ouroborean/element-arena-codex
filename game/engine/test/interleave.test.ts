/**
 * Interactive resolution order (the web client's end-of-turn "resolution order" panel): the active team's
 * queued skills and its pending dot/regen ticks can be resolved in an explicit interleaved order via
 * state.turnOrder, instead of the default "all skills, then tickDots at endTurn". Guards that the interleave
 * path applies each tick exactly once (endTurn must not re-tick), that the chosen order actually changes the
 * outcome, and that pendingTicks enumerates the same set tickDots would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingTicks, resolveTurn, endTurn } from "../src/scheduler.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";

test("pendingTicks: the active team's eligible dot/regen ticks, skipping birth-turn and the other team", () => {
  const caster = makeUnit({ id: "u1", team: "A" });
  const ally = makeUnit({ id: "u2", team: "A", statuses: [
    status("regen", { magnitude: 3, appliedBy: "u1", appliedTurn: 1 }), // A applied, before this turn -> eligible
    status("dot", { magnitude: 9, appliedBy: "e", appliedTurn: 1 }),    // applied by B -> not A's tick
  ] });
  const enemy = makeUnit({ id: "e", team: "B", statuses: [
    status("dot", { magnitude: 5, appliedBy: "u1", appliedTurn: 1 }),   // eligible
    status("dot", { magnitude: 7, appliedBy: "u1", appliedTurn: 2 }),   // birth turn == current turn -> skipped
  ] });
  const state = makeState([caster, ally], [enemy]);
  state.turn = 2;
  const ticks = pendingTicks(state, "A");
  // Unit-iteration order (u1, u2, e); u1 has none, u2's regen, then e's eligible dot.
  assert.deepEqual(ticks.map((t) => [t.unitId, t.status.magnitude]), [["u2", 3], ["e", 5]]);
});

test("interleave: a tick resolves exactly once and endTurn does not re-tick it", () => {
  const caster = makeUnit({ id: "u1", team: "A", skills: [skill("hit", [{ op: "damage", amount: 30, to: "target" }])] });
  const victim = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, statuses: [status("dot", { magnitude: 10, appliedBy: "u1", appliedTurn: 1, dtype: "affliction" })] });
  const state = makeState([caster], [victim]);
  state.turn = 2;
  const t = pendingTicks(state, "A")[0]!;
  state.turnOrder = [{ kind: "action", index: 0 }, { kind: "tick", unitId: "e", status: t.status }];
  resolveTurn(state, [{ unit: "u1", skillId: "hit", targets: ["e"] }]);
  assert.equal(state.dotsTicked, true, "resolveTurn marks that it applied the ticks");
  endTurn(state);
  assert.equal(state.dotsTicked, undefined, "endTurn clears the flag");
  assert.equal(victim.hp, 60, "100 - 30 (skill) - 10 (ONE dot tick) = 60; not 50 (double-tick) or 70 (missing)");
});

test("default path is unchanged: skill resolves, then endTurn ticks the dot once", () => {
  const caster = makeUnit({ id: "u1", team: "A", skills: [skill("hit", [{ op: "damage", amount: 30, to: "target" }])] });
  const victim = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, statuses: [status("dot", { magnitude: 10, appliedBy: "u1", appliedTurn: 1, dtype: "affliction" })] });
  const state = makeState([caster], [victim]);
  state.turn = 2;
  resolveTurn(state, [{ unit: "u1", skillId: "hit", targets: ["e"] }]); // no turnOrder
  assert.equal(state.dotsTicked, undefined);
  endTurn(state);
  assert.equal(victim.hp, 60);
});

test("interleave order changes the outcome (a heal cap makes tick-vs-skill order observable)", () => {
  // Victim at 95/100 with a +10 heal tick; a skill deals 10 to it. Whether the heal (capped at 100) lands
  // before or after the hit changes the final HP — a clean, deterministic probe that order is honored.
  const build = () => {
    const caster = makeUnit({ id: "u1", team: "A", skills: [skill("bolt", [{ op: "damage", amount: 10, to: "target" }])] });
    const victim = makeUnit({ id: "e", team: "B", hp: 95, maxHp: 100, statuses: [status("regen", { magnitude: 10, appliedBy: "u1", appliedTurn: 1 })] });
    const state = makeState([caster], [victim]);
    state.turn = 2;
    return { state, victim };
  };

  { // tick (heal +10, capped at 100) BEFORE skill (-10): 95 -> 100 -> 90
    const { state, victim } = build();
    const t = pendingTicks(state, "A")[0]!;
    state.turnOrder = [{ kind: "tick", unitId: "e", status: t.status }, { kind: "action", index: 0 }];
    resolveTurn(state, [{ unit: "u1", skillId: "bolt", targets: ["e"] }]);
    endTurn(state);
    assert.equal(victim.hp, 90, "heal first hits the cap (loses 5), then -10 => 90");
  }

  { // skill (-10) BEFORE tick (heal +10): 95 -> 85 -> 95
    const { state, victim } = build();
    const t = pendingTicks(state, "A")[0]!;
    state.turnOrder = [{ kind: "action", index: 0 }, { kind: "tick", unitId: "e", status: t.status }];
    resolveTurn(state, [{ unit: "u1", skillId: "bolt", targets: ["e"] }]);
    endTurn(state);
    assert.equal(victim.hp, 95, "damage first (85), then +10 heal under the cap => 95");
  }
});
