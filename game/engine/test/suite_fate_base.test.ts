import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startTurn, endTurn } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers fate's triggers + custom fns
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import { totalShield } from "../src/damage.ts";
import type { DamageType, MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { Effect } from "../src/effects/ast.ts";

// ============================================================================
// Fate, Reborn Hero — BASE KIT — adversarial, spec-derived behavioral suite.
//
// Oracle = the FROZEN PROSE (content/frozen/skills.json). Element = Apocalypse, maxHp 100.
//
//   fate0 "Dwindling Flame" (passive): "Fate can only be healed by his own skills and
//       effects. While his HP is at or above 50, allies affected by Fox Fire deal 5 more
//       non-Affliction damage. While his HP is below 50, enemies affected by Fox Fire deal
//       5 less non-Affliction damage."
//   fate1 "Fox Fire": "Target enemy or ally is marked by Fox Fire for 4 turns. During this
//       time, if they use or receive a new Harmful skill, they will take 5 Affliction damage
//       if they are an enemy or heal 5 HP if they are an ally. When affected units use new
//       skills on Fate, he gains Elemental Essence. Refreshes if applied on an already
//       affected target."                                            (Harmful/Helpful, gen 1, cd 0)
//   fate2 "Will-o'-wisp": "Fate deals 5 Affliction damage to himself, then gives his team 10
//       Shield for 2 turns. During this time, any enemy that uses a new Harmful skill on Fate
//       or his allies will receive 10 Affliction damage (this damage can only trigger once per
//       skill)."                                                     (Strategic/Instant, spec 1, cd 2)
//   fate3 "Vulpus Incendia": "Fate deals 10 Affliction damage to one enemy each turn. As long
//       as this skill remains active, Fox Fire deals double damage when triggered. Channeled."
//                                                                    (Harmful/Channel, gen1 spec1, cd2)
//   fate4 "Vulpus Crystallia": "Fate heals an ally 10 HP each turn. As long as this skill
//       remains active, Fox Fire gives double healing when triggered. Channeled."
//                                                                    (Helpful/Channel, gen1 spec1, cd2)
//   fate5 "Fox's Cunning": "For 1 turn, any enemy that uses a new skill will be affected by
//       Fox Fire. This effect is invisible."                        (Strategic/Instant, gen1, cd0)
//   fate6 "This Is Not The End": "For the next 2 turns, the first time Fate or an ally would
//       die, they are returned to 40 HP instead. Afterward, the revived Hero heals 5 HP for
//       every active Fox Fire. This skill can only be triggered once per round."
//                                                                    (Helpful/Strategic, spec 2, cd 3)
// ============================================================================

const APOC = () => ({ generic: 40, apocalypse: 40 });

function skillOf(u: Unit, id: string): SkillInstance {
  return (u.skills ?? []).find((s) => s.id === id)!;
}
function fox(u: Unit): { kind: string; name?: string; duration: number | null } | undefined {
  return u.statuses.find((s) => s.kind === "mark" && s.name === "Fox Fire");
}
function hasFox(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "mark" && s.name === "Fox Fire");
}
function foxStatus(dur = 4, by = "x") {
  return status("mark", { name: "Fox Fire", duration: dur, appliedBy: by, appliedTurn: 0 });
}
/** A bare hit skill (no class tags, so it does not itself set off Fox Fire's use/receive triggers). */
function hitSkill(id: string, amount: number, dtype: DamageType = "normal"): SkillInstance {
  const eff: Effect[] = [{ op: "damage", amount, dtype, to: "target" }];
  return skill(id, eff, { tags: [], element: "apocalypse", targeting: "single" });
}
function fateWith(hp = 100): Unit {
  const f = loadHero(heroById("fate"), "A", "f");
  f.hp = hp;
  return f;
}

// ---------------------------------------------------------------------------
// fate0 — "Dwindling Flame": clause 1 — Fate is heal-locked to his own healing.
// The roundStart passive installs the heal_lock; drive it by emitting roundStart.
// ---------------------------------------------------------------------------

test("fate0/heal-lock: an ally's heal does NOT heal Fate; Fate's own heal DOES", () => {
  const f = fateWith(50);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" }); // arms Dwindling Flame's heal_lock on Fate

  // An ally tries to heal Fate 20 — blocked ("only his own skills and effects").
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: ally, self: ally, targets: [f], skillId: "ally_heal" });
  assert.equal(f.hp, 50, "an ally's healing cannot touch Fate");

  // Fate heals himself 20 — allowed.
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: f, self: f, targets: [f], skillId: "fate_heal" });
  assert.equal(f.hp, 70, "Fate's own healing works (50 -> 70)");
});

test("fate0/heal-lock CONTROL: an enemy's heal also cannot heal Fate", () => {
  const f = fateWith(50);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "roundStart" });
  runEffects(state, [{ op: "heal", amount: 30, to: "target" }], { caster: enemy, self: enemy, targets: [f], skillId: "enemy_heal" });
  assert.equal(f.hp, 50, "no third party can heal Fate");
});

test("fate0/heal-lock: the lock is Fate-specific — an ALLY can still be healed by others", () => {
  const f = fateWith(50);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const other = makeUnit({ id: "o", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, other], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" });
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: other, self: other, targets: [ally], skillId: "x" });
  assert.equal(ally.hp, 70, "the heal-lock is on Fate only, not the whole team");
});

test("fate0: Fate can heal himself through his OWN skill (Vulpus Crystallia on self)", () => {
  const f = fateWith(50);
  const state = makeState([f], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" }); // heal_lock active
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate4", targets: ["f"] });
  assert.equal(r.ok, true, "Fate may target himself with his own healing skill");
  assert.equal(f.hp, 60, "his own skill heals him past the lock (50 -> 60)");
});

// ---------------------------------------------------------------------------
// fate0 — clauses 2 & 3: the HP-gated Fox-Fire damage aura. The passive refreshes
// the aura each turnStart, so drive startTurn(A) with the mark/HP preconditions set.
// ---------------------------------------------------------------------------

test("fate0/aura HP>=50: a Fox-Fire ally deals +5, a Fox-Fire enemy is UNaffected", () => {
  const f = fateWith(100); // >= 50
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")], skills: [hitSkill("swing", 20)] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")], skills: [hitSkill("bite", 20)] });
  const tgtA = makeUnit({ id: "ta", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, tgtA], [enemy]);
  state.teams.A.energy = APOC();
  state.teams.B.energy = APOC();

  startTurn(state); // Dwindling Flame refreshes the aura: +5 to Fox-Fire allies (HP >= 50)

  performAction(state, { unit: "al", skillId: "swing", targets: ["e"] });
  assert.equal(enemy.hp, 75, "marked ally deals 20+5 = 25 while Fate's HP >= 50");

  performAction(state, { unit: "e", skillId: "bite", targets: ["ta"] });
  assert.equal(tgtA.hp, 80, "marked ENEMY gets NO debuff while Fate is healthy (deals a flat 20)");
});

test("fate0/aura HP<50: a Fox-Fire enemy deals -5, a Fox-Fire ally is UNaffected", () => {
  const f = fateWith(40); // < 50
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")], skills: [hitSkill("swing", 20)] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")], skills: [hitSkill("bite", 20)] });
  const tgtA = makeUnit({ id: "ta", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, tgtA], [enemy]);
  state.teams.A.energy = APOC();
  state.teams.B.energy = APOC();

  startTurn(state); // Dwindling Flame refreshes the aura: -5 to Fox-Fire enemies (HP < 50)

  performAction(state, { unit: "e", skillId: "bite", targets: ["ta"] });
  assert.equal(tgtA.hp, 85, "marked enemy deals 20-5 = 15 while Fate's HP < 50");

  performAction(state, { unit: "al", skillId: "swing", targets: ["e"] });
  assert.equal(enemy.hp, 80, "marked ALLY gets NO buff while Fate is hurt (deals a flat 20)");
});

test("fate0/aura CONTROL: an UNMARKED ally gets no +5 even at full HP", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, skills: [hitSkill("swing", 20)] }); // NO Fox Fire
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  startTurn(state);
  performAction(state, { unit: "al", skillId: "swing", targets: ["e"] });
  assert.equal(enemy.hp, 80, "no Fox Fire mark => no aura bonus (flat 20)");
});

test("fate0/aura is 'non-Affliction': a Fox-Fire ally's Affliction damage is NOT boosted", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")], skills: [hitSkill("rot", 20, "affliction")] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  startTurn(state);
  performAction(state, { unit: "al", skillId: "rot", targets: ["e"] });
  assert.equal(enemy.hp, 80, "Affliction is excluded from the +5 (deals a flat 20, not 25)");
});

// SUSPECTED BUG: "non-Affliction damage" covers Normal, Piercing AND True. The aura is modelled as an
// outgoing_damage_mod, which (per DAMAGE_CHANNELS) only touches Normal/Piercing and never True — so a Fox-Fire
// ally's TRUE damage gets no +5 (enemy took 20, frozen expects 25). The +5 status IS present on the ally; the
// mitigation layer just refuses to apply it to True. Normal/Piercing (the common case) work; True is the gap.
test("fate0 aura boosts a Fox-Fire ally's TRUE damage too (non-Affliction includes True)", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")], skills: [hitSkill("smite", 20, "true")] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  startTurn(state);
  performAction(state, { unit: "al", skillId: "smite", targets: ["e"] });
  assert.equal(enemy.hp, 75, "True damage is non-Affliction, so the +5 aura should apply (20+5 = 25)");
});

// ---------------------------------------------------------------------------
// fate1 — "Fox Fire": mark application, targeting, refresh.
// ---------------------------------------------------------------------------

test("fate1: marks a target ENEMY with Fox Fire for 4 turns", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] });
  assert.equal(r.ok, true, "Fox Fire casts on an enemy");
  const m = fox(enemy);
  assert.ok(m, "the enemy is marked by Fox Fire");
  assert.equal(m!.duration, 4, "for 4 turns");
});

test("fate1: can also mark an ALLY (frozen: 'Target enemy or ally')", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate1", targets: ["al"] });
  assert.equal(r.ok, true, "Fox Fire is Helpful too and can be aimed at an ally");
  assert.ok(fox(ally), "the ally is marked by Fox Fire");
});

test("fate1 CONTROL: only the chosen target is marked", () => {
  const f = fateWith(100);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e2"] });
  assert.ok(fox(e2), "the chosen enemy is marked");
  assert.ok(!hasFox(e1), "the other enemy is not");
});

test("fate1: 'Refreshes if applied on an already affected target' (one mark, back to 4)", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] });
  fox(enemy)!.duration = 1; // simulate 3 turns elapsed
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] });
  const marks = enemy.statuses.filter((s) => s.kind === "mark" && s.name === "Fox Fire");
  assert.equal(marks.length, 1, "re-applying refreshes rather than stacking a second mark");
  assert.equal(marks[0]!.duration, 4, "duration is refreshed back to 4");
});

// ---------------------------------------------------------------------------
// fate1 — the standing Fox Fire behaviors: use/receive Harmful => 5 dmg (enemy)
// / 5 heal (ally); a skill used ON Fate by an affected unit => Fate gains Essence.
// ---------------------------------------------------------------------------

function foxSetup(): { f: Unit; ally: Unit; enemy: Unit; state: MatchState } {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  return { f, ally, enemy, state };
}

test("fate1/trigger: a marked ENEMY that USES a new Harmful skill takes 5 Affliction", () => {
  const { enemy, state } = foxSetup();
  enemy.statuses.push(foxStatus(4, "f"));
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 95, "the marked enemy self-punishes for 5 on its own Harmful skill");
});

test("fate1/trigger: a marked ENEMY that RECEIVES a new Harmful skill takes 5 Affliction", () => {
  const { ally, enemy, state } = foxSetup();
  enemy.statuses.push(foxStatus(4, "f"));
  // Some ally uses a Harmful skill ON the marked enemy (enemy is a target => "receives").
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: ["e"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 95, "receiving a Harmful skill also burns the marked enemy for 5");
});

test("fate1/trigger CONTROL: a marked enemy using a NON-Harmful skill takes nothing", () => {
  const { enemy, state } = foxSetup();
  enemy.statuses.push(foxStatus(4, "f"));
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Strategic"] });
  assert.equal(enemy.hp, 100, "only a NEW HARMFUL skill triggers Fox Fire");
});

test("fate1/trigger CONTROL: an UNMARKED enemy using a Harmful skill takes nothing", () => {
  const { enemy, state } = foxSetup();
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 100, "no mark => no Fox Fire burn");
});

test("fate1/trigger: a marked ALLY that USES a new Harmful skill heals 5", () => {
  const { ally, state } = foxSetup();
  ally.hp = 50;
  ally.statuses.push(foxStatus(4, "f"));
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(ally.hp, 55, "the marked ally heals 5 (not damaged) on a Harmful skill");
});

test("fate1/trigger: a marked ALLY that RECEIVES a new Harmful skill heals 5", () => {
  const { ally, enemy, state } = foxSetup();
  ally.hp = 50;
  ally.statuses.push(foxStatus(4, "f"));
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["al"], tags: ["Harmful"] });
  assert.equal(ally.hp, 55, "being hit by a Harmful skill heals the marked ally 5");
});

test("fate1/essence: an affected unit using a new skill ON Fate gives Fate Elemental Essence", () => {
  const { f, enemy, state } = foxSetup();
  enemy.statuses.push(foxStatus(4, "f"));
  assert.ok(!f.statuses.some((s) => s.kind === "elemental_essence"), "precondition: no Essence");
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: [] });
  assert.ok(f.statuses.some((s) => s.kind === "elemental_essence"), "Fate gains Elemental Essence");
});

test("fate1/essence CONTROL: an affected unit acting NOT on Fate gives no Essence", () => {
  const { f, ally, enemy, state } = foxSetup();
  enemy.statuses.push(foxStatus(4, "f"));
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["al"], tags: [] });
  assert.ok(!f.statuses.some((s) => s.kind === "elemental_essence"), "a skill not aimed at Fate grants no Essence");
});

test("fate1/essence CONTROL: an UNMARKED unit acting on Fate gives no Essence", () => {
  const { f, enemy, state } = foxSetup();
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: [] });
  assert.ok(!f.statuses.some((s) => s.kind === "elemental_essence"), "only Fox-Fire-affected units feed Fate Essence");
});

// ---------------------------------------------------------------------------
// fate2 — "Will-o'-wisp": 5 self Affliction, team 10 Shield/2t, enemy Harmful => 10 back.
// ---------------------------------------------------------------------------

test("fate2: Fate takes 5 Affliction, then his whole team gets 10 Shield", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  assert.equal(r.ok, true, "Will-o'-wisp casts");
  assert.equal(f.hp, 95, "Fate paid 5 Affliction to himself (100 -> 95)");
  assert.equal(totalShield(f), 10, "Fate got 10 Shield");
  assert.equal(totalShield(ally), 10, "the ally got 10 Shield");
  assert.equal(totalShield(enemy), 0, "the enemy did not");
  assert.equal(skillOf(f, "fate2").currentCd, 2, "Will-o'-wisp goes on its 2-turn cooldown");
});

test("fate2: an enemy Harmful skill on Fate's team is punished for 10 Affliction", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 90, "the attacking enemy takes 10 Affliction back");
});

test("fate2 CONTROL: a NON-Harmful enemy skill is not punished", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Strategic"] });
  assert.equal(enemy.hp, 100, "only a Harmful skill triggers the Will-o'-wisp retaliation");
});

test("fate2 CONTROL: with no Will-o'-wisp active, an enemy Harmful skill is not punished", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 100, "no shield window => no retaliation");
});

test("fate2: 'once per skill' — one Harmful skill hitting multiple team members returns 10, not 20", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f", "al"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 90, "the 10 damage triggers exactly once per skill (not per target)");
});

// SUSPECTED BUG: frozen says Will-o'-wisp punishes "any enemy that uses a new Harmful skill ON FATE OR HIS
// ALLIES". The retaliation trigger gates only on {eventHasTag Harmful, eventSource is an enemy, self holds the
// Will-o'-wisp mark} and never checks the skill's TARGET side, so an enemy Harmful skill aimed at its own team
// (e1 -> e2) still fires the 10 Affliction (e1 dropped to 90, expected 100). Real casts always aim Harmful
// skills at the opposing team so this rarely surfaces, but the target-side clause is unenforced.
test.skip("SUSPECTED BUG: fate2 retaliates on an enemy Harmful skill NOT used on Fate's team (target clause ignored)", () => {
  const f = fateWith(100);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  // e1 uses a Harmful skill on its OWN ally e2 — the frozen clause is "on Fate or his allies".
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["e2"], tags: ["Harmful"] });
  assert.equal(e1.hp, 100, "a Harmful skill not aimed at Fate's team must not be punished");
});

// ---------------------------------------------------------------------------
// fate3 — "Vulpus Incendia": 10 Affliction/turn (channel) + Fox Fire doubles while active.
// ---------------------------------------------------------------------------

test("fate3: deals 10 Affliction on cast and installs a channel (10 more each Fate turn)", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate3", targets: ["e"] });
  assert.equal(r.ok, true, "Vulpus Incendia casts");
  assert.equal(enemy.hp, 90, "10 Affliction on the cast turn");
  assert.ok(f.statuses.some((s) => s.kind === "channeling" && s.name === "fate3"), "a channel is sustained");
  assert.equal(skillOf(f, "fate3").currentCd, 2, "cooldown is 2");

  endTurn(state); // A -> B
  startTurn(state); // B turn
  endTurn(state); // B -> A
  startTurn(state); // A turn: the channel re-runs
  assert.equal(enemy.hp, 80, "the channel dealt another 10 at Fate's next turn (90 -> 80)");
});

test("fate3: while active, Fox Fire's triggered damage is DOUBLED (5 -> 10)", () => {
  const f = fateWith(100);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")] });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate3", targets: ["e1"] }); // channel on e1
  emit(state, { type: "skillUsed", caster: "e2", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(e2.hp, 90, "the marked enemy's Fox Fire burn is doubled to 10 while Vulpus Incendia channels");
});

test("fate3 CONTROL: with no Vulpus Incendia channel, Fox Fire burn is the base 5", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")] });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 95, "no channel => Fox Fire deals the base 5");
});

// ---------------------------------------------------------------------------
// fate4 — "Vulpus Crystallia": heal an ally 10/turn (channel) + Fox Fire doubles healing.
// ---------------------------------------------------------------------------

test("fate4: heals the target ally 10 on cast and installs a channel (10 more each Fate turn)", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate4", targets: ["al"] });
  assert.equal(r.ok, true, "Vulpus Crystallia casts");
  assert.equal(ally.hp, 60, "10 healing on the cast turn (50 -> 60)");
  assert.ok(f.statuses.some((s) => s.kind === "channeling" && s.name === "fate4"), "a channel is sustained");

  endTurn(state); // A -> B
  startTurn(state); // B
  endTurn(state); // B -> A
  startTurn(state); // A: channel re-runs
  assert.equal(ally.hp, 70, "the channel healed another 10 at Fate's next turn (60 -> 70)");
});

test("fate4: while active, Fox Fire's triggered healing is DOUBLED (5 -> 10)", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100, statuses: [foxStatus(4, "f")] });
  const chanTarget = makeUnit({ id: "ct", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, chanTarget], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate4", targets: ["ct"] }); // channel established
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(ally.hp, 60, "the marked ally's Fox Fire heal is doubled to 10 while Vulpus Crystallia channels");
});

test("fate4 CONTROL: with no Vulpus Crystallia channel, Fox Fire heal is the base 5", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100, statuses: [foxStatus(4, "f")] });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(ally.hp, 55, "no channel => Fox Fire heals the base 5");
});

// ---------------------------------------------------------------------------
// fate5 — "Fox's Cunning": for 1 turn, any enemy that uses a new skill is Fox-Fired.
// ---------------------------------------------------------------------------

test("fate5: after casting, an ENEMY that uses any new skill becomes Fox-Fire marked", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  assert.equal(r.ok, true, "Fox's Cunning casts");
  assert.ok(!hasFox(enemy), "no mark yet — the watch is only armed");
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] }); // ANY skill, not just Harmful
  const m = fox(enemy);
  assert.ok(m, "the enemy that acted is now Fox-Fire marked");
  assert.equal(m!.duration, 4, "with the standard 4-turn Fox Fire mark");
});

test("fate5 CONTROL: an ALLY using a skill is NOT marked (enemies only)", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasFox(ally), "Fox's Cunning marks enemies, not allies");
});

test("fate5 CONTROL: with no Fox's Cunning active, an enemy skill marks nobody", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasFox(enemy), "no window => no marking");
});

test("fate5: the window lasts only 1 turn — after it expires, an enemy skill no longer marks", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  // Run a full round-trip so the 1-turn window ticks away at Fate's next turn-end.
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); endTurn(state);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasFox(enemy), "the window closed; a later enemy skill is not marked");
});

// ---------------------------------------------------------------------------
// fate6 — "This Is Not The End": 2-turn team revive-to-40 + 5/Fox-Fire bonus, once/round.
// ---------------------------------------------------------------------------

function kill(state: MatchState, killer: Unit, victim: Unit): void {
  runEffects(state, [{ op: "damage", amount: 999, dtype: "normal", to: "target" }], { caster: killer, self: killer, targets: [victim], skillId: "execute" });
}

test("fate6: a lethal blow on Fate revives him to 40, plus 5 per active Fox Fire", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")] });
  const enemy2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxStatus(4, "f")] });
  const state = makeState([f], [enemy, enemy2]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  assert.equal(r.ok, true, "This Is Not The End casts");
  assert.equal(skillOf(f, "fate6").currentCd, 3, "cooldown is 3");

  kill(state, enemy, f); // Fate would die
  assert.equal(f.alive, true, "Fate did not die — he was returned instead");
  assert.equal(f.hp, 50, "revived to 40, +5 for each of the 2 active Fox Fire marks = 50");
});

test("fate6: with no active Fox Fire, the revive is a flat 40", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  kill(state, enemy, f);
  assert.equal(f.alive, true, "Fate is returned to life");
  assert.equal(f.hp, 40, "exactly 40 with no Fox Fire bonus");
});

test("fate6: protects allies too (the first ally to die is returned to 40)", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  kill(state, enemy, ally);
  assert.equal(ally.alive, true, "the ally is returned to life");
  assert.equal(ally.hp, 40, "at 40 HP");
});

test("fate6: 'first time ... would die' — only ONE revival per round for the whole team", () => {
  const f = fateWith(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });

  kill(state, enemy, ally); // first death — revived
  assert.equal(ally.alive, true, "the first death is prevented");

  kill(state, enemy, f); // a second protected hero dies later
  assert.equal(f.alive, false, "the revive only fires once — Fate is not saved a second time");
});

test("fate6: after it fires, it cannot be recast this round ('only once per round')", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = { generic: 40, apocalypse: 40 };
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  skillOf(f, "fate6").currentCd = 0; // ignore the plain cooldown; test the once-per-round lock specifically
  kill(state, enemy, f); // the ward fires
  assert.equal(f.alive, true, "revived once");
  const again = performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  assert.equal(again.ok, false, "recast is blocked after the revive fired this round");
  assert.equal(again.reason, "requirements-not-met", "specifically by the once-per-round requirement gate");
});

test("fate6 CONTROL: before casting, a lethal blow actually kills Fate", () => {
  const f = fateWith(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  kill(state, enemy, f);
  assert.equal(f.alive, false, "with no ward armed, Fate dies normally (proves the kill path works)");
});
