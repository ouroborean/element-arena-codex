import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers the custom/augment handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

// Engine-fidelity PR2 — cost-system debt retired:
//   titania5 "Jealousy"   → cost_currency_remap (Specific cost becomes Generic-payable)
//   keeper3  "Plot Twist"  → per-cast conditional costMods on the skill (re-evaluated live)

// --- titania5 / cost_currency_remap ------------------------------------------- //

test("cost_currency_remap: a skill's remaining Specific cost becomes Generic-payable; others untouched", () => {
  const u = makeUnit({ id: "u", team: "A" });
  u.skills = [
    skill("basic", [], { klass: "basic", cost: { generic: 0, specific: 2 } }),
    skill("other", [], { klass: "basic", cost: { generic: 0, specific: 2 } }),
  ];
  u.statuses.push({ kind: "cost_currency_remap", skillId: "basic", duration: 1, appliedBy: "u", appliedTurn: 0 });
  assert.deepEqual(effectiveCost(u, u.skills[0]!), { generic: 2, specific: 0 }, "basic's 2 Specific → 2 Generic");
  assert.deepEqual(effectiveCost(u, u.skills[1]!), { generic: 0, specific: 2 }, "the unremapped skill is untouched");
});

test("titania5 Jealousy: an ally triggering Prance remaps the OTHER ally's basic-skill costs to Generic", () => {
  const titania = makeUnit({ id: "t", team: "A" });
  // A bare Prance-shaped trigger that just runs the custom — the full trigger's gates are authored JSON.
  titania.triggers = [{ on: "skillUsed", owner: "t", source: "Prance", effect: [{ op: "custom", fn: "jealousyBasicsToGeneric", args: { duration: 1 } }] }];
  const triggerer = makeUnit({ id: "a1", team: "A" }); // eventSource — the ally who triggered Prance
  triggerer.skills = [skill("a1b", [], { klass: "basic", cost: { generic: 0, specific: 2 } })];
  const other = makeUnit({ id: "a2", team: "A" }); // "the other ally"
  other.skills = [
    skill("a2b1", [], { klass: "basic", cost: { generic: 0, specific: 2 } }),
    skill("a2b2", [], { klass: "basic", cost: { generic: 0, specific: 1 } }),
    skill("a2ult", [], { klass: "ultimate", cost: { generic: 0, specific: 3 } }),
  ];
  const state = makeState([titania, triggerer, other], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "skillUsed", caster: "a1", skillId: "prance", targets: [] });

  assert.ok(other.statuses.some((s) => s.kind === "cost_currency_remap" && s.skillId === "a2b1"), "other ally's basic remapped");
  assert.ok(other.statuses.some((s) => s.kind === "cost_currency_remap" && s.skillId === "a2b2"), "every basic remapped");
  assert.ok(!other.statuses.some((s) => s.kind === "cost_currency_remap" && s.skillId === "a2ult"), "non-basic skill untouched");
  assert.ok(!triggerer.statuses.some((s) => s.kind === "cost_currency_remap"), "the triggering ally is not the 'other ally'");
  assert.deepEqual(effectiveCost(other, other.skills![0]!), { generic: 2, specific: 0 }, "the remapped basic is now Generic-payable");
});

// --- keeper3 / per-cast conditional costMods ---------------------------------- //

test("keeper3 Plot Twist: keeper5 costs one less ONLY while Keeper is the sole living ally hero (re-evaluated per cast)", () => {
  const solo = loadHero(heroById("keeper"), "A", "keeper");
  applyAugment(solo, augmentById("keeper3")!);
  const k5 = (solo.skills ?? []).find((s) => s.id === "keeper5")!;
  assert.ok(k5.costMods && k5.costMods.length === 1, "keeper5 carries a per-cast conditional costMod");
  const base = { ...k5.cost };

  // Solo: the -1 applies (spilling onto Specific, since keeper5's base cost has no Generic component).
  const soloState = makeState([solo], [makeUnit({ id: "e", team: "B" })]);
  assert.deepEqual(effectiveCost(solo, k5, soloState), { generic: 0, specific: base.specific - 1 }, "solo → one less");

  // Not solo (a living ally hero present): the same skill instance costs full — the gate is live per cast.
  const dualState = makeState([solo, makeUnit({ id: "ally", team: "A" })], [makeUnit({ id: "e2", team: "B" })]);
  assert.deepEqual(effectiveCost(solo, k5, dualState), base, "with an ally alive → no reduction");
});
