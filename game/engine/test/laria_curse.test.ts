import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers the fusion custom handlers
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
void loadHero;

// Engine-fidelity — the last pending fusion stub, copyCurseIfNoSkillUsed (laria:curse "Curse of Darkness"):
// if the cursed holder never uses a skill during the mark's 3 turns, the mark expires naturally and copies
// the full curse onto a random ally; if the holder acts even once, removeMarkOnSkillUse strips the mark early
// (removeStatus does not fire onExpire) so no copy is made.

// A fresh copy each time — fusionForm returns a SHARED skill object; performAction mutates currentCd,
// which would otherwise leak a cooldown from one test's cast into the next.
const lariaCurseSkill = () => ({ ...fusionForm("laria", "curse")!.skill, currentCd: 0 });

test("copyCurseIfNoSkillUsed: natural expiry copies the FULL curse onto a random ally hero of the holder", () => {
  const laria = makeUnit({ id: "laria", team: "A", skills: [lariaCurseSkill()] });
  const holder = makeUnit({ id: "h", team: "B" });
  const ally = makeUnit({ id: "hally", team: "B" });
  const state = makeState([laria], [holder, ally]);

  // Simulate the mark's natural expiry: onExpire runs with caster = the applier (Laria), targets = [holder].
  runEffects(state, [{ op: "custom", fn: "copyCurseIfNoSkillUsed" }], { caster: laria, targets: [holder], skillId: "lariacurse1" });

  assert.ok(ally.statuses.some((s) => s.kind === "dot" && s.name === "Curse of Darkness"), "ally received the copied curse dot");
  assert.ok(ally.statuses.some((s) => s.kind === "mark" && s.name === "Curse of Darkness"), "and the copied mark — so the copy is itself spreadable/cancelable");
  assert.ok(!holder.statuses.some((s) => s.name === "Curse of Darkness"), "the holder is not re-cursed by its own expiry");
});

test("copyCurseIfNoSkillUsed: no ally to copy onto → a logged no-op, nothing applied", () => {
  const laria = makeUnit({ id: "laria", team: "A", skills: [lariaCurseSkill()] });
  const holder = makeUnit({ id: "h", team: "B" }); // the holder is the only hero on its team
  const state = makeState([laria], [holder]);

  runEffects(state, [{ op: "custom", fn: "copyCurseIfNoSkillUsed" }], { caster: laria, targets: [holder], skillId: "lariacurse1" });

  assert.ok(!holder.statuses.some((s) => s.name === "Curse of Darkness"), "no self-copy");
  assert.ok(state.log.some((l) => l.includes("no ally to copy")), "the empty-ally case is logged, not silent");
});

test("removeMarkOnSkillUse cancels the copy: the cursed holder acting strips the Curse of Darkness mark", () => {
  const laria = makeUnit({ id: "laria", team: "A", currentElement: "curse", skills: [lariaCurseSkill()] });
  const holder = makeUnit({ id: "h", team: "B", skills: [skill("hbasic", [], { cost: { generic: 0, specific: 0 } })] });
  const state = makeState([laria], [holder]);
  state.teams.A.energy = { generic: 5, curse: 5 }; // pay lariacurse1 ({generic:2, specific:1}); specific pays from Laria's current element (curse)

  performAction(state, { unit: "laria", skillId: "lariacurse1", targets: ["h"] });
  assert.ok(holder.statuses.some((s) => s.kind === "mark" && s.name === "Curse of Darkness"), "holder marked by the curse");

  // The holder uses ANY skill → the (holder-owned) watch strips the mark (so its onExpire will never copy).
  performAction(state, { unit: "h", skillId: "hbasic", targets: ["h"] });
  assert.ok(!holder.statuses.some((s) => s.kind === "mark" && s.name === "Curse of Darkness"), "mark stripped on the holder's skill use");
  // The dot (a separate status kind) is untouched — only the copy-carrying MARK is cancelled.
  assert.ok(holder.statuses.some((s) => s.kind === "dot" && s.name === "Curse of Darkness"), "the affliction dot still ticks");
});

test("cancel survives Laria's death: a dead Laria still lets the holder's own action strip the mark", () => {
  // The cancel-watch is owned by the HOLDER (owner:'target'), so it fires whenever the holder acts — the
  // holder is alive when it acts — regardless of whether Laria (a squishy caster, often focus-fired) survives.
  const laria = makeUnit({ id: "laria", team: "A", currentElement: "curse", skills: [lariaCurseSkill()] });
  const holder = makeUnit({ id: "h", team: "B", skills: [skill("hbasic", [], { cost: { generic: 0, specific: 0 } })] });
  const state = makeState([laria], [holder]);
  state.teams.A.energy = { generic: 5, curse: 5 };

  performAction(state, { unit: "laria", skillId: "lariacurse1", targets: ["h"] });
  assert.ok(holder.statuses.some((s) => s.kind === "mark" && s.name === "Curse of Darkness"), "holder marked");

  laria.alive = false; // Laria dies mid-window

  performAction(state, { unit: "h", skillId: "hbasic", targets: ["h"] });
  assert.ok(!holder.statuses.some((s) => s.kind === "mark" && s.name === "Curse of Darkness"),
    "the holder acting still strips the mark despite a dead Laria — so a holder who DID act is not wrongly copied");
});
