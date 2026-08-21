import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 8 (true bug) — dennis4 "Shared Agony": each enemy deals 5 Piercing to Dennis. The
// damage op credited every fanned hit to the caster (Dennis), so Fury ("any unit that damages him is Taunted
// toward him") saw Dennis, not the enemies, and self-taunted. The damage op now takes a `from` source, so
// each enemy is the real dealer.

test("Shared Agony: Fury taunts each ENEMY that damages Dennis toward him, not Dennis himself", () => {
  const dennis = loadHero(heroById("dennis"), "A", "d");
  dennis.statuses.push({ kind: "mark", name: "HS-112 Fury Serum", duration: null, appliedBy: "d", appliedTurn: 0 }); // Fury active
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero" });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const state = makeState([dennis], [e1, e2]);
  state.teams.A.energy = { serum: 10 };

  performAction(state, { unit: "d", skillId: "dennis4", targets: [] });

  assert.ok(e1.statuses.some((s) => s.kind === "taunt" && s.unitRef === "d"), "e1 (a real dealer) is Taunted toward Dennis");
  assert.ok(e2.statuses.some((s) => s.kind === "taunt" && s.unitRef === "d"), "e2 (a real dealer) is Taunted toward Dennis");
  assert.ok(!dennis.statuses.some((s) => s.kind === "taunt"), "Dennis is NOT self-taunted (the old mis-attribution bug)");
});
