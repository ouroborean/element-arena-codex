import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3, PR 3 — "or is removed / on consume" clauses, now wired via the statusLost event
// (emitted by the removeStatus op; added in an earlier PR). Natural lapse still emits statusExpired.

test("pyrrha Flickering Form heals 10 when Fan the Flames is REMOVED, not only when it expires", () => {
  const pyrrha = loadHero(heroById("pyrrha"), "A", "p");
  applyAugment(pyrrha, augmentById("pyrrha2")!);
  pyrrha.hp = 50;
  const state = makeState([pyrrha], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "statusLost", unit: "e", kind: "dot", name: "Fan the Flames" });
  assert.equal(pyrrha.hp, 60, "removing Fan the Flames heals Pyrrha 10 (the 'or is removed' branch)");

  emit(state, { type: "statusLost", unit: "e", kind: "dot", name: "Some Other Dot" });
  assert.equal(pyrrha.hp, 60, "removing an unrelated dot does not heal");
});

test("jarrik:mechanic Blazer Board grants Invulnerable when a Cinders mark is consumed (statusLost)", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "mechanic")!);
  const state = makeState([jarrik], [makeUnit({ id: "e", team: "B" })]);
  assert.ok(!jarrik.statuses.some((s) => s.kind === "invulnerable"), "no Invulnerable before consuming Cinders");

  emit(state, { type: "statusLost", unit: "e", kind: "mark", name: "Cinders" });
  assert.ok(jarrik.statuses.some((s) => s.kind === "invulnerable"), "consuming a Cinders mark makes Jarrik Invulnerable");
});

test("Blazer Board does NOT grant Invulnerable when a non-Cinders mark is removed", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "mechanic")!);
  const state = makeState([jarrik], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "statusLost", unit: "e", kind: "mark", name: "Not Cinders" });
  assert.ok(!jarrik.statuses.some((s) => s.kind === "invulnerable"), "an unrelated mark removal does nothing");
});
