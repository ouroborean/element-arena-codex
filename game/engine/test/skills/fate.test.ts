/**
 * Behavior tests for Fate, Reborn Hero — asserted against the FROZEN skill prose
 * (game/content/frozen/skills.json), never the implementation.
 *
 * Fate's element is "apocalypse", which the shared flushEnergy() pool does not stock, so each battle
 * tops up apocalypse energy (addElement) before casting apocalypse-specific skills.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, shieldTotal, canUse, performAction, startTurn, endTurn } from "../skillHarness.ts";
import type { MatchState, Unit } from "../../src/types.ts";

function addElement(s: MatchState, ...els: string[]): void {
  for (const t of ["A", "B"] as const) for (const el of els) s.teams[t].energy[el] = 99;
}
const outMod = (u: Unit): number =>
  u.statuses.filter((x) => x.kind === "outgoing_damage_mod").reduce((a, x) => a + (x.magnitude ?? 0), 0);
const foxMark = (u: Unit) => u.statuses.find((x) => x.kind === "mark" && x.name === "Fox Fire");
const essenceCount = (u: Unit): number => u.statuses.filter((x) => x.kind === "elemental_essence").length;

// Fate at a1. a2 = maggie (a normal-damage ally), a3 = gaia (an external healer). Enemies are
// maggie / taryn / riverdaughter (b1 maggie has a normal-damage skill1).
const F = (): MatchState => {
  const s = battle(["fate", "maggie", "gaia"], ["maggie", "taryn", "riverdaughter"]);
  addElement(s, "apocalypse");
  return s;
};

// --------------------------------------------------------------------------- //
//  fate0 — Dwindling Flame (passive)
//  "Fate can only be healed by his own skills and effects. While his HP is at or above 50, allies
//   affected by Fox Fire deal 5 more non-Affliction damage. While his HP is below 50, enemies affected
//   by Fox Fire deal 5 less non-Affliction damage."
// --------------------------------------------------------------------------- //
test("Dwindling Flame — Fate can only be healed by his own skills (external heal blocked, self heal works)", () => {
  const s = F();
  const f = unit(s, "a1");
  const lock = f.statuses.find((x) => x.kind === "heal_lock");
  assert.ok(lock, "heal_lock present at round start");
  assert.equal(lock!.unitRef, "a1", "only Fate himself is the allowed healer");

  f.hp = 50;
  performAction(s, { unit: "a3", skillId: "gaia3", targets: ["a1"] }); // an ally tries to heal Fate
  assert.equal(f.hp, 50, "an external ally heal is blocked");

  performAction(s, { unit: "a1", skillId: "fate4", targets: ["a1"] }); // Fate heals himself (his own skill)
  assert.equal(f.hp, 60, "Fate's own healing skill heals him for 10");
});

test("Dwindling Flame — HP>=50: Fox-Fire allies deal 5 more non-Affliction damage", () => {
  const s = F();
  assert.ok(unit(s, "a1").hp >= 50, "Fate starts at full HP");
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["a2"] }); // mark ally a2 with Fox Fire
  startTurn(s); // fire the turn-start passive
  assert.equal(outMod(unit(s, "a2")), 5, "the Fox-Fire ally gains +5 outgoing damage");
  const b1 = unit(s, "b1");
  const bh = b1.hp;
  performAction(s, { unit: "a2", skillId: "maggie1", targets: ["b1"] }); // maggie's 15 normal + 5
  assert.equal(bh - b1.hp, 20, "ally's non-Affliction hit deals 5 more (15 + 5 = 20)");
});

test("Dwindling Flame — HP<50: Fox-Fire enemies deal 5 less non-Affliction damage", () => {
  const s = F();
  unit(s, "a1").hp = 40; // below 50
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b1"] }); // mark enemy b1 with Fox Fire
  startTurn(s);
  assert.equal(outMod(unit(s, "b1")), -5, "the Fox-Fire enemy takes a -5 outgoing damage penalty");
  const a3 = unit(s, "a3");
  const ah = a3.hp;
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a3"] }); // enemy's 15 normal - 5
  assert.equal(ah - a3.hp, 10, "enemy's non-Affliction hit deals 5 less (15 - 5 = 10)");
});

// --------------------------------------------------------------------------- //
//  fate1 — Fox Fire
//  "Target enemy or ally is marked by Fox Fire for 4 turns. During this time, if they use or receive a
//   new Harmful skill, they will take 5 Affliction damage if they are an enemy or heal 5 HP if they are
//   an ally. When affected units use new skills on Fate, he gains Elemental Essence. Refreshes if applied
//   on an already affected target."
// --------------------------------------------------------------------------- //
test("Fox Fire — marks an enemy or ally for 4 turns; cost 1 generic, no cooldown", () => {
  const s = F();
  const f = unit(s, "a1");
  assert.ok(canUse(s, f, skillOf(f, "fate1")), "usable at fresh round");
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b1"] });
  assert.equal(foxMark(unit(s, "b1"))!.duration, 4, "enemy marked for 4 turns");
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["a2"] });
  assert.equal(foxMark(unit(s, "a2"))!.duration, 4, "ally marked for 4 turns");
  assert.equal(skillOf(f, "fate1").currentCd, 0, "no cooldown");
});

test("Fox Fire — a marked ENEMY that uses a new Harmful skill takes 5 Affliction", () => {
  const s = F();
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b1"] });
  const b1 = unit(s, "b1");
  const bh = b1.hp; // after the mark (and its receive-tick) already applied
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a2"] }); // b1 USES a Harmful skill
  assert.equal(bh - b1.hp, 5, "using a Harmful skill costs the marked enemy 5 Affliction");
});

test("Fox Fire — a marked ENEMY that receives a new Harmful skill takes 5 Affliction", () => {
  const s = F();
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b2"] });
  const b2 = unit(s, "b2");
  const bh = b2.hp;
  performAction(s, { unit: "a2", skillId: "maggie1", targets: ["b2"] }); // b2 RECEIVES 15 normal
  assert.equal(bh - b2.hp, 20, "receives 15 normal + 5 Affliction from Fox Fire = 20");
});

test("Fox Fire — a marked ALLY that uses a new Harmful skill heals 5 HP", () => {
  const s = F();
  const a2 = unit(s, "a2");
  a2.hp = 40;
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["a2"] });
  const ah = a2.hp; // after the mark's own receive-heal
  performAction(s, { unit: "a2", skillId: "maggie1", targets: ["b1"] }); // a2 USES a Harmful skill
  assert.equal(a2.hp - ah, 5, "the marked ally heals 5 HP when using a Harmful skill");
});

test("Fox Fire — Fate gains Elemental Essence when an affected unit uses a skill on him", () => {
  const s = F();
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b1"] });
  assert.equal(essenceCount(unit(s, "a1")), 0, "no Essence yet");
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a1"] }); // marked b1 uses a skill ON Fate
  assert.ok(hasStatus(unit(s, "a1"), "elemental_essence"), "Fate gains Elemental Essence");
});

test("Fox Fire — re-applying refreshes the mark rather than adding a second", () => {
  const s = F();
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b1"] });
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b1"] });
  const marks = unit(s, "b1").statuses.filter((x) => x.kind === "mark" && x.name === "Fox Fire");
  assert.equal(marks.length, 1, "a single Fox Fire mark");
  assert.equal(marks[0]!.duration, 4, "refreshed back to 4 turns");
});

// --------------------------------------------------------------------------- //
//  fate2 — Will-o'-wisp
//  "Fate deals 5 Affliction damage to himself, then gives his team 10 Shield for 2 turns. During this
//   time, any enemy that uses a new Harmful skill on Fate or his allies will receive 10 Affliction damage
//   (this damage can only trigger once per skill)."
// --------------------------------------------------------------------------- //
test("Will-o'-wisp — 5 Affliction self-damage, 10 Shield to the team for 2 turns; cost/cooldown", () => {
  const s = F();
  const f = unit(s, "a1");
  assert.equal(canUse(s, f, skillOf(f, "fate2")), true, "usable with apocalypse energy (1 specific)");
  const before = f.hp;
  const shBefore = ["a1", "a2", "a3"].map((id) => shieldTotal(unit(s, id)));
  performAction(s, { unit: "a1", skillId: "fate2" });
  assert.equal(f.hp, before - 5, "Fate takes 5 Affliction damage");
  for (const [i, id] of ["a1", "a2", "a3"].entries()) {
    assert.equal(shieldTotal(unit(s, id)) - shBefore[i], 10, `${id} gains 10 Shield`);
  }
  assert.ok(hasStatus(f, "mark", "Will-o'-wisp"), "the retaliation window is armed");
  assert.equal(skillOf(f, "fate2").currentCd, 2, "cooldown 2");
});

test("Will-o'-wisp — an enemy Harmful skill during the window takes 10 Affliction back", () => {
  const s = F();
  performAction(s, { unit: "a1", skillId: "fate2" });
  const b1 = unit(s, "b1");
  const bh = b1.hp;
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a1"] }); // enemy Harmful on Fate
  assert.equal(bh - b1.hp, 10, "the attacking enemy receives 10 Affliction");
});

// --------------------------------------------------------------------------- //
//  fate3 — Vulpus Incendia (Channel)
//  "Fate deals 10 Affliction damage to one enemy each turn. As long as this skill remains active, Fox
//   Fire deals double damage when triggered. Channeled."
// --------------------------------------------------------------------------- //
test("Vulpus Incendia — 10 Affliction on cast and again each turn; cost gate; channels", () => {
  const s = battle(["fate", "maggie", "gaia"], ["maggie", "taryn", "riverdaughter"]);
  const f = unit(s, "a1");
  assert.equal(canUse(s, f, skillOf(f, "fate3")), false, "unusable without apocalypse energy (1 specific)");
  addElement(s, "apocalypse");
  assert.equal(canUse(s, f, skillOf(f, "fate3")), true, "usable once apocalypse energy is available");

  const b1 = unit(s, "b1");
  const bh = b1.hp;
  performAction(s, { unit: "a1", skillId: "fate3", targets: ["b1"] });
  assert.equal(bh - b1.hp, 10, "10 Affliction on cast");
  assert.ok(hasStatus(f, "channeling"), "the channel is sustained");
  assert.equal(skillOf(f, "fate3").currentCd, 2, "cooldown 2");

  endTurn(s); startTurn(s); endTurn(s); startTurn(s); // return to Fate's next turn
  assert.equal(bh - b1.hp, 20, "the channel deals another 10 on Fate's next turn");
});

test("Vulpus Incendia — while channeling, Fox Fire triggers for double (10, not 5)", () => {
  const s = F();
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b2"] }); // mark b2 BEFORE channeling (fate1 would interrupt)
  performAction(s, { unit: "a1", skillId: "fate3", targets: ["b1"] }); // start the channel
  const b2 = unit(s, "b2");
  const bh = b2.hp;
  performAction(s, { unit: "b2", skillId: "taryn1", targets: ["a2"] }); // marked enemy uses a Harmful skill
  assert.equal(bh - b2.hp, 10, "Fox Fire deals double (10 Affliction) while Vulpus Incendia is active");
});

// --------------------------------------------------------------------------- //
//  fate4 — Vulpus Crystallia (Channel)
//  "Fate heals an ally 10 HP each turn. As long as this skill remains active, Fox Fire gives double
//   healing when triggered. Channeled."
// --------------------------------------------------------------------------- //
test("Vulpus Crystallia — heals an ally 10 on cast and again each turn; channels", () => {
  const s = F();
  const a2 = unit(s, "a2");
  a2.hp = 50;
  performAction(s, { unit: "a1", skillId: "fate4", targets: ["a2"] });
  assert.equal(a2.hp, 60, "heals the ally 10 on cast");
  assert.ok(hasStatus(unit(s, "a1"), "channeling"), "the channel is sustained");
  assert.equal(skillOf(unit(s, "a1"), "fate4").currentCd, 2, "cooldown 2");
  endTurn(s); startTurn(s); endTurn(s); startTurn(s);
  assert.equal(a2.hp, 70, "the channel heals another 10 on Fate's next turn");
});

test("Vulpus Crystallia — while channeling, Fox Fire gives double healing (10, not 5)", () => {
  const s = F();
  const a2 = unit(s, "a2");
  a2.hp = 40;
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["a2"] }); // mark ally a2 BEFORE channeling
  performAction(s, { unit: "a1", skillId: "fate4", targets: ["a3"] }); // channel heal on a different ally
  const ah = a2.hp; // after the mark's receive-heal
  performAction(s, { unit: "a2", skillId: "maggie1", targets: ["b1"] }); // marked ally uses a Harmful skill
  assert.equal(a2.hp - ah, 10, "Fox Fire gives double healing (10) while Vulpus Crystallia is active");
});

// --------------------------------------------------------------------------- //
//  fate5 — Fox's Cunning
//  "For 1 turn, any enemy that uses a new skill will be affected by Fox Fire. This effect is invisible."
// --------------------------------------------------------------------------- //
test("Fox's Cunning — for 1 turn, an enemy that uses a new skill is marked by Fox Fire", () => {
  const s = F();
  const f = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "fate5" });
  assert.equal(f.statuses.find((x) => x.kind === "mark" && x.name === "Fox's Cunning")!.duration, 1, "1-turn window on Fate");
  assert.equal(skillOf(f, "fate5").currentCd, 0, "no cooldown");
  assert.equal(hasStatus(unit(s, "b1"), "mark", "Fox Fire"), false, "enemy not yet marked");
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a2"] }); // enemy uses a skill during the window
  assert.ok(hasStatus(unit(s, "b1"), "mark", "Fox Fire"), "the acting enemy is now affected by Fox Fire");
});

// --------------------------------------------------------------------------- //
//  fate6 — This Is Not The End
//  "For the next 2 turns, the first time Fate or an ally would die, they are returned to 40 HP instead.
//   Afterward, the revived Hero heals 5 HP for every active Fox Fire. This skill can only be triggered
//   once per round."
// --------------------------------------------------------------------------- //
test("This Is Not The End — arms a 2-turn revive ward on Fate and allied heroes; cost/cooldown", () => {
  const s = F();
  const f = unit(s, "a1");
  assert.equal(canUse(s, f, skillOf(f, "fate6")), true, "usable with 2 apocalypse energy");
  performAction(s, { unit: "a1", skillId: "fate6" });
  for (const id of ["a1", "a2"]) {
    assert.equal(unit(s, id).statuses.find((x) => x.kind === "mark" && x.name === "This Is Not The End")!.duration, 2,
      `${id} warded for 2 turns`);
  }
  assert.equal(skillOf(f, "fate6").currentCd, 3, "cooldown 3");
});

test("This Is Not The End — first ally death is revived to 40 HP + 5 per active Fox Fire; once per round", () => {
  const s = F();
  const f = unit(s, "a1");
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b2"] }); // two active Fox Fire marks
  performAction(s, { unit: "a1", skillId: "fate1", targets: ["b3"] });
  performAction(s, { unit: "a1", skillId: "fate6" });
  const a2 = unit(s, "a2");
  a2.hp = 10;
  performAction(s, { unit: "b1", skillId: "maggie1", targets: ["a2"] }); // 15 normal -> lethal
  assert.equal(a2.alive, true, "the ally is revived, not dead");
  assert.equal(a2.hp, 50, "returned to 40 HP + 5 per active Fox Fire (40 + 5*2 = 50)");
  assert.ok(hasStatus(f, "mark", "TINTE Spent"), "the once-per-round lock is set");
  assert.equal(canUse(s, f, skillOf(f, "fate6")), false, "cannot be triggered again this round");
});
