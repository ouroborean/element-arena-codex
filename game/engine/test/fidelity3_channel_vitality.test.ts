import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 20 — gaia3 "Channel Vitality": "For the rest of the turn, if any of GAIA'S minions
// act, the marked ally is healed 10." Two fixes: (2) scope the trigger to Gaia's own summons via the new
// eventSourceSummonedBySelf condition; (1) close the window at the end of Gaia's turn (was a duration-1 mark
// that bled into her next turn) via a turnEnd(eventTeamIsSelf) removeStatus.

function setup() {
  const gaia = loadHero(heroById("gaia"), "A", "g");
  const ally = makeUnit({ id: "al", team: "A", hp: 50, maxHp: 100, kind: "hero",
    statuses: [{ kind: "mark", name: "Channel Vitality", duration: 1, appliedBy: "g", appliedTurn: 0 }] });
  const gaiaMinion = makeUnit({ id: "gm", team: "A", kind: "minion", summoner: "g" });
  const otherMinion = makeUnit({ id: "om", team: "A", kind: "minion", summoner: "al" }); // an ally's minion, not Gaia's
  const state = makeState([gaia, ally, gaiaMinion, otherMinion], [makeUnit({ id: "e", team: "B" })]);
  return { ally, state };
}

test("Channel Vitality heals only when GAIA's own minion acts, not another ally's minion", () => {
  const { ally, state } = setup();

  emit(state, { type: "skillUsed", caster: "om", skillId: "x", targets: [], tags: [] });
  assert.equal(ally.hp, 50, "a non-Gaia minion acting does not heal the marked ally");

  emit(state, { type: "skillUsed", caster: "gm", skillId: "y", targets: [], tags: [] });
  assert.equal(ally.hp, 60, "a Gaia-summoned minion acting heals the marked ally 10");
});

test("the Channel Vitality window closes at the end of Gaia's turn", () => {
  const { ally, state } = setup();

  emit(state, { type: "turnEnd", team: "A" });
  assert.ok(!ally.statuses.some((s) => s.name === "Channel Vitality"), "the mark is cleared at Gaia's turn-end");

  emit(state, { type: "skillUsed", caster: "gm", skillId: "z", targets: [], tags: [] });
  assert.equal(ally.hp, 50, "after the window closes, a Gaia minion no longer heals");
});
