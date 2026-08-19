import { test } from "node:test";
import assert from "node:assert/strict";
import { legalTargets, canUse } from "../src/scheduler.ts";
import { Rng } from "../src/rng.ts";
import { ROSTER } from "../content/roster.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";

const feedSkill = () => ROSTER.find((h) => h.id === "syl")!.skills!.find((s) => s.id === "syl1")!;

test("targetKind restricts a single-target skill's legal targets (Feed → an allied minion only)", () => {
  const syl = makeUnit({ id: "a1", team: "A", heroId: "syl" });
  const ally = makeUnit({ id: "a2", team: "A" }); // a hero ally — NOT a legal Feed target
  const eagle = makeUnit({ id: "a3", team: "A", kind: "minion", summoner: "a1" });
  const state = makeState([syl, ally, eagle], [makeUnit({ id: "b1", team: "B" })]);

  const legal = legalTargets(state, syl, feedSkill(), [syl, ally, eagle], Rng.fromState(state.rngState));
  assert.deepEqual(legal.map((u) => u.id), ["a3"], "only the Eagle (a minion) is a legal Feed target");
});

test("canUse finds the minion target for a kind-restricted Helpful skill (Feed usable with an Eagle)", () => {
  const syl = makeUnit({ id: "a1", team: "A", heroId: "syl", skills: [{ ...feedSkill(), currentCd: 0 }] });
  const eagle = makeUnit({ id: "a3", team: "A", kind: "minion", summoner: "a1" });
  const state = makeState([syl, eagle], [makeUnit({ id: "b1", team: "B" })]);
  state.teams.A.energy = { generic: 5 };
  assert.equal(canUse(state, syl, syl.skills![0]!), true, "Feed is usable when an allied minion exists");

  // With no allied minion, Feed has no legal target → unusable.
  const state2 = makeState([makeUnit({ id: "a1", team: "A", heroId: "syl", skills: [{ ...feedSkill(), currentCd: 0 }] })], [makeUnit({ id: "b1", team: "B" })]);
  state2.teams.A.energy = { generic: 5 };
  assert.equal(canUse(state2, state2.units["a1"]!, state2.units["a1"]!.skills![0]!), false, "Feed is unusable with no minion");
});
