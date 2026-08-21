import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// Fidelity Campaign 3 — selfix: roland:spore "Scattered Spores" (rolandspore0), the skillUsed clause.
//
// Frozen prose (second sentence): "If Roland uses Strength from the Earth on a Stonecap Mushroom, he deals
// 15 Affliction damage to all enemy units, destroying the Stonecap Mushroom."
//
// The passive reacts to `skillUsed`. That event carries NO `target` field — it has `caster` and a `targets`
// (plural) list. The pre-fix gate used the `eventTarget` selector (unresolvable here) and was otherwise
// ungated on skill/target, so the 15-Affliction AoE fired on EVERY Roland skill and the `defeat eventTarget`
// hit no one. The fix gates on and[ sameUnit(eventSource,self), eventSkillId:"roland1",
// isNamed(eventTargets,"Stonecap Mushroom") ] and defeats `eventTargets` (the declared-target list).
//
// The passive's UNIQUE observable is the 15 Affliction dealt to ALL enemies: Strength From The Earth
// (roland1) itself lands its base hit on the TARGET (the Stonecap), never on the enemies, so any enemy HP
// loss is the passive alone. The Stonecap is set to 10 HP so roland1's base 15 destroys it before its own
// "launch" reads currentHp (0 → the launch deals no damage to an enemy), keeping the AoE reading clean.

const STONECAP = "Stonecap Mushroom";

/** Fresh: roland fused into spore + two enemies, plus any allied minions passed in. Energy stocked. */
function setup(minions: Unit[] = []): { state: MatchState; roland: Unit; e1: Unit; e2: Unit } {
  const roland = loadHero(heroById("roland"), "A", "roland");
  applyFusion(roland, fusionForm("roland", "spore")!);
  const e1 = makeUnit({ id: "e1", team: "B", name: "Enemy One", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", name: "Enemy Two", hp: 100, maxHp: 100 });
  const state = makeState([roland, ...minions], [e1, e2]);
  state.teams.A.energy = { generic: 40, earth: 40, spore: 40 };
  return { state, roland, e1, e2 };
}

const stonecap = (id: string, hp = 10): Unit =>
  makeUnit({ id, team: "A", kind: "minion", name: STONECAP, hp, maxHp: hp });

// --------------------------------------------------------------------------------------------------- //
// POSITIVE — roland1 used ON a Stonecap Mushroom: 15 Affliction to ALL enemies + the Stonecap destroyed.
// --------------------------------------------------------------------------------------------------- //
test("Scattered Spores: Strength From The Earth on a Stonecap deals 15 Affliction to ALL enemies and destroys it", () => {
  const cap = stonecap("cap");
  const { state, e1, e2 } = setup([cap]);

  const e1Before = e1.hp;
  const e2Before = e2.hp;
  const res = performAction(state, { unit: "roland", skillId: "roland1", targets: ["cap"] });
  assert.equal(res.ok, true, "roland1 on the Stonecap is a legal, payable action");

  // The passive's signature: 15 Affliction to EVERY enemy (roland1's own hit landed on the Stonecap, not here).
  assert.equal(e1Before - e1.hp, 15, "enemy 1 took exactly 15 (the Scattered Spores AoE)");
  assert.equal(e2Before - e2.hp, 15, "enemy 2 took exactly 15 (AoE hit ALL enemies)");

  // The struck Stonecap is destroyed (held reference reflects alive:false even after minion cleanup).
  assert.equal(cap.alive, false, "the targeted Stonecap Mushroom is destroyed");
});

// --------------------------------------------------------------------------------------------------- //
// CONTROL (isNamed gate) — the fix's point. roland1 on a DIFFERENTLY-NAMED allied minion: same caster, same
// skill, same target KIND (ally minion), only the name differs → isNamed(eventTargets,"Stonecap Mushroom")
// is false → the 15-Affliction AoE must NOT fire. Enemies are untouched.
// --------------------------------------------------------------------------------------------------- //
test("Scattered Spores: roland1 on a NON-Stonecap minion deals NO AoE (isNamed gate blocks it)", () => {
  const pebble = makeUnit({ id: "peb", team: "A", kind: "minion", name: "Pebble", hp: 10, maxHp: 10 });
  const { state, e1, e2 } = setup([pebble]);

  const e1Before = e1.hp;
  const e2Before = e2.hp;
  const res = performAction(state, { unit: "roland", skillId: "roland1", targets: ["peb"] });
  assert.equal(res.ok, true, "roland1 on the Pebble is a legal, payable action");

  assert.equal(e1.hp, e1Before, "enemy 1 took NO 15 Affliction — the target was not a Stonecap");
  assert.equal(e2.hp, e2Before, "enemy 2 took NO 15 Affliction — the AoE did not fire");
  assert.equal(pebble.alive, false, "sanity: roland1 still launched + destroyed the ally minion it struck");
});

// --------------------------------------------------------------------------------------------------- //
// CONTROL (eventSkillId gate) — a DIFFERENT Roland skill must not fire the passive, even with a Stonecap on
// the field. This reproduces the exact pre-fix bug ("the 15 damage fired on EVERY Roland skill"): roland2
// (Earth Pillar) on enemy e1 deals its own 20 to e1, but e2 — untouched by roland2 — must stay at full HP,
// proving the Scattered Spores AoE did NOT fire off a non-roland1 skill.
// --------------------------------------------------------------------------------------------------- //
test("Scattered Spores: a different skill (roland2) does NOT fire the AoE, even with a Stonecap present", () => {
  const cap = stonecap("cap", 40); // present but never targeted by roland2
  const { state, e1, e2 } = setup([cap]);

  const e2Before = e2.hp;
  const res = performAction(state, { unit: "roland", skillId: "roland2", targets: ["e1"] });
  assert.equal(res.ok, true, "roland2 on an enemy is a legal, payable action");

  assert.equal(e2.hp, e2Before, "the non-targeted enemy is untouched — no Scattered Spores AoE off roland2 (eventSkillId gate)");
  assert.equal(cap.alive, true, "the bystander Stonecap is not consumed by an unrelated skill");
});

// --------------------------------------------------------------------------------------------------- //
// The re-summon clause ("Whenever a Boulder is destroyed, create a Stonecap Mushroom") must fire ONLY on a
// Boulder's death — NOT a Stonecap's. Once destroying a Stonecap via roland1 actually works, an unfiltered
// gate would spawn-loop. The isNamed:"Boulder" gate prevents that.
// --------------------------------------------------------------------------------------------------- //
test("Scattered Spores: a Boulder death re-summons a Stonecap; a Stonecap death does NOT (no spawn loop)", () => {
  const live = (st: MatchState) => Object.values(st.units).filter((u) => u.kind === "minion" && u.name === STONECAP && u.alive).length;

  // A Boulder dies -> exactly one Stonecap is created.
  {
    const boulder = makeUnit({ id: "b1", team: "A", kind: "minion", name: "Boulder", hp: 1, maxHp: 1 });
    const { state } = setup([boulder]);
    const before = live(state);
    emit(state, { type: "unitDied", unit: "b1", killer: "e1" });
    assert.equal(live(state), before + 1, "a Boulder's death re-summons one Stonecap Mushroom");
  }

  // A Stonecap dies -> NO new Stonecap (the isNamed:"Boulder" gate blocks the spawn loop).
  {
    const cap = stonecap("cap");
    const { state } = setup([cap]);
    const before = live(state); // counts 'cap'
    emit(state, { type: "unitDied", unit: "cap", killer: "e1" });
    assert.equal(live(state), before, "a Stonecap's own death does NOT re-summon another (no loop)");
  }
});
