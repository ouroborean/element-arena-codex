/**
 * Reference behavior tests for the two skills the owner flagged as mis-implemented — the pattern the
 * per-hero suites follow: assert the exact behavior the frozen description promises. Both are expected
 * to FAIL until the engine is fixed (they document real bugs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, canUse } from "./skillHarness.ts";
import { performAction } from "../src/scheduler.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";

// Sonic Thrust: "…can only be used if Wind Step is on cooldown."
test("Zephyrex — Sonic Thrust is usable ONLY while Wind Step is on cooldown", () => {
  const s = battle(["zephyrex", "syl", "gommar"], ["riverdaughter", "laria", "xyris"]);
  const z = unit(s, "a1");
  // Fresh round: Wind Step (zephyrex4) is off cooldown, so Sonic Thrust (zephyrex3) must NOT be usable.
  assert.equal(canUse(s, z, skillOf(z, "zephyrex3")), false, "gated on Wind Step being on cooldown");
});

// "untargetable — cannot be targeted by ANY of another unit's skills." Trinity's Untargetable is masked
// by its damage_ignore, so isolate the underlying defect: an AOE selector must exclude untargetable units
// exactly like single-target legalTargets does. (This is why River Daughter's Ripple still hits Trinity.)
test("Untargetable excludes a unit from AOE targeting, not just single-target", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [skill("aoe", [{ op: "damage", amount: 10, to: { faction: "enemies" } }], { targeting: "all-enemies" })] });
  const untargetable = makeUnit({ id: "b1", team: "B", hp: 100, statuses: [status("untargetable")] });
  const normal = makeUnit({ id: "b2", team: "B", hp: 100 });
  const s = makeState([caster], [untargetable, normal]);
  s.teams.A.energy = { generic: 9 };
  performAction(s, { unit: "a1", skillId: "aoe" });
  assert.equal(normal.hp, 90, "a normal enemy takes the AOE hit");
  assert.equal(untargetable.hp, 100, "the untargetable enemy is skipped by the AOE");
});
