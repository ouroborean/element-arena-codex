import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Engine-fidelity — Taryn "Protector of the Song": "When Taryn has an ability reflected TO HIM, he gains
// 10 DR for 1 turn and Elemental Essence." Now gated on eventRedirectedToSelf (the reflect destination `to`
// == Taryn), replacing the `not sameUnit(eventSource,self)` proxy that over-triggered on foreign redirects
// to non-Taryn units and wrongly suppressed Taryn's own skill being reflected back onto him.

const rewarded = (u: Unit): boolean =>
  u.statuses.some((s) => s.kind === "damage_reduction" && s.magnitude === 10) &&
  u.statuses.some((s) => s.kind === "elemental_essence");

test("Protector of the Song: a skill redirected ONTO Taryn grants him 10 DR + Essence", () => {
  const taryn = loadHero(heroById("taryn"), "A", "taryn");
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([taryn, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "a2", to: "taryn" });
  assert.ok(rewarded(taryn), "reflected TO Taryn → reward");
});

test("Protector of the Song: a redirect onto a NON-Taryn unit does NOT reward Taryn (over-trigger fixed)", () => {
  const taryn = loadHero(heroById("taryn"), "A", "taryn");
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([taryn, ally], [makeUnit({ id: "e", team: "B" })]);
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "a2" });
  assert.ok(!rewarded(taryn), "redirect onto a2 (not Taryn) → no reward, even though eventSource != Taryn");
});

test("Protector of the Song: Taryn's OWN skill reflected back onto him fires (previously suppressed)", () => {
  const taryn = loadHero(heroById("taryn"), "A", "taryn");
  const state = makeState([taryn], [makeUnit({ id: "e", team: "B" })]);
  // Taryn's harmful skill is reflected back onto him: caster == to == Taryn. The old eventSource==self guard
  // wrongly suppressed this; the prose ("reflected to him") says it should reward.
  emit(state, { type: "skillRedirected", caster: "taryn", skillId: "x", from: "e", to: "taryn" });
  assert.ok(rewarded(taryn), "reflected back onto Taryn → reward");
});

test("Divine Hymn (fused Taryn): the re-authored passive gates on redirect-to-Taryn too (fix propagated)", () => {
  const taryn = loadHero(heroById("taryn"), "A", "taryn");
  applyFusion(taryn, fusionForm("taryn", "divine")!); // re-authors Protector: 2-turn DR to Taryn + both allies
  const ally = makeUnit({ id: "a2", team: "A" });
  const state = makeState([taryn, ally], [makeUnit({ id: "e", team: "B" })]);

  // A redirect onto a NON-Taryn unit must NOT fire the fusion reward (the over-trigger this propagation fixes).
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "e", to: "a2" });
  assert.ok(!taryn.statuses.some((s) => s.kind === "damage_reduction"), "redirect onto a2 → no Divine Hymn reward");

  // A redirect ONTO Taryn rewards Taryn AND both allies (Divine Hymn's widening).
  emit(state, { type: "skillRedirected", caster: "e", skillId: "x", from: "a2", to: "taryn" });
  assert.ok(taryn.statuses.some((s) => s.kind === "damage_reduction" && s.magnitude === 10), "Taryn gets DR");
  assert.ok(ally.statuses.some((s) => s.kind === "damage_reduction" && s.magnitude === 10), "the ally also gets DR (Divine Hymn widens to allies)");
});
