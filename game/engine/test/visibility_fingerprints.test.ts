import { test } from "node:test";
import assert from "node:assert/strict";
import { redactState } from "../src/visibility.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// PR 8a — an Invisible cast fingerprints the caster OUTSIDE its statuses: the skill it used ticks a cooldown
// and the last-skill ledger names it. Neither is drawn in the UI, but both ride the wire, so redactState
// now scrubs them from a FOE's view (unless the viewer has True Sight). Ordinary skills are untouched.

const cd = (st: MatchState, uid: string, sid: string): number => st.units[uid]!.skills!.find((s) => s.id === sid)!.currentCd;

function board(revealOnA = false) {
  const a = makeUnit({ id: "a1", team: "A", statuses: revealOnA ? [status("reveal", { appliedBy: "a1" })] : [] });
  const foe = makeUnit({ id: "b1", team: "B", lastSkillId: "hid",
    skills: [skill("hid", [], { isHidden: true, currentCd: 3, cdSetTurn: 2 }), skill("vis", [], { currentCd: 2 })] });
  return makeState([a], [foe]);
}

test("a foe's Invisible-skill cooldown and last-skill ledger are scrubbed from the opponent, kept for the owner", () => {
  const st = board();

  const forA = redactState(st, "A"); // A is B's opponent
  assert.equal(cd(forA, "b1", "hid"), 0, "A cannot see the Invisible skill's cooldown (it reads as ready)");
  assert.equal(cd(forA, "b1", "vis"), 2, "A still sees an ordinary skill's cooldown");
  assert.equal(forA.units["b1"]!.lastSkillId, undefined, "A cannot see the ledger naming the Invisible skill");

  const forB = redactState(st, "B"); // the owner sees its own real state
  assert.equal(cd(forB, "b1", "hid"), 3, "B sees its own Invisible skill's real cooldown");
  assert.equal(forB.units["b1"]!.lastSkillId, "hid", "B sees its own ledger");

  assert.equal(cd(st, "b1", "hid"), 3, "the authoritative state is not mutated");
  assert.equal(st.units["b1"]!.lastSkillId, "hid", "authoritative ledger intact");
});

test("True Sight lets the viewer see even the Invisible skill's cooldown (reveal bypasses the scrub)", () => {
  const st = board(true);
  assert.equal(cd(redactState(st, "A"), "b1", "hid"), 3, "with reveal, A sees the Invisible skill's cooldown too");
});

test("a foe last-skill ledger naming an ORDINARY skill is preserved", () => {
  const foe = makeUnit({ id: "b1", team: "B", lastSkillId: "vis", skills: [skill("vis", [], { currentCd: 1 })] });
  const st = makeState([makeUnit({ id: "a1", team: "A" })], [foe]);
  assert.equal(redactState(st, "A").units["b1"]!.lastSkillId, "vis", "a visible skill in the ledger is not hidden");
});
