import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { makeState, makeUnit } from "./helpers.ts";

test("'across' selects the enemy hero in the same formation slot (Dune Stalker)", () => {
  const aramao = makeUnit({ id: "ar", team: "A", name: "Aramao" });
  const allyX = makeUnit({ id: "ax", team: "A" });
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([aramao, allyX], [e0, e1]); // slots: aramao/e0 = 0, allyX/e1 = 1

  runEffects(state, [{ op: "damage", amount: 5, to: "across" }], { caster: aramao });
  assert.equal(e0.hp, 95, "hit the across enemy");
  assert.equal(e1.hp, 100, "not the other");
});

test("'adjacent' selects neighbouring allied heroes (Heart of the Desert)", () => {
  const aramao = makeUnit({ id: "ar", team: "A" }); // slot 0
  const ax = makeUnit({ id: "ax", team: "A", hp: 50, maxHp: 100 }); // slot 1 (adjacent)
  const ay = makeUnit({ id: "ay", team: "A", hp: 50, maxHp: 100 }); // slot 2 (not adjacent to 0)
  const state = makeState([aramao, ax, ay], [makeUnit({ id: "e", team: "B" })]);

  runEffects(state, [{ op: "heal", amount: 15, to: "adjacent" }], { caster: aramao });
  assert.equal(ax.hp, 65, "adjacent healed");
  assert.equal(ay.hp, 50, "non-adjacent untouched");

  // "If there is only one Hero adjacent…" — the count is readable.
  const e = state.units.e!;
  e.hp = 100;
  runEffects(state, [{ op: "damage", to: "target", amount: { ref: "count", of: "adjacent" } }], { caster: aramao, targets: [e] });
  assert.equal(e.hp, 99, "exactly 1 adjacent");
});

test("swapPositions changes who is 'across' (Desert Knife)", () => {
  const aramao = makeUnit({ id: "ar", team: "A" }); // slot 0
  const ax = makeUnit({ id: "ax", team: "A" }); // slot 1
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([aramao, ax], [e0, e1]);

  runEffects(state, [{ op: "swapPositions", a: "caster", b: "adjacent" }], { caster: aramao });
  assert.equal(aramao.slot, 1);
  assert.equal(ax.slot, 0);

  runEffects(state, [{ op: "damage", amount: 5, to: "across" }], { caster: aramao });
  assert.equal(e1.hp, 95, "now across from the slot-1 enemy");
  assert.equal(e0.hp, 100);
});

test("shuffleTeam randomly reassigns slots, deterministically", () => {
  function run() {
    const a = makeUnit({ id: "a", team: "A" });
    const b = makeUnit({ id: "b", team: "A" });
    const c = makeUnit({ id: "c", team: "A" });
    const state = makeState([a, b, c], [makeUnit({ id: "e", team: "B" })], 42);
    runEffects(state, [{ op: "shuffleTeam" }], { caster: a });
    return [a.slot, b.slot, c.slot];
  }
  const r1 = run();
  assert.deepEqual([...r1].sort(), [0, 1, 2], "still a permutation of the 3 slots");
  assert.deepEqual(r1, run(), "same seed → same shuffle");
});
