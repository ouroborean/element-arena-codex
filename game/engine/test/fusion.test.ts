import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFusion, canFuse, type FusionForm } from "../content/fusion.ts";
import { applyAugment } from "../content/augment.ts";
import { loadHero } from "../content/hero.ts";
import { buildMatch, defaultPolicy, heroById, playMatch } from "../content/match.ts";
import { performAction, startRound } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyStatus } from "../src/status.ts";
import { addShield } from "../src/damage.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// A minimal non-mechanic Syl fusion (replace mode) that does NOT re-declare essence — used to prove the
// base "Two as One" essence gain survives fusion via the innate origin.
const SYL_CLOUD: FusionForm = {
  key: "cloud", hero: "syl", element: "cloud",
  passive: { name: "Great Roc", description: "" },
  passiveTriggers: [{ on: "roundStart", source: "Great Roc", effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Great Roc", duration: null } }] }],
  skill: skill("sylcloud1", [], { name: "Sky Drop", targeting: "single", tags: ["Harmful"] }),
};
const sylEssence = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const eagleOf = (id: string) => makeUnit({ id: `${id}:eagle`, team: "A", kind: "minion", name: "Hatchling Eagle", summoner: id });

test("fused Syl (non-mechanic) keeps Two as One: Syl + Eagle acting the same turn grants Essence", () => {
  const syl = loadHero(heroById("syl"), "A", "s1");
  applyFusion(syl, SYL_CLOUD);
  const st = makeState([syl, eagleOf("s1")], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "skillUsed", caster: "s1", skillId: "syl2", targets: [], tags: [] });
  assert.equal(sylEssence(syl), 0, "no essence yet — the Eagle hasn't acted");
  emit(st, { type: "skillUsed", caster: "s1:eagle", skillId: "sylminion1", targets: [], tags: [] });
  assert.ok(sylEssence(syl) >= 1, "essence granted once both acted (Two as One survived fusion)");
});

test("Two as One base essence is suppressed while syl:mechanic's Aerie override + shield both hold (no double)", () => {
  const syl = loadHero(heroById("syl"), "A", "s1");
  applyStatus(syl, status("mark", { name: "Aerie Essence Override", duration: null, appliedBy: "s1", appliedTurn: 0 }));
  addShield(syl, 25, null, "s1", 0);
  const st = makeState([syl, eagleOf("s1")], [makeUnit({ id: "e", team: "B" })]);
  emit(st, { type: "skillUsed", caster: "s1", skillId: "syl2", targets: [], tags: [] });
  emit(st, { type: "skillUsed", caster: "s1:eagle", skillId: "sylminion1", targets: [], tags: [] });
  assert.equal(sylEssence(syl), 0, "base grant suppressed — The Aerie owns essence while shielded");
});

test("Two as One base essence resumes once the Aerie shield breaks (override mark alone does not suppress)", () => {
  const syl = loadHero(heroById("syl"), "A", "s1");
  applyStatus(syl, status("mark", { name: "Aerie Essence Override", duration: null, appliedBy: "s1", appliedTurn: 0 }));
  const st = makeState([syl, eagleOf("s1")], [makeUnit({ id: "e", team: "B" })]); // no shield (broken)
  emit(st, { type: "skillUsed", caster: "s1", skillId: "syl2", targets: [], tags: [] });
  emit(st, { type: "skillUsed", caster: "s1:eagle", skillId: "sylminion1", targets: [], tags: [] });
  assert.ok(sylEssence(syl) >= 1, "base same-turn grant resumes when the shield is down");
});

// Ando's "storm" fusion, transcribed from the frozen prose:
//   passive (andostorm0): "Ando is permanently Blinded, but deals 10 Piercing to an additional
//     random target whenever he uses a Harmful skill."
//   active  (andostorm1): "Ando deals 15 damage to a random enemy. For the next 3 turns he will
//     repeat this damage on another random target."
const STORM: FusionForm = {
  key: "storm",
  hero: "ando",
  element: "storm",
  passive: { name: "Storm", description: "Ando is permanently Blinded, but deals 10 Piercing to an additional random target whenever he uses a Harmful skill." },
  passiveTriggers: [
    { on: "roundStart", source: "Storm", effect: [{ op: "applyStatus", to: "self", status: { kind: "blind", duration: null } }] },
    { on: "skillUsed", source: "Storm", when: { sameUnit: ["eventSource", "self"] }, effect: [{ op: "damage", amount: 10, dtype: "piercing", to: { pick: "random", from: { faction: "enemies" }, count: 1 } }] },
  ],
  skill: skill("andostorm1", [{ op: "damage", amount: 15, to: { pick: "random", from: { faction: "enemies" }, count: 1 } }], { name: "Storm Surge", targeting: "none", tags: ["Harmful"], cost: { generic: 1, specific: 0 } }),
};

function ando(): Unit {
  return loadHero(heroById("ando"), "A", "a1");
}

test("fusion re-elements, inserts the fusion skill at the 4th slot, and keeps the base kit", () => {
  const a = ando();
  const baseCount = (a.skills ?? []).length;
  assert.ok(canFuse(a), "an un-fused hero can fuse");

  applyFusion(a, STORM);

  assert.equal(a.currentElement, "storm", "re-elemented");
  assert.equal(a.baseElement, heroById("ando").element, "base element preserved");
  assert.equal((a.skills ?? []).length, baseCount + 1, "gained one skill");
  assert.equal(a.skills![3]!.id, "andostorm1", "fusion skill lands in the 4th slot (index 3)");
  assert.equal(a.skills![baseCount]!.id, heroById("ando").skills[baseCount - 1]!.id, "the ultimate is still last");
  assert.equal(a.fused, "storm");
});

test("fusion is once per match", () => {
  const a = ando();
  applyFusion(a, STORM);
  assert.ok(!canFuse(a), "a fused hero cannot fuse again");
  assert.throws(() => applyFusion(a, STORM), /already fused/);
});

test("the fusion passive replaces the base passive's triggers", () => {
  const a = ando();
  const baseSources = new Set((a.triggers ?? []).map((t) => t.source));
  applyFusion(a, STORM);
  const sources = new Set((a.triggers ?? []).map((t) => t.source));
  assert.ok(sources.has("Storm"), "fusion triggers installed");
  assert.ok(!(a.triggers ?? []).some((t) => baseSources.has(t.source) && t.source !== "Storm"), "base passive triggers gone");
  assert.ok((a.triggers ?? []).every((t) => t.owner === "a1"), "triggers re-owned to the unit");
});

test("fusing after augmenting keeps the augment's triggers, drops only the base passive's", () => {
  const a = ando();
  const baseSources = new Set((a.triggers ?? []).map((t) => t.source));
  // Round 1: an augment adds a persistent trigger.
  applyAugment(a, { id: "andoX", name: "X", description: "", patches: [
    { op: "addTrigger", trigger: { on: "turnStart", source: "AugKeep", effect: [{ op: "heal", amount: 3, to: "self" }] } },
  ] });
  // Round 2: the hero fuses (default replace).
  applyFusion(a, STORM);

  assert.ok((a.triggers ?? []).some((t) => t.source === "AugKeep"), "the augment trigger survives fusion");
  assert.ok((a.triggers ?? []).some((t) => t.source === "Storm"), "the fusion passive is installed");
  assert.ok(!(a.triggers ?? []).some((t) => baseSources.has(t.source)), "the base passive's triggers are gone");
});

test("Syl's innate Eagle-summon trigger survives fusion (replace mode) and the Eagle summons each round", () => {
  const syl = loadHero(heroById("syl"), "A", "s1");
  const CLOUD: FusionForm = {
    key: "cloud", hero: "syl", element: "cloud",
    passive: { name: "Great Roc", description: "" },
    // a fusion passive that does NOT re-summon the Eagle (relies on the innate base summon persisting)
    passiveTriggers: [{ on: "roundStart", source: "Great Roc", effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Great Roc", duration: null } }] }],
    skill: skill("sylcloud1", [], { name: "Sky Drop", targeting: "single", tags: ["Harmful"] }),
  };
  applyFusion(syl, CLOUD);
  assert.ok((syl.triggers ?? []).some((t) => t.source === "Two as One" && t.on === "roundStart"), "the innate Eagle-summon trigger survived fusion");
  assert.ok((syl.triggers ?? []).some((t) => t.source === "Great Roc"), "the fusion passive is installed");
  const state = makeState([syl], [{ ...loadHero(heroById("pyrrha"), "B", "b1"), hp: 100 }]);
  startRound(state, "A");
  assert.ok(Object.values(state.units).some((u) => u.kind === "minion" && u.name === "Hatchling Eagle" && u.summoner === "s1"), "the Hatchling Eagle summoned for the fused Syl");
});

test("Leyline Nest's cost triggers are innate: they survive fusion so a fused (non-storm) Syl keeps decay + reset", () => {
  const syl = loadHero(heroById("syl"), "A", "s1");
  const CLOUD: FusionForm = {
    key: "cloud", hero: "syl", element: "cloud",
    passive: { name: "Great Roc", description: "" },
    passiveTriggers: [{ on: "roundStart", source: "Great Roc", effect: [{ op: "applyStatus", to: "self", status: { kind: "mark", name: "Great Roc", duration: null } }] }],
    skill: skill("sylcloud1", [], { name: "Sky Drop", targeting: "single", tags: ["Harmful"] }),
  };
  applyFusion(syl, CLOUD);
  const leyline = (syl.triggers ?? []).filter((t) => t.source === "Leyline Nest");
  assert.ok(leyline.some((t) => t.on === "turnStart"), "the per-turn cost decay survived fusion");
  assert.ok(leyline.some((t) => t.on === "skillUsed"), "the cost reset-on-use survived fusion");
});

test("a fused Ando plays: round-start Blind lands, and Storm Surge damages a random enemy", () => {
  const a = ando();
  applyFusion(a, STORM);
  const state = makeState([a], [
    { ...loadHero(heroById("pyrrha"), "B", "b1"), hp: 100 },
    { ...loadHero(heroById("gaia"), "B", "b2"), hp: 100 },
  ]);
  startRound(state); // fires the Storm passive's roundStart → Blind on Ando
  assert.ok(a.statuses.some((s) => s.kind === "blind"), "permanently Blinded by the fusion passive");

  state.teams.A.energy = { generic: 5 };
  const before = (state.units.b1!.hp) + (state.units.b2!.hp);
  const r = performAction(state, { unit: "a1", skillId: "andostorm1" });
  assert.equal(r.ok, true, "the new fusion skill is usable");
  const after = (state.units.b1!.hp) + (state.units.b2!.hp);
  assert.ok(after < before, "Storm Surge dealt damage to a random enemy");
});

test("a between-round fusion persists through the next fresh battle (survives startRound reset)", () => {
  const state = buildMatch({ A: ["ando", "gaia", "roland"], B: ["pyrrha", "jarrik", "sera"], seed: 5 });
  let fusedOnce = false;
  const outcome = playMatch(state, defaultPolicy, {
    roundsToWin: 2,
    maxTurns: 500,
    onBetweenRounds: (s) => {
      const ando = s.units.a1!;
      if (!fusedOnce && canFuse(ando)) { applyFusion(ando, STORM); fusedOnce = true; }
    },
  });
  assert.ok(fusedOnce, "the between-round hook fired at least once");
  const ando = state.units.a1!;
  assert.equal(ando.fused, "storm", "the fusion flag persisted to match end");
  assert.equal(ando.currentElement, "storm", "the re-element survived every subsequent startRound");
  assert.ok((ando.skills ?? []).some((sk) => sk.id === "andostorm1"), "the fusion skill persisted across rounds");
  assert.ok(outcome.winner !== null, "the match still resolved");
});
