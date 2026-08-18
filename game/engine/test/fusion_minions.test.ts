import { test } from "node:test";
import assert from "node:assert/strict";
import "../content/fusion_effects.ts"; // register minion custom handlers (synthesize/catalyze/revenant clone)
import "../content/roster.generated.ts"; // register the minion templates (MINIONS -> registerMinion)
import { runEffects } from "../src/effects/interpret.ts";
import { getMinionTemplate } from "../src/minions.ts";
import { applyStatus } from "../src/status.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

const minionsOf = (st: ReturnType<typeof makeState>, name: string) =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.name === name && u.alive);

test("all 21 fusion-summoned minion templates are registered", () => {
  const names = ["Mushroom", "World Tree", "Gaia's Fury", "Zombie", "Troll Stonethrower", "Slimeball", "Stonecap Mushroom",
    "Grave", "Skeleton", "Saya Cell", "Shady Assistant", "Saya-Brand Monstrosity", "Bjorn, True King", "Frozen Beast",
    "Synthesizer", "Simulacrum", "Revenant", "Angel", "Shadow Clone", "Slime", "Sparrowrider"];
  for (const n of names) assert.ok(getMinionTemplate(n), `template "${n}" registered`);
  assert.equal(getMinionTemplate("Mushroom")!.maxHp, 20, "Mushroom hp 20");
  assert.ok((getMinionTemplate("Mushroom")!.skills ?? []).some((s) => s.name === "Poison Puff"), "Mushroom has Poison Puff");
});

test("Grave's Arise! summons a Zombie then sacrifices the Grave", () => {
  const roland = makeUnit({ id: "r", team: "A", name: "Roland" });
  const st = makeState([roland], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [{ op: "summon", template: "Grave", count: 1 }], { caster: roland });
  const grave = minionsOf(st, "Grave")[0]!;
  const arise = (grave.skills ?? []).find((s) => s.name === "Arise!")!;
  runEffects(st, arise.effects, { caster: grave, self: grave, targets: [] });
  assert.equal(minionsOf(st, "Zombie").length, 1, "a Zombie was created");
  assert.equal(st.units[grave.id]?.alive ?? false, false, "the Grave sacrificed itself");
});

test("Saya Cell's Divert Charge grants Essence then the Cell dies", () => {
  const saya = makeUnit({ id: "s", team: "A", name: "Saya" });
  const ally = makeUnit({ id: "al", team: "A", name: "Ally" });
  const st = makeState([saya, ally], [makeUnit({ id: "e", team: "B" })]);
  runEffects(st, [{ op: "summon", template: "Saya Cell", count: 1 }], { caster: saya });
  const cell = minionsOf(st, "Saya Cell")[0]!;
  const divert = (cell.skills ?? []).find((s) => s.name === "Divert Charge")!;
  runEffects(st, divert.effects, { caster: cell, self: cell, targets: [ally] });
  assert.ok(ally.statuses.some((s) => s.kind === "elemental_essence"), "ally gained Elemental Essence");
  assert.equal(st.units[cell.id]?.alive ?? false, false, "the Saya Cell died after use");
});

test("Synthesizer stores the target's serums, then catalyzes them onto another unit", () => {
  // Hector owns the serum skills; the Synthesizer sources them via its summoner.
  const burning = skill("hector1", [{ op: "applyStatus", to: "target", status: { kind: "mark", name: "Burning Blood Serum", duration: null } }], { name: "Burning Blood Serum" });
  const hector = makeUnit({ id: "h", team: "A", name: "Hector", skills: [burning] });
  const donor = makeUnit({ id: "d", team: "B", name: "Donor", statuses: [status("mark", { name: "Burning Blood Serum" })] });
  const victim = makeUnit({ id: "v", team: "B", name: "Victim" });
  const synth = makeUnit({ id: "h:Synthesizer:0", team: "A", kind: "minion", name: "Synthesizer", summoner: "h" });
  const st = makeState([hector, synth], [donor, victim]);
  runEffects(st, [{ op: "custom", fn: "synthesizeSerum", args: { from: "target" } }], { caster: synth, self: synth, targets: [donor] });
  assert.ok(synth.statuses.some((s) => s.name === "Stored Serum: Burning Blood Serum"), "stored the donor's serum");
  runEffects(st, [{ op: "custom", fn: "catalyzeSerum", args: { to: "target" } }], { caster: synth, self: synth, targets: [victim] });
  assert.ok(victim.statuses.some((s) => s.name === "Burning Blood Serum"), "catalyzed the stored serum onto the victim (via Hector's skill)");
});

test("Troll Stonethrower's Hurl deals ONE combined hit (10/30/40) and destroys a Boulder on the +20", () => {
  const roland = makeUnit({ id: "r", team: "A", name: "Roland" });
  const foe = makeUnit({ id: "e", team: "B", hp: 100 });
  const st = makeState([roland], [foe]);
  runEffects(st, [{ op: "summon", template: "Troll Stonethrower", count: 1 }], { caster: roland });
  const troll = minionsOf(st, "Troll Stonethrower")[0]!;
  const hurl = (troll.skills ?? []).find((s) => s.name === "Hurl")!;
  // no Boulder, no Earth Pillar -> 10
  runEffects(st, hurl.effects, { caster: troll, self: troll, targets: [foe] });
  assert.equal(foe.hp, 90, "base 10 with no Boulder / no Pillar");
  // add a Boulder -> 30 combined + Boulder destroyed
  runEffects(st, [{ op: "summon", template: "Boulder", count: 1 }], { caster: roland });
  assert.equal(minionsOf(st, "Boulder").length, 1, "a Boulder exists");
  runEffects(st, hurl.effects, { caster: troll, self: troll, targets: [foe] });
  assert.equal(foe.hp, 60, "10 base + 20 Boulder = 30 in one hit");
  assert.equal(minionsOf(st, "Boulder").length, 0, "the Boulder was destroyed");
  // Boulder + Earth Pillar -> 40
  runEffects(st, [{ op: "summon", template: "Boulder", count: 1 }], { caster: roland });
  applyStatus(troll, status("mark", { name: "Earth Pillar", appliedBy: "r", appliedTurn: 0 }));
  runEffects(st, hurl.effects, { caster: troll, self: troll, targets: [foe] });
  assert.equal(foe.hp, 20, "10 + 20 Boulder + 10 Pillar = 40 in one hit");
});

test("cloneBasicSkillsOntoRevenant copies the killed hero's basic skills onto the Revenant (basics only)", () => {
  const b1 = skill("foe1", [{ op: "damage", amount: 9, to: "target" }], { klass: "basic" });
  const ult = skill("foe4", [{ op: "damage", amount: 99, to: "target" }], { klass: "ultimate" });
  const deadHero = makeUnit({ id: "e", team: "B", name: "Fallen", kind: "hero", skills: [b1, ult], alive: false });
  const maggie = makeUnit({ id: "m", team: "A", name: "Maggie" });
  const st = makeState([maggie], [deadHero]);
  runEffects(st, [
    { op: "summon", template: "Revenant", count: 1, hp: 25 },
    { op: "custom", fn: "cloneBasicSkillsOntoRevenant", args: { copyFrom: "target", minionTemplate: "Revenant" } },
  ], { caster: maggie, self: maggie, targets: [deadHero] });
  const rev = minionsOf(st, "Revenant")[0]!;
  assert.ok((rev.skills ?? []).some((s) => s.id === "foe1"), "copied the dead hero's basic");
  assert.ok(!(rev.skills ?? []).some((s) => s.id === "foe4"), "did NOT copy the ultimate (basics only)");
});
