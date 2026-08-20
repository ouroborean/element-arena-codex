import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Engine-fidelity — the per-skill isHidden ("This effect is Invisible") flag now survives codegen and rides
// the skillUsed/skillDeclared events, readable via the eventHidden Condition. Its ledger-cited consumer is
// Sera "Eyes of Vengeance": "Enemy Heroes who use non-Invisible Harmful skills on Sera or her allies gain a
// stack" — now a real filter ({not:{eventHidden:true}}) that ignores the 20 inherently-Invisible skills.

const eyes = (u: Unit): number => u.statuses.find((s) => s.kind === "stack" && s.name === "Eyes of Vengeance")?.magnitude ?? 0;

test("Eyes of Vengeance fires on a non-Invisible enemy Harmful skill, not on an Invisible one (event flag)", () => {
  const sera = loadHero(heroById("sera"), "A", "sera");
  const ally = makeUnit({ id: "a2", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([sera, ally], [enemy]);

  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["a2"], tags: ["Harmful"], hidden: false });
  assert.equal(eyes(enemy), 1, "a visible (non-Invisible) Harmful skill on an ally → a stack");

  emit(state, { type: "skillUsed", caster: "e", skillId: "y", targets: ["a2"], tags: ["Harmful"], hidden: true });
  assert.equal(eyes(enemy), 1, "an Invisible (isHidden) skill adds no stack");

  emit(state, { type: "skillUsed", caster: "e", skillId: "z", targets: ["a2"], tags: ["Harmful"] }); // hidden omitted = visible
  assert.equal(eyes(enemy), 2, "hidden omitted is treated as visible → a stack");
});

test("isHidden threads from the skill through performAction to the event (Sera ignores a real isHidden cast)", () => {
  const sera = loadHero(heroById("sera"), "A", "sera");
  const ally = makeUnit({ id: "a2", team: "A" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  enemy.skills = [
    skill("vis", [], { tags: ["Harmful"], targeting: "single" }),
    skill("inv", [], { tags: ["Harmful"], targeting: "single", isHidden: true }),
  ];
  const state = makeState([sera, ally], [enemy]);
  state.teams.B.energy = { generic: 5 };

  performAction(state, { unit: "e", skillId: "vis", targets: ["a2"] }); // visible → stack
  assert.equal(eyes(enemy), 1, "visible skill cast → Sera stacks");

  performAction(state, { unit: "e", skillId: "inv", targets: ["a2"] }); // isHidden → skillUsed carries hidden:true → no stack
  assert.equal(eyes(enemy), 1, "isHidden skill cast → no stack (the flag reached the event)");
});
