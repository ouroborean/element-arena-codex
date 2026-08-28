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
import { poolFor, highlightFor, telegraphFor, isSingleTargetPick } from "./targeting.ts";
import { makeState, makeUnit, skill, status } from "../engine/test/helpers.ts";
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

// ── The DYNAMIC widening seam (highlightFor / telegraphFor) — what a UI offers/telegraphs once a skill's
// ── EFFECTIVE targeting changes mid-match. These read effectiveTargeting, the field both clients used to
// ── ignore (they switched on the STATIC skill.targeting), which is how "ultimate castable on anyone" and
// ── "AoE still looks single-target" survived an otherwise exhaustive engine suite. Uses the REAL shipped
// ── Black Knight skills so the authored targeting is part of the assertion. ──────────────────────────── //

const BK = ROSTER.find((h) => h.id === "blackknight")!;
const bkSkill = (id: string): SkillInstance => ({ ...(BK.skills!.find((s) => s.id === id) as SkillInstance), currentCd: 0 });
/** The skill_targeting_override Black Knight's ultimate self-applies to widen Oathbreaker Strike. */
const overrideOathbreaker = (name: "all-enemies" | "all") =>
  status("skill_targeting_override", { skillId: "blackknight1", name, duration: 2 });

test("BUG 1 seam: The Nightmare Rides is self-target — it highlights ONLY the caster, never the whole board", () => {
  const sk = bkSkill("blackknight5");
  assert.equal(sk.targeting, "self", "content: the ultimate is authored self-target (was 'single')");
  const bk = makeUnit({ id: "bk", team: "A", kind: "hero", skills: [sk] });
  const state = makeState([bk, makeUnit({ id: "al", team: "A", kind: "hero" })], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.deepEqual([...highlightFor(state, bk, sk)], ["bk"], "only the caster is offered");
});

test("BUG 2 seam: under the ultimate's override, Oathbreaker Strike highlights AND telegraphs every enemy, not one", () => {
  const sk = bkSkill("blackknight1");
  const bk = makeUnit({ id: "bk", team: "A", kind: "hero", skills: [sk], statuses: [overrideOathbreaker("all-enemies")] });
  const state = makeState([bk], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  assert.deepEqual([...highlightFor(state, bk, sk)].sort(), ["e1", "e2"], "both enemies highlighted");
  assert.deepEqual(telegraphFor(state, { unit: "bk", skillId: "blackknight1" }).sort(), ["e1", "e2"], "plan telegraph shows both enemies");
});

test("BUG 4 seam: the evil-fused widened Oathbreaker highlights EXACTLY what it hits — both enemies + both ally heroes, but NOT the caster or ally minions", () => {
  const sk = bkSkill("blackknight1");
  const bk = makeUnit({ id: "bk", team: "A", kind: "hero", fused: "evil", skills: [sk], statuses: [overrideOathbreaker("all")] });
  const state = makeState(
    [bk, makeUnit({ id: "al1", team: "A", kind: "hero" }), makeUnit({ id: "al2", team: "A", kind: "hero" }), makeUnit({ id: "am", team: "A", kind: "minion" })],
    [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })],
  );
  const hi = highlightFor(state, bk, sk);
  assert.deepEqual([...hi].sort(), ["al1", "al2", "e1", "e2"], "exactly the four units the AoE hits — enemies + ally heroes");
  assert.ok(!hi.has("bk"), "the caster is NOT highlighted (includeSelf:false — he's invulnerable and unhit)");
  assert.ok(!hi.has("am"), "the ally MINION is NOT highlighted (the AoE hits ally heroes only)");
  const tel = new Set(telegraphFor(state, { unit: "bk", skillId: "blackknight1" }));
  assert.deepEqual([...tel].sort(), ["al1", "al2", "e1", "e2"], "the plan telegraph agrees exactly — no self, no minion");
});

test("the single-target-PICK flag follows effective targeting — a widened Oathbreaker no longer forces a one-target click", () => {
  // This is the exact main.ts seam that made a widened AoE 'still look single-target': the client used the
  // STATIC skill.targeting to decide whether to force a single click. isSingleTargetPick reads effectiveTargeting.
  const sk = bkSkill("blackknight1");
  const bare = makeUnit({ id: "bk", team: "A", kind: "hero", skills: [sk] });
  const bareState = makeState([bare], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.equal(isSingleTargetPick(bareState, bare, sk), true, "normally single-target — one click");
  const widened = makeUnit({ id: "bk2", team: "A", kind: "hero", skills: [sk], statuses: [overrideOathbreaker("all-enemies")] });
  const widenedState = makeState([widened], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.equal(isSingleTargetPick(widenedState, widened, sk), false, "under the ultimate it auto-resolves the AoE (no forced single click)");
});

// The OTHER skill_targeting_override producer: Taryn's zealot Banner of Harmony (bannerAffectsAllEnemies) widens
// the single-target taryn1 to all-enemies. Same dynamic-widen class as Black Knight — guard the offering seam
// for it too (the existing Taryn suite only checks engine RESOLUTION with hand-picked targets).
const TARYN = ROSTER.find((h) => h.id === "taryn")!;
const taryn1 = (): SkillInstance => ({ ...(TARYN.skills!.find((s) => s.id === "taryn1") as SkillInstance), currentCd: 0 });

test("Taryn's Banner override widens Banner of Harmony's offering to ALL enemies (client seam, not just engine resolution)", () => {
  const sk = taryn1();
  assert.equal(sk.targeting, "single", "content: Banner of Harmony is authored single-target");
  const t = makeUnit({ id: "t", team: "A", kind: "hero", skills: [sk], statuses: [status("skill_targeting_override", { skillId: "taryn1", name: "all-enemies", duration: 1 })] });
  const state = makeState([t], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  assert.equal(isSingleTargetPick(state, t, sk), false, "no longer forces a single click while the Banner override is up");
  assert.deepEqual(telegraphFor(state, { unit: "t", skillId: "taryn1" }).sort(), ["e1", "e2"], "the plan telegraphs BOTH enemies (pre-fix: only the caster)");
  assert.deepEqual([...highlightFor(state, t, sk)].sort(), ["e1", "e2"], "and both enemies are highlighted");
});

// ── Class A (self-target mismatch): a no-pick self action authored targeting:"single" is offered to the whole
// ── board. blackknight5 was the exemplar; the audit found blackknight4 (its sibling) + others. Guard the
// ── base-hero ones behaviorally: they must highlight ONLY the caster. ─────────────────────────────────── //
test("Class A: self-buff skills highlight only the caster, never the board (targeting must be 'self')", () => {
  for (const id of ["saya4", "saya5", "sera4", "dennis5", "blackknight4"]) {
    const owner = ROSTER.find((h) => (h.skills ?? []).some((s) => s.id === id))!;
    const sk: SkillInstance = { ...(owner.skills!.find((s) => s.id === id) as SkillInstance), currentCd: 0 };
    assert.equal(sk.targeting, "self", `${id} is authored self-target`);
    const caster = makeUnit({ id: "c", team: "A", kind: "hero", skills: [sk] });
    const state = makeState([caster, makeUnit({ id: "al", team: "A", kind: "hero" })], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
    assert.deepEqual([...highlightFor(state, caster, sk)], ["c"], `${id} highlights only the caster`);
  }
});

// ── Class B2 (over-highlight): a natively group-targeted skill must light up EXACTLY what its effects reach
// ── (honoring includeSelf / kind / status filters), not the raw living-team set. Driven through the real
// ── shipped skills so the effect tree and the highlight can't drift. ──────────────────────────────────── //
const anySkill = (id: string): SkillInstance => {
  for (const h of ROSTER) for (const s of h.skills ?? []) if (s.id === id) return { ...(s as SkillInstance), currentCd: 0 };
  for (const f of FUSIONS) if ((f.skill as SkillInstance | undefined)?.id === id) return { ...(f.skill as SkillInstance), currentCd: 0 };
  throw new Error(`skill ${id} not found`);
};

test("Class B2: roland5 Fissure ('all', includeSelf:false) highlights everyone EXCEPT the caster", () => {
  const sk = anySkill("roland5");
  const r = makeUnit({ id: "r", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([r, makeUnit({ id: "al", team: "A", kind: "hero" })], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hi = highlightFor(st, r, sk);
  assert.ok(hi.has("al") && hi.has("e"), "the ally and enemy are highlighted");
  assert.ok(!hi.has("r"), "the caster (Roland) is NOT highlighted (includeSelf:false)");
});

test("Class B2: pyrrhasun1 Scorched Earth ('all-enemies', kind:hero) does NOT highlight enemy minions", () => {
  const sk = anySkill("pyrrhasun1");
  const p = makeUnit({ id: "p", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([p], [makeUnit({ id: "eh", team: "B", kind: "hero" }), makeUnit({ id: "em", team: "B", kind: "minion" })]);
  const hi = highlightFor(st, p, sk);
  assert.ok(hi.has("eh"), "the enemy hero is highlighted");
  assert.ok(!hi.has("em"), "the enemy MINION is NOT highlighted (kind:hero)");
});

test("Class B2: jarrik3 Call Cinders ('all-enemies', with mark Cinders) highlights only Cinders-marked enemies", () => {
  const sk = anySkill("jarrik3");
  const j = makeUnit({ id: "j", team: "A", kind: "hero", skills: [sk] });
  const marked = makeUnit({ id: "em", team: "B", kind: "hero", statuses: [status("mark", { name: "Cinders" })] });
  const clean = makeUnit({ id: "ec", team: "B", kind: "hero" });
  const st = makeState([j], [marked, clean]);
  const hi = highlightFor(st, j, sk);
  assert.ok(hi.has("em"), "the Cinders-marked enemy is highlighted");
  assert.ok(!hi.has("ec"), "the un-marked enemy is NOT highlighted (with:{mark:Cinders})");
});

test("Class B1 (client seam): a widenTargeting skill stops forcing a single-target click while its live condition holds", () => {
  const sk = anySkill("maggie3"); // Thornburst — widens to all-enemies at 3+ Curse of Thorns stacks
  const mk = (stacks: number) => {
    const c = makeUnit({ id: "m", team: "A", kind: "hero", skills: [sk], statuses: stacks ? [status("stack", { name: "Curse of Thorns", magnitude: stacks })] : [] });
    return { c, st: makeState([c], [makeUnit({ id: "e", team: "B", kind: "hero" })]) };
  };
  { const { c, st } = mk(3); assert.equal(isSingleTargetPick(st, c, sk), false, "3+ Curse stacks -> AoE, no forced single click"); }
  { const { c, st } = mk(2); assert.equal(isSingleTargetPick(st, c, sk), true, "2 stacks -> still a single-target pick"); }
});

test("Class B2 (regression): an all-enemies skill with a self-cleanup/self-buff rider does NOT highlight the caster", () => {
  // affectedUnits unions every affecting op's target, incl. from:self / to:self bookkeeping riders — the
  // category filter (reachInCategory) drops units outside the targeting faction so the caster's own portrait
  // never lights up on an enemy AoE (gommar2 clears Frost-Covered from itself).
  const sk = anySkill("gommar2");
  assert.equal(sk.targeting, "all-enemies", "content: gommar2 is authored all-enemies");
  const g = makeUnit({ id: "g", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([g], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  const hi = highlightFor(st, g, sk);
  assert.deepEqual([...hi].sort(), ["e1", "e2"], "only the enemies are highlighted");
  assert.ok(!hi.has("g"), "the caster is NOT highlighted despite its from:self cleanup");
});

// ── Class B2 (custom-op skills): affectedUnits can't walk a custom/useSkill reach, so these carry an explicit
// ── authored highlightSelector. Verify each narrows to exactly what it affects. ───────────────────────── //
test("Class B2 (highlightSelector): tarynsanctuary1 highlights allied heroes only", () => {
  const sk = anySkill("tarynsanctuary1");
  const t = makeUnit({ id: "t", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([t, makeUnit({ id: "ah", team: "A", kind: "hero" }), makeUnit({ id: "am", team: "A", kind: "minion" })], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.deepEqual([...highlightFor(st, t, sk)].sort(), ["ah", "t"], "Taryn + ally hero; not the ally minion or the enemy");
});

test("Class B2 (highlightSelector): hectorserum1 highlights the caster + all enemies", () => {
  const sk = anySkill("hectorserum1");
  const h = makeUnit({ id: "h", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([h, makeUnit({ id: "al", team: "A", kind: "hero" })], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  assert.deepEqual([...highlightFor(st, h, sk)].sort(), ["e1", "e2", "h"], "Hector (self-buff) + enemies; not the other ally");
});

test("Class B2 (highlightSelector): rolandnomad1 highlights Mark-the-Path enemy heroes + ally Boulders (union reach)", () => {
  const sk = anySkill("rolandnomad1");
  const r = makeUnit({ id: "r", team: "A", kind: "hero", skills: [sk] });
  const markedEnemy = makeUnit({ id: "me", team: "B", kind: "hero", statuses: [status("mark", { name: "Mark the Path" })] });
  const st = makeState(
    [r, makeUnit({ id: "b", team: "A", kind: "minion", name: "Boulder" }), makeUnit({ id: "om", team: "A", kind: "minion", name: "Slimeball" })],
    [markedEnemy, makeUnit({ id: "ce", team: "B", kind: "hero" })],
  );
  assert.deepEqual([...highlightFor(st, r, sk)].sort(), ["b", "me"], "marked enemy hero + Boulder; not the clean enemy, other minion, or Roland");
});

test("Class B1 (spread telegraph): Supercharged Electroblade telegraphs ALL enemies while keeping its single pick", () => {
  const sk = anySkill("ando1");
  const a = makeUnit({ id: "a", team: "A", kind: "hero", skills: [sk], statuses: [status("mark", { name: "Supercharged" })] });
  const st = makeState([a], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" }), makeUnit({ id: "e3", team: "B", kind: "hero" })]);
  assert.equal(isSingleTargetPick(st, a, sk), true, "still a single-target pick (magnet fusion's Charge Absorption needs the primary)");
  assert.deepEqual(telegraphFor(st, { unit: "a", skillId: "ando1", targets: ["e1"] }).sort(), ["e1", "e2", "e3"], "but the plan telegraphs the whole spread");
});

test("Class B1 (spread telegraph): Dive Undertow telegraphs ALL enemies while keeping the single pick its stun needs", () => {
  const sk = anySkill("riverdaughter2");
  const r = makeUnit({ id: "r", team: "A", kind: "hero", skills: [sk], statuses: [status("mark", { name: "Dive Undertow" })] });
  const st = makeState([r], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  assert.equal(isSingleTargetPick(st, r, sk), true, "still a single pick (the Undertow stun targets the chosen enemy)");
  assert.deepEqual(telegraphFor(st, { unit: "r", skillId: "riverdaughter2", targets: ["e1"] }).sort(), ["e1", "e2"], "the damage spread telegraphs both enemies");
});

test("spread telegraph: a plain single-target hit telegraphs ONLY its target (no spread)", () => {
  const sk = skill("hit", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], { tags: ["Harmful"] });
  const c = makeUnit({ id: "c", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([c], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  assert.deepEqual(telegraphFor(st, { unit: "c", skillId: "hit", targets: ["e1"] }), ["e1"], "just the picked target");
});

test("spread telegraph: rolandsun1 (consumes its own Boulders) telegraphs only the enemy target, not the ally Boulder", () => {
  const sk = anySkill("rolandsun1");
  const r = makeUnit({ id: "r", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([r, makeUnit({ id: "bo", team: "A", kind: "minion", name: "Boulder" })], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" })]);
  assert.deepEqual(telegraphFor(st, { unit: "r", skillId: "rolandsun1", targets: ["e1"] }), ["e1"], "the consumed friendly Boulder is filtered out of the spread (Harmful pick → enemy faction only)");
});

test("spread telegraph: galazax2 (random secondary hit) telegraphs only the picked target, not a speculative random enemy", () => {
  const sk = anySkill("galazax2");
  const g = makeUnit({ id: "g", team: "A", kind: "hero", skills: [sk] });
  const st = makeState([g], [makeUnit({ id: "e1", team: "B", kind: "hero" }), makeUnit({ id: "e2", team: "B", kind: "hero" }), makeUnit({ id: "e3", team: "B", kind: "hero" })]);
  assert.deepEqual(telegraphFor(st, { unit: "g", skillId: "galazax2", targets: ["e1"] }), ["e1"], "a pick:random reach is non-stable → falls back to the pick, not a wrong pinned portrait");
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
