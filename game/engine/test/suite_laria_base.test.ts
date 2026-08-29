import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts";
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import { performAction, endTurn, startTurn } from "../src/scheduler.ts";
import { applyDamage } from "../src/damage.ts";
import type { Status, Unit } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Adversarial, FROZEN-PROSE-derived suite for Laria, Nightcloaked (base kit).
// Oracle = ../content/frozen/skills.json (laria0..laria5). Element: shadow.
//
//  laria0 Deepening Shadows (passive): "At the end of each of her turns, Laria
//    gains a stack of Deepening Shadows. This effect will only trigger if Laria
//    has fewer than 3 stacks."
//  laria1 Nightwrap: "Deals 10 damage to target enemy or heals target ally 10
//    HP, increased by 5 for each stack of Deepening Shadows on them. If the
//    target has Elemental Essence, Laria gains Elemental Essence. Places one
//    stack of Deepening Shadows on the target."
//  laria2 Soothing Night: "Gives all allies 1 stack of Deepening Shadows and
//    heals them for 5 HP. If they already had 4 stacks, they are healed for 10
//    HP instead. Lasts up to 4 turns."
//  laria3 Suffocating Night: "Gives all enemies 1 stack of Deepening Shadows and
//    deals 5 damage to them. If they already had 4 stacks, this skill deals True
//    damage. Lasts up to 4 turns."
//  laria4 Vanish: "Laria gains 15 Damage Reduction for 3 turns, or until she
//    uses a new skill."
//  laria5 Nightfall: "All characters become invulnerable for 1 turn and take 5
//    damage or healing for each Deepening Shadows stack they have."
// ---------------------------------------------------------------------------

const DS = "Deepening Shadows";
const dsCount = (u: Unit): number =>
  u.statuses.find((s) => s.kind === "stack" && s.name === DS)?.magnitude ?? 0;
const dsStatus = (n: number): Status => ({
  kind: "stack", name: DS, magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0,
});
const drStatus = (n: number): Status => ({
  kind: "damage_reduction", magnitude: n, duration: null, appliedBy: "seed", appliedTurn: 0,
});
const essence = (): Status => ({
  kind: "elemental_essence", duration: null, appliedBy: "seed", appliedTurn: 0,
});
const hasKind = (u: Unit, kind: string): boolean => u.statuses.some((s) => s.kind === kind);
const vanishDR = (u: Unit): Status | undefined =>
  u.statuses.find((s) => s.kind === "damage_reduction" && s.name === "Vanish");

function fund(state: ReturnType<typeof makeState>, team: "A" | "B" = "A"): void {
  state.teams[team].energy = { generic: 40, shadow: 40 };
}

// ===========================================================================
// laria0 — Deepening Shadows (passive)
// ===========================================================================

test("laria0: Laria gains 1 Deepening Shadows at the end of each of her turns", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const dummy = makeUnit({ id: "e1", team: "B" });
  const state = makeState([laria], [dummy]);

  assert.equal(dsCount(laria), 0, "starts with 0 Deepening Shadows");

  state.activeTeam = "A";
  endTurn(state); // end of Laria's turn
  assert.equal(dsCount(laria), 1, "1 stack after her first turn ends");

  state.activeTeam = "A";
  endTurn(state);
  assert.equal(dsCount(laria), 2, "2 stacks after her second turn ends");
});

test("laria0: the passive stops at 3 (only triggers while she has fewer than 3)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  laria.statuses = [dsStatus(3)];
  const dummy = makeUnit({ id: "e1", team: "B" });
  const state = makeState([laria], [dummy]);

  state.activeTeam = "A";
  endTurn(state);
  assert.equal(dsCount(laria), 3, "at 3 stacks the passive does not add a 4th");
});

test("laria0: control — a stack is NOT gained on the opponent's turn end", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  laria.statuses = [dsStatus(1)];
  const dummy = makeUnit({ id: "e1", team: "B" });
  const state = makeState([laria], [dummy]);

  state.activeTeam = "B"; // opponent's turn ending, not Laria's
  endTurn(state);
  assert.equal(dsCount(laria), 1, "no Deepening Shadows on team B's turn end");
});

// ===========================================================================
// laria1 — Nightwrap
// ===========================================================================

test("laria1: enemy target takes 10 + 5 per Deepening Shadows stack (measured before the new stack)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100 }); // 0 stacks
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, statuses: [dsStatus(2)] }); // 2 stacks
  const state = makeState([laria], [e0, e2]);
  fund(state);

  // 0-stack enemy: exactly 10 (NOT 15 — scaling reads pre-existing stacks, not the placed one).
  const r0 = performAction(state, { unit: "la", skillId: "laria1", targets: ["e0"] });
  assert.ok(r0.ok, "Nightwrap resolves on e0");
  assert.equal(e0.hp, 90, "0 stacks -> 10 damage");
  assert.equal(dsCount(e0), 1, "1 Deepening Shadows placed on the target");

  // 2-stack enemy: 10 + 5*2 = 20.
  laria.skills!.find((s) => s.id === "laria1")!.currentCd = 0; // reset cd for a second cast in-test
  const r2 = performAction(state, { unit: "la", skillId: "laria1", targets: ["e2"] });
  assert.ok(r2.ok, "Nightwrap resolves on e2");
  assert.equal(e2.hp, 80, "2 stacks -> 20 damage");
  assert.equal(dsCount(e2), 3, "target now holds 3 Deepening Shadows (2 + placed 1)");
});

test("laria1: ally target is healed 10 + 5 per Deepening Shadows stack, and gains a stack", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const a0 = makeUnit({ id: "a0", team: "A", hp: 50, maxHp: 100 }); // 0 stacks
  const a3 = makeUnit({ id: "a3", team: "A", hp: 50, maxHp: 100, statuses: [dsStatus(3)] });
  const e1 = makeUnit({ id: "e1", team: "B" });
  const state = makeState([laria, a0, a3], [e1]);
  fund(state);

  const r0 = performAction(state, { unit: "la", skillId: "laria1", targets: ["a0"] });
  assert.ok(r0.ok, "Nightwrap resolves on ally a0");
  assert.equal(a0.hp, 60, "0 stacks -> heal 10");
  assert.equal(dsCount(a0), 1, "1 Deepening Shadows placed on the ally");

  laria.skills!.find((s) => s.id === "laria1")!.currentCd = 0;
  const r3 = performAction(state, { unit: "la", skillId: "laria1", targets: ["a3"] });
  assert.ok(r3.ok, "Nightwrap resolves on ally a3");
  assert.equal(a3.hp, 75, "3 stacks -> heal 10 + 15 = 25");
  assert.equal(dsCount(a3), 4, "ally now holds 4 Deepening Shadows (3 + placed 1)");
});

test("laria1: if the target has Elemental Essence, Laria gains Elemental Essence", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100, statuses: [essence()] });
  const state = makeState([laria], [e1]);
  fund(state);

  assert.equal(hasKind(laria, "elemental_essence"), false, "Laria has no essence before");
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(hasKind(laria, "elemental_essence"), true, "Laria gains Elemental Essence from an essence-bearing target");
});

test("laria1: a MIDDLE-slot target has Elemental Essence via slot income (glows, no charge) — Laria still gains it", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const mid = makeUnit({ id: "e1", team: "B", hp: 100, slot: 1 }); // MIDDLE slot (1): always has Essence income, but no charge status
  const state = makeState([laria], [mid]);
  fund(state);

  assert.equal(hasKind(mid, "elemental_essence"), false, "the middle hero holds no essence CHARGE — its Essence is slot income");
  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(hasKind(laria, "elemental_essence"), true, "the glowing middle hero counts as having Elemental Essence, so Laria gains it");
});

test("laria1: control — no Elemental Essence gained when the target has none", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const e1 = makeUnit({ id: "e1", team: "B", hp: 100 }); // no essence
  const state = makeState([laria], [e1]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap resolves");
  assert.equal(hasKind(laria, "elemental_essence"), false, "no essence on the target -> Laria gains none");
});

// ===========================================================================
// laria2 — Soothing Night (Channel)
// ===========================================================================

test("laria2: gives every ally 1 Deepening Shadows and heals 5 (or 10 if they already had 4)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const a0 = makeUnit({ id: "a0", team: "A", hp: 50, maxHp: 100 }); // 0 stacks -> heal 5
  const a3 = makeUnit({ id: "a3", team: "A", hp: 50, maxHp: 100, statuses: [dsStatus(3)] }); // 3 -> heal 5 (NOT 10)
  const a4 = makeUnit({ id: "a4", team: "A", hp: 50, maxHp: 100, statuses: [dsStatus(4)] }); // 4 -> heal 10
  const enemy = makeUnit({ id: "e1", team: "B", hp: 50, maxHp: 100 }); // control
  const state = makeState([laria, a0, a3, a4], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria2", targets: [] });
  assert.ok(r.ok, "Soothing Night resolves");

  assert.equal(a0.hp, 55, "0-stack ally healed 5");
  assert.equal(dsCount(a0), 1, "0-stack ally gained 1 Deepening Shadows");

  assert.equal(a3.hp, 55, "3-stack ally healed only 5 (had 3, not 4)");
  assert.equal(dsCount(a3), 4, "3-stack ally gained 1 (now 4)");

  assert.equal(a4.hp, 60, "4-stack ally healed 10 (already had 4)");
  assert.equal(dsCount(a4), 5, "4-stack ally gained 1 (now 5)");

  // Control: enemies are untouched by Soothing Night.
  assert.equal(enemy.hp, 50, "enemy not healed");
  assert.equal(dsCount(enemy), 0, "enemy gains no Deepening Shadows");
});

test("laria2: the channel persists and re-applies on Laria's next turn (Lasts up to 4 turns)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const a0 = makeUnit({ id: "a0", team: "A", hp: 40, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, a0], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria2", targets: [] });
  assert.ok(r.ok, "Soothing Night resolves (tick 1)");
  assert.equal(dsCount(a0), 1, "tick 1: +1 stack");
  assert.equal(a0.hp, 45, "tick 1: +5 HP");
  assert.equal(hasKind(laria, "channeling"), true, "a channel is installed");

  // Laria's next turn re-runs the channel.
  state.activeTeam = "A";
  startTurn(state);
  assert.equal(dsCount(a0), 2, "tick 2: another +1 stack");
  assert.equal(a0.hp, 50, "tick 2: another +5 HP");
});

// Frozen "Lasts up to 4 turns" = exactly 4 applications. The engine runs a channel's effects on cast PLUS
// channelTurns re-runs, so channelTurns must be 3 (cast + 3 = 4). A regression to 4 would apply a 5th stack.
test("laria2: a full channel applies EXACTLY 4 Deepening Shadows to an ally (cast + 3 re-runs), never a 5th", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const a0 = makeUnit({ id: "a0", team: "A", hp: 40, maxHp: 100 });
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria, a0], [enemy]);
  fund(state);

  performAction(state, { unit: "la", skillId: "laria2", targets: [] }); // application 1 (cast)
  for (let i = 0; i < 4; i++) { state.activeTeam = "A"; startTurn(state); } // drive 4 more Laria turns
  assert.equal(dsCount(a0), 4, "cast + 3 channel re-runs = 4 stacks; the 4th extra turn adds nothing (channel exhausted)");
});

// ===========================================================================
// laria3 — Suffocating Night (Channel)
// ===========================================================================

test("laria3: gives every enemy 1 Deepening Shadows and deals 5 damage; True damage if they already had 4", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const ally = makeUnit({ id: "a1", team: "A", hp: 100 }); // control
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100 }); // 0 stacks, no DR -> 5 normal
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100, statuses: [dsStatus(3), drStatus(10)] }); // 3 stacks, DR10 -> normal blocked
  const e4 = makeUnit({ id: "e4", team: "B", hp: 100, statuses: [dsStatus(4), drStatus(10)] }); // 4 stacks, DR10 -> True bypasses
  const state = makeState([laria, ally], [e0, e3, e4]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria3", targets: [] });
  assert.ok(r.ok, "Suffocating Night resolves");

  assert.equal(e0.hp, 95, "0-stack enemy takes 5 normal damage");
  assert.equal(dsCount(e0), 1, "0-stack enemy gains 1 Deepening Shadows");

  // 3 stacks -> still NORMAL damage, fully absorbed by DR 10 (proves it is NOT True).
  assert.equal(e3.hp, 100, "3-stack enemy: 5 normal damage reduced to 0 by DR 10");
  assert.equal(dsCount(e3), 4, "3-stack enemy gains 1 (now 4)");

  // 4 stacks -> TRUE damage, bypasses DR 10 entirely.
  assert.equal(e4.hp, 95, "4-stack enemy: 5 True damage bypasses DR 10");
  assert.equal(dsCount(e4), 5, "4-stack enemy gains 1 (now 5)");

  // Control: allies untouched.
  assert.equal(ally.hp, 100, "ally not damaged");
  assert.equal(dsCount(ally), 0, "ally gains no Deepening Shadows");
});

// ===========================================================================
// laria4 — Vanish
// ===========================================================================

// SUSPECTED BUG: frozen says Vanish grants 15 DR "for 3 turns, or until she uses a new skill", so the
// DR must be present right after the granting cast. The laria4 skillUsed trigger has no guard excluding
// the granting skill, so it fires on Vanish's OWN skillUsed and strips the DR immediately — Laria never
// actually gains any Damage Reduction. (roster.authored.json documents the intended exclusion; it is not
// implemented.)
test("laria4 Vanish grants 15 Damage Reduction for 3 turns", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const enemy = makeUnit({ id: "e1", team: "B" });
  const state = makeState([laria], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] });
  assert.ok(r.ok, "Vanish resolves");

  const dr = vanishDR(laria);
  assert.ok(dr, "Laria has a 'Vanish' damage_reduction");
  assert.equal(dr!.magnitude, 15, "magnitude 15");
  assert.equal(dr!.duration, 3, "duration 3 turns");

  // Functional: an incoming 20 normal hit is reduced by 15 -> 5 HP lost.
  applyDamage(laria, { amount: 20, type: "normal", isNew: true });
  assert.equal(laria.hp, 95, "15 Damage Reduction applied to a 20-damage hit -> 5 lost");
});

// SUSPECTED BUG: same root cause — the granting cast should not count as "a new skill", but the laria4
// trigger removes the DR on the same cast's skillUsed event.
test("laria4 Vanish survives its own granting cast (not a new skill vs itself)", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const enemy = makeUnit({ id: "e1", team: "B" });
  const state = makeState([laria], [enemy]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] });
  assert.ok(r.ok, "Vanish resolves");
  assert.ok(vanishDR(laria), "Vanish DR is present immediately after its own cast");
});

// SUSPECTED BUG: this clause ("or until she uses a new skill") can't even be exercised — the DR is
// already gone before any subsequent skill, because the granting cast strips it (see above). The precheck
// asserting Vanish is present before the next skill is what fails.
test("laria4 using a NEW skill removes Vanish", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  const enemy = makeUnit({ id: "e1", team: "B", hp: 100 });
  const state = makeState([laria], [enemy]);
  fund(state);

  performAction(state, { unit: "la", skillId: "laria4", targets: ["la"] });
  assert.ok(vanishDR(laria), "Vanish present before the next skill");

  const r = performAction(state, { unit: "la", skillId: "laria1", targets: ["e1"] });
  assert.ok(r.ok, "Nightwrap (a new skill) resolves");
  assert.equal(vanishDR(laria), undefined, "Vanish removed once Laria uses a new skill");
});

// ===========================================================================
// laria5 — Nightfall
// ===========================================================================

test("laria5: enemies take 5/stack, allies heal 5/stack, all become invulnerable", () => {
  const laria = loadHero(heroById("laria"), "A", "la");
  laria.hp = 80; laria.statuses = [dsStatus(2)]; // ally (caster) with 2 stacks -> heal 10
  const a0 = makeUnit({ id: "a0", team: "A", hp: 50, maxHp: 100 }); // 0 stacks -> heal 0 (control)
  const e3 = makeUnit({ id: "e3", team: "B", hp: 100, statuses: [dsStatus(3)] }); // 3 stacks -> 15 damage
  const e0 = makeUnit({ id: "e0", team: "B", hp: 100 }); // 0 stacks -> 0 damage (control)
  const state = makeState([laria, a0], [e3, e0]);
  fund(state);

  const r = performAction(state, { unit: "la", skillId: "laria5", targets: [] });
  assert.ok(r.ok, "Nightfall resolves");

  assert.equal(laria.hp, 90, "caster (2 stacks) healed 10");
  assert.equal(a0.hp, 50, "0-stack ally healed 0");
  assert.equal(e3.hp, 85, "3-stack enemy took 15 damage");
  assert.equal(e0.hp, 100, "0-stack enemy took 0 damage");

  // Everyone — including 0-stack units — becomes invulnerable.
  for (const u of [laria, a0, e3, e0]) {
    assert.equal(hasKind(u, "invulnerable"), true, `${u.id} is invulnerable`);
  }

  // Stacks are not consumed.
  assert.equal(dsCount(laria), 2, "caster keeps her 2 stacks");
  assert.equal(dsCount(e3), 3, "enemy keeps its 3 stacks");
});
