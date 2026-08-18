import { test } from "node:test";
import assert from "node:assert/strict";
import { FUSIONS } from "../content/fusions.generated.ts";
import { AUGMENTS } from "../content/augments.generated.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionCustomFns, registerPendingFusionCustoms } from "../content/fusion_pending.ts";
import { applyAugment } from "../content/augment.ts";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { performAction, startRound } from "../src/scheduler.ts";
import type { MatchState, Unit } from "../src/types.ts";
import { makeState, makeUnit } from "./helpers.ts";

// The P3 integration net: every authored fusion form and augment must apply to a fresh hero and
// then RESOLVE on a live match — every resulting skill casts, every passive/trigger fires — without
// throwing. Structural correctness is per-item golden tests; this guarantees the bulk content runs.

const ELEMENTS = ["fire", "ice", "water", "lightning", "wind", "poison", "earth", "holy", "unholy",
  "shadow", "nomad", "night", "serum", "apocalypse", "storm", "devil", "vengeance", "prism"];

function harness(hero: Unit): MatchState {
  const enemies = [1, 2, 3].map((i) => makeUnit({ id: `enemy${i}`, team: "B", hp: 100 }));
  const state = makeState([hero, makeUnit({ id: "ally", team: "A", hp: 100 })], enemies);
  const pool: Record<string, number> = { generic: 99 };
  for (const el of [...ELEMENTS, hero.currentElement]) pool[el] = 99;
  state.teams.A.energy = pool;
  return state;
}

function exercise(hero: Unit, label: string, failures: string[]): void {
  // Cast every skill, and fire round/turn events (summons, passives, channels, augment triggers).
  for (const skill of hero.skills ?? []) {
    const state = harness(hero);
    const self = state.units[hero.id] as Unit;
    const target = state.units.enemy1 as Unit;
    try {
      const s = (self.skills ?? []).find((k) => k.id === skill.id)!;
      s.currentCd = 0;
      performAction(state, { unit: self.id, skillId: s.id, targets: [target.id] });
      runEffects(state, s.effects, { caster: self, self, targets: [target] });
    } catch (err) {
      failures.push(`${label}.${skill.id}: ${(err as Error).message}`);
    }
  }
  try {
    const state = harness(hero);
    startRound(state, "A");
    emit(state, { type: "turnStart", team: "A" });
    emit(state, { type: "skillUsed", caster: hero.id, skillId: (hero.skills ?? [])[0]?.id ?? "x", targets: ["enemy1"] });
    emit(state, { type: "turnEnd", team: "A" });
  } catch (err) {
    failures.push(`${label} (events): ${(err as Error).message}`);
  }
}

test("fusion custom mechanics: implemented vs. pending (honest accounting)", () => {
  const all = fusionCustomFns();
  const pending = registerPendingFusionCustoms(); // stubs the not-yet-implemented ones
  const implemented = all.length - pending.length;
  // Not an assertion of correctness — a visible ledger of how much fusion logic still needs handlers.
  console.log(`fusion custom fns: ${all.length} total, ${implemented} implemented, ${pending.length} pending stubs`);
  assert.ok(all.length > 0, "fusion forms use custom mechanics");
});

test("every authored fusion form applies and resolves without throwing", () => {
  registerPendingFusionCustoms(); // ensure pending mechanics are stubbed (logged no-ops), not crashes
  assert.ok(FUSIONS.length > 0, "some fusion forms authored");
  const failures: string[] = [];
  for (const form of FUSIONS) {
    try {
      const hero = loadHero(heroById(form.hero), "A", "a1");
      applyFusion(hero, form);
      assert.equal(hero.currentElement, form.element, `${form.hero}:${form.key} re-elemented`);
      assert.ok((hero.skills ?? []).some((s) => s.id === form.skill.id), `${form.hero}:${form.key} gained its skill`);
      exercise(hero, `fusion(${form.hero}:${form.key})`, failures);
    } catch (err) {
      failures.push(`fusion(${form.hero}:${form.key}) apply: ${(err as Error).message}`);
    }
  }
  assert.deepEqual(failures, [], `fusion content threw:\n${failures.join("\n")}`);
});

test("every authored augment applies and resolves without throwing", () => {
  assert.ok(AUGMENTS.length > 0, "some augments authored");
  const failures: string[] = [];
  for (const aug of AUGMENTS) {
    try {
      assert.ok(aug.owner, `${aug.id} has an owner`);
      const hero = loadHero(heroById(aug.owner!), "A", "a1");
      applyAugment(hero, aug);
      assert.ok((hero.augments ?? []).includes(aug.id), `${aug.id} recorded`);
      exercise(hero, `augment(${aug.id})`, failures);
    } catch (err) {
      failures.push(`augment(${aug.id}) apply: ${(err as Error).message}`);
    }
  }
  assert.deepEqual(failures, [], `augment content threw:\n${failures.join("\n")}`);
});
