import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startTurn, endTurn } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers fate's triggers + custom fns
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { totalShield } from "../src/damage.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

// ============================================================================
// Fate, Reborn Hero — AUGMENTS — adversarial, spec-derived behavioral suite.
// Oracle = the FROZEN augment prose (content/frozen/augments.json). Element = Apocalypse.
//
//   fate1 "Resurgent Revival": "If Fate is revived using This Is Not The End, he no longer
//       prevents healing from his allies from affecting him."
//   fate2 "Azure Lure": "Will-o'-wisp no longer gives Fate's team Shield. Instead, the enemy
//       team has their Helpful skills stunned while it is active."
//   fate3 "Vulpus Arcana": "Vulpus Incendia and Vulpus Crystallia can now be used without
//       interrupting Channeling."
//   fate4 "Deja Vu": "Enemies that don't trigger Fox's Cunning during its duration will have
//       their cooldowns paralyzed for 2 turns."
//   fate5 "Once More, Together": "This Is Not The End's trigger limit is now per allied Hero
//       (each Hero can be revived once per round.)"
//
// Base kit facts used only to DRIVE (from frozen skills.json):
//   fate0 "Dwindling Flame" passive: "Fate can only be healed by his own skills and effects."
//   fate2 "Will-o'-wisp": self 5 Affliction; team 10 Shield/2t; an enemy Harmful skill on
//       Fate's team is punished 10 Affliction.
//   fate3 "Vulpus Incendia" (Channel), fate4 "Vulpus Crystallia" (Channel).
//   fate5 "Fox's Cunning": for 1 turn any enemy that uses a new skill is Fox-Fire marked.
//   fate6 "This Is Not The End": 2-turn team revive-to-40 (+5/Fox Fire), once per round.
// ============================================================================

const APOC = () => ({ generic: 40, apocalypse: 40 });

function fate(augId?: string): Unit {
  const f = loadHero(heroById("fate"), "A", "f");
  if (augId) applyAugment(f, augmentById(augId)!);
  return f;
}
function skillOf(u: Unit, id: string): SkillInstance {
  return (u.skills ?? []).find((s) => s.id === id)!;
}
function channeling(u: Unit, name: string): boolean {
  return u.statuses.some((s) => s.kind === "channeling" && s.name === name);
}
function hasFox(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "mark" && s.name === "Fox Fire");
}
function paralysis(u: Unit): { kind: string; duration: number | null } | undefined {
  return u.statuses.find((s) => s.kind === "paralysis");
}
/** Kill `victim` outright (mirrors the base suite's helper): 999 normal damage emits unitDied. */
function kill(state: MatchState, killer: Unit, victim: Unit): void {
  runEffects(state, [{ op: "damage", amount: 999, dtype: "normal", to: "target" }],
    { caster: killer, self: killer, targets: [victim], skillId: "execute" });
}

// ===========================================================================
// fate1 — "Resurgent Revival": if Fate is REVIVED by This Is Not The End, allies
// can heal him again (the Dwindling Flame heal-lock no longer prevents it).
// ===========================================================================

test("fate1: after Fate is revived by This Is Not The End, an ALLY's heal reaches him", () => {
  const f = fate("fate1");
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "roundStart" }); // Dwindling Flame arms the heal-lock on Fate
  state.teams.A.energy = APOC();

  // Precondition: while merely heal-locked (not yet revived) an ally cannot heal Fate.
  runEffects(state, [{ op: "heal", amount: 15, to: "target" }], { caster: ally, self: ally, targets: [f], skillId: "pre" });
  assert.equal(f.hp, 100, "precondition: before any revive the ally's heal is blocked");

  performAction(state, { unit: "f", skillId: "fate6", targets: [] }); // arm the ward
  kill(state, state.units["e"]!, f); // Fate would die -> revived by This Is Not The End
  assert.equal(f.alive, true, "Fate was revived, not killed");
  assert.equal(f.hp, 40, "revived to a flat 40 (no Fox Fire active)");

  // Now the augment: an ally's heal DOES affect the revived Fate.
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: ally, self: ally, targets: [f], skillId: "ally_heal" });
  assert.equal(f.hp, 60, "post-revive, the ally's 20 heal lands (40 -> 60)");
});

test("fate1 CONTROL (base): WITHOUT the augment a revived Fate still cannot be healed by allies", () => {
  const f = fate(); // base kit, no augment
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "roundStart" });
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });
  kill(state, state.units["e"]!, f);
  assert.equal(f.alive, true, "Fate revived");
  assert.equal(f.hp, 40, "to 40");
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: ally, self: ally, targets: [f], skillId: "ally_heal" });
  assert.equal(f.hp, 40, "base heal-lock survives the revive: the ally's heal is still blocked");
});

test("fate1 CONTROL (gating): the augment alone does NOT unlock — only an actual REVIVE does", () => {
  const f = fate("fate1");
  f.hp = 50;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  emit(state, { type: "roundStart" }); // heal-lock armed, but Fate is never revived
  runEffects(state, [{ op: "heal", amount: 20, to: "target" }], { caster: ally, self: ally, targets: [f], skillId: "ally_heal" });
  assert.equal(f.hp, 50, "'If Fate is revived' — with no revive the heal-lock still blocks the ally heal");
});

// ===========================================================================
// fate2 — "Azure Lure": Will-o'-wisp no longer grants team Shield; instead the
// enemy team's Helpful skills are stunned while Will-o'-wisp is active.
// ===========================================================================

test("fate2: Will-o'-wisp grants NO team Shield (base 10 -> 0), but Fate still pays 5 Affliction", () => {
  const f = fate("fate2");
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  state.teams.A.energy = APOC();
  const r = performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  assert.equal(r.ok, true, "augmented Will-o'-wisp still casts");
  assert.equal(f.hp, 95, "the self 5 Affliction is unchanged (100 -> 95)");
  assert.equal(totalShield(f), 0, "no Shield to Fate");
  assert.equal(totalShield(ally), 0, "no Shield to the ally — Azure Lure drops the Shield clause");
});

test("fate2 CONTROL (base): un-augmented Will-o'-wisp DOES give the team 10 Shield", () => {
  const f = fate(); // base
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  assert.equal(totalShield(f), 10, "base grants 10 Shield to Fate");
  assert.equal(totalShield(ally), 10, "and 10 to the ally (proves the augment removed exactly this)");
});

test("fate2: while active, the enemy team's HELPFUL skills are stunned; their non-Helpful skills are not", () => {
  const f = fate("fate2");
  f.hp = 100;
  const help = skill("ehelp", [{ op: "heal", amount: 10, to: "self" }], { tags: ["Helpful"], element: "apocalypse", targeting: "self" });
  const harm = skill("eharm", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { tags: ["Harmful"], element: "apocalypse", targeting: "single" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [help, harm] });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  state.teams.B.energy = APOC();

  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  // The applied stun is scoped to ONLY the enemy's Helpful skills, for the 2-turn window.
  const st = enemy.statuses.find((s) => s.kind === "stun");
  assert.ok(st, "the enemy carries a stun from Azure Lure");
  assert.equal((st as { scope?: { tag?: string; mode?: string } }).scope?.tag, "Helpful", "scoped to the Helpful tag");
  assert.equal((st as { scope?: { tag?: string; mode?: string } }).scope?.mode, "only", "mode 'only' — it stops ONLY Helpful skills");

  const rHelp = performAction(state, { unit: "e", skillId: "ehelp", targets: ["e"] });
  assert.equal(rHelp.ok, false, "the enemy's Helpful skill is stunned");
  assert.equal(rHelp.reason, "stunned", "specifically by the Azure Lure stun");

  const rHarm = performAction(state, { unit: "e", skillId: "eharm", targets: ["f"] });
  assert.equal(rHarm.ok, true, "the enemy's Harmful skill is NOT stunned (only Helpful is)");
});

test("fate2 CONTROL: with no Will-o'-wisp active, an enemy's Helpful skill is not stunned", () => {
  const f = fate("fate2");
  f.hp = 100;
  const help = skill("ehelp", [{ op: "heal", amount: 10, to: "self" }], { tags: ["Helpful"], element: "apocalypse", targeting: "self" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [help] });
  const state = makeState([f], [enemy]);
  state.teams.B.energy = APOC();
  const r = performAction(state, { unit: "e", skillId: "ehelp", targets: ["e"] });
  assert.equal(r.ok, true, "no Will-o'-wisp window => the enemy Helpful skill is free to cast");
});

test("fate2: the Will-o'-wisp retaliation (10 Affliction on enemy Harmful) is UNCHANGED by the augment", () => {
  const f = fate("fate2");
  f.hp = 100;
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate2", targets: ["f"] });
  emit(state, { type: "skillUsed", caster: "e", skillId: "x", targets: ["f"], tags: ["Harmful"] });
  assert.equal(enemy.hp, 90, "an enemy Harmful skill on Fate's team still takes 10 Affliction back");
});

// ===========================================================================
// fate3 — "Vulpus Arcana": Vulpus Incendia (fate3) and Vulpus Crystallia (fate4)
// can now be used WITHOUT interrupting Channeling.
// ===========================================================================

test("fate3: casting Vulpus Incendia does NOT interrupt an existing channel (Vulpus Crystallia keeps running)", () => {
  const f = fate("fate3");
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate4", targets: ["al"] }); // establish a Crystallia channel
  assert.ok(channeling(f, "fate4"), "precondition: Vulpus Crystallia channel is active");
  performAction(state, { unit: "f", skillId: "fate3", targets: ["e"] }); // Incendia — must not interrupt
  assert.ok(channeling(f, "fate4"), "Vulpus Incendia did not interrupt the Crystallia channel");
});

test("fate3: casting Vulpus Crystallia does NOT interrupt an existing channel (Vulpus Incendia keeps running)", () => {
  const f = fate("fate3");
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate3", targets: ["e"] }); // establish an Incendia channel
  assert.ok(channeling(f, "fate3"), "precondition: Vulpus Incendia channel is active");
  performAction(state, { unit: "f", skillId: "fate4", targets: ["al"] }); // Crystallia — must not interrupt
  assert.ok(channeling(f, "fate3"), "Vulpus Crystallia did not interrupt the Incendia channel");
});

test("fate3 CONTROL (base): WITHOUT the augment, casting Vulpus Incendia interrupts the Crystallia channel", () => {
  const f = fate(); // base
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate4", targets: ["al"] });
  assert.ok(channeling(f, "fate4"), "precondition: Crystallia channel active");
  performAction(state, { unit: "f", skillId: "fate3", targets: ["e"] });
  assert.ok(!channeling(f, "fate4"), "base: casting Incendia interrupts the pre-existing Crystallia channel");
});

test("fate3 CONTROL (scope): the exemption is only for those two skills — Fox Fire STILL interrupts a channel", () => {
  const f = fate("fate3");
  f.hp = 100;
  const ally = makeUnit({ id: "al", team: "A", kind: "hero", hp: 50, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, ally], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate4", targets: ["al"] }); // Crystallia channel
  assert.ok(channeling(f, "fate4"), "precondition: Crystallia channel active");
  performAction(state, { unit: "f", skillId: "fate1", targets: ["e"] }); // Fox Fire — an ordinary (non-exempt) skill
  assert.ok(!channeling(f, "fate4"), "an ordinary skill still interrupts — the augment is scoped to Incendia/Crystallia");
});

// ===========================================================================
// fate4 — "Deja Vu": enemies that don't TRIGGER Fox's Cunning during its duration
// have their cooldowns paralyzed for 2 turns.
// ===========================================================================

test("fate4: an enemy that does NOT act during Fox's Cunning is paralyzed 2 turns; one that acts is not", () => {
  const f = fate("fate4");
  f.hp = 100;
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // will act (triggers Fox's Cunning)
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 }); // will NOT act
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();

  performAction(state, { unit: "f", skillId: "fate5", targets: [] }); // Fox's Cunning window opens; both enemies watched
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: [], tags: [] }); // e1 triggers it

  assert.ok(!paralysis(e2), "no paralysis while the window is still open");

  // Run a full round-trip so the 1-turn Fate-anchored window lapses at Fate's next turn-end.
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); endTurn(state);

  const p = paralysis(e2);
  assert.ok(p, "the enemy that never acted is paralyzed when the window lapses");
  assert.equal(p!.duration, 2, "cooldowns paralyzed for 2 turns");
  assert.ok(!paralysis(e1), "the enemy that triggered Fox's Cunning is NOT paralyzed");
  assert.ok(hasFox(e1), "and it was Fox-Fire marked instead (it triggered the window)");
  assert.ok(!hasFox(e2), "the enemy that never acted got no Fox Fire (it never triggered)");
});

test("fate4: the paralysis actually FREEZES the enemy's cooldowns (they do not advance)", () => {
  const f = fate("fate4");
  f.hp = 100;
  const cdSkill = () => skill("es", [{ op: "damage", amount: 1, dtype: "normal", to: "target" }], { tags: ["Harmful"], element: "apocalypse", targeting: "single", cooldown: 3, currentCd: 3, cdSetTurn: 0 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [cdSkill()] }); // acts -> free
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100, skills: [cdSkill()] }); // idle -> paralyzed
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();

  performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: [], tags: [] });
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); endTurn(state); // paralysis lands on e2

  assert.ok(paralysis(e2), "precondition: e2 is paralyzed");
  const e1Before = skillOf(e1, "es").currentCd;
  const e2Before = skillOf(e2, "es").currentCd;
  // One more of the enemy team's turns: cooldowns tick at its turn-end.
  startTurn(state); endTurn(state);
  assert.equal(skillOf(e2, "es").currentCd, e2Before, "paralyzed e2's cooldown did NOT advance");
  assert.equal(skillOf(e1, "es").currentCd, e1Before - 1, "un-paralyzed e1's cooldown DID advance (control)");
});

test("fate4 CONTROL (base): WITHOUT the augment, an idle enemy is never paralyzed by Fox's Cunning", () => {
  const f = fate(); // base
  f.hp = 100;
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f], [e1, e2]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate5", targets: [] });
  emit(state, { type: "skillUsed", caster: "e1", skillId: "x", targets: [], tags: [] });
  endTurn(state); startTurn(state); endTurn(state); startTurn(state); endTurn(state);
  assert.ok(!paralysis(e2), "base Fox's Cunning never paralyzes the idle enemy");
});

// ===========================================================================
// fate5 — "Once More, Together": This Is Not The End's trigger limit is now PER
// allied Hero — each Hero can be revived once per round.
// ===========================================================================

test("fate5: two different allied Heroes can each be revived in the same round", () => {
  const f = fate("fate5");
  f.hp = 100;
  const a1 = makeUnit({ id: "a1", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const a2 = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, a1, a2], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });

  kill(state, enemy, a1);
  assert.equal(a1.alive, true, "the first allied Hero to die is revived");
  assert.equal(a1.hp, 40, "to 40");

  kill(state, enemy, a2);
  assert.equal(a2.alive, true, "a SECOND, different allied Hero is ALSO revived this round (per-Hero limit)");
  assert.equal(a2.hp, 40, "to 40");
});

test("fate5: the same Hero cannot be revived twice in one round", () => {
  const f = fate("fate5");
  f.hp = 100;
  const a1 = makeUnit({ id: "a1", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, a1], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });

  kill(state, enemy, a1);
  assert.equal(a1.alive, true, "revived the first time");

  kill(state, enemy, a1); // same Hero dies again
  assert.equal(a1.alive, false, "'each Hero can be revived once per round' — no second revive for the same Hero");
});

test("fate5 CONTROL (base): un-augmented This Is Not The End revives the WHOLE team only once per round", () => {
  const f = fate(); // base
  f.hp = 100;
  const a1 = makeUnit({ id: "a1", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const a2 = makeUnit({ id: "a2", team: "A", kind: "hero", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([f, a1, a2], [enemy]);
  state.teams.A.energy = APOC();
  performAction(state, { unit: "f", skillId: "fate6", targets: [] });

  kill(state, enemy, a1);
  assert.equal(a1.alive, true, "base: the first death is prevented");
  kill(state, enemy, a2);
  assert.equal(a2.alive, false, "base: a second, different Hero is NOT saved (whole-team once-per-round)");
});
