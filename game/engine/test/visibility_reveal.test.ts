import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// PR 5 — reveal / True Sight. A team holding a `reveal` status sees THROUGH the opponent's invisibility:
// redactState stops hiding the enemy's Invisible effects from it. Ayana's "Illumination" grants it for the
// Prism Sentence window.

const sees = (st: MatchState, viewer: "A" | "B", unit: string, name: string): boolean =>
  redactState(st, viewer).units[unit]!.statuses.some((s) => s.name === name);

test("a team holding `reveal` sees the opponent's Invisible effects; without it they stay hidden", () => {
  const a = makeUnit({ id: "a1", team: "A", statuses: [status("reveal", { appliedBy: "a1" })] });
  const b = makeUnit({ id: "b1", team: "B", statuses: [status("mark", { name: "Sneaky", appliedBy: "b1", invisible: true })] });
  const st = makeState([a], [b]);

  assert.ok(sees(st, "A", "b1", "Sneaky"), "with reveal, A (the opponent) sees B's Invisible mark");
  assert.ok(sees(st, "B", "b1", "Sneaky"), "B owns the mark, so B sees it regardless of reveal");

  a.statuses = []; // drop reveal
  assert.ok(!sees(st, "A", "b1", "Sneaky"), "without reveal, the enemy's Invisible mark is hidden from A again");
});

test("Prism Sentence grants Ayana's team True Sight — the enemy's Invisible effects become visible", () => {
  const ayana = loadHero(heroById("ayana"), "A", "ay");
  applyFusion(ayana, fusionForm("ayana", "prism")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", statuses: [status("mark", { name: "Ghost", appliedBy: "e", invisible: true })] });
  const state = makeState([ayana], [enemy]);
  state.teams.A.energy = { generic: 10, prism: 10 };

  assert.ok(!sees(state, "A", "e", "Ghost"), "before Prism Sentence, the enemy's Invisible mark is hidden from Ayana");

  performAction(state, { unit: "ay", skillId: "ayanaprism1", targets: ["e"] });
  assert.ok(ayana.statuses.some((s) => s.kind === "reveal"), "Ayana gains reveal (Illumination)");
  assert.ok(sees(state, "A", "e", "Ghost"), "now Ayana's player sees the enemy's Invisible mark");
});
