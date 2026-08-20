import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatch, heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { startRound, endTurn } from "../src/scheduler.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts";
import type { MatchState, Unit } from "../src/types.ts";

const hasFrost = (u: Unit): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === "Frost-Covered");

// Engine-fidelity — gommar:stasis "Keeper of Beasts": "Creates a Frozen Beast minion. This minion is
// permanently stunned until Gommar loses Frost-Covered." The one-way release (no auto-remove-on-mark-loss)
// is now real: a new statusLost event (emitted by the removeStatus op) drives a one-shot watch that thaws it.

const find = (state: MatchState, pred: (u: Unit) => boolean): Unit => Object.values(state.units).find(pred)!;
void heroById; void loadHero;

test("Keeper of Beasts: the Frozen Beast stays stunned until Gommar loses Frost-Covered, then thaws (once)", () => {
  const state = buildMatch({ A: ["gommar", "saya", "gaia"], B: ["roland", "sera", "ando"], seed: 1 });
  const gommar = find(state, (u) => u.heroId === "gommar");
  applyFusion(gommar, fusionForm("gommar", "stasis")!);
  startRound(state);

  // Ensure Gommar holds Frost-Covered (his charge), then cast Keeper of Beasts.
  if (!gommar.statuses.some((s) => s.kind === "mark" && s.name === "Frost-Covered"))
    gommar.statuses.push({ kind: "mark", name: "Frost-Covered", duration: null, appliedBy: gommar.id, appliedTurn: state.turn });
  const kob = (gommar.skills ?? []).find((s) => s.id === "gommarstasis1")!;
  runEffects(state, kob.effects, { caster: gommar, self: gommar, targets: [gommar], skillId: "gommarstasis1" });

  const beast = find(state, (u) => u.kind === "minion" && u.name === "Frozen Beast");
  assert.ok(beast, "Frozen Beast summoned");
  assert.ok(beast.statuses.some((s) => s.kind === "stun"), "the Frozen Beast is stunned");
  assert.ok((gommar.triggers ?? []).some((t) => t.source === "Keeper of Beasts"), "the release watch is armed on Gommar");

  // An unrelated status loss on Gommar must NOT thaw the beast.
  gommar.statuses.push({ kind: "mark", name: "Something Else", duration: null, appliedBy: gommar.id, appliedTurn: state.turn });
  runEffects(state, [{ op: "removeStatus", kind: "mark", name: "Something Else", from: "caster" }], { caster: gommar, self: gommar });
  assert.ok(beast.statuses.some((s) => s.kind === "stun"), "losing a different mark does not thaw the beast");

  // Gommar loses Frost-Covered (an active consumes the charge → removeStatus op → statusLost) → beast thaws.
  runEffects(state, [{ op: "removeStatus", kind: "mark", name: "Frost-Covered", from: "caster" }], { caster: gommar, self: gommar });
  assert.ok(!beast.statuses.some((s) => s.kind === "stun"), "the Frozen Beast thaws when Gommar loses Frost-Covered");
});

test("Flashfreeze: consuming Frost-Covered re-grants it at the end of Gommar's next turn (now fires via statusLost)", () => {
  const state = buildMatch({ A: ["gommar", "saya", "gaia"], B: ["roland", "sera", "ando"], seed: 1 });
  const gommar = find(state, (u) => u.heroId === "gommar");
  applyAugment(gommar, augmentById("gommar4")!); // Flashfreeze
  startRound(state);
  if (!hasFrost(gommar)) gommar.statuses.push({ kind: "mark", name: "Frost-Covered", duration: null, appliedBy: gommar.id, appliedTurn: state.turn });

  // Consume Frost-Covered (a removeStatus op → statusLost). Before this fix Flashfreeze listened for
  // statusExpired, which never fires for the dur-null mark, so the augment was dead.
  runEffects(state, [{ op: "removeStatus", kind: "mark", name: "Frost-Covered", from: "caster" }], { caster: gommar, self: gommar });
  assert.ok(!hasFrost(gommar), "Frost-Covered consumed");
  assert.ok(state.scheduled.some((sc) => sc.caster === gommar.id), "Flashfreeze scheduled a re-grant (it now fires)");

  endTurn(state); endTurn(state); endTurn(state); // → end of Gommar's next turn: the schedule fires
  assert.ok(hasFrost(gommar), "Frost-Covered regained at the end of his next turn");
});
