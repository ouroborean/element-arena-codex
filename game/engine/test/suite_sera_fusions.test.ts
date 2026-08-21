import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { fusionForm, fusionsFor, FUSIONS } from "../content/fusions.generated.ts";

// =============================================================================
// Adversarial, spec-derived suite for SERA (SERAFIA MKI) — FUSION FORMS.
//
// Oracle = the FROZEN prose (content/frozen/*.json). Per the task, tests are derived
// from the frozen text, never from the trigger/effect implementation.
//
// FINDING (spec-derived): Sera has NO fusion forms.
//
//   frozen/characters.json  sera  ->  starts_fused: true,  can_fuse: false,
//                                      fusion_skills: {}   (empty map)
//
//   frozen/skills.json  contains only her BASE kit ids sera0..sera6 (element
//   "vengeance"); there are NO fusion-form skill ids of the shape
//   "sera<element>0" / "sera<element>1" the way fusing heroes have (e.g.
//   "andoaurora0" / "andoaurora1").
//
// Sera "starts fused" into the fixed Vengeance element and cannot fuse into other
// elements. She therefore exposes no selectable fusion form (passive + active) to
// test the way ando/ayana/... do. Her single permanent form IS her base kit, which
// is exercised by suite_sera_base.test.ts — not here.
//
// Because there is nothing behavioral to drive, this file is a GUARD: it pins the
// frozen fact so that any future authoring that accidentally gives Sera fusion
// forms (contradicting can_fuse=false / an empty fusion_skills map) trips a red
// test instead of silently shipping. Each assertion carries a control (a genuinely
// fusing hero) so the guard is proven meaningful, not trivially always-empty.
// =============================================================================

// ---- Load the frozen character records (the oracle) at runtime. ----
const charsPath = fileURLToPath(
  new URL("../../content/frozen/characters.json", import.meta.url),
);
interface FrozenChar {
  id: string;
  character_name?: string;
  short_name?: string;
  starts_fused?: boolean;
  can_fuse?: boolean;
  base_skill_ids?: string[];
  fusion_skills?: Record<string, unknown>;
}
const FROZEN_CHARS = JSON.parse(readFileSync(charsPath, "utf8")) as FrozenChar[];
const frozenSera = FROZEN_CHARS.find((c) => c.id === "sera")!;
const frozenAndo = FROZEN_CHARS.find((c) => c.id === "ando")!; // control: a fusing hero

// =============================================================================
// FROZEN ORACLE — the character record says Sera cannot fuse and lists no forms.
// =============================================================================

test("frozen: Sera exists as SERAFIA MKI / SERAFINA and starts fused", () => {
  assert.ok(frozenSera, "sera must be present in frozen/characters.json");
  assert.equal(frozenSera.character_name, "SERAFIA MKI");
  assert.equal(frozenSera.short_name, "SERAFINA");
  // "starts_fused" = permanently in her single Vengeance form.
  assert.equal(frozenSera.starts_fused, true);
});

test("frozen: Sera can_fuse is false — she has no fusion mechanic", () => {
  assert.equal(frozenSera.can_fuse, false);
  // control: a genuinely fusing hero reports can_fuse=true, proving the field is
  // populated and the false above is a real distinction, not a missing default.
  assert.equal(frozenAndo.can_fuse, true);
});

test("frozen: Sera's fusion_skills map is empty (no passive/active forms)", () => {
  const seraForms = Object.keys(frozenSera.fusion_skills ?? {});
  assert.equal(seraForms.length, 0, `expected no fusion forms, got: ${seraForms.join(", ")}`);
  // control: a fusing hero lists many element forms, each with a passive+active.
  const andoForms = Object.keys(frozenAndo.fusion_skills ?? {});
  assert.ok(andoForms.length > 0, "control hero ando must list fusion forms");
});

test("frozen: Sera's only skills are her base kit sera0..sera6 (no <element>0/1 forms)", () => {
  assert.deepEqual(frozenSera.base_skill_ids, [
    "sera0",
    "sera1",
    "sera2",
    "sera3",
    "sera4",
    "sera5",
    "sera6",
  ]);
});

// =============================================================================
// ENGINE AGREEMENT — the fusion registry contains no Sera forms, matching frozen.
// =============================================================================

test("engine: fusionsFor('sera') is empty — no forms registered", () => {
  assert.equal(fusionsFor("sera").length, 0);
  // control: a fusing hero has forms registered, so an empty result is meaningful.
  assert.ok(fusionsFor("ando").length > 0, "control hero ando must have registered forms");
});

test("engine: fusionForm('sera', <element>) is undefined for every element key", () => {
  // Sera's element is Vengeance; probe that plus common fusion element keys.
  for (const key of [
    "vengeance",
    "aurora",
    "flame",
    "water",
    "storm",
    "current",
    "plasma",
    "ion",
  ]) {
    assert.equal(
      fusionForm("sera", key),
      undefined,
      `fusionForm('sera','${key}') should not exist`,
    );
  }
  // control: a real ando form resolves.
  assert.ok(fusionForm("ando", "aurora"), "control: ando:aurora form must resolve");
});

test("engine: the global FUSIONS registry carries no entry whose hero is 'sera'", () => {
  const seraEntries = FUSIONS.filter((f) => f.hero === "sera");
  assert.equal(seraEntries.length, 0);
});

// =============================================================================
// SANITY — Sera still loads and plays as a normal (single-form) hero.
// This isn't a fusion test; it just proves the "no forms" finding above is about
// fusion specifically, not a broken/absent hero.
// =============================================================================

test("sanity: Sera loads with her base kit and no fusion state applied", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  assert.equal(sera.heroId, "sera");
  assert.equal(sera.baseElement, "vengeance");
  assert.equal(sera.currentElement, "vengeance");
  // Base kit present (sera1..sera6 are the active skills; sera0 is the passive).
  assert.ok((sera.skills?.length ?? 0) > 0, "sera must load with active skills");
});
