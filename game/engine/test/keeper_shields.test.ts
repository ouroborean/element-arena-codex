import { test } from "node:test";
import assert from "node:assert/strict";
import { addShield, applyDamage, totalShield } from "../src/damage.ts";
import { performAction, startRound } from "../src/scheduler.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

// Engine-fidelity — the Keeper of Fables shield primitives:
//   shield_grant_bonus (keeperlich0 "Licherature": Tales to Tell grants 10 additional Shield whenever it activates)
//   shield_non_absorbing (keepermyth0 "Wise Old Man": the Shield no longer prevents damage to Keeper)

test("shield_grant_bonus: every Shield grant to the holder is boosted (Licherature +10)", () => {
  const u = makeUnit({ statuses: [status("shield_grant_bonus", { magnitude: 10 })] });
  addShield(u, 40, null, "x", 0);
  assert.equal(totalShield(u), 50, "40 granted + 10 bonus");
  addShield(u, 5, null, "x", 0);
  assert.equal(totalShield(u), 65, "each grant is boosted (5 + 10)");

  const v = makeUnit({}); // no bonus
  addShield(v, 40, null, "x", 0);
  assert.equal(totalShield(v), 40, "no bonus without the status");
});

test("shield_non_absorbing: the pool stops absorbing (damage falls through) but stays intact (Wise Old Man)", () => {
  const u = makeUnit({ hp: 100, shield: 30, statuses: [status("shield_non_absorbing")] });
  const r = applyDamage(u, { amount: 20, type: "normal" });
  assert.equal(r.hpLost, 20, "damage fell through to HP");
  assert.equal(u.hp, 80);
  assert.equal(totalShield(u), 30, "shield intact (a pure resource pool)");
  assert.equal(r.shieldAbsorbed, 0, "nothing absorbed");

  const v = makeUnit({ hp: 100, shield: 30 }); // normal shield
  assert.equal(applyDamage(v, { amount: 20, type: "normal" }).shieldAbsorbed, 20, "control: normal shield absorbs");
  assert.equal(v.hp, 100);
});

test("Wise Old Man (fused Keeper): the roundStart passive makes his Tales-to-Tell Shield non-absorbing", () => {
  const keeper = loadHero(heroById("keeper"), "A", "k");
  applyFusion(keeper, fusionForm("keeper", "myth")!);
  const state = makeState([keeper], [makeUnit({ id: "e", team: "B" })]);
  startRound(state); // Wise Old Man's roundStart trigger applies shield_non_absorbing

  assert.ok(keeper.statuses.some((s) => s.kind === "shield_non_absorbing"), "the passive applied shield_non_absorbing");
  addShield(keeper, 40, null, keeper.id, state.turn); // Tales to Tell
  const r = applyDamage(keeper, { amount: 25, type: "normal" });
  assert.equal(r.hpLost, 25, "the hit falls through to HP");
  assert.equal(totalShield(keeper), 40, "the Shield pool is untouched (still a resource)");
});
