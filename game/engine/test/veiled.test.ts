import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

// Engine-fidelity — the veiled status now breaks on the veiled unit's own Harmful action (stealth-break-on-
// action), unless the skill opts out (aramao1/aramao2 "Using this skill does not break Veiled"). The
// concealment itself (hiding the veiled unit from the enemy) is a separate server-side redaction concern.

test("Veiled breaks on a Harmful skill, is exempted by doesNotBreakVeil, and a non-Harmful skill never breaks it", () => {
  const u = makeUnit({ id: "u", team: "A", statuses: [status("veiled")] });
  u.skills = [
    skill("harm", [], { tags: ["Harmful"], targeting: "single" }),
    skill("veilharm", [], { tags: ["Harmful"], targeting: "single", doesNotBreakVeil: true }),
    skill("strat", [], { tags: ["Strategic"], targeting: "self" }),
  ];
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { generic: 9 };
  const veiled = (): boolean => u.statuses.some((s) => s.kind === "veiled");

  performAction(state, { unit: "u", skillId: "strat" });
  assert.ok(veiled(), "a Strategic (non-Harmful) skill does not break Veiled");

  performAction(state, { unit: "u", skillId: "veilharm", targets: ["e"] });
  assert.ok(veiled(), "a doesNotBreakVeil Harmful skill (aramao1/2) does not break Veiled");

  performAction(state, { unit: "u", skillId: "harm", targets: ["e"] });
  assert.ok(!veiled(), "a normal Harmful skill breaks Veiled");
});

test("aramao1/aramao2 carry doesNotBreakVeil, and Desert Knife keeps Aramao's Veil when it hits", () => {
  const aramao = loadHero(heroById("aramao"), "A", "aramao");
  const k1 = (aramao.skills ?? []).find((s) => s.id === "aramao1")!;
  const k2 = (aramao.skills ?? []).find((s) => s.id === "aramao2")!;
  assert.equal(k1.doesNotBreakVeil, true, "aramao1 Desert Knife does not break Veiled");
  assert.equal(k2.doesNotBreakVeil, true, "aramao2 does not break Veiled");

  aramao.statuses.push(status("veiled"));
  const state = makeState([aramao], [makeUnit({ id: "e", team: "B", hp: 100 })]);
  state.teams.A.energy = { sand: 9, generic: 9 };
  performAction(state, { unit: "aramao", skillId: "aramao1", targets: ["e"] });
  assert.ok(aramao.statuses.some((s) => s.kind === "veiled"), "Desert Knife (Harmful) left Aramao Veiled");
});
