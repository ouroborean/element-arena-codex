import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates + augment customs
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, spec-derived suite for Jarrik Cinderblade's AUGMENTS.
// Oracle = the FROZEN augment prose (content/frozen/augments.json), quoted per block.
// Authored/generated content is consulted ONLY to learn how to drive (ids, mark/minion names).
//
//   jarrik1 Ashen Cleave        "Blade of Ashes strikes an additional random enemy for 10 damage.
//                                Has no effect if Blade of Ashes is AOE."
//   jarrik2 Charred and Crumbling "Enemies affected by Blackened Wounds ignore healing for 1 turn."
//   jarrik3 Blazing Crescendo    "If all enemies affected by Cinderswell are marked by Cinders, they have
//                                their non-Strategic skills stunned for 1 turn."
//   jarrik4 Blackened Soul       "Jarrik splits all single-target damage received between him and any
//                                active Cinders."
//   jarrik5 Dazzling Lights      "While Blade of Dancing Lights is active, Cinder minions ignore harmful skills."
//
// Base-kit facts used as scaffolding (from frozen skills.json):
//   jarrik0 Cinders (passive)  — "When Jarrik damages an enemy marked by this skill, he deals 10 additional
//                                 Affliction damage and gains Elemental Essence."
//   jarrik1 Blade of Ashes     — single-target 10 dmg + permanently marks Cinders; targets ALL enemies while
//                                 Blade of Dancing Lights is active (Jarrik bears the 'Dancing Lights' mark).
//   jarrik2 Cinderswell        — 15 dmg to all enemies (+Shattered if any marked).
// ============================================================================

// ---- drive helpers (mark/minion names learned only from authored/generated content) ----
const mark = (name: string, dur: number | null = null): Unit["statuses"][number] =>
  ({ kind: "mark", name, duration: dur, appliedBy: "j", appliedTurn: 0 });
const cinders = () => mark("Cinders", null);
const dancingLights = (dur = 5) => mark("Dancing Lights", dur);
const blackenedWounds = () => mark("Blackened Wounds", null);

const jarrik = (id = "j") => loadHero(heroById("jarrik"), "A", id);
const enemy = (id: string, statuses: Unit["statuses"] = [], over: Partial<Unit> = {}): Unit =>
  makeUnit({ id, team: "B", hp: 100, maxHp: 100, kind: "hero", statuses, ...over });
const fundA = (st: MatchState) => { st.teams.A.energy = { generic: 40, fire: 40 }; };
const fundB = (st: MatchState) => { st.teams.B.energy = { generic: 40, fire: 40 }; };

const essenceCount = (u: Unit) => u.statuses.filter((s) => s.kind === "elemental_essence").length;
const withAug = (j: Unit, id: string) => { applyAugment(j, augmentById(id)!); return j; };
const cinderlingOf = (st: MatchState) =>
  Object.values(st.units).find((u) => u.kind === "minion" && u.name === "Cinderling" && u.alive);

// ============================================================================
// jarrik1 — Ashen Cleave: "Blade of Ashes strikes an additional random enemy for
// 10 damage. Has no effect if Blade of Ashes is AOE."
// ============================================================================

test("Ashen Cleave: Blade of Ashes fires a SECOND 10-damage strike beyond its base hit", () => {
  const j = withAug(jarrik(), "jarrik1");
  const e = enemy("e");
  const st = makeState([j], [e]);
  fundA(st);

  // Base Blade of Ashes: 10 to e (unmarked at damage-time → no Cinders rider), then marks e with Cinders.
  // Augment (not AOE): +10 to a random enemy — the only enemy is e, now Cinders-marked, so the extra strike
  // ALSO procs the Cinders passive (jarrik0: +10 Affliction). 10 (base) + 10 (extra) + 10 (rider) = 30 total.
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });

  assert.equal(e.hp, 70, "base 10 + augment's extra 10 + Cinders rider 10 on the (now-marked) extra strike");
  assert.ok(essenceCount(j) >= 1, "the extra strike hit a Cinders-marked enemy → Cinders passive granted Essence");
});

test("Ashen Cleave CONTROL: without the augment Blade of Ashes lands its base hit only", () => {
  const j = jarrik(); // no augment
  const e = enemy("e");
  const st = makeState([j], [e]);
  fundA(st);

  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });

  assert.equal(e.hp, 90, "just the base 10 (no second strike, no rider — mark applied after the hit)");
  assert.equal(essenceCount(j), 0, "no proc → no Essence");
});

test("Ashen Cleave: 'has no effect if Blade of Ashes is AOE' — the extra strike is suppressed while Dancing Lights is active", () => {
  const j = withAug(jarrik(), "jarrik1");
  j.statuses.push(dancingLights()); // Blade of Ashes now targets ALL enemies (its AOE branch)
  const e = enemy("e");
  const st = makeState([j], [e]);
  fundA(st);

  // AOE branch hits e for 10 (unmarked → no rider), marks it. Augment gate (has 'Dancing Lights') → NO extra strike.
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });

  assert.equal(e.hp, 90, "AOE Blade of Ashes → augment does nothing; only the base 10 lands (would be 70 if the extra strike had fired)");
});

// ============================================================================
// jarrik2 — Charred and Crumbling: "Enemies affected by Blackened Wounds ignore
// healing for 1 turn."
// ============================================================================

test("Charred and Crumbling: an enemy bearing Blackened Wounds cannot be healed", () => {
  const j = withAug(jarrik(), "jarrik2");
  const e = enemy("e", [blackenedWounds()], { hp: 50 });
  const st = makeState([j], [e]);

  emit(st, { type: "turnStart", team: "A" }); // the augment's standing rule (re)locks Blackened-Wounds enemies

  // "ignore healing": the heal is fully suppressed.
  runEffects(st, [{ op: "heal", amount: 20, to: "target" }], { caster: j, targets: [e] });

  assert.equal(e.hp, 50, "the heal was ignored — Blackened Wounds enemy is heal-locked");
});

test("Charred and Crumbling CONTROL: an enemy WITHOUT Blackened Wounds heals normally", () => {
  const j = withAug(jarrik(), "jarrik2");
  const e = enemy("e", [], { hp: 50 }); // no Blackened Wounds mark
  const st = makeState([j], [e]);

  emit(st, { type: "turnStart", team: "A" });
  runEffects(st, [{ op: "heal", amount: 20, to: "target" }], { caster: j, targets: [e] });

  assert.equal(e.hp, 70, "no Blackened Wounds → no heal-lock → the 20 heal lands");
});

test("Charred and Crumbling CONTROL: without the augment, Blackened Wounds alone does NOT block healing", () => {
  const j = jarrik(); // augment NOT applied
  const e = enemy("e", [blackenedWounds()], { hp: 50 });
  const st = makeState([j], [e]);

  emit(st, { type: "turnStart", team: "A" });
  runEffects(st, [{ op: "heal", amount: 20, to: "target" }], { caster: j, targets: [e] });

  assert.equal(e.hp, 70, "the heal-lock is the augment's doing — the bare mark carries no rule");
});

// ============================================================================
// jarrik3 — Blazing Crescendo: "If all enemies affected by Cinderswell are marked
// by Cinders, they have their non-Strategic skills stunned for 1 turn."
// ============================================================================

// Enemy probe skills: a non-Strategic (Harmful) skill and a Strategic skill, to read the scoped stun.
const eSkills = () => [
  skill("estrike", [{ op: "damage", amount: 5, to: "target" }], { targeting: "single", tags: ["Harmful"] }),
  skill("estrat", [{ op: "grantShield", amount: 5, to: "self" }], { targeting: "self", tags: ["Strategic"] }),
];

test("Blazing Crescendo: when ALL Cinderswell'd enemies are Cinders-marked, their non-Strategic skills are stunned (Strategic stay usable)", () => {
  const j = withAug(jarrik(), "jarrik3");
  const e1 = enemy("e1", [cinders()], { skills: eSkills() });
  const e2 = enemy("e2", [cinders()], { skills: eSkills() });
  const st = makeState([j], [e1, e2]);
  fundA(st);
  fundB(st);

  performAction(st, { unit: "j", skillId: "jarrik2", targets: [] }); // Cinderswell (all-enemies)

  // Non-Strategic (Harmful) skills are stunned for BOTH enemies...
  assert.equal(performAction(st, { unit: "e1", skillId: "estrike", targets: ["j"] }).reason, "stunned");
  assert.equal(performAction(st, { unit: "e2", skillId: "estrike", targets: ["j"] }).reason, "stunned");
  // ...but a Strategic skill is NOT stunned (scope excepts Strategic).
  assert.equal(performAction(st, { unit: "e1", skillId: "estrat", targets: [] }).ok, true, "Strategic skill remains usable");
});

test("Blazing Crescendo CONTROL: if NOT every Cinderswell'd enemy is Cinders-marked, nobody is stunned", () => {
  const j = withAug(jarrik(), "jarrik3");
  const e1 = enemy("e1", [cinders()], { skills: eSkills() });
  const e2 = enemy("e2", [], { skills: eSkills() }); // e2 is NOT marked → condition fails
  const st = makeState([j], [e1, e2]);
  fundA(st);
  fundB(st);

  performAction(st, { unit: "j", skillId: "jarrik2", targets: [] });

  // The marked e1's non-Strategic skill is NOT stunned because the "all marked" gate failed.
  const r = performAction(st, { unit: "e1", skillId: "estrike", targets: ["j"] });
  assert.notEqual(r.reason, "stunned", "no blanket stun when even one enemy is unmarked");
  assert.equal(r.ok, true);
});

// ============================================================================
// jarrik4 — Blackened Soul: "Jarrik splits all single-target damage received
// between him and any active Cinders."
// ============================================================================

test("Blackened Soul: a single-target hit on Jarrik is split evenly with an active Cinders bearer", () => {
  const j = withAug(jarrik(), "jarrik4"); // custom applies split_incoming immediately
  const atk = enemy("atk");               // the attacker (bears no Cinders mark)
  const cb = enemy("cb", [cinders()]);    // an active Cinders bearer to share with
  const st = makeState([j], [atk, cb]);

  // 20 single-target damage aimed at Jarrik → split evenly across {Jarrik, cb}: 10 each.
  runEffects(st, [{ op: "damage", amount: 20, dtype: "normal", to: "target" }],
    { caster: atk, targets: [j], targeting: "single" });

  assert.equal(j.hp, 90, "Jarrik keeps only HALF (10) of the 20 single-target hit");
  // cb's redirected 10-share is credited to Jarrik against a Cinders-marked enemy, so the Cinders passive
  // (jarrik0: +10 Affliction) also fires on it: 10 (share) + 10 (rider) = 20 → cb at 80.
  assert.equal(cb.hp, 80, "the active Cinders bearer absorbs the other half of the split");
  assert.equal(atk.hp, 100, "the attacker (no Cinders mark) is untouched by the split");
});

test("Blackened Soul CONTROL: with NO active Cinders, Jarrik eats the whole single-target hit", () => {
  const j = withAug(jarrik(), "jarrik4");
  const atk = enemy("atk");
  const bystander = enemy("by"); // present but UNMARKED → not a share recipient
  const st = makeState([j], [atk, bystander]);

  runEffects(st, [{ op: "damage", amount: 20, dtype: "normal", to: "target" }],
    { caster: atk, targets: [j], targeting: "single" });

  assert.equal(j.hp, 80, "no Cinders bearer → nothing to split with → full 20 lands on Jarrik");
  assert.equal(bystander.hp, 100, "an unmarked enemy never receives a split share");
});

test("Blackened Soul CONTROL: only SINGLE-TARGET damage is split — an AOE hit is not", () => {
  const j = withAug(jarrik(), "jarrik4");
  const atk = enemy("atk");
  const cb = enemy("cb", [cinders()]);
  const st = makeState([j], [atk, cb]);

  // Same 20, but declared as an AOE (targeting !== "single") → the split does not engage.
  runEffects(st, [{ op: "damage", amount: 20, dtype: "normal", to: "target" }],
    { caster: atk, targets: [j], targeting: "all" });

  assert.equal(j.hp, 80, "AOE damage is not single-target → Jarrik takes the full 20");
  assert.equal(cb.hp, 100, "no split from an AOE hit → the Cinders bearer is untouched");
});

// ============================================================================
// jarrik5 — Dazzling Lights: "While Blade of Dancing Lights is active, Cinder
// minions ignore harmful skills."
// ============================================================================

test("Dazzling Lights: while Blade of Dancing Lights is active, a Cinderling ignores a harmful skill", () => {
  const j = withAug(jarrik(), "jarrik5");
  j.statuses.push(dancingLights()); // Blade of Dancing Lights active = Jarrik bears the 'Dancing Lights' mark
  const atk = enemy("atk", [], { skills: [skill("hit", [{ op: "damage", amount: 5, to: "target" }], { targeting: "single", tags: ["Harmful"] })] });
  const st = makeState([j], [atk]);
  fundB(st);

  runEffects(st, [{ op: "summon", template: "Cinderling", count: 1 }], { caster: j, self: j });
  const c = cinderlingOf(st)!;

  emit(st, { type: "turnStart", team: "A" }); // augment rule fires: Cinderlings ignore harmful skills

  const res = performAction(st, { unit: "atk", skillId: "hit", targets: [c.id] });
  assert.equal(res.reason, "no-legal-target", "the harmful skill cannot land on the protected Cinderling");
  assert.equal(c.hp, c.maxHp, "the Cinderling took no damage — it ignored the harmful skill");
});

test("Dazzling Lights CONTROL: without Blade of Dancing Lights active, the Cinderling is a normal target", () => {
  const j = withAug(jarrik(), "jarrik5"); // augment applied, but NO Dancing Lights mark
  const atk = enemy("atk", [], { skills: [skill("hit", [{ op: "damage", amount: 5, to: "target" }], { targeting: "single", tags: ["Harmful"] })] });
  const st = makeState([j], [atk]);
  fundB(st);

  runEffects(st, [{ op: "summon", template: "Cinderling", count: 1 }], { caster: j, self: j });
  const c = cinderlingOf(st)!;

  emit(st, { type: "turnStart", team: "A" }); // rule's `when` (Jarrik has Dancing Lights) is false → no protection

  const res = performAction(st, { unit: "atk", skillId: "hit", targets: [c.id] });
  assert.equal(res.ok, true, "the harmful skill resolves normally");
  assert.equal(c.hp, c.maxHp - 5, "the unprotected Cinderling takes the 5 damage");
});
