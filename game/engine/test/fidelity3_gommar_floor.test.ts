import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 7 (true bug) — gommar3 Winter's Howl. The -15 damage debuff decays +5 per enemy
// skill use; with no floor it overshot -15->-10->-5->0->+5, flipping into a damage BUFF on the 4th use. It
// now floors at 0 via a {statusMag < 0} guard.

test("Winter's Howl decays toward 0 and floors there — never flips into a +5 damage buff", () => {
  const gommar = loadHero(heroById("gommar"), "A", "g");
  applyAugment(gommar, augmentById("gommar3")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero",
    statuses: [{ kind: "outgoing_damage_mod", name: "Winter's Howl", magnitude: -15, duration: null, appliedBy: "g", appliedTurn: 0 }] });
  const state = makeState([gommar], [enemy]);
  const mag = (): number => enemy.statuses.find((s) => s.kind === "outgoing_damage_mod" && s.name === "Winter's Howl")?.magnitude ?? 0;
  const use = (): void => emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["g"], tags: [] });

  use(); assert.equal(mag(), -10, "1st use: -15 -> -10");
  use(); assert.equal(mag(), -5, "2nd use: -10 -> -5");
  use(); assert.equal(mag(), 0, "3rd use: -5 -> 0");
  use(); assert.equal(mag(), 0, "4th use: floors at 0, never becomes a +5 buff");
  use(); assert.equal(mag(), 0, "and stays 0 thereafter");
});
