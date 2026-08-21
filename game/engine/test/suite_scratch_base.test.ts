import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { performAction, endTurn, effectiveCost } from "../src/scheduler.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Adversarial, spec-derived suite for Mr. Scratch's BASE kit.
// The FROZEN prose (../content/frozen/skills.json) is the oracle:
//
//  scratch0 The Devil's Price (passive): Whenever a target triggers one of Scratch's
//           Deal skills, Scratch gains Elemental Essence. When one of his Deal skills
//           expires without being triggered, its target gains Elemental Essence.
//  scratch1 Deal: Defeat Your Enemies (Helpful, gen 1): Target Hero deals 10 more
//           non-Affliction damage for 1 turn. If they use a new skill, that Hero will
//           receive 20 Affliction damage.
//  scratch2 Deal: Save Your Friends (Helpful, gen 1, cd 1): For 1 turn, target Hero's
//           next Helpful skill will heal its targets for 15 HP and make them Invulnerable
//           for 1 turn. If they use a new skill, this effect will end and that Hero will
//           be permanently Isolated.
//  scratch3 Deal: Realize Your Potential (Helpful, spec 1, cd 1): Until the end of their
//           next turn, Target Hero's skills cost 1 less Specific and 1 less Generic
//           energy. If they use a new skill, they will be stunned for 1 turn.
//  scratch4 Faustian Bargain (Strategic self, gen 1, cd 2): Scratch's next deal will not
//           apply its positive effect to enemies, and will not apply its Triggered effect
//           to allies.
//  scratch5 Disarming Pitch (Strategic self, gen 1, cd 1): For 1 turn, Scratch gains 10
//           Shield and any enemy who uses a new skill on him will be marked for 1 turn.
//           Scratch's Deal skills always apply to marked Heroes.
//  scratch6 Deal: Know Your Fate (Helpful, spec 3, cd 5): For 3 turns, target Hero ignores
//           non-damage effects and their skills have no cost. At the end of this duration,
//           that Hero is killed.
//
// Scratch's element is "devil"; Specific cost is paid in devil.
// ---------------------------------------------------------------------------

const ENERGY = () => ({ generic: 40, devil: 40 });
const essence = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);

// A harmless self-cast "new skill" the marked hero uses to trigger a Deal.
const noopSelf = () => skill("noop", [], { targeting: "self", tags: ["Strategic"] });

function setup(bExtra: Unit[] = [], aExtra: Unit[] = []): { scratch: Unit; state: MatchState } {
  const scratch = loadHero(heroById("scratch"), "A", "s");
  const state = makeState([scratch, ...aExtra], bExtra);
  state.teams.A.energy = ENERGY();
  state.teams.B.energy = ENERGY();
  return { scratch, state };
}

// ===========================================================================
// scratch1 — Deal: Defeat Your Enemies
// ===========================================================================

test("scratch1: boon grants +10 to NON-Affliction (normal) damage for 1 turn", () => {
  const dealer = makeUnit({
    id: "d", team: "B", kind: "hero",
    skills: [skill("hit", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const victim = makeUnit({ id: "v", team: "B", kind: "hero" });
  const { state } = setup([dealer, victim]);

  // Deal on the dealer buffs its next non-Affliction damage by +10.
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["d"] }).ok);
  assert.ok(performAction(state, { unit: "d", skillId: "hit", targets: ["v"] }).ok);
  // Base 10 + 10 boon = 20.
  assert.equal(victim.hp, 80, "buffed dealer's normal hit deals 10 base + 10 boon = 20");
});

test("scratch1: boon does NOT boost Affliction damage (non-Affliction only)", () => {
  const dealer = makeUnit({
    id: "d", team: "B", kind: "hero",
    skills: [skill("afflict", [{ op: "damage", amount: 10, dtype: "affliction", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const victim = makeUnit({ id: "v", team: "B", kind: "hero" });
  const { state } = setup([dealer, victim]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["d"] }).ok);
  assert.ok(performAction(state, { unit: "d", skillId: "afflict", targets: ["v"] }).ok);
  assert.equal(victim.hp, 90, "Affliction damage is unaffected by the +10 non-Affliction boon");
});

test("scratch1: triggered — a marked hero who uses a new skill takes 20 Affliction; Scratch gains Essence", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.equal(essence(scratch), 0);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);

  assert.equal(target.hp, 80, "marked hero using a new skill receives 20 Affliction damage");
  assert.equal(essence(scratch), 1, "Scratch gains 1 Elemental Essence when a Deal is triggered");
  assert.equal(hasMark(target, "Deal: Defeat Your Enemies"), false, "the Deal mark is consumed on trigger");
});

test("scratch1 CONTROL: an UNmarked hero using a skill takes no punishment and grants no Essence", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);
  assert.equal(target.hp, 100, "no Deal mark -> no 20 Affliction punishment");
  assert.equal(essence(scratch), 0, "no Deal triggered -> Scratch gains no Essence");
});

test("scratch1 passive: a Deal that EXPIRES untriggered grants its TARGET Essence (not Scratch)", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);

  // Let the 1-turn Deal mark lapse on Scratch's team without the target acting.
  endTurn(state); endTurn(state); endTurn(state);

  assert.equal(hasMark(target, "Deal: Defeat Your Enemies"), false, "the Deal mark expired");
  assert.equal(essence(target), 1, "untriggered expiry grants the TARGET 1 Elemental Essence");
  assert.equal(essence(scratch), 0, "an untriggered Deal grants Scratch no Essence");
});

// ===========================================================================
// scratch2 — Deal: Save Your Friends
// ===========================================================================

test("scratch2: boon — target's next HELPFUL skill heals its targets 15 HP + Invulnerable 1 turn", () => {
  const recipient = makeUnit({ id: "r", team: "A", kind: "hero", hp: 50 });
  const helper = makeUnit({
    id: "h", team: "A", kind: "hero",
    skills: [skill("help", [], { targeting: "single", tags: ["Helpful"] })],
  });
  const { scratch, state } = setup([], [helper, recipient]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  assert.ok(performAction(state, { unit: "h", skillId: "help", targets: ["r"] }).ok);

  assert.equal(recipient.hp, 65, "the Helpful skill's target is healed 15 HP by the boon");
  assert.ok(
    recipient.statuses.some((s) => s.kind === "invulnerable" && s.duration === 1),
    "the Helpful skill's target is made Invulnerable for 1 turn",
  );
  assert.equal(essence(scratch), 1, "triggering the Deal grants Scratch Essence");
});

test("scratch2: triggered — using a new skill ends the effect and permanently Isolates the hero", () => {
  const helper = makeUnit({ id: "h", team: "A", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([], [helper]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  assert.ok(performAction(state, { unit: "h", skillId: "noop" }).ok);

  assert.ok(
    helper.statuses.some((s) => s.kind === "isolated" && s.duration === null),
    "the hero is permanently Isolated (duration null) after using a new skill",
  );
  assert.equal(hasMark(helper, "Boon: Save Your Friends"), false, "the boon effect ends on trigger");
  assert.equal(essence(scratch), 1, "Scratch gains Essence when the Deal is triggered");
});

test("scratch2 CONTROL: a NON-Helpful skill gets no heal/Invuln boon (but still Isolates)", () => {
  const recipient = makeUnit({ id: "r", team: "A", kind: "hero", hp: 50 });
  const helper = makeUnit({
    id: "h", team: "A", kind: "hero",
    // A Strategic (non-Helpful) skill that still declares a target.
    skills: [skill("strat", [], { targeting: "single", tags: ["Strategic"] })],
  });
  const { state } = setup([], [helper, recipient]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  assert.ok(performAction(state, { unit: "h", skillId: "strat", targets: ["r"] }).ok);

  assert.equal(recipient.hp, 50, "a non-Helpful skill does NOT trigger the heal boon");
  assert.equal(
    recipient.statuses.some((s) => s.kind === "invulnerable"), false,
    "a non-Helpful skill does NOT grant Invulnerable",
  );
  assert.ok(
    helper.statuses.some((s) => s.kind === "isolated"),
    "using any new skill still permanently Isolates the hero",
  );
});

test("scratch2 passive: an untriggered Deal expires and grants the target Essence (no Isolate)", () => {
  const helper = makeUnit({ id: "h", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([], [helper]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);

  endTurn(state); endTurn(state); endTurn(state);

  assert.equal(essence(helper), 1, "untriggered expiry grants the target Essence");
  assert.equal(
    helper.statuses.some((s) => s.kind === "isolated"), false,
    "an untriggered Deal never Isolates the target",
  );
});

// ===========================================================================
// scratch3 — Deal: Realize Your Potential
// ===========================================================================

test("scratch3: boon — target's skills cost 1 less Generic and 1 less Specific", () => {
  const probeSkill = skill("probe", [], { cost: { generic: 2, specific: 2 } });
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [probeSkill] });
  const { state } = setup([target]);

  const before = effectiveCost(target, probeSkill, state);
  assert.deepEqual(before, { generic: 2, specific: 2 }, "control: unmarked cost is unchanged");

  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["t"] }).ok);
  const after = effectiveCost(target, probeSkill, state);
  assert.deepEqual(after, { generic: 1, specific: 1 }, "Deal discounts 1 Generic AND 1 Specific");
});

test("scratch3: triggered — a marked hero who uses a new skill is Stunned for 1 turn; Scratch gains Essence", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["t"] }).ok);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);

  assert.ok(
    target.statuses.some((s) => s.kind === "stun" && s.duration === 1),
    "using a new skill stuns the marked hero for 1 turn",
  );
  assert.equal(essence(scratch), 1, "triggering the Deal grants Scratch Essence");
});

test("scratch3 CONTROL: an unmarked hero using a skill is not stunned", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([target]);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);
  assert.equal(target.statuses.some((s) => s.kind === "stun"), false, "no Deal mark -> no stun");
});

// ===========================================================================
// scratch4 — Faustian Bargain
// ===========================================================================

test("scratch4: positive effect is NOT applied to an ENEMY Deal target (but the Deal still marks)", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([enemy]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch4" }).ok);
  assert.ok(hasMark(scratch, "Faustian Bargain"), "Faustian mark is set on Scratch");
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok);

  assert.equal(
    enemy.statuses.some((s) => s.kind === "outgoing_damage_mod"), false,
    "Faustian suppresses the positive (+10 damage) boon on an enemy target",
  );
  assert.ok(hasMark(enemy, "Deal: Defeat Your Enemies"), "the Deal still marks the enemy (Triggered effect intact vs enemies)");
  assert.equal(hasMark(scratch, "Faustian Bargain"), false, "Faustian is consumed by the next Deal");
});

test("scratch4 CONTROL: without Faustian, an enemy Deal target DOES get the positive boon", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok);
  assert.ok(
    enemy.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === 10),
    "no Faustian -> the +10 boon applies to the enemy",
  );
});

test("scratch4: Triggered effect is NOT applied to an ALLY Deal target (positive still applies)", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([], [ally]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch4" }).ok);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["a"] }).ok);
  assert.ok(
    ally.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === 10),
    "the positive boon still applies to an ally under Faustian",
  );

  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);
  assert.equal(ally.hp, 100, "Faustian suppresses the 20 Affliction punishment against an ally");
});

test("scratch4 CONTROL: without Faustian, an ally who triggers the Deal IS punished", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([], [ally]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["a"] }).ok);
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);
  assert.equal(ally.hp, 80, "no Faustian -> the ally takes the 20 Affliction punishment");
});

// ===========================================================================
// scratch5 — Disarming Pitch
// ===========================================================================

test("scratch5: Scratch gains 10 Shield for 1 turn", () => {
  const { scratch, state } = setup();
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(
    scratch.shields.some((sh) => sh.amount === 10 && sh.duration === 1),
    "Disarming Pitch grants Scratch a 10 Shield for 1 turn",
  );
});

test("scratch5: an enemy who uses a new skill ON Scratch is Marked for 1 turn", () => {
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero",
    skills: [skill("poke", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const { state } = setup([enemy]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "poke", targets: ["s"] }).ok);

  assert.ok(
    enemy.statuses.some((s) => s.kind === "mark" && s.name === "Marked" && s.duration === 1),
    "an enemy who uses a skill on Scratch (during the window) is Marked for 1 turn",
  );
});

test("scratch5 CONTROL: an enemy skill NOT aimed at Scratch does not Mark", () => {
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero",
    skills: [skill("poke", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const other = makeUnit({ id: "o", team: "A", kind: "hero" });
  const { state } = setup([enemy], [other]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "poke", targets: ["o"] }).ok);

  assert.equal(
    enemy.statuses.some((s) => s.kind === "mark" && s.name === "Marked"), false,
    "a skill aimed at a different unit does not Mark the enemy",
  );
});

test("scratch5 CONTROL: without the Disarming Pitch window, hitting Scratch does not Mark", () => {
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero",
    skills: [skill("poke", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const { state } = setup([enemy]);
  // No scratch5 cast: no window active.
  assert.ok(performAction(state, { unit: "e", skillId: "poke", targets: ["s"] }).ok);
  assert.equal(
    enemy.statuses.some((s) => s.kind === "mark" && s.name === "Marked"), false,
    "no window -> no Mark",
  );
});

test("scratch5: Scratch's Deal skills may legally target a Marked enemy", () => {
  const enemy = makeUnit({
    id: "e", team: "B", kind: "hero",
    skills: [skill("poke", [{ op: "damage", amount: 5, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const { state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "poke", targets: ["s"] }).ok);
  assert.ok(hasMark(enemy, "Marked"), "precondition: the enemy is Marked");

  const r = performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] });
  assert.ok(r.ok, "a Deal legally applies to a Marked enemy Hero");
  assert.ok(hasMark(enemy, "Deal: Defeat Your Enemies"), "the Deal marks the Marked enemy");
});

// ===========================================================================
// scratch6 — Deal: Know Your Fate
// ===========================================================================

test("scratch6: target's skills have no cost for the duration", () => {
  const probeSkill = skill("probe", [], { cost: { generic: 2, specific: 2 } });
  const target = makeUnit({ id: "e", team: "B", kind: "hero", skills: [probeSkill] });
  const { state } = setup([target]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);
  assert.deepEqual(
    effectiveCost(target, probeSkill, state), { generic: 0, specific: 0 },
    "Know Your Fate makes the target's skills free",
  );
});

test("scratch6: target ignores harmful non-damage effects", () => {
  const prober = makeUnit({
    id: "p", team: "A", kind: "hero",
    skills: [skill("stunner", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { targeting: "single", tags: ["Harmful"] })],
  });
  const target = makeUnit({ id: "e", team: "B", kind: "hero" });
  const control = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const { state } = setup([target, control], [prober]);

  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);

  assert.ok(performAction(state, { unit: "p", skillId: "stunner", targets: ["e"] }).ok);
  assert.equal(target.statuses.some((s) => s.kind === "stun"), false, "the target ignores the enemy stun");

  assert.ok(performAction(state, { unit: "p", skillId: "stunner", targets: ["e2"] }).ok);
  assert.ok(control.statuses.some((s) => s.kind === "stun"), "CONTROL: an unprotected enemy is stunned");
});

test("scratch6: at the end of the 3-turn duration the target is killed", () => {
  const target = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);
  assert.ok(target.alive, "target is alive during the duration");

  // Advance well past the 3-turn window (mark ticks on Scratch's team turn-ends).
  for (let i = 0; i < 8; i++) endTurn(state);

  assert.equal(target.alive, false, "the target is killed when Know Your Fate's duration ends");
});
