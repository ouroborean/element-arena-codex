import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import { performAction, endTurn, effectiveCost } from "../src/scheduler.ts";
import { fusionForm, FUSIONS } from "../content/fusions.generated.ts";
import type { MatchState, Unit } from "../src/types.ts";

// =============================================================================
// Adversarial, SPEC-DERIVED suite for Mr. SCRATCH's FUSION FORM.
//
// STRUCTURAL FACT (spec-derived, from content/frozen/characters.json):
//   Mr. Scratch is authored with  "starts_fused": true, "can_fuse": false,
//   element = "devil", and an EMPTY "fusion_skills": {}.  Like Dennis, he has NO
//   menu of elemental fusion variants; he is PERMANENTLY fused into a single
//   Devil form. That one form's passive + actives ARE his fusion kit:
//     - fusion passive : scratch0  "The Devil's Price"
//     - fusion actives : scratch1..scratch6
//   (The generated FUSIONS table therefore contains ZERO "scratch" forms — the
//   heroes that own the ~10 elemental keys are the 20 fusible heroes, not Scratch.)
//
// Section 0 pins that spec fact as an executable guard. Sections 1..8 then treat
// Scratch's single permanent Devil form as THE fusion form and verify its passive
// + every active against the FROZEN prose (content/frozen/skills.json), the sole
// oracle. Authored/generated content is consulted ONLY for how to drive (ids,
// costs, element, status/mark names), never for what to assert.
//
// Frozen text under test (verbatim from skills.json):
//  scratch0 The Devil's Price (passive): "Whenever a target triggers one of
//    Scratch's Deal skills, Scratch gains Elemental Essence. When one of his Deal
//    skills expires without being triggered, its target gains Elemental Essence."
//  scratch1 Deal: Defeat Your Enemies (Helpful, gen 1): "Target Hero deals 10 more
//    non-Affliction damage for 1 turn. If they use a new skill, that Hero will
//    receive 20 Affliction damage."
//  scratch2 Deal: Save Your Friends (Helpful, gen 1, cd 1): "For 1 turn, target
//    Hero's next Helpful skill will heal its targets for 15 HP and make them
//    Invulnerable for 1 turn. If they use a new skill, this effect will end and
//    that Hero will be permanently Isolated."
//  scratch3 Deal: Realize Your Potential (Helpful, spec 1, cd 1): "Until the end of
//    their next turn, Target Hero's skills cost 1 less Specific and 1 less Generic
//    energy. If they use a new skill, they will be stunned for 1 turn."
//  scratch4 Faustian Bargain (Strategic self, gen 1, cd 2): "Scratch's next deal
//    will not apply its positive effect to enemies, and will not apply its
//    Triggered effect to allies."
//  scratch5 Disarming Pitch (Strategic self, gen 1, cd 1): "For 1 turn, Scratch
//    gains 10 Shield and any enemy who users a new skill on him will be marked for
//    1 turn. Scratch's Deal skills always apply to marked Heroes."
//  scratch6 Deal: Know Your Fate (Helpful, spec 3, cd 5): "For 3 turns, target Hero
//    ignores non-damage effects and their skills have no cost. At the end of this
//    duration, that Hero is killed."
//
// Scratch's element is "devil"; his Specific cost is paid in devil.
// =============================================================================

const ENERGY = () => ({ generic: 40, devil: 40 });
const essence = (u: Unit): number => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const hasMark = (u: Unit, name: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === name);

// A harmless self-cast "new skill" a marked hero can use to trigger a Deal.
const noopSelf = () => skill("noop", [], { targeting: "self", tags: ["Strategic"] });
// A 10-normal Harmful hit (so we can observe the +10 boon on a dealer).
const hit10 = () =>
  skill("hit", [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], { targeting: "single", tags: ["Harmful"] });

function setup(bExtra: Unit[] = [], aExtra: Unit[] = []): { scratch: Unit; state: MatchState } {
  const scratch = loadHero(heroById("scratch"), "A", "s");
  const state = makeState([scratch, ...aExtra], bExtra);
  state.teams.A.energy = ENERGY();
  state.teams.B.energy = ENERGY();
  return { scratch, state };
}

// =============================================================================
// Section 0 — SPEC GUARD: Scratch is permanently fused and has NO elemental forms.
// Oracle: frozen characters.json (starts_fused:true, can_fuse:false, empty
// fusion_skills). The generated fusion table must therefore expose ZERO "scratch"
// forms, and every element key any hero uses must return undefined for "scratch".
// =============================================================================
test("scratch SPEC: frozen roster marks Scratch permanently fused / non-fusing (Devil)", () => {
  const chars = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../content/frozen/characters.json", import.meta.url)), "utf8"),
  ) as any[];
  const arr: any[] = Array.isArray(chars) ? chars : Object.values(chars);
  const sc = arr.find((c) => c.id === "scratch");
  assert.ok(sc, "Scratch is in the frozen roster");
  assert.equal(sc.starts_fused, true, "frozen: Scratch starts fused");
  assert.equal(sc.can_fuse, false, "frozen: Scratch cannot fuse into other elements");
  assert.equal(sc.element.name, "devil", "frozen: Scratch's permanent form is the Devil element");
  assert.equal(Object.keys(sc.fusion_skills ?? {}).length, 0, "frozen: Scratch has no elemental fusion variants");
});

test("scratch SPEC: no elemental fusion FORMS exist for Scratch (can_fuse:false honored by the engine)", () => {
  const scratchForms = FUSIONS.filter((f) => f.hero === "scratch");
  assert.equal(scratchForms.length, 0, "the generated fusion table contains no Scratch forms");
  const allKeys = [...new Set(FUSIONS.map((f) => f.key))];
  assert.ok(allKeys.length > 0, "there ARE fusion keys (owned by the 20 fusible heroes)");
  for (const key of allKeys) {
    assert.equal(fusionForm("scratch", key), undefined, `Scratch must have no '${key}' fusion form`);
  }
});

test("scratch SPEC: the loaded permanent form is elementally Devil (drives Specific cost)", () => {
  const { scratch } = setup();
  assert.equal(scratch.currentElement, "devil", "Scratch is loaded in his permanent Devil element");
});

// =============================================================================
// Section 1 — FUSION PASSIVE: scratch0 "The Devil's Price"
//   "Whenever a target triggers one of Scratch's Deal skills, Scratch gains
//    Elemental Essence. When one of his Deal skills expires without being
//    triggered, its target gains Elemental Essence."
// =============================================================================

// Clause A: a target TRIGGERING a Deal grants SCRATCH an Elemental Essence.
test("scratch0 A: a target triggering a Deal (Defeat) grants Scratch one Elemental Essence", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.equal(essence(scratch), 0);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok); // uses a new skill -> triggers
  assert.equal(essence(scratch), 1, "Scratch gains 1 Elemental Essence when his Deal is triggered");
});

// Clause A across MULTIPLE concurrent Deals: each target independently triggers ITS Deal, and
// Scratch "gains Elemental Essence". (The frozen prose does not specify that Essence CHARGES
// accumulate to a count — Elemental Essence is a one-shot income-swap charge — so we assert only
// that both Deals fire their own trigger effect and that Scratch holds an Essence charge.)
test("scratch0 A: two concurrent Deals each independently trigger; Scratch gains Elemental Essence", () => {
  const t1 = makeUnit({ id: "t1", team: "B", kind: "hero", skills: [noopSelf()] });
  const t2 = makeUnit({ id: "t2", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([t1, t2]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t1"] }).ok); // Defeat on t1
  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["t2"] }).ok); // Realize on t2
  assert.ok(performAction(state, { unit: "t1", skillId: "noop" }).ok); // t1 triggers Defeat
  assert.ok(performAction(state, { unit: "t2", skillId: "noop" }).ok); // t2 triggers Realize
  assert.equal(t1.hp, 80, "t1's Defeat trigger fired: 20 Affliction");
  assert.ok(t2.statuses.some((s) => s.kind === "stun"), "t2's Realize trigger fired: Stun");
  assert.ok(essence(scratch) >= 1, "Scratch gained an Elemental Essence charge from the trigger(s)");
});

// Clause A specificity: a NON-Deal reaction firing does NOT grant Scratch Essence.
test("scratch0 A CONTROL: triggering a NON-Deal effect (Disarming Pitch mark) grants Scratch NO Essence", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [hit10()] });
  const { scratch, state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok); // Disarming Pitch (NOT a Deal)
  assert.ok(performAction(state, { unit: "e", skillId: "hit", targets: ["s"] }).ok); // enemy hits Scratch -> Marked
  assert.ok(hasMark(enemy, "Marked"), "precondition: the Disarming-Pitch mark landed");
  assert.equal(essence(scratch), 0, "a non-Deal reaction grants Scratch no Essence (Deal-skills only)");
});

// Clause B: a Deal that EXPIRES UNTRIGGERED grants its TARGET Essence (not Scratch).
test("scratch0 B: an untriggered Deal expiring grants its TARGET one Essence (Scratch gets none)", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);
  // Let the 1-turn Deal mark lapse without the target acting.
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(hasMark(target, "Deal: Defeat Your Enemies"), false, "the Deal mark expired");
  assert.equal(essence(target), 1, "untriggered expiry grants the TARGET one Elemental Essence");
  assert.equal(essence(scratch), 0, "an UNtriggered Deal grants Scratch no Essence");
});

// Clause B "without being triggered": a Deal that WAS triggered must NOT ALSO grant its target Essence.
test("scratch0 B: a TRIGGERED Deal does NOT later grant its target Essence (only Scratch was rewarded)", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok); // triggers -> consumes the mark
  assert.equal(essence(scratch), 1, "trigger rewarded Scratch");
  endTurn(state); endTurn(state); endTurn(state); // no untriggered-expiry left to fire
  assert.equal(essence(target), 0, "a Deal consumed by a trigger never grants the target Essence");
});

// =============================================================================
// Section 2 — FUSION ACTIVE: scratch1 "Deal: Defeat Your Enemies"
//   "Target Hero deals 10 more non-Affliction damage for 1 turn. If they use a new
//    skill, that Hero will receive 20 Affliction damage."
// =============================================================================
test("scratch1: boon — target deals +10 NON-Affliction damage for 1 turn", () => {
  const dealer = makeUnit({ id: "d", team: "B", kind: "hero", skills: [hit10()] });
  const victim = makeUnit({ id: "v", team: "B", kind: "hero" });
  const { state } = setup([dealer, victim]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["d"] }).ok);
  assert.ok(performAction(state, { unit: "d", skillId: "hit", targets: ["v"] }).ok);
  assert.equal(victim.hp, 80, "10 base + 10 boon = 20 to the victim");
});

test("scratch1 CONTROL: the +10 boon does NOT apply to Affliction damage", () => {
  const dealer = makeUnit({
    id: "d", team: "B", kind: "hero",
    skills: [skill("afflict", [{ op: "damage", amount: 10, dtype: "affliction", to: "target" }], { targeting: "single", tags: ["Harmful"] })],
  });
  const victim = makeUnit({ id: "v", team: "B", kind: "hero" });
  const { state } = setup([dealer, victim]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["d"] }).ok);
  assert.ok(performAction(state, { unit: "d", skillId: "afflict", targets: ["v"] }).ok);
  assert.equal(victim.hp, 90, "Affliction damage is unaffected by the non-Affliction boon");
});

test("scratch1: trigger — a marked hero using a new skill receives 20 Affliction; Scratch gains Essence", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] }).ok);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);
  assert.equal(target.hp, 80, "20 Affliction to the hero who used a new skill");
  assert.equal(essence(scratch), 1, "the trigger grants Scratch Essence (passive)");
});

test("scratch1 CONTROL: an UNmarked hero using a skill takes no 20 Affliction", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([target]);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);
  assert.equal(target.hp, 100, "no Deal mark -> no 20 Affliction punishment");
});

// Combined: boon and trigger both bind to the SAME offending skill use — the buffed
// dealer's attack is boosted (+10) AND the dealer is punished (20 Affliction).
test("scratch1: a buffed dealer who attacks gets BOTH the +10 boost AND the 20 Affliction punishment", () => {
  const dealer = makeUnit({ id: "d", team: "B", kind: "hero", skills: [hit10()] });
  const victim = makeUnit({ id: "v", team: "B", kind: "hero" });
  const { scratch, state } = setup([dealer, victim]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["d"] }).ok);
  assert.ok(performAction(state, { unit: "d", skillId: "hit", targets: ["v"] }).ok);
  assert.equal(victim.hp, 80, "the boosted hit dealt 20 to the victim");
  assert.equal(dealer.hp, 80, "the dealer 'used a new skill' -> takes 20 Affliction");
  assert.equal(essence(scratch), 1, "and the trigger grants Scratch Essence");
});

// =============================================================================
// Section 3 — FUSION ACTIVE: scratch2 "Deal: Save Your Friends"
//   "For 1 turn, target Hero's next Helpful skill will heal its targets for 15 HP
//    and make them Invulnerable for 1 turn. If they use a new skill, this effect
//    will end and that Hero will be permanently Isolated."
// =============================================================================
test("scratch2: boon — the target's next HELPFUL skill heals its targets 15 HP + Invulnerable 1 turn", () => {
  const recipient = makeUnit({ id: "r", team: "A", kind: "hero", hp: 50 });
  const helper = makeUnit({ id: "h", team: "A", kind: "hero", skills: [skill("help", [], { targeting: "single", tags: ["Helpful"] })] });
  const { scratch, state } = setup([], [helper, recipient]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  assert.ok(performAction(state, { unit: "h", skillId: "help", targets: ["r"] }).ok);
  assert.equal(recipient.hp, 65, "the Helpful skill's target is healed 15 HP");
  assert.ok(
    recipient.statuses.some((s) => s.kind === "invulnerable" && s.duration === 1),
    "the Helpful skill's target is made Invulnerable for 1 turn",
  );
  assert.equal(essence(scratch), 1, "consuming the boon is a trigger -> Scratch gains Essence");
});

test("scratch2: trigger — using a new (non-Helpful) skill ends the effect and permanently Isolates the hero", () => {
  const helper = makeUnit({ id: "h", team: "A", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([], [helper]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  assert.ok(performAction(state, { unit: "h", skillId: "noop" }).ok);
  assert.ok(
    helper.statuses.some((s) => s.kind === "isolated" && s.duration === null),
    "the hero is PERMANENTLY Isolated (duration null)",
  );
  assert.equal(essence(scratch), 1, "the trigger grants Scratch Essence");
});

test("scratch2 CONTROL: a NON-Helpful skill gets no heal/Invuln boon (only the Isolate)", () => {
  const recipient = makeUnit({ id: "r", team: "A", kind: "hero", hp: 50 });
  const helper = makeUnit({ id: "h", team: "A", kind: "hero", skills: [skill("strat", [], { targeting: "single", tags: ["Strategic"] })] });
  const { state } = setup([], [helper, recipient]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  assert.ok(performAction(state, { unit: "h", skillId: "strat", targets: ["r"] }).ok);
  assert.equal(recipient.hp, 50, "a non-Helpful skill does NOT heal");
  assert.equal(recipient.statuses.some((s) => s.kind === "invulnerable"), false, "no Invulnerable from a non-Helpful skill");
  assert.ok(helper.statuses.some((s) => s.kind === "isolated"), "using any new skill still Isolates the hero");
});

test("scratch2: untriggered expiry grants the target Essence and NEVER Isolates", () => {
  const helper = makeUnit({ id: "h", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([], [helper]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["h"] }).ok);
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(essence(helper), 1, "untriggered expiry grants the target Essence");
  assert.equal(helper.statuses.some((s) => s.kind === "isolated"), false, "an untriggered Deal never Isolates");
});

// =============================================================================
// Section 4 — FUSION ACTIVE: scratch3 "Deal: Realize Your Potential"
//   "Until the end of their next turn, Target Hero's skills cost 1 less Specific
//    and 1 less Generic energy. If they use a new skill, they will be stunned for
//    1 turn."
// =============================================================================
test("scratch3: boon — the target's skills cost 1 less Generic AND 1 less Specific", () => {
  const probe = skill("probe", [], { cost: { generic: 2, specific: 2 } });
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [probe] });
  const { state } = setup([target]);
  assert.deepEqual(effectiveCost(target, probe, state), { generic: 2, specific: 2 }, "control: unmarked cost unchanged");
  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["t"] }).ok);
  assert.deepEqual(effectiveCost(target, probe, state), { generic: 1, specific: 1 }, "boon discounts 1 Generic AND 1 Specific");
});

test("scratch3: trigger — a marked hero using a new skill is Stunned 1 turn; Scratch gains Essence", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["t"] }).ok);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);
  assert.ok(target.statuses.some((s) => s.kind === "stun" && s.duration === 1), "the marked hero is Stunned for 1 turn");
  assert.equal(essence(scratch), 1, "the trigger grants Scratch Essence");
});

test("scratch3 CONTROL: an unmarked hero using a skill is not Stunned", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([target]);
  assert.ok(performAction(state, { unit: "t", skillId: "noop" }).ok);
  assert.equal(target.statuses.some((s) => s.kind === "stun"), false, "no Deal mark -> no stun");
});

test("scratch3: untriggered expiry grants the TARGET Essence (Deal economy)", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch3", targets: ["t"] }).ok);
  endTurn(state); endTurn(state); endTurn(state);
  assert.equal(essence(target), 1, "untriggered expiry grants the target Essence");
  assert.equal(essence(scratch), 0, "Scratch gains none from an untriggered Deal");
});

// =============================================================================
// Section 5 — FUSION ACTIVE: scratch4 "Faustian Bargain"
//   "Scratch's next deal will not apply its positive effect to enemies, and will
//    not apply its Triggered effect to allies."
// =============================================================================
test("scratch4: an ENEMY Deal target gets NO positive effect (but the Deal still marks / triggers)", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [noopSelf()] });
  const { scratch, state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch4" }).ok);
  assert.ok(hasMark(scratch, "Faustian Bargain"), "Faustian mark set on Scratch");
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok);
  assert.equal(
    enemy.statuses.some((s) => s.kind === "outgoing_damage_mod"), false,
    "Faustian suppresses the +10 positive boon on an enemy",
  );
  assert.ok(hasMark(enemy, "Deal: Defeat Your Enemies"), "the Triggered effect (mark) still applies vs an enemy");
  assert.equal(hasMark(scratch, "Faustian Bargain"), false, "Faustian is consumed by the next Deal");
});

test("scratch4 CONTROL: without Faustian, an enemy Deal target DOES get the +10 positive boon", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] }).ok);
  assert.ok(
    enemy.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.magnitude === 10),
    "no Faustian -> the +10 boon applies to the enemy",
  );
});

test("scratch4: an ALLY Deal target gets NO Triggered effect (positive still applies)", () => {
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

test("scratch4 CONTROL: without Faustian, an ally who triggers the Deal IS punished (20 Affliction)", () => {
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", skills: [noopSelf()] });
  const { state } = setup([], [ally]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["a"] }).ok);
  assert.ok(performAction(state, { unit: "a", skillId: "noop" }).ok);
  assert.equal(ally.hp, 80, "no Faustian -> the ally takes the 20 Affliction punishment");
});

// =============================================================================
// Section 6 — FUSION ACTIVE: scratch5 "Disarming Pitch"
//   "For 1 turn, Scratch gains 10 Shield and any enemy who users a new skill on him
//    will be marked for 1 turn. Scratch's Deal skills always apply to marked Heroes."
// =============================================================================
test("scratch5: Scratch gains a 10 Shield for 1 turn", () => {
  const { scratch, state } = setup();
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(scratch.shields.some((sh) => sh.amount === 10 && sh.duration === 1), "10 Shield for 1 turn");
});

test("scratch5: an enemy who uses a new skill ON Scratch is Marked for 1 turn", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [hit10()] });
  const { state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "hit", targets: ["s"] }).ok);
  assert.ok(
    enemy.statuses.some((s) => s.kind === "mark" && s.name === "Marked" && s.duration === 1),
    "an enemy who used a skill on Scratch is Marked for 1 turn",
  );
});

test("scratch5 CONTROL: an enemy skill NOT aimed at Scratch does not Mark", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [hit10()] });
  const other = makeUnit({ id: "o", team: "A", kind: "hero" });
  const { state } = setup([enemy], [other]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "hit", targets: ["o"] }).ok);
  assert.equal(enemy.statuses.some((s) => s.kind === "mark" && s.name === "Marked"), false, "a skill not aimed at Scratch does not Mark");
});

test("scratch5 CONTROL: without the window, hitting Scratch does not Mark", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [hit10()] });
  const { state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "e", skillId: "hit", targets: ["s"] }).ok); // no scratch5 cast
  assert.equal(enemy.statuses.some((s) => s.kind === "mark" && s.name === "Marked"), false, "no window -> no Mark");
});

test("scratch5: Scratch's Deal legally applies to a Marked enemy Hero", () => {
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", skills: [hit10()] });
  const { state } = setup([enemy]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch5" }).ok);
  assert.ok(performAction(state, { unit: "e", skillId: "hit", targets: ["s"] }).ok);
  assert.ok(hasMark(enemy, "Marked"), "precondition: the enemy is Marked");
  const r = performAction(state, { unit: "s", skillId: "scratch1", targets: ["e"] });
  assert.ok(r.ok, "a Deal legally applies to a Marked enemy Hero");
  assert.ok(hasMark(enemy, "Deal: Defeat Your Enemies"), "the Deal marks the Marked enemy");
});

// =============================================================================
// Section 7 — FUSION ACTIVE: scratch6 "Deal: Know Your Fate"
//   "For 3 turns, target Hero ignores non-damage effects and their skills have no
//    cost. At the end of this duration, that Hero is killed."
// =============================================================================
test("scratch6: the target's skills have NO cost for the duration", () => {
  const probe = skill("probe", [], { cost: { generic: 2, specific: 2 } });
  const target = makeUnit({ id: "e", team: "B", kind: "hero", skills: [probe] });
  const { state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);
  assert.deepEqual(effectiveCost(target, probe, state), { generic: 0, specific: 0 }, "Know Your Fate makes the target's skills free");
});

test("scratch6: the target IGNORES incoming non-damage effects (a stun does not land)", () => {
  const prober = makeUnit({
    id: "p", team: "A", kind: "hero",
    skills: [skill("stunner", [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { targeting: "single", tags: ["Harmful"] })],
  });
  const target = makeUnit({ id: "e", team: "B", kind: "hero" });
  const control = makeUnit({ id: "e2", team: "B", kind: "hero" });
  const { state } = setup([target, control], [prober]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);
  assert.ok(performAction(state, { unit: "p", skillId: "stunner", targets: ["e"] }).ok);
  assert.equal(target.statuses.some((s) => s.kind === "stun"), false, "the protected target ignores the stun");
  assert.ok(performAction(state, { unit: "p", skillId: "stunner", targets: ["e2"] }).ok);
  assert.ok(control.statuses.some((s) => s.kind === "stun"), "CONTROL: an unprotected enemy IS stunned");
});

test("scratch6: at the end of the 3-turn duration the target is killed", () => {
  const target = makeUnit({ id: "e", team: "B", kind: "hero" });
  const { state } = setup([target]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);
  assert.ok(target.alive, "target is alive during the duration");
  for (let i = 0; i < 8; i++) endTurn(state);
  assert.equal(target.alive, false, "the target is killed when Know Your Fate's duration ends");
});

// =============================================================================
// Section 8 — Cost / cooldown / legality (from the frozen skill definitions)
// =============================================================================
test("scratch3 pays its Specific cost from Scratch's own element (devil)", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const scratch = loadHero(heroById("scratch"), "A", "s");
  const state = makeState([scratch], [target]);
  state.teams.A.energy = { devil: 1 }; // exactly one devil, no generic
  const r = performAction(state, { unit: "s", skillId: "scratch3", targets: ["t"] });
  assert.equal(r.ok, true, "the 1 Specific is payable from the devil pool");
  assert.equal(state.teams.A.energy.devil ?? 0, 0, "the devil was spent");
});

test("scratch1 is rejected for insufficient energy when the pool cannot pay its 1 Generic", () => {
  const target = makeUnit({ id: "t", team: "B", kind: "hero", skills: [noopSelf()] });
  const scratch = loadHero(heroById("scratch"), "A", "s");
  const state = makeState([scratch], [target]);
  state.teams.A.energy = {};
  const r = performAction(state, { unit: "s", skillId: "scratch1", targets: ["t"] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "insufficient-energy");
});

test("scratch4 goes on a 2-turn cooldown per frozen; scratch6 on a 5-turn cooldown", () => {
  const { scratch, state } = setup([makeUnit({ id: "e", team: "B", kind: "hero" })]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch4" }).ok);
  assert.equal(scratch.skills!.find((k) => k.id === "scratch4")!.currentCd, 2, "Faustian Bargain cooldown 2");
  assert.ok(performAction(state, { unit: "s", skillId: "scratch6", targets: ["e"] }).ok);
  assert.equal(scratch.skills!.find((k) => k.id === "scratch6")!.currentCd, 5, "Know Your Fate cooldown 5");
});

test("scratch1 has no cooldown (recastable) while scratch2 goes on a 1-turn cooldown", () => {
  const t1 = makeUnit({ id: "t1", team: "B", kind: "hero" });
  const t2 = makeUnit({ id: "t2", team: "B", kind: "hero" });
  const a1 = makeUnit({ id: "a1", team: "A", kind: "hero" });
  const { scratch, state } = setup([t1, t2], [a1]);
  assert.ok(performAction(state, { unit: "s", skillId: "scratch1", targets: ["t1"] }).ok);
  assert.equal(scratch.skills!.find((k) => k.id === "scratch1")!.currentCd, 0, "Defeat Your Enemies cooldown 0");
  const again = performAction(state, { unit: "s", skillId: "scratch1", targets: ["t2"] });
  assert.equal(again.ok, true, "cooldown-0 Deal is recastable the same turn");
  assert.ok(performAction(state, { unit: "s", skillId: "scratch2", targets: ["a1"] }).ok);
  assert.equal(scratch.skills!.find((k) => k.id === "scratch2")!.currentCd, 1, "Save Your Friends cooldown 1");
});
