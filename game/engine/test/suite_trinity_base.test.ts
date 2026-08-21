import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, startRound } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ===========================================================================
// HERO: Prisma Trinity — base kit. Frozen prose (../content/frozen/skills.json) is the ORACLE.
//
//   trinity0 "Prismari Rangers" (passive): "Prisma Trinity is split between three members: Prisma Crimson,
//     Prisma Azure, and Prisma Saffron. This Hero is Untargetable and ignores damage and Harmful effects,
//     and is considered to be dead when all three members are dead."
//   trinity1 "Prisma Lens" / trinity2 "Prisma Maneuver" / trinity3 "Chroma Magica" are UMBRELLA cover-text
//     over the three Rangers' component skills (per the user ruling: implement the components, not the shell).
//     So the real behavior lives on the minion skills, exercised below:
//   Ruby/Sapphire/Citrine Lens (…crimson1/azure1/saffron1): "prepares to redirect a teammate towards a
//     targeted enemy. If a skill is redirected this way, [Ruby] the targeted enemy receives 5 Affliction
//     damage / [Sapphire] the affected ally is healed for 10 HP (cannot be countered) / [Citrine] the
//     targeted enemy deals 5 less damage for 1 turn." (+ "Reflecting skills this way gives Trinity Elemental
//     Essence" — trinity1). Amplification of the reflected skill has NO frozen number (flavor) — never asserted.
//   Prisma Vault (…crimson2): "Prisma Crimson becomes invulnerable for 1 turn. If used on another Prisma
//     Ranger that is using their Lens, the enemy they are targeting is marked for 1 turn. Crimson Crash deals
//     15 more damage to enemies marked by Prisma Vault."
//   Prisma Whirl (…azure2): "For one turn, the first enemy to use a Harmful skill will receive 10 Piercing
//     damage. If used on another Prismari Ranger that is using their Lens, that unit will become Invulnerable
//     for 1 turn and Prisma Whirl's effect can damage any number of enemies."
//   Prisma Launch (…saffron2): "Until the end of the next turn, Prisma Saffron's skills will Bypass against
//     target enemy. If used on another Prisma Ranger that is using their Lens, their skills will also Bypass
//     during this time and they become invulnerable for one turn."
//   Crimson Crash (…crimson3): "Deals 15 damage to target enemy."
//   Sonata Azure (…azure3): "Deals 10 Piercing damage to target enemy and stuns their Strategic skills for 1 turn."
//   Saffron Beam (…saffron3): "Deals 10 damage to target enemy and Taunts them for 1 turn."
//
// Content (roster.generated.ts) is read ONLY to DRIVE: skill ids, costs (Trinity/Rangers' element is prism,
// so `specific` is paid in prism), and the minion names. Every asserted value is from the prose above.
// ===========================================================================

function getRangers(state: MatchState): { crimson: Unit; azure: Unit; saffron: Unit; all: Unit[] } {
  const all = state.teams.A.units.map((id) => state.units[id]!).filter((u) => u && u.kind === "minion");
  const by = (n: string) => {
    const u = all.find((x) => x.name === n);
    assert.ok(u, `${n} minion should exist`);
    return u!;
  };
  return { crimson: by("Prisma Crimson"), azure: by("Prisma Azure"), saffron: by("Prisma Saffron"), all };
}

/** Trinity on team A (id "t"), passive fired via startRound to summon the three Rangers, plus `enemies` foes. */
function boot(enemies = 1) {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  const es: Unit[] = [];
  for (let i = 0; i < enemies; i++) es.push(makeUnit({ id: "e" + i, team: "B", kind: "hero", hp: 300, maxHp: 300 }));
  const state = makeState([trinity], es);
  startRound(state, "A"); // fires Trinity's round-start passive → summons Crimson/Azure/Saffron
  state.teams.A.energy = { generic: 40, prism: 40 };
  state.teams.B.energy = { generic: 40, fire: 40 };
  return { trinity, es, e: es[0]!, state, ...getRangers(state) };
}

const hasEssence = (u: Unit) => u.statuses.some((s) => s.kind === "elemental_essence");
const isInvuln = (u: Unit) => u.statuses.some((s) => s.kind === "invulnerable");
const cast = (state: MatchState, unit: string, skillId: string, targets: string[]) => performAction(state, { unit, skillId, targets });

// ===========================================================================
// trinity0 — "Prismari Rangers" (passive)
// ===========================================================================

test("trinity0: passive summons exactly three named Rangers at round start (control: none before)", () => {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  const enemy = makeUnit({ id: "e0", team: "B", kind: "hero" });
  const state = makeState([trinity], [enemy]);

  // Control: before any round starts, there are no Rangers.
  assert.equal(state.teams.A.units.filter((id) => state.units[id]!.kind === "minion").length, 0, "no Rangers before round start");

  startRound(state, "A");
  const { crimson, azure, saffron, all } = getRangers(state);
  assert.equal(all.length, 3, "exactly three Rangers summoned");
  for (const [name, u] of [["Prisma Crimson", crimson], ["Prisma Azure", azure], ["Prisma Saffron", saffron]] as const) {
    assert.equal(u.kind, "minion", `${name} is a minion`);
    assert.equal(u.team, "A", `${name} is on Trinity's team`);
    assert.ok(u.alive, `${name} is alive`);
    assert.equal(u.hp, u.maxHp, `${name} at full HP`);
  }
});

test("trinity0: Trinity is Untargetable — an enemy's Harmful skill cannot target her (control: it CAN target a Ranger)", () => {
  const { state, crimson, e } = boot();
  e.skills = [skill("zap", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];

  const atTrinity = cast(state, e.id, "zap", ["t"]);
  assert.equal(atTrinity.ok, false, "cannot target the Untargetable Trinity");
  assert.equal(atTrinity.reason, "no-legal-target", "Untargetable → no legal target");

  // Control: the same skill DOES land on a (targetable) Ranger.
  const hp0 = crimson.hp;
  const atRanger = cast(state, e.id, "zap", [crimson.id]);
  assert.equal(atRanger.ok, true, "a Ranger is a legal target");
  assert.equal(hp0 - crimson.hp, 20, "the Ranger took the hit");
});

test("trinity0: Trinity ignores damage — direct damage leaves her HP unchanged (control: a Ranger loses HP)", () => {
  const { state, trinity, crimson, e } = boot();
  const thp0 = trinity.hp;
  runEffects(state, [{ op: "damage", amount: 999, to: "target" }], { caster: e, targets: [trinity] });
  assert.equal(trinity.hp, thp0, "damage_ignore: Trinity's HP is unchanged");
  assert.ok(trinity.alive, "Trinity is not killed by damage");

  const chp0 = crimson.hp;
  runEffects(state, [{ op: "damage", amount: 30, to: "target" }], { caster: e, targets: [crimson] });
  assert.equal(chp0 - crimson.hp, 30, "control: a normal Ranger takes the damage");
});

test("trinity0: Trinity ignores Harmful effects — an enemy-applied stun does not stick (control: it sticks on a Ranger)", () => {
  const { state, trinity, crimson, e } = boot();
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { caster: e, targets: [trinity] });
  assert.ok(!trinity.statuses.some((s) => s.kind === "stun"), "non_damage_ignore: harmful stun does not apply to Trinity");

  // Control: the same enemy-applied stun DOES stick on a Ranger (no Harmful-effect immunity).
  runEffects(state, [{ op: "applyStatus", to: "target", status: { kind: "stun", duration: 1 } }], { caster: e, targets: [crimson] });
  assert.ok(crimson.statuses.some((s) => s.kind === "stun"), "control: the Ranger is stunned");
});

test("trinity0: Trinity is dead only when all three Rangers are dead", () => {
  const { state, trinity, crimson, azure, saffron, e } = boot();
  const kill = (r: Unit) => runEffects(state, [{ op: "damage", amount: 999, to: "target" }], { caster: e, targets: [r] });

  kill(crimson);
  assert.equal(crimson.alive, false, "Crimson dead");
  assert.equal(trinity.alive, true, "Trinity still alive with two Rangers up");

  kill(azure);
  assert.equal(azure.alive, false, "Azure dead");
  assert.equal(trinity.alive, true, "Trinity still alive with one Ranger up");

  kill(saffron);
  assert.equal(saffron.alive, false, "Saffron dead");
  assert.equal(trinity.alive, false, "the third Ranger's death makes Trinity dead");
});

// ===========================================================================
// Chroma Magica components — Crimson Crash / Sonata Azure / Saffron Beam
// ===========================================================================

test("Crimson Crash: deals exactly 15 to the target enemy (control: a non-targeted enemy is unharmed)", () => {
  const { state, crimson, es } = boot(2);
  const [e0, e1] = [es[0]!, es[1]!];
  const hp0 = e0.hp, other0 = e1.hp;
  const r = cast(state, crimson.id, "trinitycrimson3", [e0.id]);
  assert.equal(r.ok, true, `Crimson Crash should cast (reason: ${r.reason})`);
  assert.equal(hp0 - e0.hp, 15, "Crimson Crash deals 15");
  assert.equal(e1.hp, other0, "the other enemy is unharmed");
});

test("Sonata Azure: deals 10 Piercing (ignores DR) and stuns only Strategic skills for 1 turn", () => {
  const { state, azure, e } = boot();
  // Piercing ignores Damage Reduction: with DR 6 the 10 lands in full.
  e.statuses = [status("damage_reduction", { magnitude: 6 })];
  const hp0 = e.hp;
  const r = cast(state, azure.id, "trinityazure3", [e.id]);
  assert.equal(r.ok, true, `Sonata Azure should cast (reason: ${r.reason})`);
  assert.equal(hp0 - e.hp, 10, "10 Piercing ignores DR (full 10 to HP)");

  // Cross-check that DR is real: a NORMAL-damage skill (Crimson Crash 15) IS reduced by the same DR.
  const { state: s2, crimson: c2, e: e2 } = boot();
  e2.statuses = [status("damage_reduction", { magnitude: 6 })];
  const h2 = e2.hp;
  cast(s2, c2.id, "trinitycrimson3", [e2.id]);
  assert.equal(h2 - e2.hp, 9, "control: normal Crimson Crash 15 is reduced to 9 by DR 6 (so Sonata's 10 was truly piercing)");

  // Strategic-stun: the hit enemy cannot use a Strategic skill, but CAN use a non-Strategic (Harmful) one.
  e.skills = [
    skill("strat", [{ op: "applyStatus", to: "self", status: { kind: "invulnerable", duration: 1 } }], { tags: ["Strategic", "Instant"], targeting: "self" }),
    skill("harm", [{ op: "damage", amount: 1, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" }),
  ];
  const strat = cast(state, e.id, "strat", [e.id]);
  assert.equal(strat.ok, false, "Strategic skill is stunned");
  assert.equal(strat.reason, "stunned", "reason: strategic-stunned");
  const harm = cast(state, e.id, "harm", [azure.id]);
  assert.equal(harm.ok, true, "a non-Strategic (Harmful) skill is NOT stunned");
});

test("Sonata Azure: a fresh enemy that was never hit is not Strategic-stunned (control)", () => {
  const { state, e } = boot();
  e.skills = [skill("strat", [{ op: "applyStatus", to: "self", status: { kind: "invulnerable", duration: 1 } }], { tags: ["Strategic", "Instant"], targeting: "self" })];
  const r = cast(state, e.id, "strat", [e.id]);
  assert.equal(r.ok, true, "un-hit enemy can freely use a Strategic skill");
});

test("Saffron Beam: deals exactly 10 and Taunts the enemy for 1 turn (forces its Harmful onto Saffron)", () => {
  const { state, saffron, crimson, e } = boot();
  const hp0 = e.hp;
  const r = cast(state, saffron.id, "trinitysaffron3", [e.id]);
  assert.equal(r.ok, true, `Saffron Beam should cast (reason: ${r.reason})`);
  assert.equal(hp0 - e.hp, 10, "Saffron Beam deals 10");

  // Taunt: the enemy's single-target Harmful skill is forced onto Saffron even when it aims elsewhere.
  e.skills = [skill("zap", [{ op: "damage", amount: 12, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];
  const sHp0 = saffron.hp, cHp0 = crimson.hp;
  const atk = cast(state, e.id, "zap", [crimson.id]); // aims at Crimson
  assert.equal(atk.ok, true, "the taunted enemy still acts");
  assert.equal(sHp0 - saffron.hp, 12, "Taunt forced the hit onto Saffron");
  assert.equal(crimson.hp, cHp0, "Crimson (the chosen target) took nothing");
});

test("Saffron Beam: control — a never-Beamed enemy is not Taunted (its Harmful hits the chosen target)", () => {
  const { state, saffron, crimson, e } = boot();
  e.skills = [skill("zap", [{ op: "damage", amount: 12, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];
  const cHp0 = crimson.hp, sHp0 = saffron.hp;
  cast(state, e.id, "zap", [crimson.id]);
  assert.equal(cHp0 - crimson.hp, 12, "no taunt: the hit lands on the chosen Crimson");
  assert.equal(saffron.hp, sHp0, "Saffron untouched");
});

// ===========================================================================
// Prisma Lens components — the redirect/reflect mechanic (trinity1 umbrella)
// ===========================================================================

test("Prisma Lens: a prepared Lens redirects a teammate's Harmful skill onto the targeted enemy and grants Trinity Elemental Essence", () => {
  const { state, trinity, crimson, azure, e } = boot();
  assert.ok(!hasEssence(trinity), "no Elemental Essence before any reflect");

  // Crimson prepares Ruby Lens aimed at the enemy.
  const lens = cast(state, crimson.id, "trinitycrimson1", [e.id]);
  assert.equal(lens.ok, true, `Ruby Lens should cast (reason: ${lens.reason})`);

  // Azure fires a Harmful skill (Sonata Azure) AT Crimson (the Lens holder) → reflected onto the enemy.
  const eHp0 = e.hp, cHp0 = crimson.hp;
  const red = cast(state, azure.id, "trinityazure3", [crimson.id]);
  assert.equal(red.ok, true, `the reflected cast resolves (reason: ${red.reason})`);
  assert.equal(crimson.hp, cHp0, "the Lens holder (ally) took NO damage — the skill was redirected away");
  assert.ok(e.hp < eHp0, "the targeted enemy took the redirected damage");
  assert.ok(hasEssence(trinity), "reflecting a skill this way gives Trinity Elemental Essence");
});

test("Prisma Lens: control — with NO Lens prepared, a Harmful skill aimed at an ally hits that ally and grants NO Essence", () => {
  const { state, trinity, crimson, azure } = boot();
  const cHp0 = crimson.hp;
  const r = cast(state, azure.id, "trinityazure3", [crimson.id]); // no Lens on Crimson
  assert.equal(r.ok, true, "the cast resolves");
  assert.ok(crimson.hp < cHp0, "without a Lens there is no redirect: the ally takes the hit");
  assert.ok(!hasEssence(trinity), "no reflect → no Elemental Essence");
});

test("Ruby Lens: the redirected enemy receives 5 extra (Affliction) — isolated by differencing Ruby vs Sapphire with the SAME reflected skill", () => {
  // Both scenarios reflect Saffron Beam (a fixed skill). Ruby adds 5 to the enemy; Sapphire's rider heals the
  // ally and adds NOTHING to the enemy. The prose gives no reflect-amplification number, so we assert only the
  // DIFFERENCE, which the prose fixes at exactly 5 (Ruby's "5 Affliction damage").
  const rubyLoss = (() => {
    const { state, crimson, saffron, e } = boot();
    cast(state, crimson.id, "trinitycrimson1", [e.id]); // Ruby Lens holder = Crimson
    const hp0 = e.hp;
    cast(state, saffron.id, "trinitysaffron3", [crimson.id]); // Saffron Beam reflected
    return hp0 - e.hp;
  })();
  const sapphireLoss = (() => {
    const { state, azure, saffron, e } = boot();
    cast(state, azure.id, "trinityazure1", [e.id]); // Sapphire Lens holder = Azure
    const hp0 = e.hp;
    cast(state, saffron.id, "trinitysaffron3", [azure.id]); // Saffron Beam reflected
    return hp0 - e.hp;
  })();
  assert.equal(rubyLoss - sapphireLoss, 5, "Ruby Lens adds exactly 5 to the enemy over Sapphire (its 5 Affliction rider)");
});

test("Sapphire Lens: the redirected (affected) ally is healed for exactly 10 HP; the skill is Uncounterable", () => {
  const { state, azure, crimson, e } = boot();
  crimson.hp = 40; // the teammate whose skill will be redirected is wounded
  cast(state, azure.id, "trinityazure1", [e.id]); // Azure prepares Sapphire Lens on the enemy
  const cHp0 = crimson.hp;
  const red = cast(state, crimson.id, "trinitycrimson3", [azure.id]); // Crimson Crash reflected via Azure
  assert.equal(red.ok, true, `redirect resolves (reason: ${red.reason})`);
  assert.equal(crimson.hp - cHp0, 10, "the affected (redirected) ally is healed for 10 HP");

  // "This skill cannot be countered": Sapphire Lens carries the Uncounterable class (frozen prose).
  const sapphireSkill = (azure.skills ?? []).find((s) => s.id === "trinityazure1")!;
  assert.ok(sapphireSkill.tags.includes("Uncounterable"), "Sapphire Lens is Uncounterable");
});

test("Citrine Lens: the redirected enemy deals 5 less damage for 1 turn (control: full damage without it)", () => {
  const { state, saffron, crimson, e } = boot();
  cast(state, saffron.id, "trinitysaffron1", [e.id]); // Saffron prepares Citrine Lens on the enemy
  const red = cast(state, crimson.id, "trinitycrimson3", [saffron.id]); // Crimson Crash reflected via Saffron
  assert.equal(red.ok, true, `redirect resolves (reason: ${red.reason})`);

  // The debuffed enemy now attacks a Ranger and deals 5 less.
  e.skills = [skill("zap", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];
  const cHp0 = crimson.hp;
  cast(state, e.id, "zap", [crimson.id]);
  assert.equal(cHp0 - crimson.hp, 15, "the redirected enemy deals 5 less (20 → 15) for 1 turn");

  // Control: an enemy that was never Citrine-redirected deals the full 20.
  const ctrl = boot();
  ctrl.e.skills = [skill("zap", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];
  const c2Hp0 = ctrl.crimson.hp;
  cast(ctrl.state, ctrl.e.id, "zap", [ctrl.crimson.id]);
  assert.equal(c2Hp0 - ctrl.crimson.hp, 20, "control: no Citrine debuff → full 20 damage");
});

// ===========================================================================
// Prisma Maneuver components — Prisma Vault / Prisma Whirl / Prisma Launch (trinity2 umbrella)
// ===========================================================================

test("Prisma Vault (self): Prisma Crimson becomes Invulnerable for 1 turn (enemy Harmful cannot target him)", () => {
  const { state, crimson, e } = boot();
  const r = cast(state, crimson.id, "trinitycrimson2", [crimson.id]);
  assert.equal(r.ok, true, `Prisma Vault should cast (reason: ${r.reason})`);
  assert.ok(isInvuln(crimson), "Crimson is Invulnerable");

  e.skills = [skill("zap", [{ op: "damage", amount: 20, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];
  const atk = cast(state, e.id, "zap", [crimson.id]);
  assert.equal(atk.ok, false, "an Invulnerable Crimson cannot be targeted by a Harmful skill");
  assert.equal(atk.reason, "no-legal-target", "Invulnerable → no legal target");
});

test("Prisma Vault (on a Lens-Ranger): marks that Ranger's targeted enemy, and Crimson Crash deals 15 MORE to a marked enemy", () => {
  // Baseline: unmarked enemy takes 15 from Crimson Crash.
  const base = (() => {
    const { state, crimson, e } = boot();
    const hp0 = e.hp;
    cast(state, crimson.id, "trinitycrimson3", [e.id]);
    return hp0 - e.hp;
  })();
  assert.equal(base, 15, "control: Crimson Crash on an unmarked enemy deals 15");

  const { state, crimson, saffron, e } = boot();
  cast(state, saffron.id, "trinitysaffron1", [e.id]); // Saffron is "a Ranger using their Lens" aimed at the enemy
  const v = cast(state, crimson.id, "trinitycrimson2", [saffron.id]); // Vault on Saffron → marks the enemy
  assert.equal(v.ok, true, `Vault-on-Ranger should cast (reason: ${v.reason})`);

  const hp0 = e.hp;
  cast(state, crimson.id, "trinitycrimson3", [e.id]); // Crimson Crash on the Vault-marked enemy
  assert.equal(hp0 - e.hp, 30, "Crimson Crash deals 15 more (15 → 30) to a Prisma-Vault-marked enemy");
});

test("Prisma Whirl (self): the first enemy to use a Harmful skill takes 10 Piercing; it fires only ONCE", () => {
  const { state, azure, es } = boot(2);
  const [e0, e1] = [es[0]!, es[1]!];
  const w = cast(state, azure.id, "trinityazure2", [azure.id]); // Prisma Whirl on self
  assert.equal(w.ok, true, `Prisma Whirl should cast (reason: ${w.reason})`);

  for (const en of es) en.skills = [skill("zap", [{ op: "damage", amount: 3, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];

  const e0Hp0 = e0.hp;
  cast(state, e0.id, "zap", [azure.id]); // first enemy Harmful → takes 10 Piercing
  assert.equal(e0Hp0 - e0.hp, 10, "the first enemy to use a Harmful skill receives 10 Piercing");

  const e1Hp0 = e1.hp;
  cast(state, e1.id, "zap", [azure.id]); // a SECOND enemy Harmful → nothing (only the FIRST is punished)
  assert.equal(e1.hp, e1Hp0, "the effect is spent on the first Harmful use — a later one is not punished");
});

test("Prisma Whirl (self): punishes only a HARMFUL enemy skill, not a non-Harmful one", () => {
  // Frozen: "the first enemy to use a HARMFUL skill will receive 10 Piercing damage." An enemy that uses a
  // NON-Harmful (Strategic) skill must NOT be punished. The engine fires on any enemy skillUsed (no Harmful gate).
  const { state, azure, e } = boot();
  cast(state, azure.id, "trinityazure2", [azure.id]); // Prisma Whirl on self
  e.skills = [skill("buff", [{ op: "applyStatus", to: "self", status: { kind: "invulnerable", duration: 1 } }], { tags: ["Strategic", "Instant"], targeting: "self" })];
  const hp0 = e.hp;
  cast(state, e.id, "buff", [e.id]); // a NON-Harmful skill
  assert.equal(e.hp, hp0, "a non-Harmful enemy skill must NOT take 10 Piercing (prose says 'Harmful skill')");
});

test("Prisma Whirl (on a Lens-Ranger): that Ranger becomes Invulnerable for 1 turn and the effect can damage ANY number of enemies", () => {
  const { state, azure, saffron, es } = boot(2);
  const [e0, e1] = [es[0]!, es[1]!];
  cast(state, saffron.id, "trinitysaffron1", [e0.id]); // Saffron = a Ranger using their Lens
  const w = cast(state, azure.id, "trinityazure2", [saffron.id]); // Whirl on the Lens-Ranger
  assert.equal(w.ok, true, `Whirl-on-Ranger should cast (reason: ${w.reason})`);
  assert.ok(isInvuln(saffron), "the targeted Lens-Ranger becomes Invulnerable for 1 turn");

  for (const en of es) en.skills = [skill("zap", [{ op: "damage", amount: 3, to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single" })];
  const h0 = [e0.hp, e1.hp];
  cast(state, e0.id, "zap", [azure.id]); // BOTH enemies' Harmful uses are punished (not just the first)
  cast(state, e1.id, "zap", [azure.id]);
  assert.equal(h0[0]! - e0.hp, 10, "first enemy Harmful → 10 Piercing (barrage)");
  assert.equal(h0[1]! - e1.hp, 10, "second enemy Harmful → 10 Piercing too (any number of enemies)");
});

test("Prisma Launch (self): Prisma Saffron's skills Bypass (ignore DR + Shield) the targeted enemy (control: an unmarked enemy is not bypassed)", () => {
  const { state, saffron, e } = boot();
  e.shields = [{ amount: 50, duration: null, appliedBy: "x", appliedTurn: 0 }];
  e.statuses = [status("damage_reduction", { magnitude: 8 })];
  cast(state, saffron.id, "trinitysaffron2", [e.id]); // Prisma Launch on the enemy
  const hp0 = e.hp;
  cast(state, saffron.id, "trinitysaffron3", [e.id]); // Saffron Beam (10 normal) → bypasses DR + Shield
  assert.equal(hp0 - e.hp, 10, "Saffron Beam bypasses DR(8) + Shield(50): full 10 to HP");

  // Control: a DIFFERENT, unmarked enemy is not bypassed — DR + Shield apply, no HP lost.
  const ctrl = boot();
  ctrl.e.shields = [{ amount: 50, duration: null, appliedBy: "x", appliedTurn: 0 }];
  ctrl.e.statuses = [status("damage_reduction", { magnitude: 8 })];
  const chp0 = ctrl.e.hp;
  cast(ctrl.state, ctrl.saffron.id, "trinitysaffron3", [ctrl.e.id]); // no Launch mark
  assert.equal(ctrl.e.hp, chp0, "control: unmarked enemy — 10 reduced by DR to 2, absorbed by Shield, no HP lost");
});

test("Prisma Launch (on a Lens-Ranger): that Ranger becomes Invulnerable for 1 turn", () => {
  const { state, saffron, crimson, e } = boot();
  cast(state, crimson.id, "trinitycrimson1", [e.id]); // Crimson = a Ranger using their Lens
  const l = cast(state, saffron.id, "trinitysaffron2", [crimson.id]); // Launch on the Lens-Ranger
  assert.equal(l.ok, true, `Launch-on-Ranger should cast (reason: ${l.reason})`);
  assert.ok(isInvuln(crimson), "the targeted Lens-Ranger becomes Invulnerable for 1 turn");
});
