import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — Tidecaller Zev'kir, the two `statusApplied` triggers whose gate was fixed from
// the (never-resolving) `eventTarget` selector to `eventUnit` (the status recipient).
//
// statusApplied carries the recipient in `event.unit` — it has NO `target` field, so an `eventTarget`
// selector resolved to nothing and the `sameUnit[eventTarget,self]` gate could never hold: both triggers
// silently never fired. The fix keys the gate on `eventUnit`, the unit the status just landed on.
//
// Both triggers below concern a status landing on ZEV'KIR HIMSELF (a Call Tides stack; a stun), so
// eventUnit (recipient) == self (the trigger owner) is exactly the recipient the frozen text intends.

const CT = (magnitude: number) => ({
  kind: "stack" as const, name: "Call Tides", magnitude, duration: null, appliedBy: "zev", appliedTurn: 0,
});
const hasEssence = (u: { statuses: { kind: string }[] }) => u.statuses.some((s) => s.kind === "elemental_essence");

// --------------------------------------------------------------------------------------------------- //
// Oceans Gather (zevkir0): "When Zev'kir reaches 1 stack of Call Tides, he gains Elemental Essence."
// Trigger: on statusApplied, when sameUnit[eventUnit,self] AND stackCount(Call Tides,self)==1 -> Essence.
// eventUnit is CORRECT: the Call Tides stack lands ON Zev'kir, and it is Zev'kir who gains Essence.
// --------------------------------------------------------------------------------------------------- //
test("Oceans Gather: reaching 1 Call Tides stack (a status landing on Zev'kir) grants Elemental Essence", () => {
  // Positive: Zev'kir now holds exactly 1 Call Tides stack; the stack-applied event lands on him -> Essence.
  {
    const zev = loadHero(heroById("zevkir"), "A", "zev");
    zev.statuses.push(CT(1));
    const e1 = makeUnit({ id: "e1", team: "B" });
    const state = makeState([zev], [e1]);

    assert.equal(hasEssence(state.units["zev"]!), false, "no Essence before the trigger fires");
    emit(state, { type: "statusApplied", unit: "zev", source: "zev", kind: "stack", name: "Call Tides" });
    assert.equal(hasEssence(state.units["zev"]!), true, "reaching 1 Call Tides stack -> Zev'kir gains Elemental Essence");
  }

  // Control A — wrong recipient (proves eventUnit resolves and the sameUnit gate blocks non-self recipients):
  // the status lands on the ENEMY while Zev'kir sits at 1 stack. eventUnit != self -> must NOT fire.
  {
    const zev = loadHero(heroById("zevkir"), "A", "zev");
    zev.statuses.push(CT(1));
    const e1 = makeUnit({ id: "e1", team: "B" });
    const state = makeState([zev], [e1]);

    emit(state, { type: "statusApplied", unit: "e1", source: "zev", kind: "stack", name: "Call Tides" });
    assert.equal(hasEssence(state.units["zev"]!), false, "a status on the enemy must not grant Zev'kir Essence");
    assert.equal(hasEssence(state.units["e1"]!), false, "the enemy gains nothing either");
  }

  // Control B — the ==1 threshold (proves it fires only on *reaching* 1, not every stack): Zev'kir holds 2
  // Call Tides stacks. A stack lands on him -> stackCount==2, gate fails, no additional Essence.
  {
    const zev = loadHero(heroById("zevkir"), "A", "zev");
    zev.statuses.push(CT(2));
    const e1 = makeUnit({ id: "e1", team: "B" });
    const state = makeState([zev], [e1]);

    emit(state, { type: "statusApplied", unit: "zev", source: "zev", kind: "stack", name: "Call Tides" });
    assert.equal(hasEssence(state.units["zev"]!), false, "at 2 stacks the ==1 gate fails -> no Essence");
  }
});

// --------------------------------------------------------------------------------------------------- //
// Bubble Prison (zevkir3): "...This skill will end if Zev'kir is stunned."
// Trigger: on statusApplied, when sameUnit[eventUnit,self] AND has(stun,self) -> remove the Bubble Prison
// dot from all enemies. eventUnit is CORRECT: the stun lands ON Zev'kir; his own stun ends his channel.
// --------------------------------------------------------------------------------------------------- //
const hasBubble = (u: { statuses: { kind: string; name?: string }[] }) =>
  u.statuses.some((s) => s.kind === "dot" && s.name === "Bubble Prison");

const bubbleState = (zevStunned: boolean) => {
  const zev = loadHero(heroById("zevkir"), "A", "zev");
  if (zevStunned) zev.statuses.push({ kind: "stun", duration: 1, appliedBy: "x", appliedTurn: 0 });
  const e1 = makeUnit({
    id: "e1", team: "B",
    statuses: [{ kind: "dot", name: "Bubble Prison", magnitude: 15, dtype: "normal", duration: 3, appliedBy: "zev", appliedTurn: 0 }],
  });
  return makeState([zev], [e1]);
};

test("Bubble Prison ends when Zev'kir is stunned; it persists when he is not", () => {
  // Positive: Zev'kir holds a stun; the stun-applied event lands on him -> the enemy's Bubble Prison dot is removed.
  {
    const state = bubbleState(true);
    assert.equal(hasBubble(state.units["e1"]!), true, "enemy has Bubble Prison before the stun resolves");
    emit(state, { type: "statusApplied", unit: "zev", source: "e1", kind: "stun" });
    assert.equal(hasBubble(state.units["e1"]!), false, "Zev'kir stunned -> Bubble Prison ends (dot removed from enemies)");
  }

  // Control 1 — Zev'kir is NOT stunned (the has(stun,self) gate fails): a status landing on him leaves the dot intact.
  {
    const state = bubbleState(false);
    emit(state, { type: "statusApplied", unit: "zev", source: "e1", kind: "root" });
    assert.equal(hasBubble(state.units["e1"]!), true, "no stun on Zev'kir -> Bubble Prison persists");
  }

  // Control 2 — wrong recipient (proves the sameUnit[eventUnit,self] gate): the status lands on the enemy, not
  // Zev'kir, even though Zev'kir happens to be stunned. eventUnit != self -> must NOT end Bubble Prison.
  {
    const state = bubbleState(true);
    emit(state, { type: "statusApplied", unit: "e1", source: "zev", kind: "stack", name: "Call Tides" });
    assert.equal(hasBubble(state.units["e1"]!), true, "a status on the enemy must not end Bubble Prison");
  }
});
