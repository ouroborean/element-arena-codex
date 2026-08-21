import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 2 — statusApplied over-fires. Five triggers keyed off "while a state is held"
// (e.g. {has:mark,Charged}) fired on ANY status landing while the state held; they now gate on the APPLIED
// status via {eventStatusKind}, firing exactly on the gain. Representative behavioral lock (ando:reanimation);
// the other four (ando:battery Capacitor Upgrade, Shadow Court Ritual, pyrrha Burning Plasma, dennis
// Auto-Injectors) share the identical primitive + edit.

test("ando:reanimation heals on GAINING Charged, not on an unrelated status applied while Charged is held", () => {
  const ando = loadHero(heroById("ando"), "A", "an");
  applyFusion(ando, fusionForm("ando", "reanimation")!);
  ando.hp = 50;
  ando.statuses.push({ kind: "mark", name: "Charged", duration: null, appliedBy: "an", appliedTurn: 0 }); // Charged is HELD
  const state = makeState([ando], [makeUnit({ id: "e", team: "B" })]);

  // The Charged status being APPLIED heals 5.
  emit(state, { type: "statusApplied", unit: "an", source: null, kind: "mark", name: "Charged" });
  assert.equal(ando.hp, 55, "gaining Charged heals 5");

  // An unrelated status landing while Charged is still held must NOT re-heal (the old over-fire bug).
  emit(state, { type: "statusApplied", unit: "an", source: null, kind: "mark", name: "Something Else" });
  assert.equal(ando.hp, 55, "an unrelated status applied while Charged is held does not re-trigger the heal");

  // Gaining Supercharged heals 10 (its own gate), independent of the Charged gate.
  emit(state, { type: "statusApplied", unit: "an", source: null, kind: "mark", name: "Supercharged" });
  assert.equal(ando.hp, 65, "gaining Supercharged heals 10");
});
