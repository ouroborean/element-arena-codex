import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatch } from "../content/match.ts";
import { startRound } from "../src/scheduler.ts";
import { resolveSelector, runEffects } from "../src/effects/interpret.ts";
import { Rng } from "../src/rng.ts";
import type { Unit } from "../src/types.ts";

// Engine-fidelity — Dennis "Second-Rate Copy" Part A: "If Hector the Injector is on this Hero's team,
// Hector's passive won't create a minion at the start of the round, and all of Hector's skills that refer
// to Dennis will refer to this Hero instead." Encoded via Unit.understudyFor: buildMatch tags hero-Dennis as
// standing in for the "Dennis the Apprentice" minion template, and resolveSelector admits it for any selector
// naming that exact template (so Hector's count-guarded summon is suppressed and his Dennis-refs retarget).

const byHero = (state: ReturnType<typeof buildMatch>, heroId: string): Unit =>
  Object.values(state.units).find((u) => u.heroId === heroId)!;

const apprenticeMinions = (state: ReturnType<typeof buildMatch>): Unit[] =>
  Object.values(state.units).filter((u) => u.kind === "minion" && u.name === "Dennis the Apprentice");

test("Part A: a hero Dennis on Hector's team is tagged as the understudy and suppresses Hector's summon", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 1 });
  assert.equal(byHero(state, "dennis").understudyFor, "Dennis the Apprentice", "hero-Dennis stands in for the minion");

  startRound(state); // Hector's roundStart summon fires here; the count guard now sees hero-Dennis
  assert.equal(apprenticeMinions(state).length, 0, "Hector does NOT summon the Dennis minion while hero-Dennis is on the team");
});

test("Part A: without a hero Dennis, Hector still summons his Dennis minion as normal", () => {
  const state = buildMatch({ A: ["hector", "saya", "gaia"], B: ["roland", "sera", "ando"], seed: 1 });
  assert.equal(byHero(state, "hector").understudyFor, undefined, "no understudy tagged");
  startRound(state);
  assert.equal(apprenticeMinions(state).length, 1, "no hero-Dennis → the minion is summoned");
});

test("Part A: a Dennis-template selector retargets onto hero-Dennis; a blanket minion selector does not", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 1 });
  const hector = byHero(state, "hector");
  const dennis = byHero(state, "dennis");
  const ctx = { state, rng: Rng.fromState(state.rngState), caster: hector, self: hector, targets: [], it: null, vars: {}, emit: () => {} };

  const named = resolveSelector({ faction: "allies", kind: "minion", template: "Dennis the Apprentice" }, ctx);
  assert.deepEqual(named.map((u) => u.id), [dennis.id], "the Dennis-by-template minion selector resolves to hero-Dennis");

  const blanket = resolveSelector({ faction: "allies", kind: "minion" }, ctx);
  assert.ok(!blanket.some((u) => u.id === dennis.id), "a template-less minion selector never admits the hero understudy");
});

test("Part A: a minion-consume (defeat) op does NOT kill the understudy hero (Perfect Form)", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 1 });
  const hector = byHero(state, "hector");
  const dennis = byHero(state, "dennis");
  runEffects(state, [{ op: "defeat", to: { faction: "allies", kind: "minion", template: "Dennis the Apprentice" } }], { caster: hector, self: hector });
  assert.equal(dennis.alive, true, "the defeat/consume op does not admit — and so does not kill — hero-Dennis");
  assert.equal(dennis.hp, dennis.maxHp, "hero-Dennis is untouched");
});

test("Part A: a minion-revive does NOT resurrect a dead understudy hero (Serum Overload)", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 1 });
  const hector = byHero(state, "hector");
  const dennis = byHero(state, "dennis");
  dennis.alive = false; dennis.hp = 0; // hero-Dennis died this round
  runEffects(state, [{ op: "revive", hp: 50, to: { faction: "allies", kind: "minion", template: "Dennis the Apprentice", alive: false } }], { caster: hector, self: hector });
  assert.equal(dennis.alive, false, "a minion-revive does not resurrect the hero");
});

test("Part A: understudyFor persists across rounds; the summon stays suppressed in round 2", () => {
  const state = buildMatch({ A: ["hector", "dennis", "saya"], B: ["gaia", "roland", "sera"], seed: 1 });
  startRound(state);
  startRound(state); // round 2
  assert.equal(byHero(state, "dennis").understudyFor, "Dennis the Apprentice", "the tag survives startRound");
  assert.equal(apprenticeMinions(state).length, 0, "summon still suppressed in round 2");
});

test("Part A: Hector on A + Dennis on B (opposing) tags neither; Hector still summons his minion", () => {
  const state = buildMatch({ A: ["hector", "saya", "gaia"], B: ["dennis", "roland", "sera"], seed: 1 });
  assert.equal(byHero(state, "hector").understudyFor, undefined, "Hector untagged");
  assert.equal(byHero(state, "dennis").understudyFor, undefined, "the opposing Dennis is untagged (per-team scoping)");
  startRound(state);
  assert.equal(apprenticeMinions(state).length, 1, "Hector summons his minion — no same-team Dennis");
});
