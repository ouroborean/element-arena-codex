import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 24 — zephyrex "Ominous Rumble": "Marked enemies are automatically targeted by
// Arcadian Duet and Jolt, consuming the mark." A new autoTargetMark skill flag forces a single-target skill
// onto a living enemy bearing the mark; Arcadian Duet gains Jolt's consume-mark + gain-Essence branch.

test("Arcadian Duet is forced onto an Ominous Rumble-marked enemy, consuming the mark + gaining Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "z");
  const marked = makeUnit({ id: "m", team: "B", kind: "hero", statuses: [{ kind: "mark", name: "Ominous Rumble", duration: 2, appliedBy: "z", appliedTurn: 0 }] });
  const unmarked = makeUnit({ id: "u", team: "B", kind: "hero" });
  const state = makeState([zeph], [marked, unmarked]);
  state.teams.A.energy = { generic: 10, wind: 10 };

  // The player aims at the UNMARKED enemy; the auto-target forces it onto the marked one.
  performAction(state, { unit: "z", skillId: "zephyrex1", targets: ["u"] });

  assert.ok(marked.statuses.some((s) => s.kind === "invulnerable"), "the marked enemy was forcibly targeted");
  assert.ok(!marked.statuses.some((s) => s.name === "Ominous Rumble"), "the mark is consumed");
  assert.ok(zeph.statuses.some((s) => s.kind === "elemental_essence"), "Zephyrex gains Elemental Essence on the marked hit");
  assert.ok(!unmarked.statuses.some((s) => s.kind === "invulnerable"), "the unmarked enemy (the player's pick) is untouched");
});

test("with no marked enemy, Arcadian Duet targets the chosen enemy normally", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "z");
  const a = makeUnit({ id: "a", team: "B", kind: "hero" });
  const b = makeUnit({ id: "b", team: "B", kind: "hero" });
  const state = makeState([zeph], [a, b]);
  state.teams.A.energy = { generic: 10, wind: 10 };

  performAction(state, { unit: "z", skillId: "zephyrex1", targets: ["b"] });
  assert.ok(b.statuses.some((s) => s.kind === "invulnerable"), "the chosen enemy is targeted");
  assert.ok(!a.statuses.some((s) => s.kind === "invulnerable"), "the other enemy is not");
});
