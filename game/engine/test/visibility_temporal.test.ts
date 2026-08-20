import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// PR 6 — "invisible until triggered". No new reveal-on-trigger machinery is needed: the armed set-up is an
// Invisible status (hidden by redactState), and when it fires the payoff runs in a fresh trigger context
// (visible) and the armed status lapses — so the opponent only ever sees the resolution, never the set-up.

test("Shadow Rebound arms an Invisible ward — hidden from the opponent, visible to Laria (lariamirror1 isHidden)", () => {
  const laria = loadHero(heroById("laria"), "A", "l");
  applyFusion(laria, fusionForm("laria", "mirror")!);
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([laria, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 10, mirror: 10 };

  performAction(state, { unit: "l", skillId: "lariamirror1", targets: ["a2"] });

  const ward = ally.statuses.find((s) => s.name === "Shadow Rebound");
  assert.ok(ward, "the reflect ward is placed on the ally");
  assert.equal(ward!.invisible, true, "the ward is Invisible (isHidden skill's context stamped it)");
  assert.ok(!redactState(state, "B").units["a2"]!.statuses.some((s) => s.name === "Shadow Rebound"), "the opponent cannot see the armed ward");
  assert.ok(redactState(state, "A").units["a2"]!.statuses.some((s) => s.name === "Shadow Rebound"), "Laria's side sees it");
  assert.ok(!state.log.some((l) => l.includes("used")), "the ward is set up with no telegraph");
});

test("Dramatic Irony makes the Deals Invisible — the augment sets isHidden and the armed boon is concealed", () => {
  const scratch = loadHero(heroById("scratch"), "A", "f");
  applyAugment(scratch, augmentById("scratch5")!);

  const s1 = (scratch.skills ?? []).find((s) => s.id === "scratch1")!;
  const s2 = (scratch.skills ?? []).find((s) => s.id === "scratch2")!;
  assert.equal(s1.isHidden, true, "Deal: Defeat is now Invisible");
  assert.equal(s2.isHidden, true, "Deal: Save is now Invisible");

  // Cast Deal: Save on an ally — the boon it arms is stamped Invisible and hidden from the opponent.
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([scratch, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 10, devil: 10 };

  performAction(state, { unit: "f", skillId: "scratch2", targets: ["a2"] });

  const boon = ally.statuses.find((s) => s.name === "Boon: Save Your Friends");
  assert.ok(boon, "the Deal armed its boon on the ally");
  assert.equal(boon!.invisible, true, "the armed boon is Invisible");
  assert.ok(!redactState(state, "B").units["a2"]!.statuses.some((s) => s.name === "Boon: Save Your Friends"), "the opponent cannot see the armed Deal");
  assert.ok(!state.log.some((l) => l.includes("used")), "the Deal is set up with no telegraph — invisible until it triggers");
});
