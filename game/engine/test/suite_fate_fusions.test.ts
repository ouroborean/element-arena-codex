import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performAction, startTurn, endTurn } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers Fate's triggers + custom fns
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import { FUSIONS, fusionForm } from "../content/fusions.generated.ts";
import { totalShield } from "../src/damage.ts";
import type { DamageType, MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { Effect } from "../src/effects/ast.ts";

// =============================================================================
// Fate, Reborn Hero — FUSION FORM — adversarial, SPEC-DERIVED behavioral suite.
//
// STRUCTURAL FACT (spec-derived, from content/frozen/characters.json):
//   "Fate, Reborn Hero" is authored with  "starts_fused": true, "can_fuse": false,
//   "fusion_skills": {},  element = "apocalypse".  Like Dennis, Fate has NO menu of
//   ~7 elemental fusion variants; he is PERMANENTLY fused in a single Apocalypse form.
//   That one permanent form's passive + actives ARE his fusion kit:
//       fusion passive : fate0  "Dwindling Flame"
//       fusion actives : fate1..fate6
//   (The generated FUSIONS table therefore contains ZERO "fate" forms; there is no
//   applyFusion() path for Fate — asking fusionForm("fate", <any element>) is undefined.)
//
// Section 0 pins that spec fact as an executable guard. Sections 1..7 then treat Fate's
// single permanent Apocalypse form as THE fusion form and verify its passive + every
// active against the FROZEN prose (content/frozen/skills.json), the sole oracle.
// Authored/roster content is consulted ONLY for how to drive (ids, costs, element,
// status names), never for what to assert.
//
// Frozen text under test (verbatim, content/frozen/skills.json):
//   fate0 "Dwindling Flame" (passive): "Fate can only be healed by his own skills and
//     effects. While his HP is at or above 50, allies affected by Fox Fire deal 5 more
//     non-Affliction damage. While his HP is below 50, enemies affected by Fox Fire deal
//     5 less non-Affliction damage."
//   fate1 "Fox Fire": "Target enemy or ally is marked by Fox Fire for 4 turns. During
//     this time, if they use or receive a new Harmful skill, they will take 5 Affliction
//     damage if they are an enemy or heal 5 HP if they are an ally. When affected units
//     use new skills on Fate, he gains Elemental Essence. Refreshes if applied on an
//     already affected target."                                        (Harmful/Helpful, gen 1)
//   fate2 "Will-o'-wisp": "Fate deals 5 Affliction damage to himself, then gives his team
//     10 Shield for 2 turns. During this time, any enemy that uses a new Harmful skill on
//     Fate or his allies will receive 10 Affliction damage (this damage can only trigger
//     once per skill)."                                                 (Strategic, spec 1, cd 2)
//   fate3 "Vulpus Incendia": "Fate deals 10 Affliction damage to one enemy each turn. As
//     long as this skill remains active, Fox Fire deals double damage when triggered.
//     Channeled."                                                       (Harmful, gen1 spec1, cd2)
//   fate4 "Vulpus Crystallia": "Fate heals an ally 10 HP each turn. As long as this skill
//     remains active, Fox Fire gives double healing when triggered. Channeled."
//                                                                       (Helpful, gen1 spec1, cd2)
//   fate5 "Fox's Cunning": "For 1 turn, any enemy that uses a new skill will be affected
//     by Fox Fire. This effect is invisible."                          (Strategic, gen1, cd0)
//   fate6 "This Is Not The End": "For the next 2 turns, the first time Fate or an ally
//     would die, they are returned to 40 HP instead. Afterward, the revived Hero heals 5
//     HP for every active Fox Fire. This skill can only be triggered once per round."
//                                                                       (Helpful, spec 2, cd 3)
// =============================================================================

// Fate is fused into Apocalypse, so his specific cost is paid in the apocalypse pool.
const APOC = () => ({ generic: 40, apocalypse: 40 });

function fate(hp = 100): Unit {
  const f = loadHero(heroById("fate"), "A", "f");
  f.hp = hp;
  return f;
}
function skillOf(u: Unit, id: string): SkillInstance {
  return (u.skills ?? []).find((s) => s.id === id)!;
}
function foxOf(u: Unit): { duration: number | null } | undefined {
  return u.statuses.find((s) => s.kind === "mark" && s.name === "Fox Fire");
}
const hasFox = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "Fox Fire");
const hasEssence = (u: Unit): boolean => u.statuses.some((s) => s.kind === "elemental_essence");
function foxMark(dur = 4, by = "f") {
  return status("mark", { name: "Fox Fire", duration: dur, appliedBy: by, appliedTurn: 0 });
}
/** A bare damage skill with no class tags (so it does not itself set off Fox Fire's use/receive hooks). */
function hitSkill(id: string, amount: number, dtype: DamageType = "normal"): SkillInstance {
  const eff: Effect[] = [{ op: "damage", amount, dtype, to: "target" }];
  return skill(id, eff, { tags: [], element: "apocalypse", targeting: "single" });
}

// =============================================================================
// Section 0 — SPEC GUARD: Fate is permanently fused and has NO elemental forms.
// Oracle: frozen characters.json (starts_fused:true, can_fuse:false, fusion_skills:{}).
// The engine's generated fusion table must therefore expose ZERO "fate" forms.
// =============================================================================

test("fate SPEC: the frozen roster marks Fate permanently fused / non-fusing (Apocalypse)", () => {
  const chars = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../content/frozen/characters.json", import.meta.url)), "utf8"),
  ) as any;
  const arr: any[] = Array.isArray(chars) ? chars : Object.values(chars);
  const f = arr.find((c) => c.id === "fate");
  assert.ok(f, "Fate is in the frozen roster");
  assert.equal(f.starts_fused, true, "frozen: Fate starts fused");
  assert.equal(f.can_fuse, false, "frozen: Fate cannot fuse into other elements");
  assert.equal(Object.keys(f.fusion_skills ?? {}).length, 0, "frozen: Fate has no elemental fusion skills");
  assert.equal(f.element.name, "apocalypse", "frozen: Fate's permanent form is the Apocalypse element");
});

test("fate SPEC: no elemental fusion FORMS exist for Fate (can_fuse:false is honored by the engine)", () => {
  const fateForms = FUSIONS.filter((form) => form.hero === "fate");
  assert.equal(fateForms.length, 0, "the generated fusion table contains no Fate forms");
  // Every fusion element KEY any hero uses must be undefined when asked for on Fate.
  const allKeys = [...new Set(FUSIONS.map((form) => form.key))];
  assert.ok(allKeys.length > 0, "control: the fusion table is non-empty (other heroes DO fuse)");
  assert.ok(allKeys.includes("aurora"), "control: the 'aurora' key exists (owned by Ando et al.)");
  for (const key of allKeys) {
    assert.equal(fusionForm("fate", key), undefined, `Fate must have no '${key}' fusion form`);
  }
  // Control: a fusing hero DOES resolve a form for one of its keys.
  assert.ok(fusionForm("ando", "aurora"), "control: Ando (a fusing hero) resolves its 'aurora' form");
});

// =============================================================================
// Section 1 — FUSION PASSIVE: fate0 "Dwindling Flame"
// =============================================================================

// Clause 1: "Fate can only be healed by his own skills and effects."
// The roundStart passive installs the heal-lock; arm it by emitting roundStart.

test("fate0 passive/heal-lock: an ally's heal cannot touch Fate; his OWN heal does", () => {
  const f = fate(50);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" }); // arms Dwindling Flame's heal-lock

  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: ally, self: ally, targets: [f], skillId: "ally_heal" });
  assert.equal(f.hp, 50, "an ally cannot heal Fate (locked to his own healing)");

  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: f, self: f, targets: [f], skillId: "fate_self" });
  assert.equal(f.hp, 70, "Fate's own healing works through the lock (50 -> 70)");
});

test("fate0 passive/heal-lock CONTROL: an ENEMY's heal also cannot touch Fate", () => {
  const f = fate(50);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "roundStart" });
  runEffects(state, [{ op: "heal", amount: 30, to: "target" }], { caster: enemy, self: enemy, targets: [f], skillId: "enemy_heal" });
  assert.equal(f.hp, 50, "no third party of any side can heal Fate");
});

test("fate0 passive/heal-lock is Fate-specific: an ALLY can still be healed by others", () => {
  const f = fate(50);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const healer = makeUnit({ id: "h", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, healer], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" });
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: healer, self: healer, targets: [ally], skillId: "x" });
  assert.equal(ally.hp, 70, "the lock is on Fate only — teammates heal normally (50 -> 70)");
});

test("fate0 passive/heal-lock: Fate CAN heal himself via one of his own skills (Vulpus Crystallia on self)", () => {
  const f = fate(50);
  const state = makeState([f], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "roundStart" }); // lock active
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate4", targets: ["f"] });
  assert.equal(r.ok, true, "Fate may aim his own healing skill at himself");
  assert.equal(f.hp, 60, "his own skill heals past the lock (50 -> 60)");
});

// Clause 2: "While his HP is at or above 50, allies affected by Fox Fire deal 5 more
// non-Affliction damage."  The aura is refreshed each turnStart, gated on Fate's live HP.

test("fate0 passive/aura HP>=50: a Fox-Fire ALLY deals +5 non-Affliction; a Fox-Fire enemy is unaffected", () => {
  const f = fate(100); // >= 50
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()], skills: [hitSkill("swing", 20)] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()], skills: [hitSkill("bite", 20)] });
  const allyTgt = makeUnit({ id: "at", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, allyTgt], [enemy]);
  state.teams.A.energy = APOC();
  state.teams.B.energy = APOC();
  startTurn(state); // Dwindling Flame refreshes the +5 aura on Fox-Fire allies

  performAction(state, { unit: "al", skillId: "swing", targets: ["e"] });
  assert.equal(enemy.hp, 75, "marked ally deals 20+5 = 25 while Fate's HP >= 50");

  performAction(state, { unit: "e", skillId: "bite", targets: ["at"] });
  assert.equal(allyTgt.hp, 80, "the enemy debuff clause does NOT apply while Fate is healthy (flat 20)");
});

test("fate0 passive/aura CONTROL: an UNMARKED ally gets no +5 even at full HP", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, skills: [hitSkill("swing", 20)] }); // no Fox Fire
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  startTurn(state);
  performAction(state, { unit: "al", skillId: "swing", targets: ["e"] });
  assert.equal(enemy.hp, 80, "no Fox Fire => no aura bonus (flat 20)");
});

test("fate0 passive/aura is 'non-Affliction': a Fox-Fire ally's Affliction damage is NOT boosted", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()], skills: [hitSkill("rot", 20, "affliction")] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  startTurn(state);
  performAction(state, { unit: "al", skillId: "rot", targets: ["e"] });
  assert.equal(enemy.hp, 80, "Affliction is excluded from the +5 (flat 20, not 25)");
});

// Clause 3: "While his HP is below 50, enemies affected by Fox Fire deal 5 less non-Affliction damage."

test("fate0 passive/aura HP<50: a Fox-Fire ENEMY deals -5; a Fox-Fire ally is unaffected", () => {
  const f = fate(40); // < 50
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()], skills: [hitSkill("swing", 20)] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()], skills: [hitSkill("bite", 20)] });
  const allyTgt = makeUnit({ id: "at", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, allyTgt], [enemy]);
  state.teams.A.energy = APOC();
  state.teams.B.energy = APOC();
  startTurn(state); // aura now debuffs Fox-Fire enemies

  performAction(state, { unit: "e", skillId: "bite", targets: ["at"] });
  assert.equal(allyTgt.hp, 85, "marked enemy deals 20-5 = 15 while Fate's HP < 50");

  performAction(state, { unit: "al", skillId: "swing", targets: ["e"] });
  assert.equal(enemy.hp, 80, "the +5 ally clause does NOT apply while Fate is hurt (flat 20)");
});

// SUSPECTED BUG (independently derived): "non-Affliction damage" covers Normal, Piercing AND True.
// The aura is modelled as an outgoing_damage_mod, which per DAMAGE_CHANNELS never touches True, so a
// Fox-Fire ally's TRUE damage gets no +5. Frozen expects 20 -> 25.
test.skip("SUSPECTED BUG: fate0 aura does not boost a Fox-Fire ally's TRUE damage (True is non-Affliction)", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()], skills: [hitSkill("smite", 20, "true")] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  startTurn(state);
  performAction(state, { unit: "al", skillId: "smite", targets: ["e"] });
  assert.equal(enemy.hp, 75, "True damage is non-Affliction, so +5 should apply (20+5 = 25)");
});

// =============================================================================
// Section 2 — FUSION ACTIVE: fate1 "Fox Fire"
// =============================================================================

test("fate1: marks a target ENEMY with Fox Fire for 4 turns", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] });
  assert.equal(r.ok, true, "Fox Fire casts on an enemy");
  const m = foxOf(enemy);
  assert.ok(m, "the enemy carries a Fox Fire mark");
  assert.equal(m!.duration, 4, "the mark lasts 4 turns");
});

test("fate1: can also mark an ALLY (frozen: 'Target enemy or ally')", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate1", targets: ["al"] });
  assert.equal(r.ok, true, "Fox Fire is Helpful too and can be aimed at an ally");
  assert.ok(hasFox(ally), "the ally is marked by Fox Fire");
});

test("fate1 CONTROL: only the chosen target is marked", () => {
  const f = fate(100);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e2"] });
  assert.ok(hasFox(e2), "the chosen enemy is marked");
  assert.ok(!hasFox(e1), "the other enemy is not");
});

test("fate1: 'Refreshes if applied on an already affected target' (one mark, back to 4)", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] });
  foxOf(enemy)!.duration = 1 as any; // simulate 3 turns elapsed
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] });
  const marks = enemy.statuses.filter((s) => s.kind === "mark" && s.name === "Fox Fire");
  assert.equal(marks.length, 1, "re-applying refreshes rather than stacking a second mark");
  assert.equal(marks[0]!.duration, 4, "duration refreshed back to 4");
});

// "if they use or receive a new Harmful skill, they take 5 Affliction (enemy) / heal 5 (ally)"

test("fate1/trigger: a marked ENEMY that USES a new Harmful skill takes 5 Affliction", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 95, "the marked enemy self-burns 5 Affliction on its own Harmful skill");
});

test("fate1/trigger: a marked ENEMY that RECEIVES a new Harmful skill takes 5 Affliction", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: ["e"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 95, "receiving a Harmful skill also burns the marked enemy 5");
});

test("fate1/trigger: a marked ALLY that USES/RECEIVES a new Harmful skill HEALS 5", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100, statuses: [foxMark()] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(ally.hp, 55, "marked ally heals 5 when it USES a Harmful skill");
  emit(state, { type: "skillUsed", caster: "e", skillId: "y", targets: ["al"], tags: ["Harmful"] });
  assert.equal(ally.hp, 60, "marked ally heals another 5 when it RECEIVES a Harmful skill");
});

test("fate1/trigger CONTROL: a marked enemy using a NON-Harmful skill takes nothing", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Strategic"] });
  assert.equal(enemy.hp, 100, "only a NEW HARMFUL skill triggers Fox Fire");
});

test("fate1/trigger CONTROL: an UNMARKED enemy using a Harmful skill takes nothing", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 100, "no mark => no Fox Fire burn");
});

// "When affected units use new skills on Fate, he gains Elemental Essence."

test("fate1/essence: a Fox-Fire unit using a new skill ON Fate gives Fate Elemental Essence", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f], [enemy]);
  assert.ok(!hasEssence(f), "precondition: no Essence");
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: [] });
  assert.ok(hasEssence(f), "Fate gains Elemental Essence");
});

test("fate1/essence CONTROL: a Fox-Fire unit acting NOT on Fate grants no Essence", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["al"], tags: [] });
  assert.ok(!hasEssence(f), "a skill not aimed at Fate grants no Essence");
});

test("fate1/essence CONTROL: an UNMARKED unit acting on Fate grants no Essence", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: [] });
  assert.ok(!hasEssence(f), "only Fox-Fire-affected units feed Fate Essence");
});

// =============================================================================
// Section 3 — FUSION ACTIVE: fate2 "Will-o'-wisp"
// =============================================================================

test("fate2: Fate takes 5 Affliction, then his whole team gets 10 Shield (enemies do not)", () => {
  const f = fate(100);
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
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 90, "the attacking enemy takes 10 Affliction back");
});

test("fate2 'once per skill': one Harmful skill hitting two team members returns 10, not 20", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f", "al"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 90, "the 10 fires exactly once per skill, not once per target");
});

test("fate2 CONTROL: a NON-Harmful enemy skill is not punished", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Strategic"] });
  assert.equal(enemy.hp, 100, "only a Harmful skill triggers the retaliation");
});

test("fate2 CONTROL: with no Will-o'-wisp active, an enemy Harmful skill is not punished", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 100, "no shield window => no retaliation");
});

// SUSPECTED BUG (independently derived): frozen scopes the retaliation to an enemy Harmful skill used
// "on Fate or his allies". The trigger never checks the skill's TARGET side, so an enemy Harmful aimed
// at its OWN team still fires the 10 Affliction. Frozen expects no punish here.
test.skip("SUSPECTED BUG: fate2 punishes an enemy Harmful skill NOT aimed at Fate's team (target clause ignored)", () => {
  const f = fate(100);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: ["e2"], tags: ["Harmful"] });
  assert.equal(e1.hp, 100, "a Harmful skill not aimed at Fate's team must not be punished");
});

// =============================================================================
// Section 4 — FUSION ACTIVE: fate3 "Vulpus Incendia" (Channeled)
// =============================================================================

test("fate3: 10 Affliction on cast, installs a channel that repeats 10 each Fate turn", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate3", targets: ["e"] });
  assert.equal(r.ok, true, "Vulpus Incendia casts");
  assert.equal(enemy.hp, 90, "10 Affliction on the cast turn");
  assert.ok(f.statuses.some((s) => s.kind === "channeling" && s.name === "fate3"), "a channel is sustained");
  assert.equal(skillOf(f, "fate3").currentCd, 2, "cooldown is 2");

  endTurn(state); // A -> B
  startTurn(state); // B
  endTurn(state); // B -> A
  startTurn(state); // A: the channel re-runs
  assert.equal(enemy.hp, 80, "the channel dealt another 10 at Fate's next turn (90 -> 80)");
});

test("fate3: while active, Fox Fire's triggered damage is DOUBLED (5 -> 10)", () => {
  const f = fate(100);
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate3", targets: ["e1"] }); // channel on e1
  emit(state, { type: "skillUsed", caster: "e2", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(e2.hp, 90, "the marked enemy's Fox Fire burn is doubled to 10 while Vulpus Incendia channels");
});

test("fate3 CONTROL: with no Vulpus Incendia channel, Fox Fire burn is the base 5", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(enemy.hp, 95, "no channel => Fox Fire deals the base 5");
});

// =============================================================================
// Section 5 — FUSION ACTIVE: fate4 "Vulpus Crystallia" (Channeled)
// =============================================================================

test("fate4: heals the target ally 10 on cast, installs a channel that repeats 10 each Fate turn", () => {
  const f = fate(100);
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
  startTurn(state); // A: the channel re-runs
  assert.equal(ally.hp, 70, "the channel healed another 10 at Fate's next turn (60 -> 70)");
});

test("fate4: while active, Fox Fire's triggered HEALING is DOUBLED (5 -> 10)", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100, statuses: [foxMark()] });
  const chanTarget = makeUnit({ id: "ct", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally, chanTarget], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate4", targets: ["ct"] }); // channel established
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(ally.hp, 60, "the marked ally's Fox Fire heal is doubled to 10 while Vulpus Crystallia channels");
});

test("fate4 CONTROL: with no Vulpus Crystallia channel, Fox Fire heal is the base 5", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: ["Harmful"] });
  assert.equal(ally.hp, 55, "no channel => Fox Fire heals the base 5");
});

// =============================================================================
// Section 6 — FUSION ACTIVE: fate5 "Fox's Cunning"
// =============================================================================

test("fate5: after casting, an ENEMY that uses ANY new skill becomes Fox-Fire marked (4 turns)", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  assert.equal(r.ok, true, "Fox's Cunning casts");
  assert.ok(!hasFox(enemy), "no mark yet — the watch is only armed");
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] }); // ANY skill, not just Harmful
  const m = foxOf(enemy);
  assert.ok(m, "the enemy that acted is now Fox-Fire marked");
  assert.equal(m!.duration, 4, "with the standard 4-turn Fox Fire mark");
});

test("fate5 CONTROL: an ALLY using a skill is NOT marked (enemies only)", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasFox(ally), "Fox's Cunning marks enemies, not allies");
});

test("fate5 CONTROL: with no Fox's Cunning active, an enemy skill marks nobody", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasFox(enemy), "no window => no marking");
});

test("fate5: the window lasts only 1 turn — after it expires, an enemy skill no longer marks", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); endTurn(state);
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasFox(enemy), "the window closed; a later enemy skill is not marked");
});

// =============================================================================
// Section 7 — FUSION ACTIVE: fate6 "This Is Not The End"
// =============================================================================

function lethal(state: MatchState, killer: Unit, victim: Unit): void {
  runEffects(state, [{ op: "damage", amount: 999, dtype: "normal", to: "target" }], { caster: killer, self: killer, targets: [victim], skillId: "execute" });
}

test("fate6: a lethal blow on Fate revives him to 40, plus 5 per active Fox Fire", () => {
  const f = fate(100);
  const e1 = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, statuses: [foxMark()] });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  assert.equal(r.ok, true, "This Is Not The End casts");
  assert.equal(skillOf(f, "fate6").currentCd, 3, "cooldown is 3");

  lethal(state, e1, f); // Fate would die
  assert.equal(f.alive, true, "Fate did not die — he was returned instead");
  // revive to 40, then +5 for each of the 2 active Fox Fire marks; this self-heal is his OWN skill so
  // it passes the fate0 heal-lock.
  assert.equal(f.hp, 50, "40 + 5*2 = 50");
});

test("fate6: with no active Fox Fire, the revive is a flat 40", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  lethal(state, enemy, f);
  assert.equal(f.alive, true, "Fate is returned to life");
  assert.equal(f.hp, 40, "exactly 40 with no Fox Fire bonus");
});

test("fate6: protects ALLIES too (the first ally to die is returned to 40)", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  lethal(state, enemy, ally);
  assert.equal(ally.alive, true, "the ally is returned to life");
  assert.equal(ally.hp, 40, "at 40 HP");
});

test("fate6 'first time ... would die': only ONE revival for the whole team", () => {
  const f = fate(100);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  lethal(state, enemy, ally); // first death — revived
  assert.equal(ally.alive, true, "the first death is prevented");
  lethal(state, enemy, f); // second protected hero dies later
  assert.equal(f.alive, false, "the revive fires only once — Fate is not saved a second time");
});

test("fate6: after it fires, it cannot be recast this round ('only once per round')", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  skillOf(f, "fate6").currentCd = 0; // ignore the plain cooldown; test the once-per-round lock specifically
  lethal(state, enemy, f); // the ward fires
  assert.equal(f.alive, true, "revived once");
  const again = performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  assert.equal(again.ok, false, "recast is blocked after the revive fired this round");
  assert.equal(again.reason, "requirements-not-met", "specifically by the once-per-round requirement gate");
});

test("fate6 CONTROL: before casting, a lethal blow actually kills Fate", () => {
  const f = fate(100);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  lethal(state, enemy, f);
  assert.equal(f.alive, false, "with no ward armed, Fate dies normally (proves the kill path works)");
});
