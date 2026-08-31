import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyProgress, asProgress, creditWin, FUSION_ELEMENT_HEROES, FUSION_ELEM_WINS_REQUIRED,
  advancedAugmentsUnlocked, augmentUnlocked, fusionUnlocked, heroUnlocked, type Progress,
} from "../content/progression.ts";

const hero = (over: Partial<{ augments: string[]; fused: string; kind: string }> = {}) =>
  ({ kind: "hero", ...over });

test("the 7 fusion-element heroes are derived from the roster with their element", () => {
  assert.deepEqual(
    Object.fromEntries([...FUSION_ELEMENT_HEROES].sort()),
    { dennis: "serum", fate: "apocalypse", scratch: "devil", aramao: "nomad", sera: "vengeance", galazax: "storm", trinity: "prism" },
  );
});

test("single-element heroes start unlocked; fusion-element heroes start locked", () => {
  const p = emptyProgress();
  assert.equal(heroUnlocked(p, "pyrrha"), true, "a single-element hero is available");
  assert.equal(heroUnlocked(p, "dennis"), false, "a fusion-element hero is locked with no progress");
});

test("augments 1-3 are always unlocked; 4 & 5 start locked", () => {
  const p = emptyProgress();
  for (const n of [1, 2, 3]) assert.equal(augmentUnlocked(p, `pyrrha${n}`), true);
  for (const n of [4, 5]) assert.equal(augmentUnlocked(p, `pyrrha${n}`), false);
  assert.equal(advancedAugmentsUnlocked(p, "pyrrha"), false);
  assert.equal(fusionUnlocked(p, "pyrrha"), false);
});

test("a win with each of augments 1,2,3 unlocks the advanced (4 & 5) augments", () => {
  let p = emptyProgress();
  p = creditWin(p, [hero({ augments: ["pyrrha1"] })]);
  p = creditWin(p, [hero({ augments: ["pyrrha2"] })]);
  assert.equal(advancedAugmentsUnlocked(p, "pyrrha"), false, "still locked with only 1 & 2");
  p = creditWin(p, [hero({ augments: ["pyrrha3"] })]);
  assert.equal(advancedAugmentsUnlocked(p, "pyrrha"), true);
  assert.equal(augmentUnlocked(p, "pyrrha4"), true);
  assert.equal(augmentUnlocked(p, "pyrrha5"), true);
  assert.equal(fusionUnlocked(p, "pyrrha"), false, "Fusion still needs wins with 4 & 5");
});

test("one win credits EVERY augment the hero had equipped (they stack across rounds)", () => {
  const p = creditWin(emptyProgress(), [hero({ augments: ["pyrrha1", "pyrrha2", "pyrrha3"] })]);
  assert.equal(advancedAugmentsUnlocked(p, "pyrrha"), true, "1/2/3 in a single winning match all count");
  assert.deepEqual(p.augWins, { pyrrha1: 1, pyrrha2: 1, pyrrha3: 1 });
});

test("Fusion unlocks after a win with each of augments 4 & 5 (which require the advanced unlock first)", () => {
  let p: Progress = { v: 1, augWins: { pyrrha1: 1, pyrrha2: 1, pyrrha3: 1 }, fusedWins: {} };
  assert.equal(fusionUnlocked(p, "pyrrha"), false);
  p = creditWin(p, [hero({ augments: ["pyrrha4"] })]);
  assert.equal(fusionUnlocked(p, "pyrrha"), false, "only 4 so far");
  p = creditWin(p, [hero({ augments: ["pyrrha5"] })]);
  assert.equal(fusionUnlocked(p, "pyrrha"), true);
});

test("a fusion-element hero unlocks after 3 wins with a hero fused into its element", () => {
  let p = emptyProgress();
  for (let i = 0; i < FUSION_ELEM_WINS_REQUIRED - 1; i++) p = creditWin(p, [hero({ fused: "serum" })]);
  assert.equal(heroUnlocked(p, "dennis"), false, "2 wins is not enough");
  p = creditWin(p, [hero({ fused: "serum" })]);
  assert.equal(heroUnlocked(p, "dennis"), true, "3 wins fused to serum unlocks dennis");
  assert.equal(heroUnlocked(p, "fate"), false, "a different element's hero stays locked");
});

test("creditWin ignores minions and non-hero units, and is pure", () => {
  const before = emptyProgress();
  const after = creditWin(before, [hero({ augments: ["pyrrha1"] }), { kind: "minion", augments: ["pyrrha2"], fused: "serum" }]);
  assert.deepEqual(before.augWins, {}, "input is not mutated");
  assert.deepEqual(after.augWins, { pyrrha1: 1 }, "the minion's fields are not counted");
  assert.deepEqual(after.fusedWins, {});
});

test("asProgress coerces a corrupt / hand-edited blob into a clean Progress", () => {
  assert.deepEqual(asProgress(null), emptyProgress());
  assert.deepEqual(asProgress("garbage"), emptyProgress());
  assert.deepEqual(
    asProgress({ augWins: { pyrrha1: 2, bad: "x", neg: -3, nan: NaN }, fusedWins: { serum: 1.9 }, junk: 1 }),
    { v: 1, augWins: { pyrrha1: 2 }, fusedWins: { serum: 1 } },
    "non-numeric / non-positive entries dropped; float floored; unknown keys ignored",
  );
});
