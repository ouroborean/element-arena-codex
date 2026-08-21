import { test } from "node:test";
import assert from "node:assert/strict";
import { targetPool } from "./cli.ts";
import { makeState, makeUnit, skill } from "../engine/test/helpers.ts";

// Fidelity Campaign 3, PR 22 — syl:winter "Mountain Rescue Team": "Swoop can now be used to make a stunned
// ally invulnerable." The engine already carries Swoop's stunned-ally invuln branch; the gap was the client
// offering a stunned ally as a target for the Eagle's Swoop (sylminion2). Locked at the shared targetPool.

test("Swoop offers stunned allies (+ enemies) only when the Eagle's summoner is winter-fused", () => {
  const syl = makeUnit({ id: "s", team: "A", kind: "hero", fused: "winter" });
  const eagle = makeUnit({ id: "eg", team: "A", kind: "minion", summoner: "s", skills: [skill("sylminion2", [], { tags: ["Harmful"] })] });
  const stunnedAlly = makeUnit({ id: "al", team: "A", kind: "hero", statuses: [{ kind: "stun", duration: 1, appliedBy: "e", appliedTurn: 0 }] });
  const wellAlly = makeUnit({ id: "ok", team: "A", kind: "hero" });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([syl, eagle, stunnedAlly, wellAlly], [enemy]);

  const pool = targetPool(state, eagle, eagle.skills![0]!).map((x) => x.id);
  assert.ok(pool.includes("al"), "the STUNNED ally is offered");
  assert.ok(pool.includes("e"), "enemies are still offered");
  assert.ok(!pool.includes("ok"), "a non-stunned ally is NOT offered");
});

test("without Mountain Rescue Team, Swoop offers only enemies", () => {
  const syl = makeUnit({ id: "s", team: "A", kind: "hero" }); // not fused
  const eagle = makeUnit({ id: "eg", team: "A", kind: "minion", summoner: "s", skills: [skill("sylminion2", [], { tags: ["Harmful"] })] });
  const stunnedAlly = makeUnit({ id: "al", team: "A", kind: "hero", statuses: [{ kind: "stun", duration: 1, appliedBy: "e", appliedTurn: 0 }] });
  const enemy = makeUnit({ id: "e", team: "B", kind: "hero" });
  const state = makeState([syl, eagle, stunnedAlly], [enemy]);

  const pool = targetPool(state, eagle, eagle.skills![0]!).map((x) => x.id);
  assert.ok(!pool.includes("al"), "no stunned-ally offer without the winter fusion");
  assert.ok(pool.includes("e"), "enemies offered");
});
