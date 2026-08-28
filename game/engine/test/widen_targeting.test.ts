import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTargeting } from "../src/scheduler.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import { ROSTER } from "../content/roster.generated.ts";
import { FUSIONS } from "../content/fusions.generated.ts";
import type { SkillInstance } from "../src/skill.ts";

// Class B1 — a normally single-target skill that becomes a faction-wide AoE in some state must report the
// widened category through effectiveTargeting, so the client stops forcing a single-target click and
// highlights/telegraphs/auto-resolves the whole group. The audit found maggie3, jarrik1, pyrrhadragon1
// (ando1 was excluded — its magnet fusion's Charge Absorption depends on the single-declared model; and
// riverdaughter2 needs a damage-only widen that preserves its co-located single-target stun).

test("widenTargeting: effectiveTargeting reports the widened category exactly while the live condition holds", () => {
  const sk = skill("x", [], {
    targeting: "single",
    tags: ["Harmful"],
    widenTargeting: { when: { cmp: "<=", left: { ref: "currentHp", of: "self" }, right: 30 }, to: "all-enemies" },
  });
  const low = makeUnit({ id: "c", team: "A", hp: 30, maxHp: 100, skills: [sk] });
  const high = makeUnit({ id: "c2", team: "A", hp: 31, maxHp: 100, skills: [sk] });
  const st = makeState([low], [makeUnit({ id: "e", team: "B" })]);
  const st2 = makeState([high], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(effectiveTargeting(st, low, sk), "all-enemies", "widens at HP<=30");
  assert.equal(effectiveTargeting(st2, high, sk), "single", "stays single above the threshold");
  // An explicit skill_targeting_override still takes precedence over the widen rule.
  low.statuses.push(status("skill_targeting_override", { skillId: "x", name: "all" }));
  assert.equal(effectiveTargeting(st, low, sk), "all", "an override beats widenTargeting");
});

test("widenTargeting content: the conditional full-AoE skills carry a live widen rule (maggie3, jarrik1, pyrrhadragon1)", () => {
  const find = (id: string): SkillInstance | undefined => {
    for (const h of ROSTER) for (const s of h.skills ?? []) if (s.id === id) return s as SkillInstance;
    for (const f of FUSIONS) if ((f.skill as SkillInstance | undefined)?.id === id) return f.skill as SkillInstance;
    return undefined;
  };
  for (const id of ["maggie3", "jarrik1", "pyrrhadragon1"]) {
    const s = find(id);
    assert.ok(s, `${id} found in shipped content`);
    assert.ok(s!.widenTargeting, `${id} carries a widenTargeting rule`);
    assert.equal(s!.widenTargeting!.to, "all-enemies", `${id} widens to all-enemies`);
  }
});
