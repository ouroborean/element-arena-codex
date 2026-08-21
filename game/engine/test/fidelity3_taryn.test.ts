import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 13 — taryn fusions, via mutableSkill base-skill patches applied on roundStart.
const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;
const roundStart = (u: Unit): void => emit(makeState([u], [makeUnit({ id: "e", team: "B" })]), { type: "roundStart" });

test("taryn:divine — Radiant Glory auto-casts Holy Word: Peace (taryndivine1) in place of Refrain (taryn2)", () => {
  const taryn = loadHero(heroById("taryn"), "A", "t");
  applyFusion(taryn, fusionForm("taryn", "divine")!);
  assert.ok(JSON.stringify(skillOf(taryn, "taryn3").effects).includes('"skillId":"taryn2"'), "before: auto-casts Refrain");

  roundStart(taryn);

  for (const id of ["taryn3", "taryn4"]) {
    const eff = JSON.stringify(skillOf(taryn, id).effects);
    assert.ok(eff.includes('"skillId":"taryndivine1"'), `${id} now auto-casts Holy Word: Peace`);
    assert.ok(!eff.includes('"skillId":"taryn2"'), `${id} no longer auto-casts Refrain`);
  }
});

test("taryn:vengeance — Wingman makes Stalwart Shield stop granting Shield and become Invisible", () => {
  const taryn = loadHero(heroById("taryn"), "A", "t");
  applyFusion(taryn, fusionForm("taryn", "vengeance")!);
  assert.ok(skillOf(taryn, "taryn4").effects.some((e) => e.op === "grantShield"), "before: Stalwart Shield grants Shield");

  roundStart(taryn);

  const sk = skillOf(taryn, "taryn4");
  assert.equal(sk.isHidden, true, "Stalwart Shield is now Invisible");
  assert.ok(!sk.effects.some((e) => e.op === "grantShield"), "and no longer grants Taryn Shield");
});
