import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, effectiveCooldown } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers custom handlers
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// The bulk-author pass added one engine primitive — the `cooldown_mod` status — and a
// set of native `custom` handlers. These cover the faithful ones directly (the smoke
// test only proves they don't throw).

test("cooldown_mod adds to the cooldown a skill goes on when used (hector3 Mindfog)", () => {
  const caster = makeUnit({ id: "hex", team: "A" });
  const foe = makeUnit({ id: "foe", team: "B" });
  const s = skill("s", [{ op: "damage", amount: 5, to: "target" }], { cooldown: 2 });
  foe.skills = [s];
  const state = makeState([caster], [foe]);

  assert.equal(effectiveCooldown(foe, s), 2, "base cooldown");
  foe.statuses.push(status("cooldown_mod", { magnitude: 1, name: "Mindfog Serum", duration: 3 }));
  assert.equal(effectiveCooldown(foe, s), 3, "+1 while Mindfog stands");

  // A -1 mod cannot drive the cooldown below 0.
  foe.statuses = [status("cooldown_mod", { magnitude: -5 })];
  assert.equal(effectiveCooldown(foe, s), 0, "floored at 0");
});

test("a cast under cooldown_mod goes on the modified cooldown", () => {
  const foe = makeUnit({ id: "foe", team: "B", hp: 50 });
  const caster = makeUnit({ id: "hex", team: "A" });
  const s = skill("s", [{ op: "damage", amount: 5, to: "target" }], { cooldown: 1 });
  caster.skills = [s];
  caster.statuses.push(status("cooldown_mod", { magnitude: 2 }));
  const state = makeState([caster], [foe]);
  state.teams.A.energy = { generic: 9 };

  const res = performAction(state, { unit: "hex", skillId: "s", targets: ["foe"] });
  assert.equal(res.ok, true);
  assert.equal(caster.skills![0]!.currentCd, 3, "1 base + 2 mod");
});

test("equalizeHp averages a unit and its minion (syl4 Unbreakable Bond)", () => {
  const syl = makeUnit({ id: "syl", team: "A", hp: 80 });
  const eagle: Unit = { ...makeUnit({ id: "eagle", team: "A", hp: 20 }), kind: "minion" };
  const state = makeState([syl, eagle], [makeUnit({ id: "foe", team: "B" })]);

  runEffects(state, [{ op: "custom", fn: "equalizeHp", args: { units: ["self", { faction: "allies", kind: "minion" }] } }], {
    caster: syl, self: syl, targets: [],
  });
  assert.equal(syl.hp, 50, "80+20 → avg 50");
  assert.equal(eagle.hp, 50);
});

test("clearCooldownMod strips the Mindfog penalty (hector5)", () => {
  const dennis: Unit = { ...makeUnit({ id: "dennis", team: "A", hp: 30 }), kind: "minion", name: "Dennis the Apprentice" };
  dennis.statuses.push(status("cooldown_mod", { magnitude: 1, name: "Mindfog Serum" }));
  const hector = makeUnit({ id: "hector", team: "A" });
  const state = makeState([hector, dennis], [makeUnit({ id: "foe", team: "B" })]);

  runEffects(state, [{ op: "custom", fn: "clearCooldownMod", args: { from: { faction: "allies", kind: "minion", template: "Dennis the Apprentice" } } }], {
    caster: hector, self: hector, targets: [],
  });
  assert.equal(dennis.statuses.some((s) => s.kind === "cooldown_mod"), false);
});
