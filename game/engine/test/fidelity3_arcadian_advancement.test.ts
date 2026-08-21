import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 23 — titania "Arcadian Advancement": "Each time an ally triggers Prance, Titania's
// effects will permanently last an additional turn." The stack was accrued but never read; buildStatus now
// extends every non-round-permanent status the caster applies by her Arcadian Advancement stack count.

const advancement = (n: number): Unit["statuses"][number] => ({ kind: "stack", name: "Arcadian Advancement", magnitude: n, duration: null, appliedBy: "t", appliedTurn: 0 });

function applyStun(caster: Unit, dur: number | null): number | null | "absent" {
  const enemy = makeUnit({ id: "e", team: "B" });
  runEffects(makeState([caster], [enemy]), [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: dur } }], { caster, self: caster, targets: [enemy] });
  const stun = enemy.statuses.find((s) => s.kind === "stun");
  return stun ? stun.duration : "absent";
}

test("Titania's applied statuses last +1 turn per Arcadian Advancement stack; round-permanent untouched", () => {
  const titania = makeUnit({ id: "t", team: "A", statuses: [advancement(2)] });
  assert.equal(applyStun(titania, 1), 3, "a 1-turn stun with 2 stacks lasts 3");
  assert.equal(applyStun(titania, null), null, "a round-permanent (null) effect is untouched");
});

test("a caster without Arcadian Advancement applies normal durations", () => {
  const other = makeUnit({ id: "t", team: "A" });
  assert.equal(applyStun(other, 1), 1, "no extension without the stack");
});
