import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — statusApplied "eventUnit" recipient fix (formerly the "eventTarget" selector,
// which never resolves for statusApplied events, so these triggers silently never fired).
//
// maggie2 (Grasping Vines): frozen — "This effect will be cancelled if Maggie is stunned." The trigger
// fires when a status lands ON MAGGIE (eventUnit == self) while she holds a stun, and removes the
// pending "Grasping Vines" mark from every enemy — disarming the mark-guarded delayed hit + stun rider.
// eventUnit (the stun's RECIPIENT = Maggie) is the correct unit the frozen text intends.

function graspingMark() {
  return { kind: "mark", name: "Grasping Vines", duration: 2, appliedBy: "maggie", appliedTurn: 0, invisible: true };
}
function stun() {
  return { kind: "stun", duration: 1, appliedBy: "e", appliedTurn: 0 };
}
const hasGV = (u: { statuses: { kind: string; name?: string }[] }) =>
  u.statuses.some((s) => s.kind === "mark" && s.name === "Grasping Vines");

test("maggie2 Grasping Vines: a stun landing ON Maggie cancels her pending Vines (eventUnit = the stun recipient)", () => {
  // POSITIVE — the stun is applied to Maggie while she now holds a stun -> the enemy's pending mark is wiped.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const enemy = makeUnit({ id: "e", team: "B" });
    enemy.statuses.push(graspingMark() as never);
    maggie.statuses.push(stun() as never); // the stun landed (present when the trigger's `has stun of self` reads)
    const state = makeState([maggie], [enemy]);

    assert.equal(hasGV(enemy), true, "precondition: enemy carries the pending Grasping Vines mark");
    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "stun" });
    assert.equal(hasGV(enemy), false, "stun applied to Maggie cancels Grasping Vines (mark removed from enemy)");
  }

  // CONTROL A (recipient discriminator = the whole point of the fix) — Maggie IS stunned, but the
  // statusApplied event's recipient is the ENEMY, not Maggie. sameUnit[eventUnit,self] is false -> no fire.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const enemy = makeUnit({ id: "e", team: "B" });
    enemy.statuses.push(graspingMark() as never);
    maggie.statuses.push(stun() as never);
    const state = makeState([maggie], [enemy]);

    emit(state, { type: "statusApplied", unit: "e", source: "maggie", kind: "mark", name: "Grasping Vines" });
    assert.equal(hasGV(enemy), true, "a status landing on the ENEMY (not Maggie) must NOT cancel the Vines");
  }

  // CONTROL B (the `has stun of self` gate) — a status lands on Maggie while she is NOT stunned -> no fire.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    const enemy = makeUnit({ id: "e", team: "B" });
    enemy.statuses.push(graspingMark() as never);
    const state = makeState([maggie], [enemy]);

    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "mark", name: "Something Else" });
    assert.equal(hasGV(enemy), true, "an unrelated status on an un-stunned Maggie does not cancel the Vines");
  }
});

// maggie1 augment (Leeching Briars): frozen — "When Maggie gains Elemental Essence from Bramblelash,
// she heals 5 health for every stack of Curse of Thorns on her." Modeled as a statusApplied proxy:
// when a status lands ON MAGGIE (eventUnit == self) and she now holds elemental_essence, she heals
// 5 x Curse-of-Thorns stacks. eventUnit (the essence recipient = Maggie) is the correct unit.

function essence() {
  return { kind: "elemental_essence", duration: null, appliedBy: "maggie", appliedTurn: 0 };
}
function curseStacks(n: number) {
  return { kind: "stack", name: "Curse of Thorns", magnitude: n, duration: null, appliedBy: "maggie", appliedTurn: 0 };
}

test("maggie1 Leeching Briars: gaining Elemental Essence heals 5 per Curse of Thorns stack (eventUnit = the essence recipient)", () => {
  // POSITIVE — essence lands on Maggie while she holds 3 Curse stacks -> heal 5 x 3 = 15.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    applyAugment(maggie, augmentById("maggie1")!);
    maggie.hp = 50;
    maggie.statuses.push(curseStacks(3) as never);
    maggie.statuses.push(essence() as never); // essence now held (the trigger's `has elemental_essence of self` gate)
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);

    emit(state, { type: "statusApplied", unit: "maggie", source: "maggie", kind: "elemental_essence" });
    assert.equal(maggie.hp, 65, "gaining Elemental Essence heals 5 x 3 Curse of Thorns stacks");
  }

  // CONTROL A (recipient discriminator) — essence-holding Maggie, but the status lands on the ENEMY.
  // sameUnit[eventUnit,self] false -> no heal for Maggie.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    applyAugment(maggie, augmentById("maggie1")!);
    maggie.hp = 50;
    maggie.statuses.push(curseStacks(3) as never);
    maggie.statuses.push(essence() as never);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);

    emit(state, { type: "statusApplied", unit: "e", source: "maggie", kind: "mark", name: "Whatever" });
    assert.equal(maggie.hp, 50, "a status landing on the enemy must NOT heal Maggie");
  }

  // CONTROL B (the `has elemental_essence of self` gate) — status lands on Maggie but she holds NO
  // essence (this application was not an essence gain) -> no heal.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    applyAugment(maggie, augmentById("maggie1")!);
    maggie.hp = 50;
    maggie.statuses.push(curseStacks(3) as never);
    const state = makeState([maggie], [makeUnit({ id: "e", team: "B" })]);

    emit(state, { type: "statusApplied", unit: "maggie", source: "maggie", kind: "mark", name: "Bramblelash" });
    assert.equal(maggie.hp, 50, "a non-essence status on Maggie does not trigger the Leeching Briars heal");
  }
});
