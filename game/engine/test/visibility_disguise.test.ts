import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// PR — display disguise. zephyrex:mist "Cleave the Veil" is displayed to the OPPONENT as Elegant Sweep
// (zephyrex2): its cast telegraphs under the cover name, and redactState re-skins every status the cast
// leaves (name + source icon) to Elegant Sweep. The owner (and a True-Sight viewer) see the real effect;
// the mechanic (the delayed 45 Piercing) is unchanged.

const names = (st: MatchState, uid: string): string[] => st.units[uid]!.statuses.map((s) => s.name ?? s.kind);

test("Cleave the Veil is disguised as Elegant Sweep in the opponent's view, real for the owner", () => {
  const z = loadHero(heroById("zephyrex"), "A", "z");
  applyFusion(z, fusionForm("zephyrex", "mist")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([z], [enemy]);
  state.teams.A.energy = { generic: 10, mist: 10 };

  performAction(state, { unit: "z", skillId: "zephyrexmist1", targets: ["e"] });

  // The authoritative marks carry the disguise provenance (real name + the cover fields).
  const targetMark = enemy.statuses.find((s) => s.name === "Cleave Target");
  assert.ok(targetMark, "the real Cleave Target mark is on the enemy");
  assert.equal(targetMark!.disguiseAs, "zephyrex2", "it carries the disguise skill id");
  assert.equal(targetMark!.disguiseName, "Elegant Sweep", "and the disguise label");

  // Opponent's view: re-skinned to Elegant Sweep, disguise fields stripped, real name gone.
  const forB = redactState(state, "B");
  assert.ok(!names(forB, "e").includes("Cleave Target"), "the opponent never sees the real Cleave name on their unit");
  const bMark = forB.units["e"]!.statuses.find((s) => s.sourceId === "zephyrex2");
  assert.ok(bMark, "the opponent sees a status sourced to Elegant Sweep");
  assert.equal(bMark!.name, "Elegant Sweep", "labelled Elegant Sweep");
  assert.equal(bMark!.disguiseAs, undefined, "the disguise fields are stripped from the wire");
  assert.ok(!names(forB, "z").includes("Cleave Charging"), "Zephyrex's own Cleave Charging is also re-skinned for the opponent");

  // Owner's view: the genuine Cleave marks.
  assert.ok(names(redactState(state, "A"), "e").includes("Cleave Target"), "Zephyrex sees the real Cleave Target");
  assert.ok(names(redactState(state, "A"), "z").includes("Cleave Charging"), "Zephyrex sees the real Cleave Charging");

  // The log telegraphs under the cover name, never the real one.
  assert.ok(state.log.some((l) => l.includes("Elegant Sweep")), "the cast telegraphs as Elegant Sweep");
  assert.ok(!state.log.some((l) => l.includes("Cleave the Veil")), "the real skill name never hits the shared log");
});
