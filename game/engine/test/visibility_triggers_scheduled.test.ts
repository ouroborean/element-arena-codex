import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { TriggeredEffect } from "../src/events.ts";

// PR 8b — the last provenance-carrying wire leaks. A reflect/trap armed by an Invisible cast rides `triggers`
// (by name) and a deferred payload rides `state.scheduled`; both now carry an `invisible` flag (stamped by
// installWatch / the schedule op under ctx.invisible), and redactState omits them from anyone who is not on
// the installing team.

const trig = (over: Partial<TriggeredEffect>): TriggeredEffect => ({ on: "skillUsed", owner: "x", effect: [], source: "T", ...over });

test("redactState hides a foe's Invisible watch (keyed on installer team), keeps a public trigger, keeps both for the owner", () => {
  const ando = makeUnit({ id: "a1", team: "A", triggers: [
    trig({ owner: "a1", source: "Opposites Attract", duration: 1, invisible: true, appliedBy: "a1" }),
    trig({ owner: "a1", source: "Public Passive" }),
  ] });
  const st = makeState([ando], [makeUnit({ id: "b1", team: "B" })]);

  const forB = redactState(st, "B"); // opponent
  assert.equal(forB.units["a1"]!.triggers!.length, 1, "B cannot see A's Invisible watch");
  assert.equal(forB.units["a1"]!.triggers![0]!.source, "Public Passive", "the public trigger survives");
  assert.equal(redactState(st, "A").units["a1"]!.triggers!.length, 2, "A (installer) sees both");
});

test("an Invisible watch a foe installed ON the viewer's own unit is still hidden from the viewer", () => {
  // Ando (A) invisibly arms a watch that sits on B's unit (an enemy-target watch) — appliedBy = Ando (A).
  const bUnit = makeUnit({ id: "b1", team: "B", triggers: [trig({ owner: "b1", source: "Opposites Attract", duration: 1, invisible: true, appliedBy: "a1" })] });
  const st = makeState([makeUnit({ id: "a1", team: "A" })], [bUnit]);

  assert.equal(redactState(st, "B").units["b1"]!.triggers!.length, 0, "B cannot see the watch A secretly armed on B's own unit");
  assert.equal(redactState(st, "A").units["b1"]!.triggers!.length, 1, "A (installer) sees it");
});

test("redactState omits a foe's Invisible scheduled effect, keeps a visible one, keeps both for the owner", () => {
  const st = makeState([makeUnit({ id: "a1", team: "A" })], [makeUnit({ id: "b1", team: "B" })]);
  st.scheduled.push({ effect: [], caster: "a1", targets: [], turns: 1, appliedTurn: 0, skillId: "hid", invisible: true });
  st.scheduled.push({ effect: [], caster: "a1", targets: [], turns: 1, appliedTurn: 0, skillId: "pub" });

  const forB = redactState(st, "B");
  assert.equal(forB.scheduled.length, 1, "B cannot see A's Invisible scheduled payload");
  assert.equal(forB.scheduled[0]!.skillId, "pub", "the visible scheduled effect survives");
  assert.equal(redactState(st, "A").scheduled.length, 2, "A (owner) sees both");
  assert.equal(st.scheduled.length, 2, "authoritative scheduled list is untouched");
});

test("casting an Invisible skill stamps its installed watches invisible and hides them from the opponent (andomagnet1)", () => {
  const ando = loadHero(heroById("ando"), "A", "an");
  applyFusion(ando, fusionForm("ando", "magnet")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([ando], [enemy]);
  state.teams.A.energy = { generic: 10, magnet: 10 };

  performAction(state, { unit: "an", skillId: "andomagnet1", targets: ["e"] });

  const installed = [...(ando.triggers ?? []), ...(enemy.triggers ?? [])].filter((t) => t.sourceSkillId === "andomagnet1");
  assert.ok(installed.length > 0, "the Invisible cast installed at least one watch");
  assert.ok(installed.every((t) => t.invisible), "every watch it installed is stamped invisible");

  const forB = redactState(state, "B");
  const leaked = [...(forB.units["an"]?.triggers ?? []), ...(forB.units["e"]?.triggers ?? [])].filter((t) => t.sourceSkillId === "andomagnet1");
  assert.equal(leaked.length, 0, "the opponent's wire view shows none of the armed Invisible watches");
});
