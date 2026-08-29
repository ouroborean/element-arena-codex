import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { GameEvent } from "../src/events.ts";

// The client's turn-playback animation reads state.eventSink — an opt-in ordered tap of every emitted GameEvent
// around a turn's resolution. These lock in the capture contract (present => filled in order; absent => no cost).

test("eventSink captures a skill's effect events (incl. effect-op damage) alongside its skillUsed", () => {
  const atk = skill("atk", [{ op: "damage", amount: 15, dtype: "normal", to: "target" }], {
    tags: ["Harmful", "Instant"], targeting: "single", cost: { generic: 0, specific: 0 }, cooldown: 0,
  });
  const st = makeState([makeUnit({ id: "a", team: "A", skills: [atk] })], [makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 })]);
  st.eventSink = [];
  performAction(st, { unit: "a", skillId: "atk", targets: ["e"] });
  const evs = st.eventSink;
  assert.ok(evs.some((ev) => ev.type === "skillUsed" && ev.caster === "a" && ev.skillId === "atk"), "the skillUsed event is captured");
  // The damage op emits via the effect bus (ctx.emit) — the sink must catch those too, not just top-level emits.
  const dmg = evs.find((ev): ev is Extract<GameEvent, { type: "damageDealt" }> => ev.type === "damageDealt" && ev.target === "e");
  assert.ok(dmg, "the effect-op damageDealt event is captured");
  assert.equal(dmg!.amount, 15, "with the right amount");
  assert.ok(!dmg!.isTick, "a skill's damage is NOT marked isTick");
});

test("eventSink marks dot-tick damage with isTick (the animation's 'no-panel' tick phase)", () => {
  const st = makeState(
    [makeUnit({ id: "a", team: "A" })],
    [makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, statuses: [status("dot", { name: "Burn", magnitude: 5, dtype: "affliction", duration: null, appliedBy: "a", appliedTurn: 0 })] })],
  );
  st.turn = 5; // past the dot's appliedTurn so it ticks
  st.eventSink = [];
  endTurn(st); // team A's turn-end ticks its dots on the enemy
  const tick = (st.eventSink ?? []).find((ev): ev is Extract<GameEvent, { type: "damageDealt" }> => ev.type === "damageDealt" && ev.target === "e");
  assert.ok(tick, "the dot tick emits a damageDealt");
  assert.equal(tick!.isTick, true, "and it is marked isTick");
});

test("eventSink is off by default — no capture unless the client opts in", () => {
  const atk = skill("atk", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { tags: ["Harmful"], targeting: "single", cost: { generic: 0, specific: 0 }, cooldown: 0 });
  const st = makeState([makeUnit({ id: "a", team: "A", skills: [atk] })], [makeUnit({ id: "e", team: "B" })]);
  performAction(st, { unit: "a", skillId: "atk", targets: ["e"] });
  assert.equal(st.eventSink, undefined, "no sink is created by the engine itself");
});
