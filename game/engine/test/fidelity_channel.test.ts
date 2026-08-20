import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, runChannels, effectiveCost } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers the custom/augment handlers
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";

// Engine-fidelity PR3 — channel + live-value debt retired:
//   galazax1 "Twin Storms" → channelCopies (N concurrent copies of one Channel skill) + statusCount ref
//   saya2    "Link Coils"   → coil_damage_bonus (live per-hit coil bonus) + statusMag ref

// --- galazax1 / channelCopies ------------------------------------------------- //

function channelHero() {
  const hero = makeUnit({ id: "h", team: "A" });
  hero.skills = [
    skill("chan", [{ op: "damage", amount: 5, to: { faction: "enemies" } }], {
      tags: ["Channel", "Harmful"], targeting: "all-enemies", channelTurns: null, channelCopies: 2,
      requires: { cmp: "<", left: { ref: "statusCount", kind: "channeling", name: "chan", of: "self" }, right: 2 },
      cost: { generic: 0, specific: 0 },
    }),
    skill("other", [], { tags: [], targeting: "self", cost: { generic: 0, specific: 0 } }),
  ];
  return hero;
}

test("channelCopies: a 2-copy channel installs two concurrent instances, both re-run each turn; a 3rd is blocked", () => {
  const hero = channelHero();
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([hero], [enemy]);

  assert.equal(performAction(state, { unit: "h", skillId: "chan" }).ok, true, "first copy casts");
  assert.equal(hero.statuses.filter((s) => s.kind === "channeling").length, 1);
  assert.equal(performAction(state, { unit: "h", skillId: "chan" }).ok, true, "second copy casts (sibling preserved)");
  const chans = hero.statuses.filter((s) => s.kind === "channeling");
  assert.equal(chans.length, 2, "two concurrent channeling instances");
  assert.deepEqual(chans.map((s) => s.instanceId).sort(), ["chan#0", "chan#1"], "distinct instanceIds");

  const third = performAction(state, { unit: "h", skillId: "chan" });
  assert.equal(third.ok, false, "a 3rd copy is blocked");
  assert.equal(third.reason, "requirements-not-met");

  // Both copies re-run at a turn: 2 × 5 = 10 to the enemy.
  enemy.hp = 100;
  runChannels(state, "A");
  assert.equal(enemy.hp, 90, "both channel copies re-ran independently");
});

test("channelCopies: a FINITE multi-copy channel drops only the expiring copy, not its siblings", () => {
  const hero = makeUnit({ id: "h", team: "A" });
  hero.skills = [
    skill("chan", [{ op: "damage", amount: 5, to: { faction: "enemies" } }], {
      tags: ["Channel", "Harmful"], targeting: "all-enemies", channelTurns: 3, channelCopies: 2,
      requires: { cmp: "<", left: { ref: "statusCount", kind: "channeling", name: "chan", of: "self" }, right: 2 },
      cost: { generic: 0, specific: 0 },
    }),
  ];
  const enemy = makeUnit({ id: "e", team: "B", hp: 200 });
  const state = makeState([hero], [enemy]);

  performAction(state, { unit: "h", skillId: "chan" });          // copy0 installed, magnitude 3
  runChannels(state, "A");                                        // copy0 → 2
  performAction(state, { unit: "h", skillId: "chan" });          // copy1 installed, magnitude 3 (sibling preserved)
  runChannels(state, "A");                                        // copy0 → 1, copy1 → 2
  runChannels(state, "A");                                        // copy0 → 0 (removed), copy1 → 1 (SURVIVES)

  const chans = hero.statuses.filter((s) => s.kind === "channeling");
  assert.equal(chans.length, 1, "only the expiring copy was removed; the younger copy still ticks");
  assert.equal(chans[0]!.instanceId, "chan#1");
});

test("channelCopies: casting a different skill cancels ALL copies of the channel", () => {
  const hero = channelHero();
  const enemy = makeUnit({ id: "e", team: "B", hp: 100 });
  const state = makeState([hero], [enemy]);
  performAction(state, { unit: "h", skillId: "chan" });
  performAction(state, { unit: "h", skillId: "chan" });
  assert.equal(hero.statuses.filter((s) => s.kind === "channeling").length, 2);

  performAction(state, { unit: "h", skillId: "other" }); // a non-channel skill interrupts
  assert.equal(hero.statuses.filter((s) => s.kind === "channeling").length, 0, "all channel copies cancelled");
});

test("galazax1 Twin Storms sets channelCopies=2 + a '< 2 live copies' requires gate on The Sky Darkens", () => {
  const g = loadHero(heroById("galazax"), "A", "galazax");
  applyAugment(g, augmentById("galazax1")!);
  const sk = (g.skills ?? []).find((s) => s.id === "galazax1")!;
  assert.equal(sk.channelCopies, 2, "channelCopies set");
  assert.deepEqual(sk.requires, { cmp: "<", left: { ref: "statusCount", kind: "channeling", name: "galazax1", of: "self" }, right: 2 }, "base single-copy gate relaxed to < 2");
});

// --- saya2 / coil_damage_bonus ------------------------------------------------ //

function sayaWithCoils(coils: number) {
  const saya = loadHero(heroById("saya"), "A", "saya");
  saya.statuses.push({ kind: "stack", name: "Saya Coil", magnitude: coils, duration: null, appliedBy: "saya", appliedTurn: 0 });
  return saya;
}

test("saya2 Link Coils: each coil deals +5 per active coil (unaugmented ticks are unchanged)", () => {
  // Baseline: 3 coils tick 10 each = 30 onto the sole enemy.
  const base = sayaWithCoils(3);
  const be = makeUnit({ id: "e", team: "B", hp: 100 });
  const s1 = makeState([base], [be]);
  emit(s1, { type: "turnEnd", team: "A" });
  assert.equal(be.hp, 70, "unaugmented: 10 × 3 coils = 30");

  // Augmented: coil_damage_bonus=5 → each coil deals 10 + 5×3 = 25, so 25 × 3 = 75.
  const aug = sayaWithCoils(3);
  applyAugment(aug, augmentById("saya2")!);
  const ae = makeUnit({ id: "e2", team: "B", hp: 100 });
  const s2 = makeState([aug], [ae]);
  emit(s2, { type: "turnEnd", team: "A" });
  assert.equal(ae.hp, 25, "Link Coils: (10 + 5×3) × 3 = 75");
});

// A quick statusMag sanity check via effectiveCost is not applicable; the coil test above exercises both
// the statusMag ref (the bonus) and its live recomputation from the current coil count.
void effectiveCost;
