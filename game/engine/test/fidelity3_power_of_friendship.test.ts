import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../src/effects/interpret.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { getMinionTemplate } from "../src/minions.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 32 — trinity4 "The Power of Friendship": the augment appendEffects the Prisma
// Rangers' Lens skills (trinitycrimson1/azure1/saffron1), which live on Trinity's MINION TEMPLATES, not on
// the Trinity hero. Applied to the hero, the patches found no matching skill and were silently dropped.
// Now an appendEffect/setSkillMeta/patchNode whose skill the hero does not own is recorded as a
// minion-skill patch and replayed onto every minion the hero summons (deep-cloned per instance).

const rubyLensBonus = (s: { effects: unknown[] } | undefined): boolean =>
  !!s && s.effects.length >= 2; // base Ruby Lens + the two appended ops (damage + addStack)

function summon(state: MatchState, caster: Unit, template: string): Unit {
  runEffects(state, [{ op: "summon", template, count: 1 }], { caster, self: caster });
  return Object.values(state.units).find((u) => u.kind === "minion" && u.name === template)!;
}

test("Power of Friendship records minion-skill patches (the hero does not own the Lens skills)", () => {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  applyAugment(trinity, augmentById("trinity4")!);
  const patches = trinity.minionSkillPatches ?? [];
  assert.equal(patches.length, 3, "one recorded patch per Lens skill");
  assert.deepEqual(
    patches.map((p) => p.skillId).sort(),
    ["trinityazure1", "trinitycrimson1", "trinitysaffron1"],
    "the three Prisma Lens skills",
  );
});

test("the appended Lens damage propagates onto a summoned Prisma Ranger (template untouched)", () => {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  const templateBefore = getMinionTemplate("Prisma Crimson")!.skills!.find((s) => s.id === "trinitycrimson1")!.effects.length;
  applyAugment(trinity, augmentById("trinity4")!);
  const state = makeState([trinity], [makeUnit({ id: "e", team: "B", kind: "hero" })]);

  const crimson = summon(state, trinity, "Prisma Crimson");
  const lens = crimson.skills!.find((s) => s.id === "trinitycrimson1");
  assert.ok(rubyLensBonus(lens), "the summoned Ruby Lens carries the appended Power-of-Friendship damage");
  // The shared template must not have been mutated by the per-instance patch.
  assert.equal(
    getMinionTemplate("Prisma Crimson")!.skills!.find((s) => s.id === "trinitycrimson1")!.effects.length,
    templateBefore,
    "the global Prisma Crimson template is unchanged (no leak)",
  );
});

test("a Trinity without the augment summons a plain Ruby Lens", () => {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  const state = makeState([trinity], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const crimson = summon(state, trinity, "Prisma Crimson");
  const lens = crimson.skills!.find((s) => s.id === "trinitycrimson1")!;
  const templateLen = getMinionTemplate("Prisma Crimson")!.skills!.find((s) => s.id === "trinitycrimson1")!.effects.length;
  assert.equal(lens.effects.length, templateLen, "unaugmented Ruby Lens matches the template (no appended ops)");
});

// The same reachability bug silently dropped two other minion-targeting augments; the general channel
// repairs them too. Guard the incidental fixes so they aren't silently (de)activated later.
test("the channel is general: gaia2 (seedling1) and trinity1 (Prisma Maneuvers) also propagate onto minions", () => {
  // gaia2 "Earthen Aid" appends a heal to Channel Earth (seedling1), which lives on Gaia's Seedling template.
  const gaia = loadHero(heroById("gaia"), "A", "g");
  const seedBase = getMinionTemplate("Seedling")!.skills!.find((s) => s.id === "seedling1")!.effects.length;
  applyAugment(gaia, augmentById("gaia2")!);
  const gState = makeState([gaia], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const seedling = summon(gState, gaia, "Seedling");
  assert.ok(
    seedling.skills!.find((s) => s.id === "seedling1")!.effects.length > seedBase,
    "gaia2 reaches the summoned Seedling's Channel Earth",
  );

  // trinity1 "Scarlet Somersault Crash" appends to the Prisma Maneuver skills (per-template).
  const trinity = loadHero(heroById("trinity"), "A", "t");
  const vaultBase = getMinionTemplate("Prisma Crimson")!.skills!.find((s) => s.id === "trinitycrimson2")!.effects.length;
  applyAugment(trinity, augmentById("trinity1")!);
  const tState = makeState([trinity], [makeUnit({ id: "e", team: "B", kind: "hero" })]);
  const crimson = summon(tState, trinity, "Prisma Crimson");
  assert.ok(
    crimson.skills!.find((s) => s.id === "trinitycrimson2")!.effects.length > vaultBase,
    "trinity1 reaches the summoned Prisma Crimson's Prisma Vault",
  );
});

test("the propagated lens scales damage by prior Lens stacks (0 then 5)", () => {
  const trinity = loadHero(heroById("trinity"), "A", "t");
  applyAugment(trinity, augmentById("trinity4")!);
  const enemy = makeUnit({ id: "e", team: "B", hp: 100, maxHp: 100, kind: "hero" });
  const state = makeState([trinity], [enemy]);
  const crimson = summon(state, trinity, "Prisma Crimson");
  const azure = summon(state, trinity, "Prisma Azure");
  const rubyEffects = crimson.skills!.find((s) => s.id === "trinitycrimson1")!.effects;
  const sapphireEffects = azure.skills!.find((s) => s.id === "trinityazure1")!.effects;

  const hp0 = enemy.hp;
  runEffects(state, rubyEffects, { caster: crimson, self: crimson, targets: [enemy], skillId: "trinitycrimson1" });
  const firstLensDamage = hp0 - enemy.hp; // first lens: 5 * 0 prior = 0 from the Power-of-Friendship rider

  const hp1 = enemy.hp;
  runEffects(state, sapphireEffects, { caster: azure, self: azure, targets: [enemy], skillId: "trinityazure1" });
  const secondLensRider = hp1 - enemy.hp; // second lens reads the 1 stack the first left -> +5

  assert.ok(secondLensRider - firstLensDamage >= 5, "the second Lens adds 5 more than the first (per-prior-stack scaling)");
});
