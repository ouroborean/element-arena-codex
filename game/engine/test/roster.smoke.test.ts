import { test } from "node:test";
import assert from "node:assert/strict";
import { ROSTER } from "../content/roster.generated.ts";
import { loadHero } from "../content/hero.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { performAction, startRound } from "../src/scheduler.ts";
import type { MatchState, Unit } from "../src/types.ts";
import { makeState, makeUnit } from "./helpers.ts";

// The integration net: every authored hero must LOAD and every skill must RESOLVE against a
// live match without throwing. This is not per-skill correctness (that's golden tests) — it's
// the guarantee that the bulk content is structurally sound and runs on the real engine.

function harness(hero: ReturnType<typeof loadHero>): MatchState {
  const enemies = [1, 2, 3].map((i) => makeUnit({ id: `enemy${i}`, team: "B", hp: 100 }));
  const ally = makeUnit({ id: "ally", team: "A", hp: 100 });
  const state = makeState([hero, ally], enemies);
  // Bankroll every element so any cost can be paid.
  const pool: Record<string, number> = { generic: 99 };
  for (const el of ["fire", "ice", "water", "lightning", "wind", "poison", "earth", "holy", "unholy", "shadow", "nomad", "night", "serum", "apocalypse", "storm", "devil", "vengeance", "prism", hero.currentElement]) pool[el] = 99;
  state.teams.A.energy = pool;
  return state;
}

test("the whole roster loads (27 heroes)", () => {
  assert.equal(ROSTER.length, 27, "all 27 heroes present");
  const ids = new Set(ROSTER.map((h) => h.id));
  assert.equal(ids.size, 27, "no duplicate ids");
});

test("every hero loads and every skill resolves without throwing", () => {
  const failures: string[] = [];
  for (const def of ROSTER) {
    const hero = loadHero(def, "A", def.id);
    for (const skill of hero.skills ?? []) {
      const state = harness(loadHero(def, "A", def.id));
      const self = state.units[def.id] as Unit;
      const target = state.units.enemy1 as Unit;
      try {
        // Reset cooldown so the cast is always attempted; try both a normal cast and a raw effect run.
        skill.currentCd = 0;
        performAction(state, { unit: self.id, skillId: skill.id, targets: [target.id] });
        // Also run the effect tree directly (covers self/none-targeting + minion-summoning paths).
        runEffects(state, skill.effects, { caster: self, self, targets: [target] });
      } catch (err) {
        failures.push(`${def.id}.${skill.id} (${skill.name}): ${(err as Error).message}`);
      }
    }
  }
  assert.deepEqual(failures, [], `skills threw:\n${failures.join("\n")}`);
});

test("every hero's passives/triggers survive a round-start and a few events", () => {
  const failures: string[] = [];
  for (const def of ROSTER) {
    try {
      const hero = loadHero(def, "A", def.id);
      const state = harness(hero);
      startRound(state, "A"); // fires roundStart passives (summons, self-buffs)
      emit(state, { type: "turnStart", team: "A" });
      emit(state, { type: "turnEnd", team: "A" });
    } catch (err) {
      failures.push(`${def.id}: ${(err as Error).message}`);
    }
  }
  assert.deepEqual(failures, [], `passives threw:\n${failures.join("\n")}`);
});
