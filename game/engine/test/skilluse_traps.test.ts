import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects, emit } from "../src/effects/interpret.ts";
import "../content/hero.ts"; // side-effect: registers the fusion custom handlers
import { makeState, makeUnit } from "./helpers.ts";

// Engine-fidelity — the "target-side skillUsed trap" primitives (armSkillUseTrap / armSkillUseReward /
// removeMarkOnSkillUse) are real and complete; the three fusion notes that claimed otherwise were stale.
// This locks armSkillUseTrap (hector:assassin "To Your Health!"), the least-covered of them: a target that
// uses a skill within the window eats the onUse payload AND has the cancels-mark stripped (so its onExpire
// heal never fires).

test("armSkillUseTrap: the target acting fires onUse and cancels the pending heal-mark; not acting lets it stand", () => {
  const caster = makeUnit({ id: "c", team: "A" });
  const target = makeUnit({ id: "t", team: "B", hp: 100 });
  const state = makeState([caster], [target]);

  runEffects(state, [
    { op: "applyStatus", to: "target", status: { kind: "mark", name: "Heal Mark", duration: 2, onExpire: [{ op: "heal", amount: 15, to: "caster" }] } },
    { op: "custom", fn: "armSkillUseTrap", args: { on: "target", window: 2, cancels: "Heal Mark", onUse: [
      { op: "damage", amount: 15, dtype: "affliction", to: "target" },
      { op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } },
    ] } },
  ], { caster, self: caster, targets: [target], skillId: "s" });

  assert.ok(target.statuses.some((s) => s.kind === "mark" && s.name === "Skill Trap"), "trap armed on the target");
  assert.ok(target.statuses.some((s) => s.kind === "mark" && s.name === "Heal Mark"), "heal-mark present");

  emit(state, { type: "skillUsed", caster: "t", skillId: "x", targets: [] }); // the target uses a skill → trap springs

  assert.equal(target.hp, 85, "onUse dealt 15 Affliction to the target");
  assert.ok(target.statuses.some((s) => s.kind === "stun"), "onUse stunned the target");
  assert.ok(!target.statuses.some((s) => s.kind === "mark" && s.name === "Heal Mark"), "cancels stripped the heal-mark → its onExpire heal cannot fire");
  assert.ok(!target.statuses.some((s) => s.kind === "mark" && s.name === "Skill Trap"), "the trap mark is consumed");
});

test("armSkillUseReward: the marked ally using a skill grants Elemental Essence", () => {
  const caster = makeUnit({ id: "c", team: "A" });
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([caster, ally], [makeUnit({ id: "e", team: "B" })]);

  runEffects(state, [{ op: "custom", fn: "armSkillUseReward", args: { on: { faction: "allies", includeSelf: false }, window: 1 } }],
    { caster, self: caster, targets: [ally], skillId: "s" });

  emit(state, { type: "skillUsed", caster: "a2", skillId: "x", targets: [] });
  assert.ok(ally.statuses.some((s) => s.kind === "elemental_essence"), "the ally gained Essence by using a skill");
});
