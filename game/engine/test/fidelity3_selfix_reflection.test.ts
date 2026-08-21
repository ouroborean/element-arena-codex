import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — The River Daughter, mirror form "Reflection of Kindness" (riverdaughtermirror0).
//
// Frozen prose: "River Daughter stores all healing received by the ENEMY team. Each time she accumulates
// 50 total healing, she gains Elemental Essence and deals 15 Affliction damage to all enemies."
//
// The passive reacts to `healReceived`. That event carries the recipient in `event.unit` — it has NO
// `target` field, so the pre-fix gate selector `eventTarget` never resolved and the `isFaction` check
// silently ran against a fallback unit. The fix keys the faction gate on `eventUnit` (the heal's
// recipient): `{ isFaction: "eventUnit", faction: "enemy" }`. Only when an ENEMY received the heal does
// custom `storeHealing` bank `event.amount` into a "Reflection of Kindness" stack on River Daughter.
//
// The observable is that stack: kind:"stack", name:"Reflection of Kindness", magnitude == running total.
// POSITIVE — an enemy's heal grows the tally by the heal amount. CONTROL — an ALLY's heal (eventUnit is
// an ally, not an enemy) must NOT grow the tally at all: no stack is banked. Amounts stay below 50 so the
// threshold branch (Essence + 15 Affliction) is not crossed and the raw tally is read cleanly.

type Stat = { kind: string; name?: string; magnitude?: number; duration?: number | null };
type U = { statuses: Stat[]; hp: number };
const tally = (u: U): Stat | undefined =>
  u.statuses.find((s) => s.kind === "stack" && s.name === "Reflection of Kindness");
const tallyMag = (u: U): number => tally(u)?.magnitude ?? 0;
const hasEssence = (u: U): boolean => u.statuses.some((s) => s.kind === "elemental_essence");

/** River Daughter fused into the mirror form + one ally + one enemy, in a fresh state. */
function setup() {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  const form = fusionForm("riverdaughter", "mirror");
  assert.ok(form, "fusion form riverdaughter:mirror must exist");
  applyFusion(rd, form as FusionForm);
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally", hp: 40, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", name: "Enemy", hp: 40, maxHp: 100 });
  const state = makeState([rd, ally], [enemy]);
  return { state, rd, ally, enemy };
}

// --------------------------------------------------------------------------------------------------- //
// POSITIVE — healing received by an ENEMY banks into the "Reflection of Kindness" tally on River Daughter,
// and accumulates across multiple enemy heals. eventUnit == the enemy recipient (faction "enemy" holds).
// --------------------------------------------------------------------------------------------------- //
test("Reflection of Kindness: an enemy's healing banks into River Daughter's tally and accumulates", () => {
  const { state, rd, enemy } = setup();
  assert.equal(tallyMag(rd), 0, "no Reflection of Kindness banked before any enemy heal");

  // Enemy e1 receives 10 healing (self-heal: source == recipient == the enemy).
  emit(state, { type: "healReceived", unit: "e1", source: "e1", amount: 10 });
  assert.equal(tallyMag(rd), 10, "the 10 healing the enemy received was banked onto River Daughter");

  // A second enemy heal accumulates on top (10 + 15 = 25), still below the 50 threshold.
  emit(state, { type: "healReceived", unit: "e1", source: "e1", amount: 15 });
  assert.equal(tallyMag(rd), 25, "enemy healing accumulates: 10 + 15 = 25 stored");

  // Below 50 total: the threshold reward has NOT fired.
  assert.equal(hasEssence(rd), false, "under 50 stored: no Elemental Essence yet");
  assert.equal(enemy.hp, 40, "under 50 stored: no 15 Affliction dealt to enemies yet");
});

// --------------------------------------------------------------------------------------------------- //
// CONTROL — the fix's point. Healing received by an ALLY must NOT bank anything. This is the ONLY change
// from the positive: the event's `unit` is the ally (a2) instead of the enemy (e1). eventUnit resolves to
// the ally, `isFaction:"eventUnit", faction:"enemy"` is false, so storeHealing never runs. Pre-fix, the
// unresolved `eventTarget` gate could not distinguish recipient factions correctly.
// --------------------------------------------------------------------------------------------------- //
test("Reflection of Kindness: an ALLY's healing does NOT bank into the tally (isFaction eventUnit enemy)", () => {
  const { state, rd, ally } = setup();
  assert.equal(tallyMag(rd), 0, "nothing banked to start");

  // Ally a2 receives 10 healing — same amount as the positive, but the recipient is an ally.
  emit(state, { type: "healReceived", unit: "a2", source: "a2", amount: 10 });

  assert.equal(tally(rd), undefined, "an ally's heal must not create a Reflection of Kindness stack");
  assert.equal(tallyMag(rd), 0, "the tally stays at 0 — only ENEMY healing is stored");
  assert.equal(ally.hp, 40, "sanity: the control event is a heal event, unrelated to the tally");
});
