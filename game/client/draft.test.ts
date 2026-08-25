import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatch, defaultPolicy } from "../engine/content/match.ts";
import { availableFusions, availableAugments } from "../engine/content/metagame.ts";
import { runMatch } from "./loop.ts";
import { draftableHeroes, applyDraftChoice, applyDraftChoices, autoDraft, hasDraftOptions } from "./draft.ts";

const DRAFT = { A: ["syl", "jarrik", "gommar"], B: ["keeper", "riverdaughter", "saya"], seed: 7 };

test("availableFusions is partner-gated: syl (wind) gets forms from its teammates' elements", () => {
  const st = buildMatch({ ...DRAFT });
  const forms = availableFusions(st, st.units["a1"]!).map((f) => f.key).sort();
  // jarrik=fire → recipe(wind,fire)=mechanic; gommar=ice → recipe(wind,ice)=winter.
  assert.deepEqual(forms, ["mechanic", "winter"]);
});

test("availableFusions is empty once a hero has fused; availableAugments drops taken ones", () => {
  const st = buildMatch({ ...DRAFT });
  const syl = st.units["a1"]!;
  assert.equal(availableAugments(syl).length, 5);
  const r = applyDraftChoice(st, { kind: "fuse", unitId: "a1", formKey: "mechanic" });
  assert.equal(r.ok, true);
  assert.equal(syl.fused, "mechanic");
  assert.equal(availableFusions(st, syl).length, 0, "can't fuse twice");
  // augment it too, then that augment is no longer offered
  const aug = availableAugments(syl)[0]!;
  applyDraftChoice(st, { kind: "augment", unitId: "a1", augmentId: aug.id });
  assert.ok((syl.augments ?? []).includes(aug.id));
  assert.ok(!availableAugments(syl).some((a) => a.id === aug.id));
});

test("applyDraftChoice rejects illegal choices (unavailable fusion / already-taken augment)", () => {
  const st = buildMatch({ ...DRAFT });
  // 'storm' needs a lightning teammate; syl's team has none → not offered.
  assert.equal(applyDraftChoice(st, { kind: "fuse", unitId: "a1", formKey: "storm" }).ok, false);
  assert.equal(applyDraftChoice(st, { kind: "augment", unitId: "a1", augmentId: "nope" }).ok, false);
  assert.equal(st.units["a1"]!.fused, undefined, "no illegal fusion slipped through");
});

test("autoDraft returns one choice per eligible hero, preferring fusion; each is applicable", () => {
  const st = buildMatch({ ...DRAFT });
  const cs1 = autoDraft(st, "A");
  assert.ok(cs1.length >= 1, "at least one hero has an upgrade");
  assert.ok(cs1.some((c) => c.kind === "fuse"), "prefers a fusion when available");
  for (const res of applyDraftChoices(st, "A", cs1)) assert.equal(res.ok, true); // apply the whole phase
  // everyone who could fuse now has; the next phase can only offer augments
  const cs2 = autoDraft(st, "A");
  assert.ok(cs2.every((c) => c.kind === "augment"), "already-fused heroes fall back to augment");
});

test("draftableHeroes includes wiped heroes (the round loser drafts for the next fresh battle)", () => {
  const st = buildMatch({ ...DRAFT });
  for (const u of draftableHeroes(st, "A")) u.alive = false; // simulate a wipe
  assert.equal(draftableHeroes(st, "A").length, 3, "dead heroes still draft");
  assert.equal(hasDraftOptions(st, "A"), true, "a wiped team still has upgrade options");
});

test("full match with a between-round draft: an upgrade is drafted and persists into the next round", async () => {
  const state = buildMatch({ ...DRAFT });
  let drafts = 0;
  await runMatch(state, (s, side) => defaultPolicy(s, side), {
    roundsToWin: 2, maxTurns: 200,
    onBetweenRounds: (s) => {
      for (const side of ["A", "B"] as const) {
        for (const res of applyDraftChoices(s, side, autoDraft(s, side))) if (res.ok) drafts++;
      }
    },
  });
  assert.ok(drafts >= 1, "at least one upgrade drafted");
  const upgraded = Object.values(state.units).some((u) => u.kind === "hero" && (u.fused || (u.augments?.length ?? 0) > 0));
  assert.ok(upgraded, "a hero still carries its upgrade at match end (persisted across the round reset)");
});
