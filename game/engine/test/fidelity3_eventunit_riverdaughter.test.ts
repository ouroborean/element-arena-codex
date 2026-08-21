import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import type { FusionForm } from "../content/fusion.ts";
import { makeState, makeUnit } from "./helpers.ts";

// Fidelity Campaign 3 — The River Daughter, the `statusApplied` triggers whose gate was fixed from the
// (never-resolving) `eventTarget` selector to `eventUnit` (the status recipient).
//
// statusApplied carries the recipient in `event.unit` — it has NO `target` field, so an `eventTarget`
// selector resolved to nothing. In these gates that meant `has(stun, eventTarget)` fell back to `self`
// (resolveOne's `?? ctx.caster`), and `sameUnit[eventTarget,self]` could never hold — the triggers
// silently never fired. The fix keys the gate on `eventUnit`, the unit the status just landed on.
//
// Healing Tears' STUN half fires when River Daughter STUNS AN ENEMY: the stun's source is herself and the
// recipient (eventUnit) is the enemy who now holds the stun — exactly what `has(stun, eventUnit)` reads.
// The isolation used below keeps `source == rd` fixed and moves only WHERE the stun sits: on the enemy
// (eventUnit, positive) vs. on River Daughter herself (control). A gate that read `self` instead of
// `eventUnit` would fire the control off her own stun; the fixed gate must not.

const stun = (appliedBy: string) => ({ kind: "stun" as const, duration: 1, appliedBy, appliedTurn: 0 });
const essence = (appliedBy: string) => ({ kind: "elemental_essence" as const, duration: null, appliedBy, appliedTurn: 0 });

type U = { statuses: { kind: string; name?: string; magnitude?: number; duration?: number | null }[]; hp: number; maxHp: number };
const hasEssence = (u: U) => u.statuses.some((s) => s.kind === "elemental_essence");
const essenceCount = (u: U) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const regen = (u: U, name: string) => u.statuses.find((s) => s.kind === "regen" && s.name === name);
const storedStack = (u: U) => u.statuses.find((s) => s.kind === "stack" && s.name === "Blood in the Water");

/** rd (fused into `key` if given) + a plain ally hero + one enemy, all in a fresh state. */
function setup(key?: string) {
  const rd = loadHero(heroById("riverdaughter"), "A", "rd");
  if (key) {
    const form = fusionForm("riverdaughter", key);
    assert.ok(form, `fusion form riverdaughter:${key} must exist`);
    applyFusion(rd, form as FusionForm);
  }
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const enemy = makeUnit({ id: "e1", team: "B", name: "Enemy" });
  const state = makeState([rd, ally], [enemy]);
  return { state, rd, ally, enemy };
}

// --------------------------------------------------------------------------------------------------- //
// Healing Tears (riverdaughter0) — the STUN half of "Whenever River Daughter counters or stuns an enemy,
// she heals her team for 5 HP every turn for 3 turns ... she gains Elemental Essence."
// eventUnit is CORRECT: it is the STUNNED ENEMY that the gate `has(stun, eventUnit)` must read.
// --------------------------------------------------------------------------------------------------- //
test("Healing Tears: stunning an enemy heals the team (regen 5/3) and grants Essence; her own stun does not", () => {
  // Positive — the stun lands on the ENEMY (applied by River Daughter). eventUnit == enemy, which holds stun.
  {
    const { state, rd, ally, enemy } = setup();
    enemy.statuses.push(stun("rd"));
    assert.equal(!!regen(rd, "Healing Tears"), false, "no Healing Tears regen before the trigger fires");

    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(regen(rd, "Healing Tears")?.magnitude, 5, "self healed: Healing Tears regen 5");
    assert.equal(regen(rd, "Healing Tears")?.duration, 3, "Healing Tears lasts 3 turns");
    assert.equal(regen(ally, "Healing Tears")?.magnitude, 5, "ally healed: Healing Tears regen 5");
    assert.equal(hasEssence(rd), true, "stunning an enemy grants River Daughter Elemental Essence");
  }

  // Control — the stun sits on RIVER DAUGHTER HERSELF; the enemy is NOT stunned. Only the event's `unit`
  // differs (still source==rd). eventUnit == enemy (no stun) -> gate fails; a `self`-reading gate would fire.
  {
    const { state, rd, ally } = setup();
    rd.statuses.push(stun("e1")); // she is stunned, the enemy is not
    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(!!regen(rd, "Healing Tears"), false, "her own stun (eventUnit != stunned enemy) must not heal the team");
    assert.equal(!!regen(ally, "Healing Tears"), false, "ally not healed by her own stun");
    assert.equal(hasEssence(rd), false, "no Essence off her own stun");
  }
});

// --------------------------------------------------------------------------------------------------- //
// Triton's Blessing (riverdaughterocean0) — the ocean form keeps Healing Tears' stun half, renamed to a
// "Triton's Blessing" regen (5/3) + Essence. Same eventUnit == stunned enemy correctness.
// --------------------------------------------------------------------------------------------------- //
test("Triton's Blessing (ocean): stunning an enemy grants a Triton's Blessing regen + Essence; her own stun does not", () => {
  // Positive.
  {
    const { state, rd, ally, enemy } = setup("ocean");
    enemy.statuses.push(stun("rd"));
    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(regen(rd, "Triton's Blessing")?.magnitude, 5, "self healed: Triton's Blessing regen 5");
    assert.equal(regen(rd, "Triton's Blessing")?.duration, 3, "Triton's Blessing lasts 3 turns");
    assert.equal(regen(ally, "Triton's Blessing")?.magnitude, 5, "ally healed: Triton's Blessing regen 5");
    assert.equal(hasEssence(rd), true, "stunning an enemy grants Elemental Essence");
  }

  // Control — she is stunned, the enemy is not; eventUnit == enemy (no stun) -> no heal.
  {
    const { state, rd, ally } = setup("ocean");
    rd.statuses.push(stun("e1"));
    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(!!regen(rd, "Triton's Blessing"), false, "her own stun must not grant a Triton's Blessing regen");
    assert.equal(!!regen(ally, "Triton's Blessing"), false, "ally not healed");
    assert.equal(hasEssence(rd), false, "no Essence off her own stun");
  }
});

// --------------------------------------------------------------------------------------------------- //
// Conducted Emotion (riverdaughtercurrent0) — TWO statusApplied triggers.
//   Trigger A (stun half): "Healing Tears now lasts one turn and heals 10 health" -> regen 10/1 + Essence.
//     eventUnit == stunned enemy (correct).
//   Trigger B (essence half): "it also activates whenever she gains Elemental Essence from another source.
//     Triggering Healing Tears this way will not give River Daughter Elemental Essence."
//     eventUnit is CORRECT and is a DIFFERENT recipient than the stun half: here the status (the essence)
//     lands ON RIVER DAUGHTER, so the gate `sameUnit[eventUnit,self]` scopes it to "SHE gains essence".
// --------------------------------------------------------------------------------------------------- //
test("Conducted Emotion (current) A: stunning an enemy heals 10/1 + Essence; her own stun does not", () => {
  // Positive.
  {
    const { state, rd, ally, enemy } = setup("current");
    enemy.statuses.push(stun("rd"));
    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(regen(rd, "Healing Tears")?.magnitude, 10, "self healed: Healing Tears regen 10 (Conducted Emotion)");
    assert.equal(regen(rd, "Healing Tears")?.duration, 1, "Conducted Emotion: Healing Tears now lasts 1 turn");
    assert.equal(regen(ally, "Healing Tears")?.magnitude, 10, "ally healed: Healing Tears regen 10");
    assert.equal(hasEssence(rd), true, "stunning an enemy grants Elemental Essence");
  }

  // Control — her own stun; enemy not stunned; eventUnit == enemy (no stun) -> no heal.
  {
    const { state, rd, ally } = setup("current");
    rd.statuses.push(stun("e1"));
    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(!!regen(rd, "Healing Tears"), false, "her own stun must not heal the team");
    assert.equal(!!regen(ally, "Healing Tears"), false, "ally not healed");
    assert.equal(hasEssence(rd), false, "no Essence off her own stun");
  }
});

test("Conducted Emotion (current) B: her gaining Essence re-triggers Healing Tears (heal only); an ally's Essence does not", () => {
  // Positive — the essence lands ON River Daughter (from an external source e1). eventUnit == rd == self.
  // Trigger B heals the team (regen 10/1) but must NOT grant her further Essence (only the one she already holds).
  {
    const { state, rd, ally } = setup("current");
    rd.statuses.push(essence("e1")); // she has just gained Essence from another source (gate reads `has essence`)
    assert.equal(!!regen(rd, "Healing Tears"), false, "no Healing Tears regen before the essence event");

    emit(state, { type: "statusApplied", unit: "rd", source: "e1", kind: "elemental_essence" });

    assert.equal(regen(rd, "Healing Tears")?.magnitude, 10, "gaining Essence heals the team: regen 10");
    assert.equal(regen(rd, "Healing Tears")?.duration, 1, "regen lasts 1 turn");
    assert.equal(regen(ally, "Healing Tears")?.magnitude, 10, "ally healed too");
    assert.equal(essenceCount(rd), 1, "triggering Healing Tears this way does NOT give River Daughter more Essence");
  }

  // Control — the essence lands on the ALLY, not River Daughter. She ALSO holds Essence, so the ONLY
  // difference from the positive is the event's `unit` (a2 vs rd). eventUnit == a2 != self -> must NOT fire.
  {
    const { state, rd, ally } = setup("current");
    rd.statuses.push(essence("e1"));
    ally.statuses.push(essence("e1"));

    emit(state, { type: "statusApplied", unit: "a2", source: "e1", kind: "elemental_essence" });

    assert.equal(!!regen(rd, "Healing Tears"), false, "an ally gaining Essence (eventUnit != self) must not heal the team");
    assert.equal(!!regen(ally, "Healing Tears"), false, "no team heal off the ally's Essence");
  }
});

// Conducted Emotion (current) B — "from ANOTHER source": essence River Daughter grants HERSELF (source==self,
// e.g. via Healing Tears' own counter/stun halves) must NOT re-fire the essence half (that was the loop the
// author flagged). Only an external essence gain counts. (Gate now: eventStatusKind essence + eventUnit==self
// + eventSource != self.)
test("Conducted Emotion (current) B: essence she grants HERSELF does not re-fire Healing Tears", () => {
  const { state, rd, ally } = setup("current");
  rd.statuses.push(essence("rd")); // self-granted
  emit(state, { type: "statusApplied", unit: "rd", source: "rd", kind: "elemental_essence" });

  assert.equal(!!regen(rd, "Healing Tears"), false, "self-granted essence (source==self) must not re-fire Healing Tears");
  assert.equal(!!regen(ally, "Healing Tears"), false, "no team heal from her own essence grant (no loop)");
});

// Blood in the Water (blood) — the bonus is ADDITIVE ("10 additional health"): the base Healing Tears
// (regen 5/3 + Essence) is preserved on top of the +10-per-40 instant heal (replace-mode fusion had dropped it).
test("Blood in the Water (blood): base Healing Tears (regen 5/3 + Essence) applies IN ADDITION to +10/40", () => {
  const { state, rd, ally, enemy } = setup("blood");
  rd.hp = 50; ally.hp = 50;
  rd.statuses.push({ kind: "stack", name: "Blood in the Water", magnitude: 80, duration: null, appliedBy: "rd", appliedTurn: 0 });
  enemy.statuses.push(stun("rd"));

  emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

  assert.equal(regen(rd, "Healing Tears")?.magnitude, 5, "base Healing Tears regen 5 is preserved");
  assert.equal(regen(rd, "Healing Tears")?.duration, 3, "base regen lasts 3 turns");
  assert.equal(regen(ally, "Healing Tears")?.magnitude, 5, "ally gets the base regen too");
  assert.equal(hasEssence(rd), true, "River Daughter gains Essence (base Healing Tears)");
  assert.equal(rd.hp, 70, "the +20 blood bonus (10 per 40 of 80 stored) still applies instantly");
  assert.equal(storedStack(rd), undefined, "stored damage emptied");
});

// --------------------------------------------------------------------------------------------------- //
// Bubbling Mire (riverdaughterslime0) — the slime form routes Healing Tears' stun half into "Congeal"
// (riverdaughterslime1), which heals allied Slime minions +15 (overheal -> Max HP).
// eventUnit == stunned enemy (correct).
// --------------------------------------------------------------------------------------------------- //
test("Bubbling Mire (slime): stunning an enemy casts Congeal to heal a Slime minion; her own stun does not", () => {
  const slimeState = () => {
    const rd = loadHero(heroById("riverdaughter"), "A", "rd");
    const form = fusionForm("riverdaughter", "slime");
    assert.ok(form, "fusion form riverdaughter:slime must exist");
    applyFusion(rd, form as FusionForm);
    const slime = makeUnit({ id: "sl1", team: "A", name: "Slime", kind: "minion", hp: 5, maxHp: 15, summoner: "rd" });
    const enemy = makeUnit({ id: "e1", team: "B", name: "Enemy" });
    const state = makeState([rd, slime], [enemy]);
    return { state, rd, slime, enemy };
  };

  // Positive — stun on the enemy -> Congeal fires -> the damaged Slime heals +15 (5 -> 20, overheal to Max HP).
  {
    const { state, rd, slime, enemy } = slimeState();
    enemy.statuses.push(stun("rd"));
    assert.equal(slime.hp, 5, "Slime starts damaged");

    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(state.units["sl1"]!.hp, 20, "Congeal healed the Slime +15 (overheal past Max HP)");
    assert.equal(state.units["sl1"]!.maxHp, 20, "the overheal became Max HP");
  }

  // Control — she is stunned, the enemy is not; eventUnit == enemy (no stun) -> Congeal does not fire.
  {
    const { state, rd, slime } = slimeState();
    rd.statuses.push(stun("e1"));
    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(state.units["sl1"]!.hp, 5, "her own stun must not cast Congeal; the Slime stays damaged");
  }
});

// --------------------------------------------------------------------------------------------------- //
// Blood in the Water (riverdaughterblood0) — "Whenever Healing Tears triggers, she heals her team for 10
// additional health for every 40 damage stored, emptying the stored damage." The stun half carries this.
// eventUnit == stunned enemy (correct).
// --------------------------------------------------------------------------------------------------- //
test("Blood in the Water (blood): stunning an enemy spends stored damage into a team heal; her own stun does not", () => {
  const bloodStack = () => ({ kind: "stack" as const, name: "Blood in the Water", magnitude: 80, duration: null, appliedBy: "rd", appliedTurn: 0 });

  // Positive — 80 stored -> floor(80/40)=2 -> +20 HP to the team; the stored stack is emptied afterward.
  {
    const { state, rd, ally, enemy } = setup("blood");
    rd.hp = 50; ally.hp = 50;
    rd.statuses.push(bloodStack());
    enemy.statuses.push(stun("rd"));

    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(rd.hp, 70, "self healed +20 (10 per 40 of 80 stored)");
    assert.equal(ally.hp, 70, "ally healed +20");
    assert.equal(storedStack(rd), undefined, "the stored damage was emptied");
  }

  // Control — her own stun; enemy not stunned; eventUnit == enemy (no stun) -> no heal, stored damage kept.
  {
    const { state, rd, ally } = setup("blood");
    rd.hp = 50; ally.hp = 50;
    rd.statuses.push(bloodStack());
    rd.statuses.push(stun("e1"));

    emit(state, { type: "statusApplied", unit: "e1", source: "rd", kind: "stun" });

    assert.equal(rd.hp, 50, "her own stun must not heal");
    assert.equal(ally.hp, 50, "ally not healed");
    assert.equal(storedStack(rd)?.magnitude, 80, "stored damage is retained (nothing triggered)");
  }
});
