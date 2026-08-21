import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, endTurn } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================================
// Adversarial, SPEC-DERIVED behavioural suite for Geolord ROLAND's FUSION FORMS.
// The FROZEN prose (content/frozen/skills.json) is the sole oracle for WHAT each form must do.
// The authored roster/fusions are read only to learn HOW to drive: element keys, skill ids,
// costs, targeting, and the status/minion NAMES each form should produce.
//
// Frozen text under test (passive + active per form):
//   grave    — Cairnstones (rolandgrave0): "Whenever a non-Boulder, non-Zombie ally dies, Roland
//                creates a Boulder minion."
//              Call the Honored Dead (rolandgrave1): "Consumes all active Boulder minions to create
//                that many Zombie minions."
//   life     — Living Boulder (rolandlife0): "Boulder minions now have Living Lash." (Living Lash =
//                "Deals 10 damage to target enemy.")
//              Mother Stone's Embrace (rolandlife1): "For the next 2 turns, all allied units are
//                affected by Living Stone each turn."
//   magnet   — Mag-Lev Pillars (rolandmagnet0): "Boulders gain 15 Shield for 2 turns whenever an
//                enemy is affected by Earth Pillar."
//              Magnetize Munitions (rolandmagnet1): "Target Boulder taunts all enemies for 1 turn.
//                On the following turn, that Boulder will deal double damage to any enemy it damages."
//   moon     — Moonfield (rolandmoon0): "Each time Earth Pillar has been used or a Boulder has been
//                launched with Strength From The Earth, Roland gains one stack of Stonefield Stalker."
//              Stonefield Stalker (rolandmoon1): "Roland consumes all stacks of Stonefield Stalker. He
//                becomes Mooncursed for a number of turns equal to 1 + the number of stacks consumed,
//                and during this time Strength from the Earth deals 15 additional damage to targets
//                affected by Earth Pillar."
//   myth     — Spires of the North (rolandmyth0): "Earth Pillar can now be used on allies, giving them
//                15 permanent Shield and making them invulnerable to Strategic skills for 2 turns."
//              Troll Stonethrower (rolandmyth1): "Creates a Troll Stonethrower minion."
//   nomad    — Mark the Path (rolandnomad0): "Enemies damaged by Boulders are permanently marked by
//                Mark the Path. Allies Bypass when targeting enemies affected by Mark the Path."
//              FInal Warning (rolandnomad1): "Roland casts Strength From The Earth on all enemy heroes
//                marked by Mark the Path and all active Boulders."
//   sanctuary— Soothing Stone (rolandsanctuary0): "Allies affected by Living Stone's shield heal 5 HP
//                each turn."
//              Sanctus Terra (rolandsanctuary1): "Deals 45 damage to the enemy team. Can only be used
//                if Roland has exactly 4 Boulder minions."
//   slime    — Oozeshaping (rolandslime0): "Creating Boulder minionss now instead creates two Slimeball
//                minions. Strength from the Earth can be used to launch a Slimeball like it's a Boulder,
//                stunning any enemy damaged by it."
//              Call to the Mire (rolandslime1): "For 2 turns, Slimeball minions are immune to damage
//                and one will be created each turn."
//   spore    — Scattered Spores (rolandspore0): "Whenever a Boulder is destroyed, create a Stonecap
//                Mushroom minion. If Roland uses Strength from the Earth on a Stonecap Mushroom, he
//                deals 15 Affliction damage to all enemy units, destroying the Stonecap Mushroom."
//              Loamwrecker (rolandspore1): "Deals 35 damage to target enemy. If Roland controls more
//                Boulders than Stonecap Mushrooms, this damage is Piercing and grants him 15 Shield. If
//                he controls more Stonecap Mushrooms than Boulders, this damage is Affliction and heals
//                him for 10 Health."
//   sun      — Exposure (rolandsun0): "Enemies marked by Earth Pillar receive 10 Affliction damage per
//                turn that they remain marked."
//              Molten Rockslide (rolandsun1): "Launches all active Boulders at target enemy affected by
//                Earth Pillar, dealing 20 Affliction damage per Boulder."
// ============================================================================================

const totalShield = (u: Unit) => u.shields.reduce((t, s) => t + s.amount, 0);
const has = (u: Unit, kind: string, name?: string) =>
  u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const stackMag = (u: Unit, name: string) =>
  u.statuses.find((s) => s.kind === "stack" && s.name === name)?.magnitude ?? 0;
const aliveMinions = (st: MatchState, name: string, team: "A" | "B" = "A") =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.name === name && u.team === team && u.alive);

/** A fused Roland pays a Specific cost in his CURRENT (fusion) element; fund every colour generously. */
function fund(st: MatchState): void {
  const bag = {
    generic: 80, earth: 40, grave: 40, life: 40, magnet: 40, moon: 40, myth: 40,
    nomad: 40, sanctuary: 40, slime: 40, spore: 40, sun: 40, fire: 40,
  };
  st.teams.A.energy = { ...bag };
  st.teams.B.energy = { ...bag };
}

function fuse(key: string, id = "a1"): Unit {
  const r = loadHero(heroById("roland"), "A", id);
  applyFusion(r, fusionForm("roland", key)!);
  return r;
}
function baseRoland(id = "a1"): Unit {
  return loadHero(heroById("roland"), "A", id);
}

/** A generic enemy hero carrying a Harmful hit, a Strategic-Harmful hit, and a Strategic self-buff. */
function enemy(id: string, hp = 100): Unit {
  return makeUnit({
    id, team: "B", hp, maxHp: hp, name: `Enemy ${id}`,
    skills: [
      skill("zap", [{ op: "damage", amount: 20, dtype: "normal", to: "target", id: "zap.hit" }],
        { targeting: "single", tags: ["Harmful", "Instant"], cost: { generic: 0, specific: 0 } }),
      skill("stratzap", [{ op: "damage", amount: 20, dtype: "normal", to: "target", id: "stratzap.hit" }],
        { targeting: "single", tags: ["Harmful", "Strategic", "Instant"], cost: { generic: 0, specific: 0 } }),
      skill("buff", [{ op: "applyStatus", to: "caster", status: { kind: "damage_reduction", magnitude: 5, duration: 1 } }],
        { targeting: "self", tags: ["Strategic", "Instant"], cost: { generic: 0, specific: 0 } }),
    ],
  });
}

/** Manually attach a minion (Boulder/Zombie/Slimeball/Stonecap Mushroom/…) to a team after makeState. */
function addMinion(st: MatchState, name: string, id: string, hp = 50, team: "A" | "B" = "A"): Unit {
  const m = makeUnit({ id, team, kind: "minion", name, hp, maxHp: hp, baseElement: "earth", currentElement: "earth" });
  st.units[id] = m;
  st.teams[team].units.push(id);
  return m;
}

// =========================================================================== //
//  GRAVE — Cairnstones + Call the Honored Dead
// =========================================================================== //

test("grave Cairnstones: when a normal (non-Boulder/Zombie) ally dies, Roland creates a Boulder", () => {
  const r = fuse("grave");
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally", hp: 10, maxHp: 100 });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);

  assert.equal(aliveMinions(st, "Boulder").length, 0, "no Boulder before the ally dies");
  performAction(st, { unit: "e1", skillId: "zap", targets: ["a2"] }); // 20 kills the 10-hp ally
  assert.equal(ally.alive, false, "the ally died");
  assert.equal(aliveMinions(st, "Boulder").length, 1, "a Boulder is created from the ally's death");
});

test("grave Cairnstones control: an ENEMY death does NOT create a Boulder (gated on ally faction)", () => {
  const r = fuse("grave");
  const e = enemy("e1", 10);
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] }); // Earth Pillar: 20 kills the 10-hp enemy
  assert.equal(e.alive, false, "the enemy died");
  assert.equal(aliveMinions(st, "Boulder").length, 0, "an enemy death is not an ALLY death — no Boulder");
});

// Adversarial: frozen excludes Boulder/Zombie deaths ("a non-Boulder, non-Zombie ally") precisely to avoid a
// spawn loop off the stones this form makes. The authored trigger gates ONLY on `isFaction ally`, so a Boulder
// dying is itself an ally death and re-spawns a Boulder.
test.skip("SUSPECTED BUG: grave Cairnstones re-spawns a Boulder off a BOULDER's death — frozen excludes non-Boulder/Zombie only, but the trigger has no template exclusion", () => {
  const r = fuse("grave");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  const boulder = addMinion(st, "Boulder", "b1", 10);
  assert.equal(aliveMinions(st, "Boulder").length, 1, "exactly one Boulder before its death");
  performAction(st, { unit: "e1", skillId: "zap", targets: ["b1"] }); // 20 kills the 10-hp Boulder
  assert.equal(boulder.alive, false, "the Boulder died");
  assert.equal(aliveMinions(st, "Boulder").length, 0, "a Boulder's death must NOT create a new Boulder (loop guard)");
});

test("grave Call the Honored Dead: consumes all active Boulders to create that many Zombies", () => {
  const r = fuse("grave");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  const b1 = addMinion(st, "Boulder", "b1", 50);
  const b2 = addMinion(st, "Boulder", "b2", 50);

  const res = performAction(st, { unit: "a1", skillId: "rolandgrave1", targets: [] });
  assert.ok(res.ok, "Call the Honored Dead casts");
  assert.equal(aliveMinions(st, "Zombie").length, 2, "two Boulders -> two Zombies");
  assert.equal(b1.alive, false, "the first Boulder was consumed");
  assert.equal(b2.alive, false, "the second Boulder was consumed");
});

test("grave Call the Honored Dead control: with NO Boulders, no Zombies are created", () => {
  const r = fuse("grave");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "rolandgrave1", targets: [] });
  assert.equal(aliveMinions(st, "Zombie").length, 0, "no Boulders -> zero Zombies");
});

// =========================================================================== //
//  LIFE — Living Boulder + Mother Stone's Embrace
// =========================================================================== //

test("life Living Boulder: a Boulder created after fusing has Living Lash and deals 10 with it", () => {
  const r = fuse("life");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone -> a Boulder
  const b = aliveMinions(st, "Boulder")[0]!;
  assert.ok((b.skills ?? []).some((s) => s.id === "rolandlivingboulder1"), "the Boulder gained Living Lash");

  const res = performAction(st, { unit: b.id, skillId: "rolandlivingboulder1", targets: ["e1"] });
  assert.ok(res.ok, "the Boulder can use Living Lash");
  assert.equal(e.hp, 90, "Living Lash deals 10 to the enemy");
});

test("life Living Boulder control: a Boulder from an UNFUSED Roland has no Living Lash", () => {
  const r = baseRoland();
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland3", targets: [] });
  const b = aliveMinions(st, "Boulder")[0]!;
  assert.ok(!(b.skills ?? []).some((s) => s.id === "rolandlivingboulder1"), "no Living Boulder passive -> no Living Lash");
});

test("life Mother Stone's Embrace: over the following turns every ally becomes affected by Living Stone", () => {
  const r = fuse("life");
  const a2 = makeUnit({ id: "a2", team: "A", name: "Ally2" });
  const a3 = makeUnit({ id: "a3", team: "A", name: "Ally3" });
  const st = makeState([r, a2, a3], [enemy("e1")]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "rolandlife1", targets: [] });
  // The effect is scheduled per-turn ("for the next 2 turns … each turn"), not this instant.
  for (const u of [r, a2, a3]) assert.ok(!has(u, "mark", "Living Stone"), "no ally is Living-Stone-marked the instant it is cast");

  for (let i = 0; i < 4; i++) endTurn(st); // advance through Roland's next turns so the scheduled grants fire
  for (const u of [r, a2, a3]) {
    assert.ok(has(u, "mark", "Living Stone"), `${u.name} became affected by Living Stone`);
    assert.ok(totalShield(u) >= 10, `${u.name} received the Living Stone shield`);
  }
});

// =========================================================================== //
//  MAGNET — Mag-Lev Pillars + Magnetize Munitions
// =========================================================================== //

test("magnet Mag-Lev Pillars: a Boulder gains 15 Shield (2 turns) when an enemy is affected by Earth Pillar", () => {
  const r = fuse("magnet");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);

  assert.equal(totalShield(b), 0, "the Boulder has no shield before Earth Pillar");
  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] }); // Earth Pillar marks the enemy
  assert.ok(has(e, "mark", "Earth Pillar"), "the enemy is affected by Earth Pillar");
  const shield = b.shields.find((s) => s.amount === 15)!;
  assert.ok(shield, "the Boulder gained a 15 Shield");
  assert.equal(shield.duration, 2, "…for 2 turns");
});

test("magnet Mag-Lev Pillars control: a NON-Earth-Pillar status on an enemy does not shield Boulders", () => {
  const r = fuse("magnet");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);

  // Some other status applied to the enemy — the passive is keyed on the Earth Pillar mark only.
  emit(st, { type: "statusApplied", unit: "e1", source: "a1", kind: "mark", name: "Some Other Mark" });
  assert.equal(totalShield(b), 0, "no Earth Pillar -> Boulders stay unshielded");
});

// Adversarial: "Target Boulder taunts all enemies for 1 turn" means enemies are FORCED onto that Boulder. The
// authored active applies a `taunt` status to the Boulder itself (no unitRef pointing enemies at it), so the
// engine's taunt-redirect (which reads the ATTACKER's taunt+unitRef) never forces anyone.
test.skip("SUSPECTED BUG: magnet Magnetize Munitions does not taunt enemies onto the Boulder — frozen forces the enemy's Harmful skill onto it, but the taunt is placed on the Boulder with no unitRef", () => {
  const r = fuse("magnet");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);

  performAction(st, { unit: "a1", skillId: "rolandmagnet1", targets: ["b1"] }); // taunt the Boulder
  performAction(st, { unit: "e1", skillId: "zap", targets: ["a1"] });           // enemy AIMS at Roland
  assert.equal(r.hp, 100, "the taunt should force the enemy off Roland");
  assert.equal(b.hp, 30, "…and onto the Boulder (50 - 20)");
});

// Adversarial: "On the following turn, that Boulder will deal double damage to any enemy it damages." With the
// Magnetized mark up, a launched Boulder should deal DOUBLE its remaining-health hit; nothing in the engine
// reads the Magnetized mark to double outgoing damage.
test.skip("SUSPECTED BUG: magnet Magnetize Munitions does not double a Magnetized Boulder's damage — frozen doubles it, the engine has no Magnetized damage reader", () => {
  const r = fuse("magnet");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);
  b.statuses.push(status("mark", { name: "Magnetized", duration: 1 })); // "the following turn"

  performAction(st, { unit: "a1", skillId: "roland1", targets: ["b1"] }); // launch: 50 -15 = 35 remaining
  assert.equal(e.hp, 100 - 70, "a Magnetized Boulder's 35 launch is doubled to 70");
});

// =========================================================================== //
//  MOON — Moonfield + Stonefield Stalker
// =========================================================================== //

// Adversarial: frozen grants ONE stack per Earth-Pillar use. The authored passive installs TWO ungated
// skillUsed triggers, so any self skill grants two stacks.
test.skip("SUSPECTED BUG: moon Moonfield grants TWO Stonefield Stalker stacks for one Earth Pillar — frozen grants exactly one", () => {
  const r = fuse("moon");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] }); // Earth Pillar used once
  assert.equal(stackMag(r, "Stonefield Stalker"), 1, "one Earth Pillar use = one Stonefield Stalker stack");
});

// Adversarial: a skill that is neither Earth Pillar nor a Boulder launch grants NO stacks per frozen; the
// ungated triggers grant two off any self skill.
test.skip("SUSPECTED BUG: moon Moonfield grants stacks off an unrelated skill (Form Stone) — frozen grants none", () => {
  const r = fuse("moon");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland3", targets: [] }); // Form Stone: not Earth Pillar, not a launch
  assert.equal(stackMag(r, "Stonefield Stalker"), 0, "Form Stone must grant no Stonefield Stalker stacks");
});

test("moon Stonefield Stalker: becomes Mooncursed for 1 + (stacks) turns, reading the stacks", () => {
  const r = fuse("moon");
  r.statuses.push(status("stack", { name: "Stonefield Stalker", magnitude: 2, duration: null }));
  const st = makeState([r], [enemy("e1")]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "rolandmoon1", targets: [] });
  const mc = r.statuses.find((s) => s.kind === "mark" && s.name === "Mooncursed")!;
  assert.ok(mc, "Roland becomes Mooncursed");
  assert.equal(mc.duration, 3, "duration = 1 + 2 stacks read at cast time");
});

// Adversarial: the active "consumes all stacks of Stonefield Stalker" — the count should be 0 afterwards. It
// does removeStatus the stacks, but the Moonfield PASSIVE (two ungated skillUsed triggers) fires on the
// active's OWN cast and re-grants 2 stacks, so the resource is never actually spent.
test.skip("SUSPECTED BUG: moon Stonefield Stalker does not end with stacks consumed — the Moonfield over-fire re-grants stacks on the active's own cast", () => {
  const r = fuse("moon");
  r.statuses.push(status("stack", { name: "Stonefield Stalker", magnitude: 2, duration: null }));
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "rolandmoon1", targets: [] });
  assert.equal(stackMag(r, "Stonefield Stalker"), 0, "all Stonefield Stalker stacks are consumed");
});

// Adversarial: frozen says "during this time Strength from the Earth deals 15 additional damage to targets
// affected by Earth Pillar." SFtE (roland1) has no Mooncursed reader, so the +15 rider never applies.
test.skip("SUSPECTED BUG: moon Mooncursed rider is missing — SFtE deals no +15 to an Earth-Pillar target while Mooncursed", () => {
  const r = fuse("moon");
  r.statuses.push(status("mark", { name: "Mooncursed", duration: 3 }));
  const e = enemy("e1");
  e.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  const st = makeState([r], [e]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "roland1", targets: ["e1"] });
  assert.equal(e.hp, 100 - 30, "15 base + 15 Mooncursed rider = 30 on the Earth-Pillar target");
});

test("moon rider control: SFtE deals only 15 when Mooncursed but the target is NOT Earth-Pillar-marked", () => {
  const r = fuse("moon");
  r.statuses.push(status("mark", { name: "Mooncursed", duration: 3 }));
  const e = enemy("e1"); // no Earth Pillar
  const st = makeState([r], [e]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland1", targets: ["e1"] });
  assert.equal(e.hp, 85, "the +15 rider requires the target to be affected by Earth Pillar");
});

test("moon rider control: SFtE deals only 15 on an Earth-Pillar target when NOT Mooncursed", () => {
  const r = fuse("moon");
  const e = enemy("e1");
  e.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  const st = makeState([r], [e]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland1", targets: ["e1"] });
  assert.equal(e.hp, 85, "no Mooncursed -> no +15 rider");
});

// =========================================================================== //
//  MYTH — Spires of the North + Troll Stonethrower
// =========================================================================== //

test("myth Spires of the North: an ally marked by Earth Pillar gains 15 permanent Shield + Strategic invuln", () => {
  const r = fuse("myth");
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);

  // Earth Pillar landing on an ally is the reactive trigger (statusApplied, ally, Earth Pillar mark).
  emit(st, { type: "statusApplied", unit: "a2", source: "a1", kind: "mark", name: "Earth Pillar" });
  const shield = ally.shields.find((s) => s.amount === 15)!;
  assert.ok(shield, "the ally gains 15 Shield");
  assert.equal(shield.duration, null, "…permanent");
  const inv = ally.statuses.find((s) => s.kind === "invulnerable")!;
  assert.ok(inv, "the ally is made invulnerable");
  assert.deepEqual(inv.scope, { tag: "Strategic", mode: "only" }, "scoped to Strategic skills");
  assert.equal(inv.duration, 2, "for 2 turns");

  // A Strategic Harmful skill cannot land on the covered ally.
  const strat = performAction(st, { unit: "e1", skillId: "stratzap", targets: ["a2"] });
  assert.equal(strat.ok, false, "a Strategic skill is blocked");
});

test("myth Spires control: Earth Pillar landing on an ENEMY grants it no Shield/invuln", () => {
  const r = fuse("myth");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  emit(st, { type: "statusApplied", unit: "e1", source: "a1", kind: "mark", name: "Earth Pillar" });
  assert.equal(totalShield(e), 0, "an enemy gains no Spires shield");
  assert.ok(!has(e, "invulnerable"), "an enemy gains no Spires invulnerability");
});

// Adversarial: frozen scopes the invulnerability to STRATEGIC skills only — a non-Strategic Harmful skill must
// still land. The engine's invulnerable gate ignores `scope`, blocking every Harmful skill.
test("myth Spires of the North: invulnerable to Strategic skills only — a non-Strategic hit still lands", () => {
  const r = fuse("myth");
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally" });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);
  emit(st, { type: "statusApplied", unit: "a2", source: "a1", kind: "mark", name: "Earth Pillar" }); // 15 shield + Strategic invuln

  performAction(st, { unit: "e1", skillId: "zap", targets: ["a2"] }); // a NON-Strategic Harmful hit (20)
  assert.equal(ally.hp, 95, "the 15 shield absorbs 15, 5 falls through -> a non-Strategic skill still lands");
});

test("myth Troll Stonethrower: creates one Troll Stonethrower minion (40 HP, Roland's team)", () => {
  const r = fuse("myth");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  assert.equal(aliveMinions(st, "Troll Stonethrower").length, 0, "none before the cast");
  const res = performAction(st, { unit: "a1", skillId: "rolandmyth1", targets: [] });
  assert.ok(res.ok, "the cast succeeds");
  const trolls = aliveMinions(st, "Troll Stonethrower");
  assert.equal(trolls.length, 1, "exactly one Troll Stonethrower is created");
  assert.equal(trolls[0]!.maxHp, 40, "it has 40 max HP");
  assert.equal(trolls[0]!.team, "A", "on Roland's team");
});

// =========================================================================== //
//  NOMAD — Mark the Path + FInal Warning
// =========================================================================== //

test("nomad Mark the Path: an enemy damaged by an allied Boulder minion is permanently marked", () => {
  const r = fuse("nomad");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);

  // The Boulder itself deals the damage (source = the minion) — the reactive rule's precondition.
  emit(st, { type: "damageDealt", source: b.id, target: "e1", amount: 10, dtype: "normal" });
  const mark = e.statuses.find((s) => s.kind === "mark" && s.name === "Mark the Path")!;
  assert.ok(mark, "the Boulder-damaged enemy is marked by Mark the Path");
  assert.equal(mark.duration, null, "…permanently");
});

// Adversarial: the canonical way a Boulder damages an enemy is being LAUNCHED by SFtE — and frozen says such
// an enemy is marked. But SFtE credits the launch's damage to ROLAND (no `from` on its launch node), so the
// event's source is the hero, not the Boulder, and the minion-gated Mark the Path passive never fires.
test.skip("SUSPECTED BUG: a Boulder LAUNCHED by SFtE does not mark its victim — the launch damage is credited to Roland (hero), not the Boulder", () => {
  const r = fuse("nomad");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);

  performAction(st, { unit: "a1", skillId: "roland1", targets: ["b1"] }); // launch the Boulder at the enemy
  assert.ok(!b.alive, "the launched Boulder is destroyed");
  assert.ok(has(e, "mark", "Mark the Path"), "an enemy damaged by a launched Boulder should be Mark-the-Path marked");
});

test("nomad Mark the Path control: an enemy damaged by ROLAND (a hero) is not marked", () => {
  const r = fuse("nomad");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "roland2", targets: ["e1"] }); // Earth Pillar: Roland deals it, not a minion
  assert.ok(!has(e, "mark", "Mark the Path"), "hero-dealt damage does not apply Mark the Path (minion-only)");
});

test("nomad FInal Warning: casts SFtE on every Mark-the-Path enemy hero (not unmarked ones)", () => {
  const r = fuse("nomad");
  const marked = enemy("e1");
  const unmarked = enemy("e2");
  marked.statuses.push(status("mark", { name: "Mark the Path", duration: null }));
  const st = makeState([r], [marked, unmarked]);
  fund(st);

  performAction(st, { unit: "a1", skillId: "rolandnomad1", targets: [] });
  assert.equal(marked.hp, 85, "the Mark-the-Path enemy takes SFtE's 15");
  assert.equal(unmarked.hp, 100, "an unmarked enemy is untouched (no Boulders to launch either)");
});

test("nomad FInal Warning: also casts SFtE on every active Boulder (launching it)", () => {
  const r = fuse("nomad");
  const marked = enemy("e1");
  marked.statuses.push(status("mark", { name: "Mark the Path", duration: null }));
  const st = makeState([r], [marked]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 50);

  performAction(st, { unit: "a1", skillId: "rolandnomad1", targets: [] });
  // Marked enemy: direct SFtE 15, then the launched Boulder (50 -15 = 35 remaining) hits the lone enemy.
  assert.equal(marked.hp, 100 - 15 - 35, "marked enemy eats the direct 15 and the 35 launch");
  assert.equal(b.alive, false, "the Boulder was launched and destroyed");
});

// =========================================================================== //
//  SANCTUARY — Soothing Stone + Sanctus Terra
// =========================================================================== //

test("sanctuary Soothing Stone: an ally affected by Living Stone heals 5 at turn start", () => {
  const r = fuse("sanctuary");
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally", hp: 50, maxHp: 100 });
  ally.statuses.push(status("mark", { name: "Living Stone", duration: null }));
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);

  emit(st, { type: "turnStart", team: "A" });
  assert.equal(ally.hp, 55, "the Living-Stone ally heals 5");
});

test("sanctuary Soothing Stone control: an ally WITHOUT Living Stone does not heal", () => {
  const r = fuse("sanctuary");
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally", hp: 50, maxHp: 100 });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);
  emit(st, { type: "turnStart", team: "A" });
  assert.equal(ally.hp, 50, "no Living Stone mark -> no Soothing Stone heal");
});

test("sanctuary Sanctus Terra: with exactly 4 Boulders, deals 45 to the enemy team", () => {
  const r = fuse("sanctuary");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([r], [e1, e2]);
  fund(st);
  for (let i = 0; i < 4; i++) addMinion(st, "Boulder", `b${i}`, 50);

  const res = performAction(st, { unit: "a1", skillId: "rolandsanctuary1", targets: [] });
  assert.ok(res.ok, "the cast resolves with 4 Boulders");
  assert.equal(e1.hp, 55, "enemy 1 takes 45");
  assert.equal(e2.hp, 55, "enemy 2 takes 45");
});

test("sanctuary Sanctus Terra control: with only 3 Boulders, it deals no damage (needs EXACTLY 4)", () => {
  const r = fuse("sanctuary");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  for (let i = 0; i < 3; i++) addMinion(st, "Boulder", `b${i}`, 50);
  performAction(st, { unit: "a1", skillId: "rolandsanctuary1", targets: [] });
  assert.equal(e.hp, 100, "3 Boulders != exactly 4 -> no 45 damage");
});

// =========================================================================== //
//  SLIME — Oozeshaping + Call to the Mire
// =========================================================================== //

test("slime Oozeshaping: an allied minion (Slimeball) damaging an enemy stuns it for 1 turn", () => {
  const r = fuse("slime");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const slime = addMinion(st, "Slimeball", "s1", 30);

  emit(st, { type: "damageDealt", source: slime.id, target: "e1", amount: 5, dtype: "normal" });
  const stun = e.statuses.find((s) => s.kind === "stun")!;
  assert.ok(stun, "the enemy damaged by the Slimeball is stunned");
  assert.equal(stun.duration, 1, "for 1 turn");
});

test("slime Oozeshaping control: damage dealt by ROLAND (a hero) does not stun (minion-only)", () => {
  const r = fuse("slime");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  emit(st, { type: "damageDealt", source: "a1", target: "e1", amount: 5, dtype: "normal" });
  assert.ok(!has(e, "stun"), "a hero's damage does not proc Oozeshaping's stun");
});

test("slime Call to the Mire: existing Slimeballs become immune to damage and a new Slimeball is created", () => {
  const r = fuse("slime");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  const s0 = addMinion(st, "Slimeball", "s0", 30);

  performAction(st, { unit: "a1", skillId: "rolandslime1", targets: [] });
  assert.ok(has(s0, "damage_ignore"), "the pre-existing Slimeball is immune to damage");
  assert.equal(aliveMinions(st, "Slimeball").length, 2, "one new Slimeball is created immediately");

  // Prove the immunity: a real hit does nothing to the immune Slimeball.
  performAction(st, { unit: "e1", skillId: "zap", targets: ["s0"] });
  assert.equal(s0.hp, 30, "the immune Slimeball takes no damage");
});

// Adversarial: "Slimeball minions are immune to damage" — ALL of them for the window, including the one created
// this turn. The active only applies damage_ignore to Slimeballs that existed BEFORE the summon.
test.skip("SUSPECTED BUG: slime Call to the Mire leaves the freshly-created Slimeball vulnerable — frozen makes all Slimeballs immune for 2 turns", () => {
  const r = fuse("slime");
  const st = makeState([r], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "rolandslime1", targets: [] }); // creates a Slimeball with no pre-existing one to loop over
  const fresh = aliveMinions(st, "Slimeball")[0]!;
  assert.ok(has(fresh, "damage_ignore"), "the Slimeball created by Call to the Mire is itself immune");
});

// =========================================================================== //
//  SPORE — Scattered Spores + Loamwrecker
// =========================================================================== //

test("spore Scattered Spores: a Boulder's destruction creates a Stonecap Mushroom", () => {
  const r = fuse("spore");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  const b = addMinion(st, "Boulder", "b1", 10);

  performAction(st, { unit: "e1", skillId: "zap", targets: ["b1"] }); // 20 kills the 10-hp Boulder
  assert.equal(b.alive, false, "the Boulder was destroyed");
  assert.equal(aliveMinions(st, "Stonecap Mushroom").length, 1, "a Stonecap Mushroom is created");
});

test("spore Scattered Spores control: an ally-hero death does NOT create a Stonecap (Boulder-only)", () => {
  const r = fuse("spore");
  const ally = makeUnit({ id: "a2", team: "A", name: "Ally", hp: 10, maxHp: 100 });
  const st = makeState([r, ally], [enemy("e1")]);
  fund(st);
  performAction(st, { unit: "e1", skillId: "zap", targets: ["a2"] });
  assert.equal(aliveMinions(st, "Stonecap Mushroom").length, 0, "only a Boulder's death spawns a Stonecap");
});

test("spore Scattered Spores: SFtE on a Stonecap deals 15 Affliction to ALL enemies and destroys the Stonecap", () => {
  const r = fuse("spore");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([r], [e1, e2]);
  fund(st);
  const cap = addMinion(st, "Stonecap Mushroom", "c1", 20);

  emit(st, { type: "skillUsed", caster: "a1", skillId: "roland1", targets: ["c1"] });
  assert.equal(e1.hp, 85, "enemy 1 takes 15 Affliction");
  assert.equal(e2.hp, 85, "enemy 2 takes 15 Affliction");
  assert.equal(cap.alive, false, "the Stonecap is consumed");
  assert.equal(aliveMinions(st, "Stonecap Mushroom").length, 0, "the consumed Stonecap does NOT respawn another Stonecap");
});

test("spore Scattered Spores control: SFtE on a NON-Stonecap target does not deal the 15 Affliction", () => {
  const r = fuse("spore");
  const e1 = enemy("e1");
  const st = makeState([r], [e1]);
  fund(st);
  emit(st, { type: "skillUsed", caster: "a1", skillId: "roland1", targets: ["e1"] }); // target is an enemy, not a Stonecap
  assert.equal(e1.hp, 100, "no Stonecap consumed -> no all-enemy Affliction");
});

test("spore Scattered Spores control: a DIFFERENT skill on a Stonecap does not trigger the Affliction", () => {
  const r = fuse("spore");
  const e1 = enemy("e1");
  const st = makeState([r], [e1]);
  fund(st);
  const cap = addMinion(st, "Stonecap Mushroom", "c1", 20);
  emit(st, { type: "skillUsed", caster: "a1", skillId: "roland2", targets: ["c1"] }); // Earth Pillar, not SFtE
  assert.equal(e1.hp, 100, "wrong skill -> no all-enemy Affliction");
  assert.equal(cap.alive, true, "…and the Stonecap survives");
});

test("spore Loamwrecker: more Boulders than Stonecaps -> 35 Piercing (ignores DR) + 15 Shield to Roland", () => {
  const r = fuse("spore");
  const e = enemy("e1");
  e.statuses.push(status("damage_reduction", { magnitude: 15, duration: null })); // Piercing must bypass this
  const st = makeState([r], [e]);
  fund(st);
  addMinion(st, "Boulder", "b1", 50); // 1 Boulder, 0 Stonecaps

  performAction(st, { unit: "a1", skillId: "rolandspore1", targets: ["e1"] });
  assert.equal(e.hp, 65, "Piercing ignores the 15 DR -> full 35 lands");
  assert.equal(totalShield(r), 15, "Roland gains 15 Shield");
});

test("spore Loamwrecker: more Stonecaps than Boulders -> 35 Affliction (ignores Shield) + heal 10 to Roland", () => {
  const r = fuse("spore", "a1");
  r.hp = 50;
  const e = enemy("e1");
  e.shields.push({ amount: 20, duration: null, appliedBy: "e1", appliedTurn: 0 }); // Affliction must bypass this
  const st = makeState([r], [e]);
  fund(st);
  addMinion(st, "Stonecap Mushroom", "c1", 20); // 1 Stonecap, 0 Boulders

  performAction(st, { unit: "a1", skillId: "rolandspore1", targets: ["e1"] });
  assert.equal(totalShield(e), 20, "Affliction bypasses the shield (it is not spent)");
  assert.equal(e.hp, 65, "…and 35 lands straight on HP");
  assert.equal(r.hp, 60, "Roland heals 10");
});

test("spore Loamwrecker: a tie (equal Boulders/Stonecaps) -> plain 35 (respects DR), no rider", () => {
  const r = fuse("spore", "a1");
  r.hp = 50;
  const e = enemy("e1");
  e.statuses.push(status("damage_reduction", { magnitude: 15, duration: null }));
  const st = makeState([r], [e]);
  fund(st);
  // 0 Boulders, 0 Stonecaps -> tie

  performAction(st, { unit: "a1", skillId: "rolandspore1", targets: ["e1"] });
  assert.equal(e.hp, 80, "plain (normal) damage respects the 15 DR -> 35 - 15 = 20 lands");
  assert.equal(totalShield(r), 0, "no Shield rider on a tie");
  assert.equal(r.hp, 50, "no heal rider on a tie");
});

// =========================================================================== //
//  SUN — Exposure + Molten Rockslide
// =========================================================================== //

test("sun Exposure: an Earth-Pillar-marked enemy takes 10 Affliction at turn start", () => {
  const r = fuse("sun");
  const e = enemy("e1");
  e.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  const st = makeState([r], [e]);
  fund(st);

  emit(st, { type: "turnStart", team: "A" });
  assert.equal(e.hp, 90, "the marked enemy takes 10 Affliction");
});

test("sun Exposure control: an UNMARKED enemy takes no Exposure damage", () => {
  const r = fuse("sun");
  const e = enemy("e1");
  const st = makeState([r], [e]);
  fund(st);
  emit(st, { type: "turnStart", team: "A" });
  assert.equal(e.hp, 100, "no Earth Pillar mark -> no Exposure tick");
});

test("sun Molten Rockslide: deals 20 Affliction per active Boulder to the target, then consumes them", () => {
  const r = fuse("sun");
  const e = enemy("e1");
  e.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  const st = makeState([r], [e]);
  fund(st);
  const b0 = addMinion(st, "Boulder", "b0", 50);
  const b1 = addMinion(st, "Boulder", "b1", 50);
  const b2 = addMinion(st, "Boulder", "b2", 50);

  performAction(st, { unit: "a1", skillId: "rolandsun1", targets: ["e1"] });
  assert.equal(e.hp, 100 - 60, "20 x 3 Boulders = 60 to the target");
  assert.equal(aliveMinions(st, "Boulder").length, 0, "all Boulders are consumed");
  assert.ok(!b0.alive && !b1.alive && !b2.alive, "each launched Boulder is destroyed");
});

test("sun Molten Rockslide control: with no Boulders, it deals no damage (20 x 0)", () => {
  const r = fuse("sun");
  const e = enemy("e1");
  e.statuses.push(status("mark", { name: "Earth Pillar", duration: 2 }));
  const st = makeState([r], [e]);
  fund(st);
  performAction(st, { unit: "a1", skillId: "rolandsun1", targets: ["e1"] });
  assert.equal(e.hp, 100, "no Boulders -> 0 damage");
});
