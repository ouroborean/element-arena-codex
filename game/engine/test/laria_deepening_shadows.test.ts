import { test } from "node:test";
import assert from "node:assert/strict";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { redactState } from "../src/visibility.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import type { Status, Unit } from "../src/types.ts";

// PR 5 — Laria "Deep, Dark Night" (laria:night). Two visibility toggles keyed on the SUM of Deepening
// Shadows stacks (new `stackSum` primitive — the old `count` gate tallied distinct holders, max 3, so it was
// unreachable). Recomputed each turnStart, because clearRoundStatuses wipes the stacks before a roundStart
// trigger could read them. Enemy 10+ → Laria gains `reveal` (True Sight); allies 10+ → allies are `veiled`.

const ds = (n: number, id: string): Status => status("stack", { name: "Deepening Shadows", magnitude: n, appliedBy: id });
const hasKind = (u: Unit, k: string): boolean => u.statuses.some((s) => s.kind === k);

test("stackSum sums a named stack's magnitude across a selector (not the count of holders)", () => {
  const a = makeUnit({ id: "a1", team: "A" });
  const st = makeState([a], [makeUnit({ id: "e1", team: "B", statuses: [ds(6, "e1")] }), makeUnit({ id: "e2", team: "B", statuses: [ds(4, "e2")] })]);
  const gate = { op: "if" as const,
    cond: { cmp: ">=" as const, left: { ref: "stackSum" as const, name: "Deepening Shadows", of: { faction: "enemies" as const, kind: "hero" as const } }, right: 10 },
    then: [{ op: "applyStatus" as const, to: "self" as const, status: { kind: "mark" as const, name: "Ten", duration: null } }] };
  runEffects(st, [gate], { caster: a, self: a });
  assert.ok(a.statuses.some((s) => s.name === "Ten"), "6 + 4 = 10 total → gate passes (a count of holders would be only 2)");
});

test("Deep, Dark Night: enemies at 10+ total Deepening Shadows grant Laria True Sight (continuous toggle)", () => {
  const laria = loadHero(heroById("laria"), "A", "l");
  applyFusion(laria, fusionForm("laria", "night")!);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", statuses: [ds(6, "e1"), status("mark", { name: "Ghost", appliedBy: "e1", invisible: true })] });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", statuses: [ds(4, "e2")] });
  const state = makeState([laria], [e1, e2]);

  emit(state, { type: "turnStart", team: "A" });
  assert.ok(hasKind(laria, "reveal"), "10 total enemy Deepening Shadows → Laria gains reveal");
  assert.ok(redactState(state, "A").units["e1"]!.statuses.some((s) => s.name === "Ghost"), "and Laria now sees the enemy's Invisible mark");

  e2.statuses = e2.statuses.filter((s) => s.name !== "Deepening Shadows"); // total now 6
  emit(state, { type: "turnStart", team: "A" });
  assert.ok(!hasKind(laria, "reveal"), "below 10 total → reveal removed (the else-branch toggles it off)");
});

test("Deep, Dark Night: allies at 10+ total Deepening Shadows are veiled, concealing their effects", () => {
  const laria = loadHero(heroById("laria"), "A", "l");
  applyFusion(laria, fusionForm("laria", "night")!);
  laria.statuses.push(ds(10, "l")); // Laria herself carries 10 Deepening Shadows
  const state = makeState([laria], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "turnStart", team: "A" });
  assert.ok(hasKind(laria, "veiled"), "10+ total allied Deepening Shadows → allied heroes veiled");

  laria.statuses.push(status("mark", { name: "Secret", appliedBy: "l" }));
  assert.ok(!redactState(state, "B").units["l"]!.statuses.some((s) => s.name === "Secret"), "the opponent cannot see a veiled ally's effect");
});
