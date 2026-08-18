import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { endTurn } from "../src/scheduler.ts";
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit } from "./helpers.ts";

test("grantShield adds a pool that absorbs before HP", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [e]);

  runEffects(state, [{ op: "grantShield", amount: 20, to: "target" }], { caster: p, targets: [e] });
  assert.equal(totalShield(e), 20);

  runEffects(state, [{ op: "damage", amount: 30, to: "target" }], { caster: p, targets: [e] });
  assert.equal(totalShield(e), 0, "shield spent");
  assert.equal(e.hp, 90, "10 overflow to HP");
});

test("grantShield amount can be a Value expression", () => {
  const p = makeUnit({ id: "p", team: "A", hp: 40, maxHp: 100 });
  const state = makeState([p], [makeUnit({ id: "e", team: "B" })]);
  // "gains Shield equal to missing HP"
  runEffects(state, [{ op: "grantShield", amount: { ref: "missingHp", of: "self" }, to: "self" }], { caster: p });
  assert.equal(totalShield(p), 60);
});

test("multiple shields stack and absorb in order", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const e = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([p], [e]);
  runEffects(state, [{ op: "grantShield", amount: 10, to: "target" }, { op: "grantShield", amount: 10, to: "target" }], { caster: p, targets: [e] });
  assert.equal(totalShield(e), 20);
  runEffects(state, [{ op: "damage", amount: 15, to: "target" }], { caster: p, targets: [e] });
  assert.equal(totalShield(e), 5);
  assert.equal(e.hp, 100);
});

test("a timed shield expires at the applier's next turn-end", () => {
  const p = makeUnit({ id: "p", team: "A" });
  const state = makeState([p], [makeUnit({ id: "e", team: "B" })]);
  runEffects(state, [{ op: "grantShield", amount: 15, to: "self", duration: 1 }], { caster: p });
  assert.equal(totalShield(p), 15);

  endTurn(state); // A turn 1 end (birth) — no tick
  assert.equal(totalShield(p), 15);
  endTurn(state); // B turn 2 — not A's shield
  assert.equal(totalShield(p), 15);
  endTurn(state); // A turn 3 — expires
  assert.equal(totalShield(p), 0);
});

test("shieldBroken and shieldDamaged fire reactive triggers", () => {
  const attacker = makeUnit({ id: "a", team: "A" });
  const d = makeUnit({ id: "d", team: "B", hp: 100 });
  runEffects(makeState([attacker], [d]), [{ op: "grantShield", amount: 20, to: "self" }], { caster: d });
  // "When my shield breaks, gain 5 DR."
  d.triggers = [{
    on: "shieldBroken", owner: "d", source: "test",
    when: { sameUnit: ["eventUnit", "self"] },
    effect: [{ op: "applyStatus", to: "self", status: { kind: "damage_reduction", magnitude: 5, duration: 2 } }],
  }];
  const state = makeState([attacker], [d]);

  runEffects(state, [{ op: "damage", amount: 25, to: "target" }], { caster: attacker, targets: [d] });
  assert.equal(totalShield(d), 0);
  assert.ok(d.statuses.some((s) => s.kind === "damage_reduction"), "shieldBroken trigger fired");
});
