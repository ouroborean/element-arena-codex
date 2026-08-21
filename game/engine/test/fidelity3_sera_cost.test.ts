import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost } from "../src/scheduler.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 9 — sera6 "Divinity Engine": its per-cast cost reduction (-1 Specific per dead
// ally) was never modeled (shipped a flat {0,3}). Now a dynamic costMods magnitude = -count(dead allies).

const skillOf = (u: Unit, id: string) => (u.skills ?? []).find((s) => s.id === id)!;

test("Divinity Engine's Specific cost drops by 1 per dead ally hero (dynamic costMods)", () => {
  const sera = loadHero(heroById("sera"), "A", "s");
  const sk = skillOf(sera, "sera6");

  const alone = makeState([sera], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(effectiveCost(sera, sk, alone).specific, 3, "no dead allies -> full 3 Specific");

  const dead = (id: string): Unit => { const u = makeUnit({ id, team: "A", kind: "hero" }); u.alive = false; return u; };
  const two = makeState([sera, dead("a1"), dead("a2")], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(effectiveCost(sera, sk, two).specific, 1, "two dead allies -> 3 - 2 = 1 Specific");
});
