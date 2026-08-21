import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 11 — laria:night "Nightwalker": characters with 3+ Deepening Shadows Bypass (their
// outgoing damage ignores DR + Shield). The inert "Bypass" mark is now an UNCONDITIONAL conditional_bypass
// (bypassCond absent), which bypassesAgainst honors.

const dr = (mag: number): Unit["statuses"][number] => ({ kind: "damage_reduction", magnitude: mag, duration: null, appliedBy: "t", appliedTurn: 0 });
const target = (): Unit => makeUnit({ id: "t", team: "B", hp: 100, maxHp: 100, shield: 20, statuses: [dr(5)] });
const damage10 = (attacker: Unit, t: Unit): void => {
  runEffects(makeState([attacker], [t]), [{ op: "damage", amount: 10, to: "target" }], { caster: attacker, self: attacker, targets: [t], targeting: "single" });
};

test("an unconditional conditional_bypass makes the holder's damage ignore DR and Shield", () => {
  const attacker = makeUnit({ id: "a", team: "A", statuses: [{ kind: "conditional_bypass", name: "Bypass", duration: null, appliedBy: "a", appliedTurn: 0 }] });
  const t = target();
  damage10(attacker, t);
  assert.equal(t.hp, 90, "10 damage bypasses the 5 DR and 20 Shield -> full 10 to HP");
});

test("without the bypass, the same hit is absorbed by DR + Shield", () => {
  const attacker = makeUnit({ id: "a", team: "A" });
  const t = target();
  damage10(attacker, t);
  assert.equal(t.hp, 100, "10 - 5 DR = 5, absorbed by the 20 Shield -> 0 HP lost");
});
