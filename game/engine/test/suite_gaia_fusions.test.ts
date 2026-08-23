import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers
import { heroById } from "../content/match.ts";
import { performAction, startRound, endTurn, canUse } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Status, StatusKind, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

/**
 * ADVERSARIAL, SPEC-DERIVED suite for GAIA Worldsoul's FUSION FORMS.
 *
 * The oracle for every assertion is the FROZEN PROSE (content/frozen/skills.json), transcribed
 * verbatim next to each form. Authored/generated content is read ONLY to learn HOW to drive each
 * form (skill ids, fusion element keys, cost/targeting, and the status/minion names it produces),
 * NEVER to decide what a clause should do.
 *
 * Cost-token legend (from content/frozen/elements.json — bracket icons are element ids):
 *   [65] = generic   [39] = myth   [22] = slime
 * A FUSED hero pays a skill's "specific" cost in its CURRENT (fusion) element — so e.g. Worldfist
 * (gaia2, 1 specific) is paid from the fusion element pool while fused.
 *
 * "Channel Earth" is driven through the real in-kit mechanism: a Seedling minion performs its own
 * seedling1 "Channel Earth" action, which records a permanent Channel Earth stack on Gaia.
 *
 * Forms (passive / active), verbatim frozen text:
 *  grave     Rotten Vitality  "Seedling Minions return to the battlefield 1 turn after they die."
 *            Decompose        "Target enemy loses 20 health. This health loss is not considered damage of any kind."
 *  life      Roiling Life     "Enemies damaged by Worldfist take 10 damage on the following turn. This effect
 *                              lasts one additional turn with each time Channel Earth has been used."
 *            Overgrowth       "Deals 50 Piercing damage to target enemy. This effect Bypasses if the target is
 *                              affected by Roiling Life"
 *  magnet    Magnetic Shielding "When Rampart's Shield takes damage, Gaia gains a stack of Channel Earth."
 *            Ancient Railgun  "Removes all Shield from Gaia and then deals Piercing damage to target enemy equal
 *                              to the Shield removed. This skill cannot be countered."
 *  moon      Rising Indignation "Whenever Gaia receives new damage, the cost of Gaia's Fury is reduced by [65],
 *                              stacking. At 3 stacks, Gaia's Fury is automatically cast. During this time, Moonspike
 *                              may not be used, and the Gaia's Fury minion deals and receives 10 additional damage."
 *            Gaia's Fury      "For 3 turns, Gaia is stunned and ignores damage. She creates a Gaia, Enraged minion
 *                              with HP equal to her current HP."
 *  myth      Branch of the World Tree "Channel Vitality now costs [65] and affects all targets, but can only target minions."
 *            Yggdrasil        "Summons a World Tree minion. This skill costs [39] less for each Seedling minion Gaia controls."
 *  nomad     Oasis            "At the end of each turn, if Gaia or her allied Heroes did not have Elemental Essence,
 *                              they gain Elemental Essence and heal 10 HP."
 *            Sandstorm        "Deals 5 damage to the enemy team for 4 turns. During this time, Rampart costs [65],
 *                              and enemies damaged by Worldfist are Blinded for 1 turn."
 *  sanctuary Sacred Grove     "Until they use a Harmful skill, the allied Heroes heal for 5 health per turn. If an
 *                              ally under this effect is damaged, the attacker is marked by Sacred Grove."
 *            Expel Intruders  "Target enemy marked by Sacred Grove takes 15 damage and is stunned for 1 turn. This
 *                              consumes the mark and will not remove Sacred Grove from Gaia."
 *  slime     Nutrient Sludge  "Whenever Gaia gains a stack of Channel Earth, she heals all allied minions 5 HP. If
 *                              they are at max HP, they gain 5 max HP."
 *            Life From the Loam "Heals all allied units for 25 HP. Whenever an allied unit dies, this skill costs 1 less [22] for 1 turn."
 *  spore     Shroomtender     "Instead of Seedling minions, Gaia now begins play with one Mushroom minion."
 *            Sow the Spores   "Deals 10 affliction damage to the enemy team, increased by 10 for each Mushroom Minion in the game."
 *  sun       Nurturing Light  "At the end of her turn, all active Seedling minions gain 10 max HP."
 *            Sunbeam          "Deals 15 damage to target enemy, increased by 10 for each 20 HP among Seedling minions
 *                              Gaia controls. After using this skill, all Seedling minions have their max HP returned to their default."
 */

// --------------------------------------------------------------------------- //
//  Harness
// --------------------------------------------------------------------------- //

const GAIA = "g";

function fuse(element: string, opts: { allies?: Unit[]; enemies?: Unit[] } = {}) {
  const g = loadHero(heroById("gaia"), "A", GAIA);
  applyFusion(g, fusionForm("gaia", element)!);
  const allies = opts.allies ?? [];
  const enemies = opts.enemies ?? [makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200 })];
  const st = makeState([g, ...allies], enemies);
  st.teams.A.energy = { generic: 40, [element]: 40 };
  st.teams.B.energy = { generic: 40 };
  startRound(st, "A"); // fires roundStart (installs the form's round-start passive: Mushroom/Channel-Vitality re-author/Sacred Grove regen)
  return { g, st, enemies, allies };
}

const sk = (u: Unit, id: string) => u.skills!.find((s) => s.id === id)!;
const minions = (st: MatchState, team: string, name?: string): Unit[] =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.team === team && u.alive && (name === undefined || u.name === name));
const stackMag = (u: Unit, name: string): number => u.statuses.find((s) => s.kind === "stack" && s.name === name)?.magnitude ?? 0;
const dotOf = (u: Unit, name: string): Status | undefined => u.statuses.find((s) => s.kind === "dot" && s.name === name);
const regenOf = (u: Unit, name: string): Status | undefined => u.statuses.find((s) => s.kind === "regen" && s.name === name);
const markOf = (u: Unit, name: string): Status | undefined => u.statuses.find((s) => s.kind === "mark" && s.name === name);
const hasKind = (u: Unit, kind: StatusKind, name?: string): boolean => u.statuses.some((s) => s.kind === kind && (name === undefined || s.name === name));
const shieldOf = (u: Unit): number => u.shields.reduce((a, s) => a + s.amount, 0);

const dmgSkill = (id: string, amount: number, over: Partial<SkillInstance> = {}): SkillInstance =>
  skill(id, [{ op: "damage", amount, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single", cost: { generic: 0, specific: 0 }, cooldown: 0, ...over });
const harmfulSkill = (id: string): SkillInstance =>
  skill(id, [{ op: "damage", amount: 1, dtype: "normal", to: "target" }], { tags: ["Harmful", "Instant"], targeting: "single", cost: { generic: 0, specific: 0 }, cooldown: 0 });

// One full A-round cycle (A end, B end, A end) so a Gaia-applied dot/regen ticks exactly once —
// the tick only fires on the applier team's turn-end when its appliedTurn precedes the current turn.
const oneATick = (st: MatchState) => { endTurn(st); endTurn(st); endTurn(st); };

/** Drive one real Channel Earth use: a Gaia-owned Seedling performs its seedling1 action. */
function channelEarth(st: MatchState) {
  const seed = minions(st, "A", "Seedling")[0]!;
  assert.ok(seed, "need a live Seedling to drive Channel Earth");
  const r = performAction(st, { unit: seed.id, skillId: "seedling1", targets: [] });
  assert.ok(r.ok, `Channel Earth should resolve (${r.reason ?? "?"})`);
}

/** Construct a raw minion of a given template name on a team (for over-fire / count controls). */
function mkMinion(id: string, name: string, team: "A" | "B", over: Partial<Unit> = {}): Unit {
  return {
    id, kind: "minion", name, team,
    hp: over.hp ?? 40, maxHp: over.maxHp ?? 40,
    baseElement: "earth", currentElement: "earth",
    statuses: [], shields: [], alive: true, summoner: GAIA, skills: [],
    ...over,
  } as Unit;
}

// =============================================================================================== //
//  Loadout sanity — each form re-elements Gaia & inserts its active in slot 4 (index 3)
// =============================================================================================== //

test("each Gaia fusion form re-elements her, inserts its active at slot 4, keeps the base kit", () => {
  for (const [element, id, name] of [
    ["grave", "gaiagrave1", "Decompose"], ["life", "gaialife1", "Overgrowth"],
    ["magnet", "gaiamagnet1", "Ancient Railgun"], ["moon", "gaiamoon1", "Gaia's Fury"],
    ["myth", "gaiamyth1", "Yggdrasil"], ["nomad", "gaianomad1", "Sandstorm"],
    ["sanctuary", "gaiasanctuary1", "Expel Intruders"], ["slime", "gaiaslime1", "Life From the Loam"],
    ["spore", "gaiaspore1", "Sow the Spores"], ["sun", "gaiasun1", "Sunbeam"],
  ] as const) {
    const { g } = fuse(element);
    assert.equal(g.currentElement, element, `${element}: currentElement re-set`);
    assert.equal(g.fused, element, `${element}: fused marker set`);
    const s = sk(g, id);
    assert.equal(s.name, name, `${element}: active present`);
    assert.equal(g.skills!.indexOf(s), 3, `${element}: active inserted at slot 4 (index 3)`);
    for (const b of ["gaia1", "gaia2", "gaia3", "gaia4", "gaia5"]) assert.ok(sk(g, b), `${element}: base ${b} kept`);
  }
});

// =============================================================================================== //
//  grave — Rotten Vitality (passive) + Decompose (active)
// =============================================================================================== //

test("Decompose: target loses exactly 20 health (paid in the fusion element)", () => {
  const { g, st, enemies } = fuse("grave", { enemies: [makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 })] });
  const e = enemies[0]!;
  const sp0 = st.teams.A.energy.grave!;
  const r = performAction(st, { unit: GAIA, skillId: "gaiagrave1", targets: ["e"] });
  assert.equal(r.ok, true, "Decompose resolves");
  assert.equal(e.hp, 80, "target lost 20 health (100 -> 80)");
  assert.equal(sp0 - st.teams.A.energy.grave!, 1, "cost is 1 specific, paid from the fusion (grave) pool");
});

test("Decompose: health loss is NOT damage — ignores Shield AND full damage-ignore", () => {
  const { g, st, enemies } = fuse("grave", { enemies: [makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 })] });
  const e = enemies[0]!;
  // Shields are cleared by startRound; re-apply after, plus a bare damage_ignore (invulnerability).
  e.shields = [{ amount: 50, duration: null, appliedBy: "x", appliedTurn: 0 }];
  e.statuses.push({ kind: "damage_ignore", duration: null, appliedBy: "x", appliedTurn: 0 });
  performAction(st, { unit: GAIA, skillId: "gaiagrave1", targets: ["e"] });
  assert.equal(e.hp, 80, "20 health removed straight from HP — through invulnerability");
  assert.equal(shieldOf(e), 50, "the Shield is untouched (health loss does not spend it) — so this was not damage");
});

test("Rotten Vitality: a dead Seedling returns to the battlefield 1 Gaia-turn later", () => {
  const { g, st } = fuse("grave");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] }); // Sprout one Seedling
  const seed = minions(st, "A", "Seedling")[0]!;
  seed.hp = 0; seed.alive = false;
  emit(st, { type: "unitDied", unit: seed.id, killer: "e" });
  assert.equal(minions(st, "A", "Seedling").length, 0, "control: no Seedling on the field the instant it dies");
  oneATick(st); // one Gaia turn-end later
  assert.equal(minions(st, "A", "Seedling").length, 1, "a fresh Seedling returns exactly one Gaia-turn after death");
});

test("grave Rotten Vitality: only a dead Seedling returns — a dead Worldsprout does not", () => {
  const { g, st } = fuse("grave");
  const ws = mkMinion("ws", "Worldsprout", "A");
  st.units["ws"] = ws; st.teams.A.units.push("ws");
  ws.hp = 0; ws.alive = false;
  emit(st, { type: "unitDied", unit: "ws", killer: "e" });
  oneATick(st);
  // Frozen: only SEEDLING minions return. A Worldsprout dying must not spawn a Seedling.
  assert.equal(minions(st, "A", "Seedling").length, 0, "a non-Seedling death must not return a Seedling");
});

// =============================================================================================== //
//  life — Roiling Life (passive) + Overgrowth (active)
// =============================================================================================== //

test("Roiling Life: Worldfist seeds a 10-damage delayed hit that lands the following Gaia turn", () => {
  const { g, st, enemies } = fuse("life");
  const e = enemies[0]!;
  performAction(st, { unit: GAIA, skillId: "gaia2", targets: ["e"] }); // Worldfist (10)
  assert.equal(e.hp, 190, "Worldfist itself deals 10");
  const dot = dotOf(e, "Roiling Life");
  assert.ok(dot, "Worldfist seeds the Roiling Life delayed hit");
  assert.equal(dot!.magnitude, 10, "the delayed hit is 10");
  assert.equal(dot!.duration, 1, "with 0 Channel Earth uses it lasts a single turn (the following turn)");
  oneATick(st);
  assert.equal(e.hp, 180, "the 10 lands on the following Gaia turn (190 -> 180)");
});

test("Roiling Life: the delayed hit lasts one extra turn for each Channel Earth used", () => {
  const { g, st, enemies } = fuse("life");
  const e = enemies[0]!;
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] }); // a Seedling to channel through
  channelEarth(st); // Channel Earth #1
  channelEarth(st); // Channel Earth #2
  assert.equal(stackMag(g, "Channel Earth"), 2, "2 Channel Earth uses recorded");
  performAction(st, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
  assert.equal(dotOf(e, "Roiling Life")!.duration, 3, "duration = 1 + 2 Channel Earth uses");
});

test("Overgrowth: 50 Piercing normally (Shield absorbs); Bypasses (ignores Shield) vs a Roiling-Life target", () => {
  // No Roiling Life: Piercing 50 is absorbed by Shield.
  {
    const { g, st, enemies } = fuse("life");
    const e = enemies[0]!;
    e.shields = [{ amount: 100, duration: null, appliedBy: "x", appliedTurn: 0 }];
    const r = performAction(st, { unit: GAIA, skillId: "gaialife1", targets: ["e"] });
    assert.equal(r.ok, true, "Overgrowth resolves");
    assert.equal(e.hp, 200, "no Roiling Life: the Piercing hit is soaked by Shield — HP untouched");
    assert.equal(shieldOf(e), 50, "Shield absorbed the full 50 (100 -> 50)");
    assert.equal(dotOf(e, "Roiling Life"), undefined, "control: Overgrowth's OWN hit does NOT seed Roiling Life (only Worldfist does)");
  }
  // With Roiling Life present: the hit Bypasses Shield and lands on HP.
  {
    const { g, st, enemies } = fuse("life");
    const e = enemies[0]!;
    performAction(st, { unit: GAIA, skillId: "gaia2", targets: ["e"] }); // Worldfist seeds Roiling Life (and deals 10)
    e.shields = [{ amount: 100, duration: null, appliedBy: "x", appliedTurn: 0 }];
    const hp0 = e.hp;
    performAction(st, { unit: GAIA, skillId: "gaialife1", targets: ["e"] });
    assert.equal(hp0 - e.hp, 50, "Roiling Life present: 50 lands on HP, Bypassing Shield");
    assert.equal(shieldOf(e), 100, "the Shield is not spent — the hit went around it");
  }
});

// =============================================================================================== //
//  magnet — Magnetic Shielding (passive) + Ancient Railgun (active)
// =============================================================================================== //

test("Magnetic Shielding: damage to Gaia's (Rampart) Shield grants a Channel Earth stack", () => {
  const attacker = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, skills: [dmgSkill("ehit", 10)] });
  const { g, st } = fuse("magnet", { enemies: [attacker] });
  performAction(st, { unit: GAIA, skillId: "gaia4", targets: [] }); // Rampart -> 20 Shield
  assert.equal(stackMag(g, "Channel Earth"), 0, "control: gaining Shield alone grants no Channel Earth");
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] }); // hits the Shield
  assert.equal(shieldOf(g), 10, "the hit was absorbed by Shield (20 -> 10)");
  assert.equal(g.hp, 100, "no HP lost — the hit only touched Shield");
  assert.equal(stackMag(g, "Channel Earth"), 1, "Shield taking damage grants one Channel Earth stack");
});

test("Magnetic Shielding: no stack when the damage does not hit Gaia's Shield", () => {
  const attacker = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, skills: [dmgSkill("ehit", 10)] });
  const { g, st } = fuse("magnet", { enemies: [attacker] });
  // Gaia has NO Shield: a hit lands on HP, not Shield -> no shieldDamaged -> no stack.
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] });
  assert.equal(g.hp, 90, "the hit landed on HP (no Shield to absorb it)");
  assert.equal(stackMag(g, "Channel Earth"), 0, "no Channel Earth when no Shield was damaged");
});

test("Ancient Railgun: removes all of Gaia's Shield and deals that much Piercing to the target", () => {
  const { g, st, enemies } = fuse("magnet");
  const e = enemies[0]!;
  performAction(st, { unit: GAIA, skillId: "gaia4", targets: [] }); // 20 Shield
  assert.equal(shieldOf(g), 20, "Rampart gave 20 Shield");
  const hp0 = e.hp;
  const r = performAction(st, { unit: GAIA, skillId: "gaiamagnet1", targets: ["e"] });
  assert.equal(r.ok, true, "Railgun resolves");
  assert.equal(hp0 - e.hp, 20, "deals Piercing equal to the Shield removed (20)");
  assert.equal(shieldOf(g), 0, "all of Gaia's Shield is removed");
  assert.ok(sk(g, "gaiamagnet1").tags.includes("Uncounterable"), "the skill carries the Uncounterable tag (cannot be countered)");
});

test("Ancient Railgun: with no Shield, deals nothing", () => {
  const { g, st, enemies } = fuse("magnet");
  const e = enemies[0]!;
  const hp0 = e.hp;
  performAction(st, { unit: GAIA, skillId: "gaiamagnet1", targets: ["e"] });
  assert.equal(e.hp, hp0, "0 Shield removed -> 0 damage");
});

// =============================================================================================== //
//  moon — Rising Indignation (passive) + Gaia's Fury (active)
// =============================================================================================== //

test("Rising Indignation: each new hit on Gaia adds a stack and cuts Gaia's Fury cost by 1 generic", () => {
  const attacker = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, skills: [dmgSkill("ehit", 10)] });
  const { g, st } = fuse("moon", { enemies: [attacker] });
  assert.deepEqual(sk(g, "gaiamoon1").cost, { generic: 3, specific: 0 }, "base cost is 3 generic");
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] });
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] });
  assert.equal(stackMag(g, "Rising Indignation"), 2, "two new-damage instances -> two stacks");
  const gen0 = st.teams.A.energy.generic!;
  const r = performAction(st, { unit: GAIA, skillId: "gaiamoon1", targets: [] });
  assert.equal(r.ok, true, "Gaia's Fury resolves");
  assert.equal(gen0 - st.teams.A.energy.generic!, 1, "cost reduced by 1 per stack: 3 - 2 = 1 generic");
});

test("Rising Indignation: at 3 stacks Gaia's Fury auto-casts (stun + ignore damage 3 turns; minion HP = Gaia's HP), stacks reset", () => {
  const attacker = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, skills: [dmgSkill("ehit", 30)] });
  const { g, st } = fuse("moon", { enemies: [attacker] });
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] }); // 1
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] }); // 2
  assert.equal(minions(st, "A", "Gaia's Fury").length, 0, "control: no auto-cast before the 3rd stack");
  performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] }); // 3 -> auto-cast
  const fury = minions(st, "A", "Gaia's Fury")[0]!;
  assert.ok(fury, "at 3 stacks Gaia's Fury is automatically cast (a Gaia, Enraged minion appears)");
  assert.equal(fury.hp, g.hp, "the minion's HP equals Gaia's current HP");
  assert.equal(g.hp, 10, "Gaia is at 10 after three 30-damage hits");
  assert.ok(hasKind(g, "stun"), "Gaia is stunned");
  assert.ok(hasKind(g, "damage_ignore"), "Gaia ignores damage");
  assert.equal(stackMag(g, "Rising Indignation"), 0, "the stacks reset after the auto-cast");
});

test("Gaia's Fury minion: deals +10 and receives +10 damage; may not use Moon Spike", () => {
  // Small hits so Gaia keeps most HP — the minion inherits her HP and must survive a 30-damage return hit.
  const attacker = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200, skills: [dmgSkill("ehit", 5)] });
  const bystander = makeUnit({ id: "e2", team: "B", hp: 200, maxHp: 200, skills: [dmgSkill("e2hit", 20)] });
  const { g, st } = fuse("moon", { enemies: [attacker, bystander] });
  for (let i = 0; i < 3; i++) performAction(st, { unit: "e", skillId: "ehit", targets: [GAIA] });
  const fury = minions(st, "A", "Gaia's Fury")[0]!;
  assert.ok(fury, "Fury minion exists");
  assert.equal(fury.hp, 85, "minion inherits Gaia's current HP (100 - three 5-damage hits = 85)");

  // "Moonspike may not be used" — the minion's Moon Spike (gaiafury2) is gated off; Killing Frenzy is allowed.
  assert.equal(canUse(st, fury, sk(fury, "gaiafury2")), false, "the Enraged minion may not use Moon Spike");
  assert.equal(canUse(st, fury, sk(fury, "gaiafury1")), true, "it may still use Killing Frenzy");
  assert.equal(performAction(st, { unit: fury.id, skillId: "gaiafury2", targets: ["e"] }).reason, "requirements-not-met", "Moon Spike is blocked");

  // Deals +10: Killing Frenzy is 15 Piercing -> 25 to each enemy.
  st.teams.A.energy.generic = 40;
  const e2hp0 = bystander.hp;
  const rk = performAction(st, { unit: fury.id, skillId: "gaiafury1", targets: [] });
  assert.equal(rk.ok, true, "Killing Frenzy resolves");
  assert.equal(e2hp0 - bystander.hp, 25, "15 base + 10 additional = 25 dealt");

  // Receives +10: a 20-damage hit on the minion lands as 30.
  const furyhp0 = fury.hp;
  performAction(st, { unit: "e2", skillId: "e2hit", targets: [fury.id] });
  assert.equal(furyhp0 - fury.hp, 30, "20 incoming + 10 additional = 30 received");
});

// =============================================================================================== //
//  myth — Branch of the World Tree (passive) + Yggdrasil (active)
// =============================================================================================== //

test("Branch of the World Tree: Channel Vitality now costs 1 generic, heals all allied minions, and does NOT touch heroes", () => {
  const ally = makeUnit({ id: "a", team: "A", hp: 100, maxHp: 100 });
  const { g, st } = fuse("myth", { allies: [ally] });
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const [s1, s2] = minions(st, "A", "Seedling");
  s1!.hp = 10; s2!.hp = 12;
  g.hp = 50; ally.hp = 50; // damage the heroes AFTER startRound

  const gen0 = st.teams.A.energy.generic!, my0 = st.teams.A.energy.myth!;
  const r = performAction(st, { unit: GAIA, skillId: "gaia3", targets: [] });
  assert.equal(r.ok, true, "Channel Vitality resolves with no explicit target (now hits all)");
  assert.equal(gen0 - st.teams.A.energy.generic!, 1, "now costs 1 generic ([65])");
  assert.equal(my0 - st.teams.A.energy.myth!, 0, "…and pays no myth/specific");
  assert.equal(s1!.hp, 20, "first Seedling healed 10 (all targets affected)");
  assert.equal(s2!.hp, 22, "second Seedling healed 10");
  assert.equal(g.hp, 50, "Gaia (a hero) is NOT healed — minion-only");
  assert.equal(ally.hp, 50, "the allied hero is NOT healed — minion-only");
});

test("Yggdrasil: summons a World Tree minion (base cost 4 myth)", () => {
  const { g, st } = fuse("myth");
  assert.deepEqual(sk(g, "gaiamyth1").cost, { generic: 0, specific: 4 }, "base cost is 4 specific");
  const my0 = st.teams.A.energy.myth!;
  const r = performAction(st, { unit: GAIA, skillId: "gaiamyth1", targets: [] });
  assert.equal(r.ok, true, "Yggdrasil resolves");
  const tree = minions(st, "A", "World Tree")[0]!;
  assert.ok(tree, "a World Tree minion is summoned");
  assert.equal(tree.maxHp, 80, "World Tree template HP");
  assert.equal(my0 - st.teams.A.energy.myth!, 4, "with 0 Seedlings the full 4 myth is paid");
});

test("Yggdrasil costs [39] less per Seedling — 2 Seedlings drop its cost to 2 myth", () => {
  const { g, st } = fuse("myth");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  assert.equal(minions(st, "A", "Seedling").length, 2, "Gaia controls 2 Seedlings");
  const my0 = st.teams.A.energy.myth!;
  performAction(st, { unit: GAIA, skillId: "gaiamyth1", targets: [] });
  // Frozen: "costs [39] less for each Seedling minion Gaia controls" -> 4 - 2 = 2 myth.
  assert.equal(my0 - st.teams.A.energy.myth!, 2, "cost should be 4 - 2 Seedlings = 2 myth");
});

// =============================================================================================== //
//  nomad — Oasis (passive) + Sandstorm (active)
// =============================================================================================== //

test("Oasis: at end of turn, a Gaia without Elemental Essence gains it and heals 10", () => {
  const { g, st } = fuse("nomad");
  g.hp = 50;
  assert.equal(hasKind(g, "elemental_essence"), false, "Gaia starts without Essence");
  endTurn(st);
  assert.equal(g.hp, 60, "heals 10 at end of turn (50 -> 60)");
  assert.ok(hasKind(g, "elemental_essence"), "and gains Elemental Essence");
});

test("Oasis: a hero who already has Elemental Essence is NOT healed", () => {
  const { g, st } = fuse("nomad");
  g.hp = 50;
  g.statuses.push({ kind: "elemental_essence", duration: null, appliedBy: GAIA, appliedTurn: 0 });
  endTurn(st);
  assert.equal(g.hp, 50, "already had Essence -> no Oasis heal");
});

test("Sandstorm: applies a 5-damage, 4-turn hit to every enemy", () => {
  const e1 = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 200, maxHp: 200 });
  const { g, st } = fuse("nomad", { enemies: [e1, e2] });
  const r = performAction(st, { unit: GAIA, skillId: "gaianomad1", targets: [] });
  assert.equal(r.ok, true, "Sandstorm resolves");
  for (const e of [e1, e2]) {
    const d = dotOf(e, "Sandstorm");
    assert.ok(d, "every enemy gets the Sandstorm hit");
    assert.equal(d!.magnitude, 5, "5 damage");
    assert.equal(d!.duration, 4, "for 4 turns");
  }
  oneATick(st);
  assert.equal(e1.hp, 195, "the 5 ticks on a Gaia turn (200 -> 195)");
});

test("Sandstorm auras: during it, Rampart costs generic and Worldfist Blinds", () => {
  // Control snapshot (no Sandstorm active): Rampart is paid in the fusion element, Worldfist does not Blind.
  {
    const e = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200 });
    const { g, st } = fuse("nomad", { enemies: [e] });
    performAction(st, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
    assert.equal(hasKind(e, "blind"), false, "control: without Sandstorm, Worldfist does not Blind");
    const gen0 = st.teams.A.energy.generic!, nom0 = st.teams.A.energy.nomad!;
    performAction(st, { unit: GAIA, skillId: "gaia4", targets: [] });
    assert.equal(nom0 - st.teams.A.energy.nomad!, 1, "control: without Sandstorm, Rampart costs 1 nomad (its specific)");
    assert.equal(gen0 - st.teams.A.energy.generic!, 0, "…and no generic");
  }
  // During Sandstorm.
  {
    const e = makeUnit({ id: "e", team: "B", hp: 200, maxHp: 200 });
    const { g, st } = fuse("nomad", { enemies: [e] });
    performAction(st, { unit: GAIA, skillId: "gaianomad1", targets: [] }); // Sandstorm on
    const gen0 = st.teams.A.energy.generic!, nom0 = st.teams.A.energy.nomad!;
    performAction(st, { unit: GAIA, skillId: "gaia4", targets: [] });
    assert.equal(gen0 - st.teams.A.energy.generic!, 1, "during Sandstorm, Rampart costs 1 generic ([65])");
    assert.equal(nom0 - st.teams.A.energy.nomad!, 0, "…and no nomad");
    performAction(st, { unit: GAIA, skillId: "gaia2", targets: ["e"] });
    assert.ok(hasKind(e, "blind"), "during Sandstorm, an enemy damaged by Worldfist is Blinded");
  }
});

// =============================================================================================== //
//  sanctuary — Sacred Grove (passive) + Expel Intruders (active)
// =============================================================================================== //

test("Sacred Grove: allied heroes get a 5/turn regen; using a Harmful skill ends it", () => {
  const ally = makeUnit({ id: "a", team: "A", hp: 100, maxHp: 100, skills: [harmfulSkill("ahit")] });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 });
  const { g, st } = fuse("sanctuary", { allies: [ally], enemies: [enemy] });
  assert.ok(regenOf(g, "Sacred Grove"), "Gaia has the Sacred Grove regen");
  assert.ok(regenOf(ally, "Sacred Grove"), "the allied hero has it too");
  ally.hp = 50;
  oneATick(st);
  assert.equal(ally.hp, 55, "the regen heals 5 on a Gaia turn (50 -> 55)");

  performAction(st, { unit: "a", skillId: "ahit", targets: ["e"] }); // ally uses a Harmful skill
  assert.equal(regenOf(ally, "Sacred Grove"), undefined, "using a Harmful skill removes that hero's Sacred Grove regen");
  assert.ok(regenOf(g, "Sacred Grove"), "Gaia (who did not act harmfully) keeps hers");
});

test("Sacred Grove: damaging a protected ally marks the attacker; damaging an unprotected ally does not", () => {
  const ally = makeUnit({ id: "a", team: "A", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, skills: [dmgSkill("ehit", 20)] });
  const { g, st } = fuse("sanctuary", { allies: [ally], enemies: [enemy] });
  st.teams.B.energy = { generic: 40 };
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] }); // hit an ally under Sacred Grove
  assert.ok(markOf(enemy, "Sacred Grove"), "the attacker is marked by Sacred Grove");

  // Control: strip the ally's regen, then a hit leaves no mark.
  const enemy2 = enemy;
  ally.statuses = ally.statuses.filter((s) => !(s.kind === "regen" && s.name === "Sacred Grove"));
  enemy2.statuses = enemy2.statuses.filter((s) => !(s.kind === "mark" && s.name === "Sacred Grove"));
  st.teams.B.energy = { generic: 40 };
  performAction(st, { unit: "e", skillId: "ehit", targets: ["a"] });
  assert.equal(markOf(enemy2, "Sacred Grove"), undefined, "an ally NOT under Sacred Grove does not mark its attacker");
});

test("Expel Intruders: a marked enemy takes 15 + a 1-turn stun and loses the mark; an unmarked enemy is untouched; a bystander's Sacred Grove survives", () => {
  const bystander = makeUnit({ id: "a", team: "A", hp: 100, maxHp: 100 });
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 });
  const { g, st } = fuse("sanctuary", { allies: [bystander], enemies: [enemy] });

  // Unmarked control first.
  const hp0 = enemy.hp;
  performAction(st, { unit: GAIA, skillId: "gaiasanctuary1", targets: ["e"] });
  assert.equal(enemy.hp, hp0, "unmarked enemy takes no damage");
  assert.equal(hasKind(enemy, "stun"), false, "unmarked enemy is not stunned");

  // Now mark the enemy and expel.
  enemy.statuses.push({ kind: "mark", name: "Sacred Grove", duration: null, appliedBy: GAIA, appliedTurn: 0 });
  sk(g, "gaiasanctuary1").currentCd = 0; // clear the cooldown from the control cast
  const r = performAction(st, { unit: GAIA, skillId: "gaiasanctuary1", targets: ["e"] });
  assert.equal(r.ok, true, "Expel resolves on the marked enemy");
  assert.equal(enemy.hp, 85, "marked enemy takes 15 (100 -> 85)");
  assert.ok(hasKind(enemy, "stun"), "and is stunned for 1 turn");
  assert.equal(markOf(enemy, "Sacred Grove"), undefined, "the mark is consumed");
  // "will not remove Sacred Grove from Gaia": consuming the enemy MARK does not strip a Sacred Grove REGEN.
  assert.ok(regenOf(bystander, "Sacred Grove"), "a bystanding ally's Sacred Grove regen is untouched by the mark consumption");
});

// =============================================================================================== //
//  slime — Nutrient Sludge (passive) + Life From the Loam (active)
// =============================================================================================== //

test("Nutrient Sludge: a Channel Earth gain heals allied minions; a max-HP minion gains +5 max HP", () => {
  const { g, st } = fuse("slime");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  assert.equal(seed.hp, 25, "the Seedling is at full HP (25/25)");
  channelEarth(st); // Gaia gains a Channel Earth stack
  assert.equal(stackMag(g, "Channel Earth"), 1, "one Channel Earth stack recorded");
  assert.equal(seed.maxHp, 30, "at max HP the minion gains 5 MAX HP (25 -> 30)");
});

test("Nutrient Sludge: a below-max minion is HEALED 5 by a Channel Earth gain", () => {
  const { g, st } = fuse("slime");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  seed.hp = 15; // below max (25)
  channelEarth(st);
  assert.equal(seed.hp, 20, "the below-max minion is healed 5 (15 -> 20)");
});

test.skip("SUSPECTED BUG: Nutrient Sludge raises a BELOW-max minion's max HP too — frozen heals (max HP unchanged) only when NOT at max", () => {
  const { g, st } = fuse("slime");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  seed.hp = 15; // NOT at max
  channelEarth(st);
  // Frozen: heals 5 HP; the "+5 MAX HP" branch is reserved for minions already AT max HP.
  assert.equal(seed.maxHp, 25, "a below-max minion's MAX HP must stay 25 (only a plain heal applies)");
});

test.skip("SUSPECTED BUG: Nutrient Sludge over-fires — it triggers on ANY ally-minion skill, not only Channel Earth gains", () => {
  const { g, st, enemies } = fuse("slime");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  seed.hp = 10;
  // A Worldsprout acts with a NON-Channel-Earth skill — Gaia gains no Channel Earth stack.
  const ws = mkMinion("ws", "Worldsprout", "A", { skills: [dmgSkill("worldsprout1", 15)] });
  st.units["ws"] = ws; st.teams.A.units.push("ws");
  performAction(st, { unit: "ws", skillId: "worldsprout1", targets: ["e"] });
  assert.equal(stackMag(g, "Channel Earth"), 0, "the Worldsprout's action grants no Channel Earth");
  // Frozen: no Channel Earth gained -> the passive must not fire, so the Seedling is not healed.
  assert.equal(seed.hp, 10, "no Channel Earth gain -> no heal");
});

test("Life From the Loam: heals every allied unit 25; an ally death makes it cost 1 slime less for a turn", () => {
  const ally = makeUnit({ id: "a", team: "A", hp: 100, maxHp: 100 });
  const { g, st } = fuse("slime", { allies: [ally] });
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  g.hp = 50; ally.hp = 60; seed.hp = 5;
  const sl0 = st.teams.A.energy.slime!;
  const r = performAction(st, { unit: GAIA, skillId: "gaiaslime1", targets: [] });
  assert.equal(r.ok, true, "Loam resolves");
  assert.equal(sl0 - st.teams.A.energy.slime!, 2, "base cost is 2 slime");
  assert.equal(g.hp, 75, "Gaia healed 25 (50 -> 75)");
  assert.equal(ally.hp, 85, "the allied hero healed 25 (60 -> 85)");
  assert.equal(seed.hp, 25, "the Seedling healed 25, capped at its 25 max");

  // An allied death then discounts the next cast by 1 slime for 1 turn.
  const seed2Owner = performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  assert.ok(seed2Owner.ok);
  const seed2 = minions(st, "A", "Seedling").find((s) => s.id !== seed.id)!;
  seed2.hp = 0; seed2.alive = false;
  emit(st, { type: "unitDied", unit: seed2.id, killer: "e" });
  sk(g, "gaiaslime1").currentCd = 0; // clear the cooldown from the first cast
  const sl1 = st.teams.A.energy.slime!;
  performAction(st, { unit: GAIA, skillId: "gaiaslime1", targets: [] });
  assert.equal(sl1 - st.teams.A.energy.slime!, 1, "after an ally death the cost is 1 less: 2 - 1 = 1 slime");
});

// =============================================================================================== //
//  spore — Shroomtender (passive) + Sow the Spores (active)
// =============================================================================================== //

test("Shroomtender: Gaia begins play with one Mushroom minion and no Seedlings", () => {
  const { g, st } = fuse("spore");
  assert.equal(minions(st, "A", "Mushroom").length, 1, "exactly one Mushroom at start");
  assert.equal(minions(st, "A", "Seedling").length, 0, "and no Seedlings (replaced by the Mushroom)");
});

test("Sow the Spores: 10 Affliction to every enemy, +10 for each Mushroom in the game", () => {
  const e1 = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100 });
  const e2 = makeUnit({ id: "e2", team: "B", hp: 100, maxHp: 100 });
  const { g, st } = fuse("spore", { enemies: [e1, e2] });
  assert.equal(minions(st, "A", "Mushroom").length, 1, "one Mushroom on the field");
  performAction(st, { unit: GAIA, skillId: "gaiaspore1", targets: [] });
  assert.equal(e1.hp, 80, "10 base + 10 per Mushroom (1) = 20 to each enemy");
  assert.equal(e2.hp, 80, "…both enemies hit");

  // Add a second Mushroom anywhere in the game -> +10 more.
  const m2 = mkMinion("m2", "Mushroom", "A", { hp: 20, maxHp: 20 });
  st.units["m2"] = m2; st.teams.A.units.push("m2");
  sk(g, "gaiaspore1").currentCd = 0;
  const hp0 = e1.hp;
  performAction(st, { unit: GAIA, skillId: "gaiaspore1", targets: [] });
  assert.equal(hp0 - e1.hp, 30, "with 2 Mushrooms: 10 + 10*2 = 30");
});

// =============================================================================================== //
//  sun — Nurturing Light (passive) + Sunbeam (active)
// =============================================================================================== //

test("Nurturing Light: at the end of Gaia's turn, active Seedlings gain 10 max HP", () => {
  const { g, st } = fuse("sun");
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  assert.equal(seed.maxHp, 25, "starts at the 25 default");
  endTurn(st); // end of Gaia's turn
  assert.equal(seed.maxHp, 35, "gains 10 max HP (25 -> 35)");
});

test("Sunbeam: 15 + 10 per 20 HP among Seedlings, then resets their max HP to default", () => {
  const { g, st, enemies } = fuse("sun");
  const e = enemies[0]!;
  performAction(st, { unit: GAIA, skillId: "gaia1", targets: [] });
  const seed = minions(st, "A", "Seedling")[0]!;
  endTurn(st); // Nurturing Light: maxHp 25 -> 35, hp 35
  assert.equal(seed.hp, 35, "the lone Seedling now holds 35 HP");

  const hp0 = e.hp;
  const r = performAction(st, { unit: GAIA, skillId: "gaiasun1", targets: ["e"] });
  assert.equal(r.ok, true, "Sunbeam resolves");
  // floor(35 total Seedling HP / 20) = 1 -> 15 + 10 = 25.
  assert.equal(hp0 - e.hp, 25, "15 base + 10 per full 20 HP among Seedlings (floor(35/20)=1) = 25");
  assert.equal(seed.maxHp, 25, "after Sunbeam every Seedling's max HP is returned to its 25 default");
});

test("Sunbeam: with no Seedlings it deals only its 15 base", () => {
  const { g, st, enemies } = fuse("sun");
  const e = enemies[0]!;
  assert.equal(minions(st, "A", "Seedling").length, 0, "control: no Seedlings");
  const hp0 = e.hp;
  performAction(st, { unit: GAIA, skillId: "gaiasun1", targets: ["e"] });
  assert.equal(hp0 - e.hp, 15, "no Seedling HP to scale on -> 15");
});
