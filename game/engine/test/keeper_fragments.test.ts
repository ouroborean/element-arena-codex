import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import "../content/hero.ts"; // side-effect: registers consumeShield
import { totalShield } from "../src/damage.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Engine-fidelity — keeper:crystal "Chronicle Fragments": "These Fragments are consumed by his abilities,
// counting as 10 Shield each." A shield-cost check now reads spendableShield (= totalShield + 10*Fragments),
// and consumeShield spends real Shield first, then whole Fragments for the shortfall.

const frags = (u: Unit): number => u.statuses.find((s) => s.kind === "stack" && s.name === "Chronicle Fragments")?.magnitude ?? 0;
const withFrags = (n: number): Unit => makeUnit({ id: "k", team: "A", shield: 20, statuses: n > 0 ? [{ kind: "stack", name: "Chronicle Fragments", magnitude: n, duration: null, appliedBy: "k", appliedTurn: 0 }] : [] });

test("spendableShield >= N counts Chronicle Fragments (10 each); a Shield-cost check passes on Shield+Fragments", () => {
  const gate = { op: "if" as const, cond: { cmp: ">=" as const, left: { ref: "spendableShield" as const, of: "self" as const }, right: 25 },
    then: [{ op: "applyStatus" as const, to: "self" as const, status: { kind: "mark" as const, name: "Paid", duration: null } }] };
  const run = (u: Unit): boolean => { const st = makeState([u], [makeUnit({ id: "e", team: "B" })]); runEffects(st, [gate], { caster: u, self: u }); return u.statuses.some((s) => s.kind === "mark" && s.name === "Paid"); };

  assert.equal(run(withFrags(0)), false, "20 Shield alone (< 25) → check fails");
  assert.equal(run(withFrags(1)), true, "20 Shield + 1 Fragment (=30) → check passes");
});

test("consumeShield spends real Shield first, then whole Fragments for the shortfall", () => {
  // 20 Shield + 1 Fragment, consume 25 → spend 20 Shield + 1 Fragment (covers the 5 shortfall, whole stack).
  const u = withFrags(1);
  runEffects(makeState([u], [makeUnit({ id: "e", team: "B" })]), [{ op: "custom", fn: "consumeShield", args: { amount: 25, of: "self" } }], { caster: u, self: u });
  assert.equal(totalShield(u), 0, "all 20 real Shield spent first");
  assert.equal(frags(u), 0, "1 Fragment consumed to cover the 5 shortfall");

  // 0 Shield + 3 Fragments (=30), consume 25 → ceil(25/10)=3 Fragments (whole stacks; over-pays by 5).
  const v = makeUnit({ id: "k2", team: "A", statuses: [{ kind: "stack", name: "Chronicle Fragments", magnitude: 3, duration: null, appliedBy: "k2", appliedTurn: 0 }] });
  runEffects(makeState([v], [makeUnit({ id: "e2", team: "B" })]), [{ op: "custom", fn: "consumeShield", args: { amount: 25, of: "self" } }], { caster: v, self: v });
  assert.equal(frags(v), 0, "3 Fragments consumed to cover 25 (whole stacks)");

  // A non-Keeper (no Fragments) still just spends real Shield — no change to behavior.
  const w = makeUnit({ id: "n", team: "A", shield: 10 });
  runEffects(makeState([w], [makeUnit({ id: "e3", team: "B" })]), [{ op: "custom", fn: "consumeShield", args: { amount: 25, of: "self" } }], { caster: w, self: w });
  assert.equal(totalShield(w), 0, "spends what Shield it has; no Fragments to draw");
});
