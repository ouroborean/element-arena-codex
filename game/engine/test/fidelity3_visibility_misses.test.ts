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
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 1 — visibility misses the roster-wide audit found (skills whose frozen "This
// effect is invisible" was never wired, even though the visibility system now supports it).

test("maggie:grave Bloodrose Offering is Invisible — its window mark is hidden from the opponent", () => {
  const maggie = loadHero(heroById("maggie"), "A", "m");
  applyFusion(maggie, fusionForm("maggie", "grave")!);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([maggie, ally], [enemy]);
  state.teams.A.energy = { generic: 10, grave: 10 };

  performAction(state, { unit: "m", skillId: "maggiegrave1", targets: ["al"] });

  const mark = ally.statuses.find((s) => s.name === "Bloodrose Offering");
  assert.ok(mark?.invisible, "the Bloodrose Offering mark is stamped Invisible");
  assert.ok(!redactState(state, "B").units["al"]!.statuses.some((s) => s.name === "Bloodrose Offering"), "the opponent cannot see it");
  assert.ok(redactState(state, "A").units["al"]!.statuses.some((s) => s.name === "Bloodrose Offering"), "Maggie's own side sees it");
});

test("saya Kinetic Converter keeps Plasma Shield Invisible AND its Enhanced->Plasma Charge branch", () => {
  const saya = loadHero(heroById("saya"), "A", "s");
  applyAugment(saya, augmentById("saya4")!);
  const sk = (saya.skills ?? []).find((s) => s.id === "saya4")!;

  assert.equal(sk.isHidden, true, "the augmented Plasma Shield is still Invisible (the replaceSkill preserved isHidden)");
  assert.equal(sk.cooldown, 1, "the augment's cooldown change is intact");

  // The base's Enhanced->Plasma Charge on-cast branch must survive the replaceSkill.
  (saya as Unit).statuses.push({ kind: "mark", name: "Enhanced", duration: null, appliedBy: "s", appliedTurn: 0 });
  const state = makeState([saya], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 10 };
  performAction(state, { unit: "s", skillId: "saya4", targets: [] });

  assert.ok(saya.statuses.some((s) => s.name === "Plasma Charge"), "casting while Enhanced grants Plasma Charge");
  assert.ok(!saya.statuses.some((s) => s.name === "Enhanced"), "and consumes Enhanced");
});
