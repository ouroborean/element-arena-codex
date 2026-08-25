/**
 * Tests for the CLIENT target-OFFERING layer (poolFor) — the seam the engine behavioral suite never crosses.
 *
 * The engine's suite drives targeting by passing target ids straight to performAction, so it verifies target
 * legality + effects (e.g. Nightwrap heals an ally you HAND it) but never the code that decides which units a
 * UI lets a player CLICK. That code (poolFor, shared by both clients) is where the Laria "can't target allies
 * with Nightwrap" bug lived. These tests cover the faction ladder directly, plus a data-driven guard that any
 * skill flagged targetsEitherFaction is actually offerable to both sides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFor } from "./targeting.ts";
import { makeState, makeUnit, skill } from "../engine/test/helpers.ts";
import { ROSTER } from "../engine/content/roster.generated.ts";
import { FUSIONS } from "../engine/content/fusions.generated.ts";
import type { SkillInstance } from "../engine/src/skill.ts";

/** A caster on team A with `sk`, plus an ally and an enemy; returns the OFFERED target ids. */
function offered(sk: SkillInstance, casterOver: Partial<Parameters<typeof makeUnit>[0]> = {}): string[] {
  const caster = makeUnit({ id: "c", team: "A", kind: "hero", skills: [sk], ...casterOver });
  const ally = makeUnit({ id: "al", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([caster, ally], [enemy]);
  return poolFor(state, caster, sk).map((x) => x.id);
}

test("a cross-faction skill (targetsEitherFaction) offers BOTH an enemy and an ally — the Nightwrap regression", () => {
  const pool = offered(skill("x", [], { tags: ["Harmful", "Helpful"], targetsEitherFaction: true }));
  assert.ok(pool.includes("e"), "an enemy is offered");
  assert.ok(pool.includes("al"), "an ALLY is offered");
});

test("a Harmful-only skill offers only enemies", () => {
  const pool = offered(skill("x", [], { tags: ["Harmful"] }));
  assert.ok(pool.includes("e"), "enemy offered");
  assert.ok(!pool.includes("al"), "ally NOT offered");
});

test("a Helpful-only skill offers only allies", () => {
  const pool = offered(skill("x", [], { tags: ["Helpful"] }));
  assert.ok(pool.includes("al"), "ally offered");
  assert.ok(!pool.includes("e"), "enemy NOT offered");
});

test("a Harmful+Helpful skill WITHOUT the flag stays enemies-only (Bog Witch's Bargain: the Helpful tag is a self-heal)", () => {
  const pool = offered(skill("x", [], { tags: ["Harmful", "Helpful"] })); // no targetsEitherFaction
  assert.ok(pool.includes("e"), "enemy offered");
  assert.ok(!pool.includes("al"), "ally NOT offered — tags alone must not widen to allies");
});

test("a skill with neither Harmful nor Helpful offers both factions (Strategic single-target)", () => {
  const pool = offered(skill("x", [], { tags: ["Strategic"] }));
  assert.ok(pool.includes("e") && pool.includes("al"), "both factions offered");
});

test("Merciless (blackknight1 while evil-fused): Oathbreaker Strike offers enemies + allied HEROES, not self or minions", () => {
  const caster = makeUnit({ id: "bk", team: "A", kind: "hero", fused: "evil", skills: [skill("blackknight1", [], { tags: ["Harmful"] })] });
  const allyHero = makeUnit({ id: "ah", team: "A", kind: "hero" });
  const allyMinion = makeUnit({ id: "am", team: "A", kind: "minion" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([caster, allyHero, allyMinion], [enemy]);
  const pool = poolFor(state, caster, caster.skills![0]!).map((x) => x.id);
  assert.ok(pool.includes("e"), "enemy offered");
  assert.ok(pool.includes("ah"), "allied HERO offered");
  assert.ok(!pool.includes("bk"), "self NOT offered");
  assert.ok(!pool.includes("am"), "allied MINION not offered");
});

// ── Data-driven guards over the real content (auto-cover future flagged skills) ──────────────────────── //

/** Every skill in the shipped roster + fusion forms that carries the targetsEitherFaction flag. */
function flaggedSkills(): SkillInstance[] {
  const out: SkillInstance[] = [];
  for (const h of ROSTER) for (const s of h.skills ?? []) if ((s as SkillInstance).targetsEitherFaction) out.push({ ...(s as SkillInstance), currentCd: 0 });
  for (const f of FUSIONS) { const s = f.skill as SkillInstance | undefined; if (s?.targetsEitherFaction) out.push({ ...s, currentCd: 0 }); }
  return out;
}

test("exactly the six 'enemy or ally' skills carry targetsEitherFaction (drift guard)", () => {
  const ids = flaggedSkills().map((s) => s.id).sort();
  assert.deepEqual(ids, ["fate1", "hectorfaerie1", "laria1", "pyrrharitual1", "taryn2", "titaniaantidote1"],
    "if this changes, confirm the skill's frozen prose really says 'target an enemy or an ally'");
});

test("every targetsEitherFaction skill in real content is offerable to BOTH factions", () => {
  for (const sk of flaggedSkills()) {
    const pool = offered(sk);
    assert.ok(pool.includes("e"), `${sk.id} offers an enemy`);
    assert.ok(pool.includes("al"), `${sk.id} offers an ally`);
  }
});
