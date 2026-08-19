/**
 * Behavior tests for Prisma Trinity, asserted against the frozen skill prose (the oracle). Trinity is a
 * three-body hero: the a1 shell is an undamageable/untargetable stand-in and the fight is carried by its
 * three summoned Rangers — Prisma Crimson, Prisma Azure, Prisma Saffron — whose concrete skills realize the
 * abstract shell skills.
 *
 *   trinity0 Prismari Rangers — "Prisma Trinity is split between three members ... This Hero is Untargetable
 *                               and ignores damage and Harmful effects, and is considered to be dead when all
 *                               three members are dead."
 *   trinity1 Prisma Lens      — "Members of the Prismari can target the user of this skill to reflect their own
 *                               skills to the targeted enemy, amplified. Reflecting skills this way gives Prisma
 *                               Trinity Elemental Essence."  (Ruby / Sapphire / Citrine Lens)
 *   trinity2 Prisma Maneuver  — reactive/defensive: Prisma Vault, Prisma Whirl, Prisma Launch.
 *   trinity3 Chroma Magica    — magical attacks: Crimson Crash, Sonata Azure, Saffron Beam.
 *
 * Ranger skills (each id begins with "trinity"):
 *   trinitycrimson1 Ruby Lens      — redirect setup; a redirected skill deals +5 Affliction to the target enemy.
 *   trinitycrimson2 Prisma Vault   — self Invulnerable 1t; buddy: marks the lens's enemy for Prisma Vault.
 *   trinitycrimson3 Crimson Crash  — 15 damage; +15 more vs a Prisma Vault-marked enemy.
 *   trinityazure1   Sapphire Lens  — redirect setup; a redirected skill heals the redirected ally 10 HP. Uncounterable.
 *   trinityazure2   Prisma Whirl   — primes 10 Piercing on the first enemy to act; buddy: Invulnerable + hits any number.
 *   trinityazure3   Sonata Azure   — 10 Piercing + stuns the target's Strategic skills 1t.
 *   trinitysaffron1 Citrine Lens   — redirect setup; a redirected skill weakens the target enemy -5 damage 1t. Uncounterable.
 *   trinitysaffron2 Prisma Launch  — Saffron's skills Bypass vs the target; buddy: buddy also Bypasses + Invulnerable.
 *   trinitysaffron3 Saffron Beam   — 10 damage + Taunts the target onto Saffron 1t.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { battle, unit, skillOf, hasStatus, stackMag, performAction, canUse, startTurn, endTurn, emit } from "../skillHarness.ts";

const A: [string, string, string] = ["trinity", "gommar", "gommar"];
const B: [string, string, string] = ["riverdaughter", "laria", "xyris"];

/** Rangers are prism-element; the flush pool has no prism, so top it up so specific costs never block. */
function prismBattle(): ReturnType<typeof battle> {
  const s = battle(A, B);
  s.teams.A.energy.prism = 99;
  s.teams.B.energy.prism = 99;
  return s;
}
const ranger = (s: ReturnType<typeof battle>, name: string) =>
  Object.values(s.units).find((u) => u.name === name)!;
const trinityEssence = (s: ReturnType<typeof battle>) => hasStatus(unit(s, "a1"), "elemental_essence");

// --------------------------------------------------------------------------- //
//  trinity0 — Prismari Rangers (passive)
// --------------------------------------------------------------------------- //

test("Prismari Rangers — the shell is Untargetable and ignores damage/Harmful, with three Rangers and RangersAlive=3", () => {
  const s = prismBattle();
  const shell = unit(s, "a1");
  assert.ok(hasStatus(shell, "untargetable"), "Untargetable");
  assert.ok(hasStatus(shell, "damage_ignore"), "ignores damage");
  assert.ok(hasStatus(shell, "non_damage_ignore"), "ignores Harmful effects");
  assert.equal(stackMag(shell, "RangersAlive"), 3, "RangersAlive starts at 3");
  for (const name of ["Prisma Crimson", "Prisma Azure", "Prisma Saffron"]) {
    assert.ok(ranger(s, name), `${name} is summoned`);
  }
});

test("Prismari Rangers — an enemy cannot single-target the Untargetable shell", () => {
  const s = prismBattle();
  const r = performAction(s, { unit: "b1", skillId: "riverdaughter2", targets: ["a1"] });
  assert.equal(r.ok, false, "the action is rejected");
  assert.equal(r.reason, "no-legal-target", "because the shell is untargetable");
});

test("Prismari Rangers — the shell ignores AOE Harmful damage (untargetable + damage_ignore)", () => {
  const s = prismBattle();
  performAction(s, { unit: "b1", skillId: "riverdaughter1" }); // 10 to the whole enemy team
  assert.equal(unit(s, "a1").hp, 100, "the shell takes no damage");
});

test("Prismari Rangers — Trinity is considered dead only once all three members are dead", () => {
  const s = prismBattle();
  const names = ["Prisma Crimson", "Prisma Azure", "Prisma Saffron"];
  for (let i = 0; i < names.length; i++) {
    const r = ranger(s, names[i]!);
    r.hp = 0;
    r.alive = false;
    emit(s, { type: "unitDied", unit: r.id, killer: "b1" });
    const remaining = names.length - 1 - i;
    assert.equal(stackMag(unit(s, "a1"), "RangersAlive"), remaining, `RangersAlive drops to ${remaining}`);
    assert.equal(unit(s, "a1").alive, remaining > 0, remaining > 0 ? "Trinity still alive" : "Trinity dead at 0 members");
  }
});

// --------------------------------------------------------------------------- //
//  trinitycrimson3 — Crimson Crash (Chroma Magica)
// --------------------------------------------------------------------------- //

test("Crimson Crash — deals 15 damage to the target enemy", () => {
  const s = prismBattle();
  performAction(s, { unit: ranger(s, "Prisma Crimson").id, skillId: "trinitycrimson3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 85, "15 damage");
});

// --------------------------------------------------------------------------- //
//  trinitycrimson2 — Prisma Vault (Maneuver)
// --------------------------------------------------------------------------- //

test("Prisma Vault — makes Prisma Crimson Invulnerable for 1 turn", () => {
  const s = prismBattle();
  const crimson = ranger(s, "Prisma Crimson");
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson2", targets: [crimson.id] });
  const inv = crimson.statuses.find((x) => x.kind === "invulnerable");
  assert.ok(inv, "Invulnerable applied");
  assert.equal(inv!.duration, 1, "for 1 turn");
});

test("Prisma Vault (buddy) marks the lensing Ranger's enemy, and Crimson Crash deals +15 to it (total 30)", () => {
  const s = prismBattle();
  const crimson = ranger(s, "Prisma Crimson");
  const saffron = ranger(s, "Prisma Saffron");
  performAction(s, { unit: saffron.id, skillId: "trinitysaffron1", targets: ["b1"] }); // Citrine Lens -> Saffron lensing b1
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson2", targets: [saffron.id] }); // Vault on lensing Saffron
  assert.ok(hasStatus(unit(s, "b1"), "mark"), "the enemy is marked");
  assert.ok(
    unit(s, "b1").statuses.some((x) => x.kind === "mark" && x.name === "Prisma Vault"),
    "specifically the Prisma Vault mark",
  );
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson3", targets: ["b1"] }); // Crimson Crash 15 + 15
  assert.equal(unit(s, "b1").hp, 70, "15 base + 15 Prisma Vault bonus = 30 (100 -> 70)");
});

// --------------------------------------------------------------------------- //
//  trinitycrimson1 — Ruby Lens (reflect)
// --------------------------------------------------------------------------- //

test("Ruby Lens — a skill reflected via Prisma Crimson hits the marked enemy with +5 Affliction and grants Trinity Elemental Essence", () => {
  const s = prismBattle();
  const crimson = ranger(s, "Prisma Crimson");
  const azure = ranger(s, "Prisma Azure");
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson1", targets: ["b1"] }); // Ruby Lens: Crimson lenses b1
  assert.ok(crimson.statuses.some((x) => x.kind === "mark" && x.name === "Lens"), "Crimson holds the Lens mark");
  assert.ok(unit(s, "b1").statuses.some((x) => x.kind === "mark" && x.name === "Lens Target"), "b1 is the Lens Target");
  // Azure fires a Harmful skill at the lensing Crimson -> redirected to b1, amplified.
  performAction(s, { unit: azure.id, skillId: "trinityazure3", targets: [crimson.id] }); // Sonata Azure: 10 pierce
  assert.equal(unit(s, "b1").hp, 85, "10 (Sonata) + 5 (Ruby amplification) = 15 to the lens target");
  assert.equal(unit(s, "a1").hp, 100, "the reflect leaves Crimson unharmed (fully redirected)");
  assert.equal(crimson.hp, 65, "Crimson takes none of it");
  assert.ok(trinityEssence(s), "reflecting grants Prisma Trinity Elemental Essence");
  assert.equal(crimson.statuses.some((x) => x.kind === "mark" && x.name === "Lens"), false, "the Lens is consumed");
});

// --------------------------------------------------------------------------- //
//  trinityazure3 — Sonata Azure (Chroma Magica)
// --------------------------------------------------------------------------- //

test("Sonata Azure — deals 10 Piercing damage and stuns the target's Strategic skills for 1 turn", () => {
  const s = prismBattle();
  performAction(s, { unit: ranger(s, "Prisma Azure").id, skillId: "trinityazure3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 Piercing damage");
  const stun = unit(s, "b1").statuses.find((x) => x.kind === "stun");
  assert.ok(stun, "a stun is applied");
  assert.deepEqual(stun!.scope, { tag: "Strategic", mode: "only" }, "Strategic-only stun");
  assert.equal(stun!.duration, 1, "for 1 turn");
});

// --------------------------------------------------------------------------- //
//  trinityazure2 — Prisma Whirl (Maneuver)
// --------------------------------------------------------------------------- //

test("Prisma Whirl — the first enemy to act after it is primed takes 10 Piercing, and the primed mark is consumed", () => {
  const s = prismBattle();
  const azure = ranger(s, "Prisma Azure");
  performAction(s, { unit: azure.id, skillId: "trinityazure2", targets: [azure.id] }); // self-prime
  assert.ok(azure.statuses.some((x) => x.kind === "mark" && x.name === "Prisma Whirl"), "primed with the Whirl mark");
  endTurn(s); // hand to team B
  startTurn(s);
  performAction(s, { unit: "b1", skillId: "riverdaughter1" }); // first enemy action
  assert.equal(unit(s, "b1").hp, 90, "the first acting enemy takes 10 Piercing");
  assert.equal(azure.statuses.some((x) => x.kind === "mark" && x.name === "Prisma Whirl"), false, "consumed (first-only)");
});

test("Prisma Whirl (buddy) on a lensing Ranger grants Invulnerable and upgrades to a Barrage that hits any number of enemies", () => {
  const s = prismBattle();
  const azure = ranger(s, "Prisma Azure");
  const crimson = ranger(s, "Prisma Crimson");
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson1", targets: ["b1"] }); // Crimson lensing
  performAction(s, { unit: azure.id, skillId: "trinityazure2", targets: [crimson.id] }); // Whirl on lensing Crimson
  assert.ok(crimson.statuses.some((x) => x.kind === "invulnerable"), "the buddy becomes Invulnerable");
  assert.ok(crimson.statuses.some((x) => x.kind === "mark" && x.name === "Prisma Whirl Barrage"), "upgraded to Barrage");
  endTurn(s);
  startTurn(s);
  performAction(s, { unit: "b1", skillId: "riverdaughter1", targets: ["a2"] });
  performAction(s, { unit: "b2", skillId: "laria1", targets: ["a2"] });
  assert.equal(unit(s, "b1").hp, 90, "first enemy takes 10");
  assert.equal(unit(s, "b2").hp, 90, "second enemy also takes 10 (any number)");
});

// --------------------------------------------------------------------------- //
//  trinityazure1 — Sapphire Lens (reflect + heal, Uncounterable)
// --------------------------------------------------------------------------- //

test("Sapphire Lens — is Uncounterable, and a skill reflected via Prisma Azure heals the redirected ally 10 HP and grants Trinity Essence", () => {
  const s = prismBattle();
  const azure = ranger(s, "Prisma Azure");
  const crimson = ranger(s, "Prisma Crimson");
  assert.ok(skillOf(azure, "trinityazure1").tags.includes("Uncounterable"), "Sapphire Lens is Uncounterable");
  crimson.hp = 40;
  performAction(s, { unit: azure.id, skillId: "trinityazure1", targets: ["b1"] }); // Sapphire Lens: Azure lensing b1
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson3", targets: [azure.id] }); // Crimson Crash redirected
  assert.equal(unit(s, "b1").hp, 85, "the redirected Crimson Crash (15) lands on b1");
  assert.equal(crimson.hp, 50, "the redirected ally (Crimson) is healed 10 (40 -> 50)");
  assert.ok(trinityEssence(s), "reflecting grants Prisma Trinity Elemental Essence");
});

// --------------------------------------------------------------------------- //
//  trinitysaffron3 — Saffron Beam (Chroma Magica)
// --------------------------------------------------------------------------- //

test("Saffron Beam — deals 10 damage and Taunts the target onto Prisma Saffron for 1 turn", () => {
  const s = prismBattle();
  const saffron = ranger(s, "Prisma Saffron");
  performAction(s, { unit: saffron.id, skillId: "trinitysaffron3", targets: ["b1"] });
  assert.equal(unit(s, "b1").hp, 90, "10 damage");
  const taunt = unit(s, "b1").statuses.find((x) => x.kind === "taunt");
  assert.ok(taunt, "a taunt is applied");
  assert.equal(taunt!.unitRef, saffron.id, "taunted onto Prisma Saffron");
  assert.equal(taunt!.duration, 1, "for 1 turn");
});

// --------------------------------------------------------------------------- //
//  trinitysaffron1 — Citrine Lens (reflect + weaken, Uncounterable)
// --------------------------------------------------------------------------- //

test("Citrine Lens — is Uncounterable, and a skill reflected via Prisma Saffron weakens the target enemy -5 damage for 1 turn and grants Trinity Essence", () => {
  const s = prismBattle();
  const saffron = ranger(s, "Prisma Saffron");
  const crimson = ranger(s, "Prisma Crimson");
  assert.ok(skillOf(saffron, "trinitysaffron1").tags.includes("Uncounterable"), "Citrine Lens is Uncounterable");
  performAction(s, { unit: saffron.id, skillId: "trinitysaffron1", targets: ["b1"] }); // Citrine Lens: Saffron lensing b1
  performAction(s, { unit: crimson.id, skillId: "trinitycrimson3", targets: [saffron.id] }); // Crimson Crash redirected
  assert.equal(unit(s, "b1").hp, 85, "the redirected Crimson Crash (15) lands on b1");
  const mod = unit(s, "b1").statuses.find((x) => x.kind === "outgoing_damage_mod");
  assert.ok(mod, "an outgoing-damage weaken is applied to b1");
  assert.equal(mod!.magnitude, -5, "5 less damage");
  assert.equal(mod!.duration, 1, "for 1 turn");
  assert.ok(trinityEssence(s), "reflecting grants Prisma Trinity Elemental Essence");
});

// --------------------------------------------------------------------------- //
//  trinitysaffron2 — Prisma Launch (Maneuver)
// --------------------------------------------------------------------------- //

test("Prisma Launch (buddy) grants the lensing Ranger Invulnerable for 1 turn", () => {
  const s = prismBattle();
  const saffron = ranger(s, "Prisma Saffron");
  const azure = ranger(s, "Prisma Azure");
  performAction(s, { unit: azure.id, skillId: "trinityazure1", targets: ["b1"] }); // Azure lensing
  performAction(s, { unit: saffron.id, skillId: "trinitysaffron2", targets: [azure.id] }); // Launch on lensing Azure
  assert.ok(azure.statuses.some((x) => x.kind === "invulnerable"), "the lensing buddy becomes Invulnerable");
});

test("Prisma Launch — Saffron's skills Bypass invulnerability against the target enemy", () => {
  const s = prismBattle();
  const saffron = ranger(s, "Prisma Saffron");
  performAction(s, { unit: saffron.id, skillId: "trinitysaffron2", targets: ["b1"] }); // Launch vs b1
  // Make b1 Invulnerable; the prose promises Saffron's skills still land against b1 (Bypass).
  unit(s, "b1").statuses.push({ kind: "invulnerable", duration: 1, appliedBy: "x", appliedTurn: 0 });
  const r = performAction(s, { unit: saffron.id, skillId: "trinitysaffron3", targets: ["b1"] }); // Saffron Beam
  assert.equal(r.ok, true, "Saffron Beam is castable against the Invulnerable, Launch-targeted enemy");
  assert.equal(unit(s, "b1").hp, 90, "and it deals its 10 damage (Bypass)");
});
