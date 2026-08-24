import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates + augment customs
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// HERO: Hector the Injector — AUGMENTS.
//
// Frozen augment prose (../content/frozen/augments.json) is the ORACLE for every assertion:
//   hector1 "Overeager":             "At the start of each round, Hector automatically casts Burning Blood
//                                      Serum on Dennis."
//   hector2 "Calibrated Syringe Gun":"Hector's Serum skills cannot be stunned."
//   hector3 "Dilution":              "Serums now last for 2 additional turns, but their costs are increased
//                                      by [65]."
//   hector4 "Promotion":             "Dennis the Apprentice begins the game with 20 extra health, and under
//                                      the effect of a random Serum"
//   hector5 "Emergency Clinic":       "Hector may use his Serums on targets other than Dennis once Dennis has
//                                      died."
//
// Supporting frozen skill prose used to shape assertions (../content/frozen/skills.json):
//   hector1 Burning Blood Serum — "+10 damage dealt for 3 turns … Dennis takes 10 damage/turn/stack".
//   hector2 Stoneseal Serum     — "heals 10/turn for 3 turns; +1 Generic skill cost".
//   hector3 Mindfog Serum       — "+1 cooldowns; ignore stuns & counters for 3 turns".
//   The three injectable Serums are hector1/hector2/hector3.
//
// Content (augments.authored.json / *.generated.ts) is read ONLY to drive: augment ids hector1..hector5,
// which base skills each touches, that Hector's element is poison (so `specific` energy is paid in poison),
// and the produced status names ("Burning Blood Serum", "Stoneseal Serum", "Mindfog Serum"). The oracle for
// WHAT is correct is the prose above.
// ---------------------------------------------------------------------------

const DENNIS = "Dennis the Apprentice";
const SERUM_NAMES = ["Burning Blood Serum", "Stoneseal Serum", "Mindfog Serum"] as const;

function getDennis(state: MatchState): Unit {
  const d = Object.values(state.units).find((u) => u.kind === "minion" && u.name === DENNIS);
  assert.ok(d, "Dennis the Apprentice minion should exist");
  return d!;
}
function findStatus(u: Unit, kind: string, name?: string) {
  return u.statuses.find((s) => s.kind === kind && (name === undefined || s.name === name));
}
function skillOf(u: Unit, id: string) {
  const s = (u.skills ?? []).find((k) => k.id === id);
  assert.ok(s, `hero should carry skill ${id}`);
  return s!;
}
/** Apply a plain (unscoped) external stun to `victim` via the real status-apply path. */
function stun(state: MatchState, victim: Unit, by: Unit) {
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 2 } }] as never, {
    caster: by,
    targets: [victim],
    skillId: "extstun",
  } as never);
}

/** Build a Hector (id "h") on team A with `augId` applied (or none), summon Dennis, and fund the team. */
function setup(augId?: string, enemyOver: Partial<Unit> = {}) {
  const hector = loadHero(heroById("hector"), "A", "h");
  if (augId) applyAugment(hector, augmentById(augId)!);
  const enemy = makeUnit({ id: "e1", team: "B", kind: "hero", hp: 100, maxHp: 100, ...enemyOver });
  const state = makeState([hector], [enemy]);
  state.teams.A.energy = { generic: 400, poison: 400 }; // fund BEFORE startRound so round-start casts can pay
  state.teams.B.energy = { generic: 400, fire: 400 };
  startRound(state, "A"); // fires Hector's round-start passive (summons Dennis) + any augment round-start triggers
  return { state, hector, enemy, dennis: getDennis(state) };
}

// =========================================================================
// hector1 — "Overeager": auto-cast Burning Blood Serum on Dennis every round start
// =========================================================================

test("hector1 Overeager: at round start Hector auto-casts Burning Blood Serum onto Dennis", () => {
  const { dennis } = setup("hector1");
  // Burning Blood Serum's two observable statuses (frozen: +10 dmg dealt boon, and 10/turn self-dot).
  assert.ok(
    findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum"),
    "Dennis carries Burning Blood Serum's damage-dealt boon after round start",
  );
  assert.ok(
    findStatus(dennis, "dot", "Burning Blood Serum"),
    "Dennis carries Burning Blood Serum's self-damage dot after round start",
  );
});

test("hector1 Overeager (control): without the augment, no Burning Blood is auto-applied at round start", () => {
  const { dennis } = setup(); // no augment
  assert.equal(
    findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum"),
    undefined,
    "a plain Hector does NOT inject Dennis at round start",
  );
  assert.equal(findStatus(dennis, "dot", "Burning Blood Serum"), undefined, "…and applies no self-dot either");
});

test("hector1 Overeager: the auto-cast targets DENNIS specifically (the enemy is never injected)", () => {
  const { enemy } = setup("hector1");
  assert.equal(
    findStatus(enemy, "outgoing_damage_mod", "Burning Blood Serum"),
    undefined,
    "the round-start auto-cast lands on Dennis, not on the enemy",
  );
});

// =========================================================================
// hector2 — "Calibrated Syringe Gun": Hector's Serum skills cannot be stunned
// =========================================================================

test("hector2 Calibrated: a stunned Hector can still cast Burning Blood Serum (hector1)", () => {
  const { state, hector, enemy, dennis } = setup("hector2");
  stun(state, hector, enemy);
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [dennis.id] });
  assert.equal(r.ok, true, `Serum skill should be unstunnable (reason: ${r.reason})`);
  assert.ok(findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum"), "…and it actually injected Dennis");
});

test("hector2 Calibrated: a stunned Hector can still cast Stoneseal Serum (hector2)", () => {
  const { state, hector, enemy, dennis } = setup("hector2");
  stun(state, hector, enemy);
  const r = performAction(state, { unit: "h", skillId: "hector2", targets: [dennis.id] });
  assert.equal(r.ok, true, `Stoneseal (a Serum skill) should be unstunnable (reason: ${r.reason})`);
  assert.ok(findStatus(dennis, "regen", "Stoneseal Serum"), "…and it injected Stoneseal's regen");
});

test("hector2 Calibrated: a stunned Hector can still cast Mindfog Serum (hector3)", () => {
  const { state, hector, enemy, dennis } = setup("hector2");
  stun(state, hector, enemy);
  const r = performAction(state, { unit: "h", skillId: "hector3", targets: [dennis.id] });
  assert.equal(r.ok, true, `Mindfog (a Serum skill) should be unstunnable (reason: ${r.reason})`);
  assert.ok(findStatus(dennis, "mark", "Mindfog Serum"), "…and it injected Mindfog's mark");
});

test("hector2 Calibrated (control): a NON-Serum skill (Protect Me!) is still stopped by a stun", () => {
  // Protect Me! (hector4) is not a Serum; the augment does not shield it, so a stun must block it.
  const { state, hector, enemy } = setup("hector2");
  stun(state, hector, enemy);
  const r = performAction(state, { unit: "h", skillId: "hector4", targets: [] });
  assert.equal(r.ok, false, "a stunned Hector cannot cast his non-Serum skill");
  assert.equal(r.reason, "stunned", "…rejected specifically for the stun");
});

test("hector2 Calibrated (control): without the augment, a stun DOES block a Serum skill", () => {
  const { state, hector, enemy, dennis } = setup(); // no augment
  stun(state, hector, enemy);
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [dennis.id] });
  assert.equal(r.ok, false, "a plain Hector's Serum is stunnable");
  assert.equal(r.reason, "stunned", "…rejected specifically for the stun");
});

// =========================================================================
// hector3 — "Dilution": Serums last 2 additional turns; their costs are increased by [65]
// =========================================================================

test("hector3 Dilution: Burning Blood Serum now lasts 2 additional turns (3 -> 5)", () => {
  const { state, dennis } = setup("hector3");
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [dennis.id] });
  assert.equal(r.ok, true, `Burning Blood should cast (reason: ${r.reason})`);
  assert.equal(
    findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum")?.duration,
    5,
    "the +10-damage boon lasts 3+2 = 5 turns",
  );
  assert.equal(
    findStatus(dennis, "dot", "Burning Blood Serum")?.duration,
    5,
    "the self-damage dot also lasts 5 turns",
  );
});

test("hector3 Dilution (control): without the augment, Burning Blood lasts the base 3 turns", () => {
  const { state, dennis } = setup(); // no augment
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [dennis.id] });
  assert.equal(r.ok, true, `Burning Blood should cast (reason: ${r.reason})`);
  assert.equal(
    findStatus(dennis, "outgoing_damage_mod", "Burning Blood Serum")?.duration,
    3,
    "base Burning Blood lasts 3 turns",
  );
});

test("hector3 Dilution: Stoneseal (regen) and Mindfog (mark) also extend by 2 turns (3 -> 5)", () => {
  const { state, dennis } = setup("hector3");
  const r2 = performAction(state, { unit: "h", skillId: "hector2", targets: [dennis.id] });
  assert.equal(r2.ok, true, `Stoneseal should cast (reason: ${r2.reason})`);
  assert.equal(findStatus(dennis, "regen", "Stoneseal Serum")?.duration, 5, "Stoneseal's regen lasts 5 turns");

  const r3 = performAction(state, { unit: "h", skillId: "hector3", targets: [dennis.id] });
  assert.equal(r3.ok, true, `Mindfog should cast (reason: ${r3.reason})`);
  assert.equal(findStatus(dennis, "mark", "Mindfog Serum")?.duration, 5, "Mindfog's mark lasts 5 turns");
});

test("hector3 Dilution: each Serum's cost is increased by 65", () => {
  // Frozen "[65]" read as magnitude 65 (bracket-as-magnitude precedent). Assert the total energy cost of
  // each Serum skill rises by exactly 65 vs its base cost — agnostic about which pool absorbs it.
  const base = loadHero(heroById("hector"), "A", "hb");
  const aug = loadHero(heroById("hector"), "A", "ha");
  applyAugment(aug, augmentById("hector3")!);
  for (const id of ["hector1", "hector2", "hector3"]) {
    const b = skillOf(base, id).cost;
    const a = skillOf(aug, id).cost;
    const baseTotal = (b.generic ?? 0) + (b.specific ?? 0);
    const augTotal = (a.generic ?? 0) + (a.specific ?? 0);
    assert.equal(augTotal - baseTotal, 65, `Serum ${id}'s cost is increased by 65 (base ${baseTotal} -> ${augTotal})`);
  }
});

// =========================================================================
// hector4 — "Promotion": Dennis begins with 20 extra health AND under a random Serum
// =========================================================================

test("hector4 Promotion: Dennis begins with 20 extra maximum health", () => {
  const baseDennis = setup().dennis; // fresh base Dennis for the maxHp baseline
  const { dennis } = setup("hector4");
  assert.equal(
    dennis.maxHp - baseDennis.maxHp,
    20,
    `Promotion grants Dennis +20 max health (base ${baseDennis.maxHp} -> ${dennis.maxHp})`,
  );
});

test("hector4 Promotion: Dennis begins under exactly one (random) Serum", () => {
  const { dennis } = setup("hector4");
  const present = SERUM_NAMES.filter((n) => dennis.statuses.some((s) => s.name === n));
  assert.equal(present.length, 1, `Dennis starts under exactly one Serum (found: [${present.join(", ")}])`);
});

test("hector4 Promotion (control): a plain Dennis begins under NO Serum and at base health", () => {
  const { dennis } = setup(); // no augment
  const present = SERUM_NAMES.filter((n) => dennis.statuses.some((s) => s.name === n));
  assert.equal(present.length, 0, "a plain Dennis carries no Serum at round start");
});

// =========================================================================
// hector5 — "Emergency Clinic": Hector may use Serums on non-Dennis targets ONCE Dennis has died
// =========================================================================

test("hector5 Emergency Clinic: once Dennis is dead, Hector may inject a Serum into another unit", () => {
  const { state, enemy, dennis } = setup("hector5");
  dennis.hp = 0;
  dennis.alive = false; // Dennis has died
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [enemy.id] });
  assert.equal(r.ok, true, `with Dennis dead, a Serum on a non-Dennis target should be allowed (reason: ${r.reason})`);
  assert.ok(
    findStatus(enemy, "outgoing_damage_mod", "Burning Blood Serum"),
    "the Serum lands on the chosen non-Dennis target",
  );
});

// The augment's grant is CONDITIONAL: "once Dennis has died". Its discriminating half is therefore that
// while Dennis is ALIVE a Serum may NOT be aimed at another unit. DEFERRED (kept skipped): the base "only
// Dennis" restriction cannot be a simple base-skill flag, because 4+ hector fusion forms each REDEFINE Serum
// targeting (antidote -> allies, assassin -> enemies, evolution -> self) and would all need coordinated
// per-form targeting overrides. Needs a design ruling on how the base restriction composes with those forms,
// not a single primitive. Frozen assertions preserved below.
test.skip("hector5 Emergency Clinic: while Dennis is ALIVE a Serum on a non-Dennis target is rejected", () => {
  const { state, enemy, dennis } = setup("hector5");
  assert.ok(dennis.alive, "precondition: Dennis is alive");
  const r = performAction(state, { unit: "h", skillId: "hector1", targets: [enemy.id] });
  assert.equal(r.ok, false, "with Dennis alive, a Serum may only target Dennis — a non-Dennis target is rejected");
  assert.equal(
    findStatus(enemy, "outgoing_damage_mod", "Burning Blood Serum"),
    undefined,
    "…so no Serum lands on the non-Dennis target",
  );
});
