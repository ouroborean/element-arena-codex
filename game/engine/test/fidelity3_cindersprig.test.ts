import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 18 — jarrik:alchemy "Cindersprig Brew": +5 non-Affliction damage for 4 turns,
// "ends if they use a new skill". A named outgoing_damage_mod + a Drunken-Swordsman skillUsed cancel trigger;
// a one-shot "Cindersprig Grace" mark (applied only when Jarrik buffs HIMSELF) spares the very cast that
// applied it, so his own casting skill doesn't instantly cancel the buff.

const hasBrew = (u: Unit): boolean => u.statuses.some((s) => s.kind === "outgoing_damage_mod" && s.name === "Cindersprig Brew");

test("an ally's Cindersprig buff ends on the ally's next skill", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "alchemy")!);
  const ally = makeUnit({ id: "al", team: "A", kind: "hero",
    statuses: [{ kind: "outgoing_damage_mod", name: "Cindersprig Brew", magnitude: 5, duration: 4, appliedBy: "j", appliedTurn: 0 }] });
  const state = makeState([jarrik, ally], [makeUnit({ id: "e", team: "B" })]);

  emit(state, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: [] });
  assert.ok(!hasBrew(ally), "the ally's first skill ends the buff (no grace for allies)");
});

test("Jarrik's self-cast does not cancel its own Cindersprig buff, but his NEXT skill does", () => {
  const jarrik = loadHero(heroById("jarrik"), "A", "j");
  applyFusion(jarrik, fusionForm("jarrik", "alchemy")!);
  const state = makeState([jarrik], [makeUnit({ id: "e", team: "B" })]);
  state.teams.A.energy = { alchemy: 10 };

  performAction(state, { unit: "j", skillId: "jarrikalchemy1", targets: ["j"] });
  assert.ok(hasBrew(jarrik), "the self-buff survives its own casting skill (grace spared it)");
  assert.ok(!jarrik.statuses.some((s) => s.name === "Cindersprig Grace"), "the grace mark was consumed by the cast");

  emit(state, { type: "skillUsed", caster: "j", skillId: "y", targets: [], tags: [] });
  assert.ok(!hasBrew(jarrik), "Jarrik's next skill ends the buff");
});
