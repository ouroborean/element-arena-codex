import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 25 — gaia:myth "Branch of the World Tree": "Channel Vitality now costs [65] and
// affects all targets, but can only target minions." A roundStart mutableSkill patch re-authors gaia3's
// cost / targeting / targetKind (the base-skill metadata patch channel fusion forms lacked).

test("Branch of the World Tree re-authors Channel Vitality's cost, targeting and targetKind", () => {
  const gaia = loadHero(heroById("gaia"), "A", "g");
  applyFusion(gaia, fusionForm("gaia", "myth")!);
  emit(makeState([gaia], [makeUnit({ id: "e", team: "B" })]), { type: "roundStart" });

  const sk = (gaia.skills ?? []).find((s) => s.id === "gaia3")!;
  assert.deepEqual(sk.cost, { generic: 1, specific: 0 }, "cost re-authored to 1 Generic");
  assert.equal(sk.targeting, "all-allies", "targeting -> all-allies (affects all targets)");
  assert.equal(sk.targetKind, "minion", "targetKind -> minion (can only target minions)");
});
