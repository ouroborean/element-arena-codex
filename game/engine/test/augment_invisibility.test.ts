import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// PR 7 — the remaining augment-granted invisibility grants, now expressible via the two capabilities the
// feature added: setSkillMeta may set isHidden (skill-level "X is now invisible"), and a status spec may
// carry invisible:true (per-effect "this effect is invisible"). Both flow through redactState.

const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;

test("Polite Denial makes Elegant Sweep Invisible (augment setSkillMeta isHidden)", () => {
  const z = loadHero(heroById("zephyrex"), "A", "z");
  applyAugment(z, augmentById("zephyrex5")!);
  assert.equal(skillOf(z, "zephyrex2").isHidden, true, "Elegant Sweep (zephyrex2) is now Invisible");
});

test("Wind Dancer makes the augmented Wind Step's enemy-side effects Invisible (replaceSkill isHidden)", () => {
  const z = loadHero(heroById("zephyrex"), "A", "z");
  applyAugment(z, augmentById("zephyrex3")!);
  assert.equal(skillOf(z, "zephyrex4").isHidden, true, "the augmented Wind Step is Invisible");

  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([z], [enemy]); // zephyrex4 costs 0, so no energy needed
  performAction(state, { unit: "z", skillId: "zephyrex4", targets: ["e"] });

  assert.ok(enemy.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.invisible), "the -10 debuff on the enemy is Invisible");
  assert.ok(!redactState(state, "B").units["e"]!.statuses.some((s) => s.name === "Wind Dancer"), "the enemy cannot see the Wind Dancer mark tracking it");
  assert.ok(!redactState(state, "B").units["e"]!.statuses.some((s) => s.kind === "outgoing_damage_mod"), "nor the damage debuff");
});

test("Proto-Prophecy conceals Heavenly Parry's -10 debuff from the debuffed enemy", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  applyAugment(sera, augmentById("sera2")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([sera], [enemy]);
  state.teams.A.energy = { generic: 10, vengeance: 10 };

  performAction(state, { unit: "s", skillId: "sera3", targets: ["e"] });

  const debuff = enemy.statuses.find((s) => s.kind === "outgoing_damage_mod");
  assert.ok(debuff && debuff.invisible, "the -10 debuff is Invisible");
  assert.ok(!redactState(state, "B").units["e"]!.statuses.some((s) => s.kind === "outgoing_damage_mod"), "the debuffed enemy cannot see it");
});
