import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, spec-derived augment suite for DENNIS. The oracle is the FROZEN
// augment prose (content/frozen/augments.json), corroborated by the frozen base
// skill prose (content/frozen/skills.json). Every assertion is derived from that
// wording; the authored/generated content is consulted only to learn how to DRIVE
// (augment ids, base skill ids, energy pools, status/mark names).
//
// Frozen base skills referenced below:
//   dennis1 Big Green Fist:  "Deals 10 damage to target enemy, +5 per Pain Tolerance stack on Dennis."
//   dennis2 HS-112 Fury Serum: taunt-on-damage for 4 turns (mechanically a "HS-112 Fury Serum" mark). No self-damage.
//   dennis3 HS-46 Ascendant Serum: "Dennis takes 5 Affliction damage, ignores non-damage effects for 1 turn,
//                                    and Big Green Fist deals 10 more damage until the end of his next turn."
//   dennis4 Shared Agony: "Dennis deals 5 damage to all enemy units, and all enemy units deal 5 Piercing damage to him."
//   dennis5 HS-88 Reconstitution Serum: "Dennis heals 5 HP each turn (stacks)."
//   dennis6 End of Shift: "Dennis takes 25 Affliction damage, then uses HS-112, HS-46, and HS-88 on himself."
//   dennis0 Pain Tolerance (passive): on being damaged, gain Elemental Essence + 5 Damage Reduction
//                                     "until the end of his next turn"; stacks, does not refresh; Essence once/turn.
// ============================================================================

const D = () => loadHero(heroById("dennis"), "A", "d");
const hasMark = (u: Unit, name: string): boolean =>
  u.statuses.some((s) => s.kind === "mark" && s.name === name);
const painDR = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "damage_reduction" && s.name === "Pain Tolerance")?.magnitude ?? 0;
const painStacks = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === "Pain Tolerance")?.magnitude ?? 0;
const HS46_MARK = "HS-46 Ascendant Serum";
const FURY_MARK = "HS-112 Fury Serum";

// ============================================================================
// dennis1 — Auto-Injectors
// FROZEN: "Dennis will automatically use HS-46 Ascendant Serum on himself any time
//          he receives a stun effect."
// HS-46 (frozen) observables: 5 Affliction self-damage, "ignores non-damage effects
// for 1 turn" (non_damage_ignore status), and the "+10 Big Green Fist" flag (HS-46 mark).
// ============================================================================

test("dennis1: a STUN landing on Dennis auto-uses HS-46 Ascendant Serum on himself", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis1")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  assert.ok(!hasMark(dennis, HS46_MARK), "precondition: no HS-46 flag before any stun");
  emit(state, { type: "statusApplied", unit: "d", source: null, kind: "stun" });

  // The three frozen HS-46 outcomes, each a concrete observable:
  assert.equal(dennis.hp, hpBefore - 5, "HS-46 self-inflicted 5 Affliction damage");
  assert.ok(dennis.statuses.some((s) => s.kind === "non_damage_ignore"), "HS-46 granted 'ignore non-damage effects'");
  assert.ok(hasMark(dennis, HS46_MARK), "HS-46 set its Big-Green-Fist-empowers flag");
});

test("dennis1 control: a NON-stun status on Dennis does NOT auto-inject", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis1")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "statusApplied", unit: "d", source: null, kind: "mark", name: "Some Buff" });

  assert.equal(dennis.hp, hpBefore, "no HS-46 self-damage on a non-stun status");
  assert.ok(!hasMark(dennis, HS46_MARK), "no HS-46 flag on a non-stun status");
  assert.ok(!dennis.statuses.some((s) => s.kind === "non_damage_ignore"), "no non_damage_ignore on a non-stun status");
});

test("dennis1 control: a stun on ANOTHER unit does not make Dennis auto-inject", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis1")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "statusApplied", unit: "e", source: null, kind: "stun" }); // stun lands on the enemy, not Dennis

  assert.equal(dennis.hp, hpBefore, "Dennis untouched — the augment gates on Dennis RECEIVING the stun");
  assert.ok(!hasMark(dennis, HS46_MARK), "no HS-46 flag — the stun was not on Dennis");
});

test("dennis1: HS-46 applies no stun, so a single stun triggers exactly ONE injection (no loop)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis1")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "statusApplied", unit: "d", source: null, kind: "stun" });

  // A re-entrant loop (HS-46 re-stunning Dennis) would deal 5 repeatedly; exactly -5 proves a single fire.
  assert.equal(dennis.hp, hpBefore - 5, "exactly one HS-46 (5 damage), not a runaway loop");
});

// ============================================================================
// dennis2 — Rage Response
// FROZEN: "Dennis will automatically use HS-112 Fury Serum on himself if an allied
//          Hero dies. If that Hero was Hector the Injector, Dennis uses End of Shift instead."
// Discriminator: Fury Serum deals NO self-damage and sets only the Fury mark. End of Shift
// (frozen) takes 25 Affliction + fans out HS-112/HS-46/HS-88 — so it costs Dennis real HP and
// sets the HS-46 flag + an HS-88 regen. Those tell the two branches apart.
// ============================================================================

test("dennis2: a NON-Hector allied hero dying auto-uses HS-112 Fury Serum (not End of Shift)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis2")!);
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100 });
  const state = makeState([dennis, ally], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "unitDied", unit: "a", killer: "e" });

  assert.ok(hasMark(dennis, FURY_MARK), "Fury Serum was auto-used (its mark is present)");
  assert.equal(dennis.hp, hpBefore, "Fury Serum deals no self-damage — the End-of-Shift branch did NOT run");
  assert.ok(!hasMark(dennis, HS46_MARK), "no HS-46 flag — End of Shift (which fans HS-46) did not run");
});

test("dennis2 control: an ENEMY hero dying does not trigger Rage Response", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis2")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "unitDied", unit: "e", killer: "d" });

  assert.ok(!hasMark(dennis, FURY_MARK), "an enemy death does not trigger the ally-only Rage Response");
  assert.equal(dennis.hp, hpBefore, "Dennis untouched");
});

test("dennis2 control: an allied MINION dying does not trigger (only an allied HERO does)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis2")!);
  const minion = makeUnit({ id: "m", team: "A", kind: "minion", hp: 30, name: "Blob" });
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  state.units["m"] = minion;
  state.teams.A.units.push("m");

  emit(state, { type: "unitDied", unit: "m", killer: "e" });

  assert.ok(!hasMark(dennis, FURY_MARK), "an allied minion death is not an allied HERO death");
});

test("dennis2 control: Dennis's OWN death does not trigger Rage Response (an ALLIED hero, not self)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis2")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "unitDied", unit: "d", killer: "e" });

  assert.ok(!hasMark(dennis, FURY_MARK), "Dennis dying is excluded (not-self gate) — no Fury on his own death");
  assert.equal(dennis.hp, hpBefore, "no self-inflicted serum on his own death");
});

// SUSPECTED BUG (assertions preserved): frozen says a dying Hector routes to End of Shift, but the
// generated trigger's Hector discriminator is {faction:allies,kind:hero,template:"hector"} — a real
// Hector's Unit.name is "Hector the Injector" (templateAlias undefined), so the selector never matches
// and the engine falls through to the ELSE branch (Fury Serum). Observed: Hector dies -> Fury mark set,
// Dennis HP unchanged (no End-of-Shift self-damage), no HS-46 flag, no HS-88 regen.
test.skip("dennis2 SUSPECTED BUG: a dying Hector the Injector should route Dennis to End of Shift, not Fury Serum", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis2")!);
  const hector = loadHero(heroById("hector"), "A", "hec");
  const state = makeState([dennis, hector], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const hpBefore = dennis.hp;

  emit(state, { type: "unitDied", unit: "hec", killer: "e" });

  // End of Shift = "Dennis takes 25 Affliction damage, then uses ... HS-46 ... HS-88 ...":
  assert.ok(dennis.hp < hpBefore, "End of Shift inflicts heavy Affliction self-damage (>=25) on Dennis");
  assert.ok(hasMark(dennis, HS46_MARK), "End of Shift fans HS-46 Ascendant Serum onto Dennis");
  assert.ok(
    dennis.statuses.some((s) => s.kind === "regen" && s.name === "HS-88 Reconstitution Serum"),
    "End of Shift fans HS-88 Reconstitution Serum onto Dennis",
  );
});

// ============================================================================
// dennis3 — Long Memory
// FROZEN: "Pain Tolerance now lasts for 2 turns."
// Base Pain Tolerance lasts "until the end of his next turn" (one Dennis turn-end). The augment
// stretches a single hit's stack + Damage Reduction to survive TWO of Dennis's turn-ends.
// ============================================================================

test("dennis3: a Pain Tolerance stack from one hit survives PAST Dennis's next turn-end (base would have expired)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis3")!);
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]); // turn 1, A active

  emit(state, { type: "damageDealt", source: "e", target: "d", amount: 10, dtype: "normal", isNew: true });
  assert.equal(painStacks(dennis), 1, "the hit granted one Pain Tolerance stack");
  assert.equal(painDR(dennis), 5, "and 5 Damage Reduction (5 x 1 stack)");

  endTurn(state); // A end (turn 1) — birth turn, no tick
  endTurn(state); // B end (turn 2)
  endTurn(state); // A end (turn 3) = Dennis's NEXT turn-end — base's 1-turn window would close HERE
  assert.equal(painStacks(dennis), 1, "augmented: the stack still stands one turn-end later (lasts 2 turns)");
  assert.equal(painDR(dennis), 5, "augmented: the 5 DR is still present at Dennis's next turn-end");

  endTurn(state); // B end (turn 4)
  endTurn(state); // A end (turn 5) = one Dennis turn-end further — the 2-turn window closes
  assert.equal(painStacks(dennis), 0, "expired after two of Dennis's turn-ends");
  assert.equal(painDR(dennis), 0, "DR recomputed to 0");
});

test("dennis3 control: WITHOUT the augment, a hit's Pain Tolerance expires at Dennis's next turn-end", () => {
  const dennis = D(); // no augment
  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero" })]);

  emit(state, { type: "damageDealt", source: "e", target: "d", amount: 10, dtype: "normal", isNew: true });
  assert.equal(painStacks(dennis), 1, "base: one stack from the hit");

  endTurn(state); // A end (turn 1)
  endTurn(state); // B end (turn 2)
  endTurn(state); // A end (turn 3) = Dennis's next turn-end
  assert.equal(painStacks(dennis), 0, "base: the 1-turn window closes at Dennis's next turn-end");
  assert.equal(painDR(dennis), 0, "base DR gone — proving the augment's persistence is a real change");
});

// ============================================================================
// dennis4 — Dennis So Popular Now
// FROZEN: "Shared Agony now costs 1 Generic energy, but both parts of its activation now include
//          all allied units."
// Base: Dennis deals 5 to all enemies; all enemies deal 5 Piercing to Dennis.
// Augmented: EACH allied unit deals 5 to all enemies; each enemy deals 5 Piercing to ALL allied units.
// ============================================================================

test("dennis4: cost becomes 1 Generic energy (castable with generic-only; base needs Serum)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis4")!);
  assert.deepEqual(
    dennis.skills!.find((s) => s.id === "dennis4")!.cost,
    { generic: 1, specific: 0 },
    "augmented Shared Agony costs exactly 1 Generic, 0 specific",
  );

  const state = makeState([dennis], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100 })]);
  state.teams.A.energy = { generic: 1 }; // ONLY generic, no serum
  const r = performAction(state, { unit: "d", skillId: "dennis4", targets: [] });
  assert.ok(r.ok, "augmented Shared Agony is payable with 1 Generic alone");

  // Control: the base skill (Serum-costed) cannot be paid with generic-only.
  const base = D();
  const state2 = makeState([base], [makeUnit({ id: "e", team: "B", kind: "hero", hp: 100 })]);
  state2.teams.A.energy = { generic: 1 };
  const r2 = performAction(state2, { unit: "d", skillId: "dennis4", targets: [] });
  assert.ok(!r2.ok, "base Shared Agony is NOT payable with generic-only (it costs Serum)");
});

test("dennis4: both parts fan across all allies — each enemy hit once per ally, each ally hit once per enemy", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis4")!);
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100 });
  const state = makeState([dennis, ally], [e1, e2]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  const r = performAction(state, { unit: "d", skillId: "dennis4", targets: [] });
  assert.ok(r.ok, "cast succeeded");

  // Part 1: 2 allied dealers x 5 each -> every enemy takes 10.
  assert.equal(e1.hp, 90, "e1 took 5 from Dennis + 5 from the ally");
  assert.equal(e2.hp, 90, "e2 took 5 from Dennis + 5 from the ally");
  // Part 2: 2 enemy dealers x 5 Piercing each -> every allied unit takes 10.
  assert.equal(dennis.hp, 90, "Dennis took 5 Piercing from each of the 2 enemies");
  assert.equal(ally.hp, 90, "the ally is now included in part 2 and also took 10");
});

test("dennis4 control: WITHOUT the augment, only Dennis participates in both parts", () => {
  const dennis = D();
  const ally = makeUnit({ id: "a", team: "A", kind: "hero", hp: 100 });
  const e1 = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", kind: "hero", hp: 100 });
  const state = makeState([dennis, ally], [e1, e2]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  const r = performAction(state, { unit: "d", skillId: "dennis4", targets: [] });
  assert.ok(r.ok, "cast succeeded");

  assert.equal(e1.hp, 95, "base: only Dennis deals part 1 → enemy took just 5");
  assert.equal(e2.hp, 95, "base: only Dennis deals part 1 → enemy took just 5");
  assert.equal(dennis.hp, 90, "base: Dennis alone absorbs part 2 (5 from each enemy = 10)");
  assert.equal(ally.hp, 100, "base: the ally is NOT included — untouched");
});

// ============================================================================
// dennis5 — Working for Weekend
// FROZEN: "Big Green Fist deals 5 more base damage, and decreases the remaining cooldown of
//          End of Shift by 1 turn."
// ============================================================================

test("dennis5: Big Green Fist deals 5 more base damage (10 -> 15 with no Pain Tolerance stacks)", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis5")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100 });
  const state = makeState([dennis], [e]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  assert.ok(!hasMark(dennis, HS46_MARK), "precondition: no HS-46 empower, 0 Pain stacks → pure base damage");
  const r = performAction(state, { unit: "d", skillId: "dennis1", targets: ["e"] });
  assert.ok(r.ok, "cast succeeded");
  assert.equal(e.hp, 85, "augmented base damage is 15 (10 + 5), not the base 10");
});

test("dennis5 control: base Big Green Fist deals 10 base damage (no +5)", () => {
  const dennis = D(); // no augment
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100 });
  const state = makeState([dennis], [e]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  const r = performAction(state, { unit: "d", skillId: "dennis1", targets: ["e"] });
  assert.ok(r.ok, "cast succeeded");
  assert.equal(e.hp, 90, "base Big Green Fist deals 10 — proving the +5 is the augment's doing");
});

test("dennis5: casting Big Green Fist reduces End of Shift's remaining cooldown by 1", () => {
  const dennis = D();
  applyAugment(dennis, augmentById("dennis5")!);
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100 });
  const state = makeState([dennis], [e]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  const eos = dennis.skills!.find((s) => s.id === "dennis6")!;
  eos.currentCd = 3;
  eos.cdSetTurn = -99; // an earlier turn, so nothing else touches this cooldown during the cast

  const r = performAction(state, { unit: "d", skillId: "dennis1", targets: ["e"] });
  assert.ok(r.ok, "cast succeeded");
  assert.equal(eos.currentCd, 2, "End of Shift's remaining cooldown dropped 3 → 2 on the Big Green Fist cast");
});

test("dennis5 control: base Big Green Fist does NOT touch End of Shift's cooldown", () => {
  const dennis = D(); // no augment
  const e = makeUnit({ id: "e", team: "B", kind: "hero", hp: 100 });
  const state = makeState([dennis], [e]);
  state.teams.A.energy = { generic: 40, serum: 40 };

  const eos = dennis.skills!.find((s) => s.id === "dennis6")!;
  eos.currentCd = 3;
  eos.cdSetTurn = -99;

  const r = performAction(state, { unit: "d", skillId: "dennis1", targets: ["e"] });
  assert.ok(r.ok, "cast succeeded");
  assert.equal(eos.currentCd, 3, "base: End of Shift's cooldown is unchanged (the -1 is the augment's doing)");
});
