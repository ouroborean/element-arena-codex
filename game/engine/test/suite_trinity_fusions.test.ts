import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFusion } from "../content/fusion.ts";
import { FUSIONS, fusionForm, fusionsFor } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";

// ===========================================================================
// Adversarial, spec-derived FUSION-FORM suite for TRINITY ("Prisma Trinity").
// The FROZEN PROSE (../content/frozen/skills.json) is the oracle for every assertion.
//
// FROZEN FACTS ABOUT TRINITY (the oracle):
//   trinity0 "Prismari Rangers" (passive): "Prisma Trinity is split between three members:
//     Prisma Crimson, Prisma Azure, and Prisma Saffron. This Hero is Untargetable and ignores
//     damage and Harmful effects, and is considered to be dead when all three members are dead."
//   trinity1 "Prisma Lens" / trinity2 "Prisma Maneuver" / trinity3 "Chroma Magica" are UMBRELLA
//     cover-text over the three Rangers' component minion skills (Ruby/Sapphire/Citrine Lens,
//     Prisma Vault/Whirl/Launch, Crimson Crash/Sonata Azure/Saffron Beam).
//   Trinity's single element is "prism" (elements.json id 51). The color names azure / crimson /
//     saffron are the three RANGER MEMBERS (minions), NOT fusion elements/forms.
//
// THE SPEC-DERIVED CONCLUSION THIS SUITE ENCODES:
//   A "fusion form" is a once-per-match transformation that re-elements a hero and grants a new
//   passive + active on top of the base kit (see ../content/fusion.ts). Nothing in Trinity's frozen
//   prose describes any such transformation: Trinity is a fixed Rangers shell that summons three
//   minion members. Therefore, DERIVED FROM THE FROZEN PROSE, Trinity has ZERO fusion forms.
//   Its real (Ranger) behavior is base-kit and is covered by suite_trinity_base.test.ts.
//
//   This suite asserts that Trinity is NOT a fusion hero: no authored/generated fusion form belongs
//   to it, and every color/element key a naive enumeration might guess resolves to `undefined`.
//   A CONTROL (a real fusion hero, ando) proves the harness genuinely detects fusion forms, so the
//   emptiness observed for Trinity is a true negative and not a broken import.
// ===========================================================================

// The keys a naive "enumerate the forms" pass might guess for Trinity: its own element ("prism")
// and the three Ranger member colors. None is a fusion form.
const TRINITY_GUESSED_KEYS = ["prism", "azure", "crimson", "saffron"] as const;

test("trinity: fusionsFor('trinity') is empty — Trinity has NO fusion forms (frozen: a Rangers shell, not a fusion hero)", () => {
  const forms = fusionsFor("trinity");
  assert.equal(forms.length, 0, `expected 0 trinity fusion forms, got ${forms.length}: ${forms.map((f) => f.key).join(",")}`);
});

test("trinity: no FUSIONS entry belongs to hero 'trinity'", () => {
  const owned = FUSIONS.filter((f) => f.hero === "trinity");
  assert.equal(owned.length, 0, `no fusion form should be owned by trinity, found: ${owned.map((f) => f.key).join(",")}`);
});

test("trinity: fusionForm('trinity', <guessed key>) is undefined for prism / azure / crimson / saffron", () => {
  for (const key of TRINITY_GUESSED_KEYS) {
    const form = fusionForm("trinity", key);
    assert.equal(form, undefined, `fusionForm("trinity","${key}") must be undefined — Trinity has no such fusion form`);
  }
});

test("trinity: the Ranger color names are NOT secretly Trinity fusion forms under any hero", () => {
  // Even if some *other* hero happened to own a form keyed azure/crimson/saffron/prism, none may be
  // attributed to trinity. (In current content none exist at all, but assert the ownership guard.)
  for (const key of TRINITY_GUESSED_KEYS) {
    const any = FUSIONS.filter((f) => f.key === key && f.hero === "trinity");
    assert.equal(any.length, 0, `key "${key}" must not resolve to a trinity-owned fusion form`);
  }
});

test("trinity: loaded hero is the 'prism' Rangers shell exposing umbrella actives (trinity1/2/3), never a fusion active", () => {
  const tri = loadHero(heroById("trinity"), "A", "t");
  // Frozen trinity0 fixes Trinity's element as prism; there is no fusion re-elementing.
  assert.equal(tri.currentElement, "prism", "Trinity's element is prism");
  assert.equal(tri.baseElement, "prism", "Trinity's base element is prism (nothing re-elements it)");
  const ids = (tri.skills ?? []).map((s) => (s as { id?: string }).id);
  // The active slots are the umbrella shell skills; no fusion skill is ever inserted.
  for (const shellId of ["trinity1", "trinity2", "trinity3"]) {
    assert.ok(ids.includes(shellId), `Trinity's kit must include the umbrella active ${shellId}; got [${ids.join(",")}]`);
  }
  assert.equal(tri.fused ?? false, false, "a freshly loaded Trinity has not fused (and has no form to fuse into)");
});

test("trinity: there is no form to drive applyFusion with — fusionForm returns undefined, so a fusion cannot be performed", () => {
  const tri = loadHero(heroById("trinity"), "A", "t");
  // canFuse is a generic hero gate (Trinity IS a hero), so it may report true; the operative fact is
  // that NO FusionForm exists to pass to applyFusion. Applying `undefined` must be impossible.
  const form = fusionForm("trinity", "prism");
  assert.equal(form, undefined, "no trinity fusion form exists to supply to applyFusion");
  assert.throws(
    () => applyFusion(tri, form as unknown as Parameters<typeof applyFusion>[1]),
    "applyFusion with a non-existent (undefined) trinity form must throw, not silently fuse",
  );
});

// -------------------------------------------------------------------------
// CONTROL: a real fusion hero proves the harness actually detects fusion forms,
// so the zeros asserted above for Trinity are a genuine true negative.
// (Every fused hero in current content owns exactly 10 forms.)
// -------------------------------------------------------------------------
test("control: a real fusion hero (ando) DOES have fusion forms — proves the emptiness for trinity is meaningful", () => {
  const andoForms = fusionsFor("ando");
  assert.equal(andoForms.length, 10, `control hero ando should own 10 fusion forms, got ${andoForms.length}`);
  const aurora = fusionForm("ando", "aurora");
  assert.ok(aurora, "control: fusionForm('ando','aurora') must be defined");
  assert.equal(aurora!.hero, "ando", "control: the aurora form belongs to ando");
  assert.ok(aurora!.passive && aurora!.skill, "control: a real fusion form carries a passive + an active skill");
});
