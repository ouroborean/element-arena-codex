import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status } from "./helpers.ts";

// Fidelity Campaign 3 — coverage for ayana:sanctuary "Hallowed Footsteps" (#12).
// Frozen (fusion passive): "When dealing damage to or healing a target affected by your Consecrate, deal 10
// additional damage or healing to them. This effect is not triggered by Consecrate."
// SHIPPING: a damageDealt trigger whose `when` includes {not:{eventSourceId:"Consecrate"}}, so the Consecrate
// dot's OWN ticks (damageDealt sourceId="Consecrate") are excluded, while a real skill hit on a Consecrated
// enemy fires the +10 rider.

test("Hallowed Footsteps: the Consecrate dot's own tick does NOT trigger the +10 rider", () => {
  const ayana = loadHero(heroById("ayana"), "A", "a");
  applyFusion(ayana, fusionForm("ayana", "sanctuary")!);
  // Enemy is affected by ayana's Consecrate (the named piercing dot).
  const enemy = makeUnit({
    id: "e",
    team: "B",
    kind: "hero",
    hp: 100,
    maxHp: 100,
    statuses: [status("dot", { name: "Consecrate", magnitude: 5, dtype: "piercing", duration: 5 })],
  });
  const state = makeState([ayana], [enemy]);

  // The Consecrate dot ticking: a damageDealt from ayana carrying sourceId "Consecrate".
  emit(state, { type: "damageDealt", source: "a", target: "e", amount: 5, dtype: "piercing", sourceId: "Consecrate", isNew: false });

  assert.equal(enemy.hp, 100, "Consecrate's own tick applies NO +10 rider (hp unchanged)");
  assert.ok(!ayana.statuses.some((s) => s.name === "Hallowed Proc Lock"), "no proc lock left behind (rider never entered)");
});

test("Hallowed Footsteps: a normal skill hit on a Consecrated enemy deals +10", () => {
  const ayana = loadHero(heroById("ayana"), "A", "a");
  applyFusion(ayana, fusionForm("ayana", "sanctuary")!);
  const enemy = makeUnit({
    id: "e",
    team: "B",
    kind: "hero",
    hp: 100,
    maxHp: 100,
    statuses: [status("dot", { name: "Consecrate", magnitude: 5, dtype: "piercing", duration: 5 })],
  });
  const state = makeState([ayana], [enemy]);

  // A real ayana skill hit (any non-Consecrate sourceId) on the Consecrated enemy.
  emit(state, { type: "damageDealt", source: "a", target: "e", amount: 15, dtype: "normal", sourceId: "ayana1", isNew: true });

  // The event itself is a notification (does not re-apply its own 15); only the +10 rider touches hp.
  assert.equal(enemy.hp, 90, "the +10 rider fires: Consecrated enemy loses 10");
  assert.ok(!ayana.statuses.some((s) => s.name === "Hallowed Proc Lock"), "proc lock is set then removed within the rider");
});

test("Hallowed Footsteps: no rider when the target is NOT affected by Consecrate (control)", () => {
  const ayana = loadHero(heroById("ayana"), "A", "a");
  applyFusion(ayana, fusionForm("ayana", "sanctuary")!);
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100, maxHp: 100 });
  const state = makeState([ayana], [enemy]);

  emit(state, { type: "damageDealt", source: "a", target: "e", amount: 15, dtype: "normal", sourceId: "ayana1", isNew: true });

  assert.equal(enemy.hp, 100, "a hit on an un-Consecrated enemy gets no +10 rider");
});
