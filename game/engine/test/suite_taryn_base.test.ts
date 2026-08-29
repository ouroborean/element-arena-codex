import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// =============================================================================
// Adversarial, spec-derived suite for Taryn's BASE kit. Every assertion is
// derived from the FROZEN prose (content/frozen/skills.json), not from the
// implementation. Taryn's element is Holy, so Specific costs are paid in holy.
//
//   taryn0 Protector of the Song (passive): "When Taryn has an ability reflected
//     to him, he gains 10 DR for 1 turn and Elemental Essence."
//   taryn1 Banner of Harmony: "Deals 15 damage to target enemy. For 1 turns, any
//     Harmful skill used by the target is reflected to Taryn."
//   taryn2 Refrain: "Targets one enemy or ally. If used on an enemy, stuns their
//     harmful skills for 1 turn. If used on an ally, they are healed for 15 health
//     whenever they use a skill for 2 turns."
//   taryn3 Inspiring Thrust: "Deals 20 damage to target enemy. This turn, any ally
//     who uses a new harmful skill on the target will gain Elemental Essence."
//   taryn4 Stalwart Shield: "May target Taryn or an ally. Grants Taryn 20 Shield,
//     and if used on an ally, reflects all harmful skills from the target to
//     himself. This skill's target is invisible."
//   taryn5 Radiant Glory: "For 3 turns, using Stalwart Shield and Inspiring Thrust
//     will also use Refrain on the target."
// =============================================================================

// A synthetic harmful skill (no side effects other than a plain damage hit) — lets
// us drive an enemy/ally attack without coupling to any other hero's implementation.
const harmSkill = (id: string, amount: number) =>
  skill(id, [{ op: "damage", amount, to: "target", id: `${id}.d` }], {
    tags: ["Harmful"], element: "fire", cost: { generic: 0, specific: 0 }, targeting: "single",
  });
// A synthetic non-harmful skill (self heal) — used to prove tag-scoped stuns leave it alone.
const helpSkill = (id: string) =>
  skill(id, [{ op: "heal", amount: 1, to: "self", id: `${id}.h` }], {
    tags: ["Helpful"], element: "fire", cost: { generic: 0, specific: 0 }, targeting: "self",
  });

interface Board { taryn: Unit; ally: Unit; enemy: Unit; enemy2: Unit; state: MatchState; }

function board(allyHp = 100): Board {
  const taryn = loadHero(heroById("taryn"), "A", "taryn");
  const ally = makeUnit({ id: "a2", team: "A", kind: "hero", hp: allyHp, maxHp: 100,
    skills: [harmSkill("ahit", 10), helpSkill("aheal")] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [harmSkill("ehit", 30), helpSkill("eheal")] });
  const enemy2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100,
    skills: [harmSkill("e2hit", 30)] });
  const state = makeState([taryn, ally], [enemy, enemy2]);
  state.teams.A.energy = { generic: 40, holy: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { taryn, ally, enemy, enemy2, state };
}

const rewarded = (u: Unit): boolean =>
  u.statuses.some((s) => s.kind === "damage_reduction" && s.magnitude === 10 && s.duration === 1) &&
  u.statuses.some((s) => s.kind === "elemental_essence");

// ============================== taryn0 — Protector of the Song ================

test("Protector of the Song: a skill reflected ONTO Taryn grants exactly 10 DR (1 turn) + Elemental Essence", () => {
  const { taryn, ally, state } = board();
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "a2", to: "taryn" });
  assert.ok(
    taryn.statuses.some((s) => s.kind === "damage_reduction" && s.magnitude === 10 && s.duration === 1),
    "10 DR for 1 turn",
  );
  assert.ok(taryn.statuses.some((s) => s.kind === "elemental_essence"), "Elemental Essence");
  assert.ok(!rewarded(ally), "the reflected-from unit gets nothing");
});

test("Protector of the Song: a redirect onto a NON-Taryn unit does NOT reward Taryn (control)", () => {
  const { taryn, state } = board();
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "a2" });
  assert.ok(!taryn.statuses.some((s) => s.kind === "damage_reduction"), "no DR");
  assert.ok(!taryn.statuses.some((s) => s.kind === "elemental_essence"), "no Essence");
});

test("Protector of the Song fires through a REAL reflect (Banner) — reward + DR blunts the reflected hit", () => {
  const { taryn, enemy, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] }); // arm reflect on E
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] }); // 30 dmg, reflected to Taryn
  assert.ok(rewarded(taryn), "the reflect onto Taryn triggers the passive");
  // 30 incoming, blunted by the passive's own 10 DR that lands before the hit resolves.
  assert.equal(taryn.hp, 80, "Taryn takes 30-10DR = 20");
});

// ============================== taryn1 — Banner of Harmony ====================

test("Banner of Harmony: deals exactly 15 to the target enemy; no one else is hit", () => {
  const { ally, enemy, enemy2, state } = board();
  const r = performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] });
  assert.equal(r.ok, true, "cast succeeds");
  assert.equal(enemy.hp, 85, "target enemy takes 15");
  assert.equal(enemy2.hp, 100, "the other enemy is untouched");
  assert.equal(ally.hp, 100, "the ally is untouched");
});

test("Banner of Harmony: for the window, the TARGET's harmful skill is reflected to Taryn", () => {
  const { taryn, ally, enemy, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] });
  const r = performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] }); // E attacks the ally
  assert.equal(r.ok, true);
  assert.equal(ally.hp, 100, "the ally is NOT hit — the skill was reflected off it");
  assert.ok(taryn.hp < 100, "Taryn absorbed the reflected harmful skill instead");
});

test("Banner of Harmony: only the banner'd enemy reflects — an un-banner'd enemy hits normally (control)", () => {
  const { taryn, ally, enemy2, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] }); // banner E, not E2
  const r = performAction(state, { unit: "e2", skillId: "e2hit", targets: ["a2"] });
  assert.equal(r.ok, true);
  assert.equal(ally.hp, 70, "E2 (not banner'd) hits the ally for 30 as normal");
  assert.equal(taryn.hp, 100, "Taryn is not involved");
});

test("Banner of Harmony: the reflect is temporary (expires), not permanent", () => {
  const { taryn, ally, enemy, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn1", targets: ["e"] });
  for (let i = 0; i < 4; i++) endTurn(state); // advance well past the 1-turn window
  ally.hp = 100; taryn.hp = 100; taryn.statuses = [];
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(ally.hp, 70, "after the window, E's harmful skill lands on the ally again");
  assert.equal(taryn.hp, 100, "Taryn is no longer reflecting it");
});

// ============================== taryn2 — Refrain ==============================

test("Refrain on an ENEMY: stuns their harmful skills for 1 turn (harmful blocked, non-harmful allowed)", () => {
  const { enemy, state } = board();
  const r = performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["e"] });
  assert.equal(r.ok, true);
  assert.ok(
    enemy.statuses.some((s) => s.kind === "stun" && s.duration === 1),
    "a 1-turn stun is applied",
  );
  const harm = performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(harm.ok, false, "the enemy's HARMFUL skill is stunned");
  assert.equal(harm.reason, "stunned");
  const help = performAction(state, { unit: "e", skillId: "eheal", targets: ["e"] });
  assert.equal(help.ok, true, "a non-harmful skill is NOT stunned (scope is harmful-only)");
});

test("Refrain on an ALLY: heals them 15 whenever they use a skill (and does NOT stun)", () => {
  const { ally, enemy, state } = board(50);
  const r = performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] });
  assert.equal(r.ok, true);
  assert.ok(!ally.statuses.some((s) => s.kind === "stun"), "no stun on an ally target");
  assert.ok(ally.statuses.some((s) => s.duration === 2), "the buff lasts 2 turns");
  assert.equal(ally.hp, 50, "no heal until the ally uses a skill");
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e"] }); // uses a (non-self-healing) skill
  assert.equal(ally.hp, 65, "using a skill heals the ally exactly 15");
});

test("Refrain heal-on-skill fires on EACH skill use within the window", () => {
  const { ally, enemy, state } = board(40);
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] });
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e"] });
  assert.equal(ally.hp, 55, "first skill use: +15");
  performAction(state, { unit: "a2", skillId: "aheal", targets: ["a2"] }); // +1 self heal +15 Refrain
  assert.equal(ally.hp, 71, "second skill use in-window: +15 (plus the skill's own +1)");
});

test("Refrain: an enemy target gets NO heal-on-skill buff (enemy branch grants only the stun)", () => {
  const { enemy, state } = board();
  enemy.hp = 50; // below max, so its own +1 self-heal is observable and not capped
  performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["e"] });
  performAction(state, { unit: "e", skillId: "eheal", targets: ["e"] }); // enemy uses a (helpful) skill
  assert.equal(enemy.hp, 51, "enemy healed only by its own skill (+1), NOT +15 from Refrain");
});

// ============================== taryn3 — Inspiring Thrust =====================

test("Inspiring Thrust: deals exactly 20 to the target enemy; no collateral", () => {
  const { ally, enemy, enemy2, state } = board();
  const r = performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.equal(r.ok, true);
  assert.equal(enemy.hp, 80, "target takes 20");
  assert.equal(enemy2.hp, 100, "other enemy untouched");
  assert.equal(ally.hp, 100, "ally untouched");
});

test("Inspiring Thrust: an ally who then uses a harmful skill ON THE TARGET gains Elemental Essence", () => {
  const { ally, enemy, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  assert.ok(!ally.statuses.some((s) => s.kind === "elemental_essence"), "no essence before the ally acts");
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e"] });
  assert.ok(ally.statuses.some((s) => s.kind === "elemental_essence"), "ally gains Elemental Essence");
});

test("Inspiring Thrust: an ally hitting a DIFFERENT enemy earns no Essence (control — must be the target)", () => {
  const { ally, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] });
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e2"] }); // wrong enemy
  assert.ok(!ally.statuses.some((s) => s.kind === "elemental_essence"), "no essence for hitting a non-target");
});

test("Inspiring Thrust: no Essence-window exists without a cast (control — plain harmful hit grants nothing)", () => {
  const { ally, state } = board();
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e"] }); // no Inspiring Thrust first
  assert.ok(!ally.statuses.some((s) => s.kind === "elemental_essence"), "no essence absent Inspiring Thrust");
});

// ============================== taryn4 — Stalwart Shield ======================

test("Stalwart Shield on SELF: grants Taryn exactly 20 Shield", () => {
  const { taryn, state } = board();
  const r = performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["taryn"] });
  assert.equal(r.ok, true);
  const shield = taryn.shields.reduce((a, s) => a + s.amount, 0);
  assert.equal(shield, 20, "20 Shield");
});

test("Stalwart Shield on an ALLY: still grants Taryn 20 Shield AND reflects the ally's incoming harm to Taryn", () => {
  const { taryn, ally, enemy, state } = board();
  const r = performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a2"] });
  assert.equal(r.ok, true);
  assert.equal(taryn.shields.reduce((a, s) => a + s.amount, 0), 20, "Taryn still gets 20 Shield");
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] }); // enemy attacks the shielded ally
  assert.equal(ally.hp, 100, "the ally is NOT hit — the harm was reflected off it");
  assert.ok(taryn.hp < 100 || taryn.shields.reduce((a, s) => a + s.amount, 0) < 20,
    "Taryn absorbed the reflected harm (on HP or Shield)");
});

test("Stalwart Shield on SELF does NOT reflect an ally's incoming harm (control — 'if used on an ally')", () => {
  const { taryn, ally, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["taryn"] });
  performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(ally.hp, 70, "with Stalwart on SELF, the ally takes its own 30 damage");
  assert.equal(taryn.hp, 100, "Taryn does not intercept it");
});

// Frozen: "reflects all HARMFUL skills from the target to himself." Refrain (taryn2) is dual-tagged
// Harmful+Helpful. Taryn casting Refrain's HELPFUL heal-buff onto the guarded ally must NOT be reflected
// back onto himself — only an ENEMY's harmful skill is. (Regression: the reflect gate lacked a source guard.)
test("Stalwart Shield: Taryn's own Refrain on the guarded ally lands on the ALLY, not reflected onto Taryn", () => {
  const { taryn, ally, state } = board(50);
  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a2"] }); // guard the ally (installs the reflect mark)
  const r = performAction(state, { unit: "taryn", skillId: "taryn2", targets: ["a2"] }); // Refrain (Harmful+Helpful) on the ally
  assert.equal(r.ok, true, "Refrain resolves");
  assert.ok(!rewarded(taryn), "Protector of the Song does NOT fire — nothing was reflected onto Taryn");
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e"] }); // the ally uses a skill
  assert.equal(ally.hp, 65, "the ally carries Refrain's heal-on-skill buff (50 -> 65), so Refrain landed on the ally");
});

// The ally reflect must be finite (frozen gives no duration; modeled as 1 turn) — a null-duration mark made
// the protection outlive Taryn's shield, reading as permanent.
test("Stalwart Shield on an ally: the reflect mark is finite (1 turn), not permanent", () => {
  const { ally, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a2"] });
  const mark = ally.statuses.find((s) => s.kind === "mark" && s.name === "Stalwart Shield");
  assert.ok(mark, "the ally carries the Stalwart Shield reflect mark");
  assert.equal(mark!.duration, 1, "the ally reflect lasts 1 turn, not round-permanent (null)");
});

// Frozen: "This skill's target is invisible." Casting Stalwart Shield on an ally installs the
// "Stalwart Shield" mark that IS the target (the only persistent artifact identifying whom Taryn
// protected). For the target to be invisible, the opponent's redacted view must not reveal it —
// yet Taryn's own side must still see it. The engine never stamps taryn4 or its mark as Invisible
// (no isHidden / no invisible:true), so the opponent reads the mark and learns the target.
test("Stalwart Shield's target mark is invisible to the opponent (own team still sees it)", () => {
  const { state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a2"] });
  const marksIn = (viewer: "A" | "B") =>
    redactState(state, viewer).units["a2"]!.statuses.filter((st) => st.name === "Stalwart Shield");
  assert.equal(marksIn("A").length, 1, "Taryn's own team sees who was shielded");
  assert.equal(marksIn("B").length, 0, "the OPPONENT must NOT see the target — the skill's target is invisible");
});

// ============================== taryn5 — Radiant Glory ========================

test("Radiant Glory: for the window, Inspiring Thrust ALSO applies Refrain to the target (enemy → stun)", () => {
  const { enemy, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn5", targets: ["taryn"] });
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // Inspiring Thrust
  assert.equal(enemy.hp, 80, "the base 20 damage still lands");
  assert.ok(enemy.statuses.some((s) => s.kind === "stun" && s.duration === 1),
    "the piggybacked Refrain stuns the enemy's harmful skills");
  const harm = performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(harm.ok, false, "the enemy is now stunned out of harmful skills");
});

test("Radiant Glory: for the window, Stalwart Shield ALSO applies Refrain to the target (ally → heal-on-skill)", () => {
  const { ally, enemy, state } = board(50);
  performAction(state, { unit: "taryn", skillId: "taryn5", targets: ["taryn"] });
  performAction(state, { unit: "taryn", skillId: "taryn4", targets: ["a2"] }); // Stalwart on ally
  assert.equal(ally.hp, 50, "no heal yet");
  performAction(state, { unit: "a2", skillId: "ahit", targets: ["e"] }); // ally uses a skill
  assert.equal(ally.hp, 65, "the piggybacked Refrain heals the ally 15 on skill use");
});

test("Radiant Glory control: WITHOUT it, Inspiring Thrust does NOT apply Refrain (no stun)", () => {
  const { enemy, state } = board();
  performAction(state, { unit: "taryn", skillId: "taryn3", targets: ["e"] }); // no Radiant Glory
  assert.ok(!enemy.statuses.some((s) => s.kind === "stun"), "no piggybacked stun");
  const harm = performAction(state, { unit: "e", skillId: "ehit", targets: ["a2"] });
  assert.equal(harm.ok, true, "the enemy can still use harmful skills");
});
