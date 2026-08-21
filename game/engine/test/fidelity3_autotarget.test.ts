import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 24 — zephyrex "Ominous Rumble": "Marked enemies are automatically targeted by
// Arcadian Duet and Jolt, consuming the mark in the process." A new autoTargetMark skill flag forces a
// single-target skill onto a living enemy bearing the mark. Per the frozen text, Arcadian Duet CONSUMES the
// mark only; Elemental Essence on a marked hit belongs to JOLT (zephyrexstorm1), whose frozen text grants it.

test("Arcadian Duet is forced onto an Ominous Rumble-marked enemy and consumes the mark WITHOUT granting Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "z");
  const marked = makeUnit({ id: "m", team: "B", kind: "hero", statuses: [{ kind: "mark", name: "Ominous Rumble", duration: 2, appliedBy: "z", appliedTurn: 0 }] });
  const unmarked = makeUnit({ id: "u", team: "B", kind: "hero" });
  const state = makeState([zeph], [marked, unmarked]);
  state.teams.A.energy = { generic: 10, wind: 10 };

  // The player aims at the UNMARKED enemy; the auto-target forces it onto the marked one.
  performAction(state, { unit: "z", skillId: "zephyrex1", targets: ["u"] });

  assert.ok(marked.statuses.some((s) => s.kind === "invulnerable"), "the marked enemy was forcibly targeted");
  assert.ok(!marked.statuses.some((s) => s.name === "Ominous Rumble"), "the mark is consumed");
  assert.ok(!zeph.statuses.some((s) => s.kind === "elemental_essence"), "Arcadian Duet grants NO Essence (that is Jolt's clause)");
  assert.ok(!unmarked.statuses.some((s) => s.kind === "invulnerable"), "the unmarked enemy (the player's pick) is untouched");
});

test("Jolt on an Ominous Rumble-marked enemy deals 20 Piercing, consumes the mark, and grants Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "z");
  applyFusion(zeph, fusionForm("zephyrex", "storm")!);
  const marked = makeUnit({ id: "m", team: "B", hp: 100, maxHp: 100, kind: "hero", statuses: [{ kind: "mark", name: "Ominous Rumble", duration: 2, appliedBy: "z", appliedTurn: 0 }] });
  const state = makeState([zeph], [marked]);
  state.teams.A.energy = { generic: 10, wind: 10 };

  performAction(state, { unit: "z", skillId: "zephyrexstorm1", targets: ["m"] });

  assert.equal(marked.hp, 80, "20 Piercing Bypassing damage landed");
  assert.ok(!marked.statuses.some((s) => s.name === "Ominous Rumble"), "Jolt consumes the mark");
  assert.ok(zeph.statuses.some((s) => s.kind === "elemental_essence"), "Jolt grants Elemental Essence on the marked hit");
});

test("Jolt on an UNMARKED enemy grants no Essence", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "z");
  applyFusion(zeph, fusionForm("zephyrex", "storm")!);
  const plain = makeUnit({ id: "p", team: "B", hp: 100, maxHp: 100, kind: "hero" });
  const state = makeState([zeph], [plain]);
  state.teams.A.energy = { generic: 10, wind: 10 };

  performAction(state, { unit: "z", skillId: "zephyrexstorm1", targets: ["p"] });
  assert.equal(plain.hp, 80, "20 Piercing still lands");
  assert.ok(!zeph.statuses.some((s) => s.kind === "elemental_essence"), "no mark -> no Essence");
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
