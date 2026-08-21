import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — statusApplied over-fire fix, maggie1 "Leeching Briars".
//
// Frozen (augments.json / augments.authored.json, id "maggie1"): "When Maggie gains Elemental Essence
// from Bramblelash, she heals 5 health for every stack of Curse of Thorns on her." Modeled as a
// statusApplied proxy. The FIXED trigger's gate is:
//   and[ sameUnit[eventUnit, self], eventStatusKind:"elemental_essence" ]  -> heal 5 x stackCount(Curse of Thorns) to self.
//
// The bug this locks in: the gate USED to be a STATE check `has(elemental_essence, self)`, which is true
// for EVERY status that lands on Maggie while she still holds an Essence stack — so an unrelated mark, stun,
// etc. would each re-fire the leech heal. The fix keys on the APPLIED status's kind (eventStatusKind), so
// only an actual Elemental Essence application heals.

function essence() {
  return { kind: "elemental_essence", duration: null, appliedBy: "maggie", appliedTurn: 0 };
}
function curseStacks(n: number) {
  return { kind: "stack", name: "Curse of Thorns", magnitude: n, duration: null, appliedBy: "maggie", appliedTurn: 0 };
}

test("maggie1 Leeching Briars: only an Elemental Essence application heals; a different status on an essence-holding Maggie does not", () => {
  // POSITIVE — an Elemental Essence status lands ON Maggie (kind == elemental_essence) while she holds 3
  // Curse of Thorns stacks -> she heals 5 x 3 = 15 (50 -> 65). Source is another unit (she "gains" it).
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    applyAugment(maggie, augmentById("maggie1")!);
    maggie.hp = 50;
    maggie.statuses.push(curseStacks(3) as never);
    maggie.statuses.push(essence() as never); // she now holds the freshly-gained Essence
    const enemy = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [enemy]);

    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "elemental_essence" });
    assert.equal(maggie.hp, 65, "gaining Elemental Essence heals 5 x 3 Curse of Thorns stacks (50 -> 65)");
  }

  // OVER-FIRE CONTROL (the fixed bug) — Maggie ALREADY holds Elemental Essence (and 3 Curse stacks), but the
  // status that now lands on her is a DIFFERENT one (kind:"mark", name:"Decoy"), not an Essence gain.
  // Pre-fix, the gate `has(elemental_essence, self)` was satisfied by the essence she still carries, so this
  // spuriously re-ran the leech heal. The fixed gate `eventStatusKind:"elemental_essence"` requires the
  // APPLIED status itself to be Essence -> a mark application must NOT heal.
  {
    const maggie = loadHero(heroById("maggie"), "A", "maggie");
    applyAugment(maggie, augmentById("maggie1")!);
    maggie.hp = 50;
    maggie.statuses.push(curseStacks(3) as never);
    maggie.statuses.push(essence() as never); // she is STILL holding Essence from a prior real gain
    const enemy = makeUnit({ id: "e", team: "B" });
    const state = makeState([maggie], [enemy]);

    emit(state, { type: "statusApplied", unit: "maggie", source: "e", kind: "mark", name: "Decoy" });
    assert.equal(maggie.hp, 50, "a non-Essence status on an essence-holding Maggie must NOT re-fire the leech heal");
  }
});
