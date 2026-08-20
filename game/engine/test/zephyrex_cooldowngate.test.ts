import { test } from "node:test";
import assert from "node:assert/strict";
import { canUse } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { SkillInstance } from "../src/skill.ts";

// Engine-fidelity — zephyrex3 "Sonic Thrust": "...can only be used if Wind Step is on cooldown." Now a real
// castability gate via requires:{skillOnCooldown:"zephyrex4"} — a new Condition reading the caster's own
// skill's live cooldown (previously undocumentable in the DSL).

test("Sonic Thrust is castable only while Wind Step (zephyrex4) is on cooldown", () => {
  const zeph = loadHero(heroById("zephyrex"), "A", "z");
  const z3 = (zeph.skills ?? []).find((s) => s.id === "zephyrex3") as SkillInstance;
  const z4 = (zeph.skills ?? []).find((s) => s.id === "zephyrex4") as SkillInstance;
  const state = makeState([zeph], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  state.teams.A.energy = { wind: 9, generic: 9 };
  z3.currentCd = 0; // Sonic Thrust itself is off cooldown

  z4.currentCd = 0; // Wind Step ready
  assert.equal(canUse(state, zeph, z3), false, "unusable while Wind Step is ready");

  z4.currentCd = 2; // Wind Step on cooldown
  assert.equal(canUse(state, zeph, z3), true, "usable while Wind Step is on cooldown");

  z4.currentCd = 0; // back to ready
  assert.equal(canUse(state, zeph, z3), false, "gate is live — re-blocks once Wind Step comes back up");
});
