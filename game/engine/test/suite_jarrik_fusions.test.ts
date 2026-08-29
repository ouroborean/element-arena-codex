import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { emit, runEffects } from "../src/effects/interpret.ts";
import { applyFusion } from "../content/fusion.ts";
import { fusionForm } from "../content/fusions.generated.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { makeState, makeUnit, status, skill } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// ============================================================================
// Adversarial, spec-derived suite for Jarrik Cinderblade's FUSION FORMS.
// Oracle = the FROZEN prose (content/frozen/skills.json), quoted at each block.
// Authored/generated content is read ONLY to learn HOW to drive (element keys,
// skill ids, energy costs, targeting, status/minion names).
//
// A fused hero's currentElement becomes the fusion element, so a Specific cost is
// paid from the FUSION element's pool. `fund` stocks generic + every fusion element.
// ============================================================================

const jarrik = (id = "j"): Unit => loadHero(heroById("jarrik"), "A", id);
const fuse = (u: Unit, key: string): void => applyFusion(u, fusionForm("jarrik", key)!);
const enemy = (id: string, statuses: Unit["statuses"] = [], over: Partial<Unit> = {}): Unit =>
  makeUnit({ id, team: "B", hp: 100, maxHp: 100, kind: "hero", statuses, ...over });
const fund = (st: MatchState): void => {
  st.teams.A.energy = {
    generic: 40, fire: 40, alchemy: 40, apocalypse: 40, brimstone: 40, devil: 40,
    dragon: 40, judgment: 40, mechanic: 40, plasma: 40, ritual: 40, sun: 40,
  };
};
const cinders = (): Unit["statuses"][number] =>
  ({ kind: "mark", name: "Cinders", duration: null, appliedBy: "j", appliedTurn: 0 });
const has = (u: Unit, kind: string): boolean => u.statuses.some((s) => s.kind === kind);
const hasMark = (u: Unit, n: string): boolean => u.statuses.some((s) => s.kind === "mark" && s.name === n);
const stackMag = (u: Unit, n: string): number | undefined =>
  u.statuses.find((s) => s.kind === "stack" && s.name === n)?.magnitude;
const minionsA = (st: MatchState): number =>
  Object.values(st.units).filter((u) => u.kind === "minion" && u.team === "A" && u.alive).length;

// ============================================================================
// alchemy — Drunken Swordsman (passive):
//   "Jarrik will deal 10 piercing damage to any enemy that uses a Harmful skill
//    on him. At the end of each turn, Jarrik will deal 10 piercing damage to a
//    random enemy."
// ============================================================================

test("alchemy passive: an enemy that uses a Harmful skill ON Jarrik takes 10 piercing back", () => {
  const j = jarrik(); fuse(j, "alchemy");
  const e = enemy("e");
  const st = makeState([j], [e]);

  // POSITIVE — enemy skill declared against Jarrik.
  emit(st, { type: "skillUsed", caster: "e", skillId: "x", targets: ["j"], tags: ["Harmful"] });
  assert.equal(e.hp, 90, "the enemy takes 10 piercing for hitting Jarrik");
});

test("alchemy passive: an enemy skill NOT targeting Jarrik does not retaliate", () => {
  const j = jarrik(); fuse(j, "alchemy");
  const other = makeUnit({ id: "o", team: "A", kind: "hero" });
  const e = enemy("e");
  const st = makeState([j, other], [e]);

  emit(st, { type: "skillUsed", caster: "e", skillId: "x", targets: ["o"], tags: ["Harmful"] });
  assert.equal(e.hp, 100, "the enemy targeted the ally, not Jarrik → no retaliation");
});

test("alchemy passive: an ALLY using a skill on Jarrik does not retaliate (must be an enemy)", () => {
  const j = jarrik(); fuse(j, "alchemy");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero" });
  const st = makeState([j, ally], [enemy("e")]);

  emit(st, { type: "skillUsed", caster: "al", skillId: "x", targets: ["j"], tags: ["Helpful"] });
  assert.equal(ally.hp, 100, "an ally's skill on Jarrik triggers nothing");
});

test("alchemy passive: at end of each turn Jarrik deals 10 piercing to a random enemy", () => {
  const j = jarrik(); fuse(j, "alchemy");
  const e = enemy("e");
  const st = makeState([j], [e]);

  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(e.hp, 90, "the lone enemy eats the end-of-turn 10 piercing");
});

// alchemy — Cindersprig Brew:
//   "Jarrik or target ally deal 5 more non-Affliction damage for the next 4 turns.
//    This effect will end if they use a new skill."

test("Cindersprig Brew: applies a +5 non-Affliction buff (magnitude 5, 4 turns) to a target ally", () => {
  const j = jarrik(); fuse(j, "alchemy");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero" });
  const st = makeState([j, ally], [enemy("e")]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikalchemy1", targets: ["al"] });
  const buff = ally.statuses.find((s) => s.kind === "outgoing_damage_mod" && s.name === "Cindersprig Brew");
  assert.ok(buff, "the ally carries the Cindersprig Brew buff");
  assert.equal(buff!.magnitude, 5, "magnitude is +5");
  assert.equal(buff!.duration, 4, "lasts 4 turns");
});

test("Cindersprig Brew: +5 applies to NON-Affliction damage but NOT to Affliction damage", () => {
  const j = jarrik(); fuse(j, "alchemy");
  j.statuses.push({ kind: "outgoing_damage_mod", name: "Cindersprig Brew", magnitude: 5, duration: 4, appliedBy: "j", appliedTurn: 0 });
  const st = makeState([j], [enemy("e")]);

  // normal (non-Affliction) hit from the buffed dealer → 10 + 5.
  runEffects(st, [{ op: "damage", amount: 10, dtype: "normal", to: "target" }], { caster: j, targets: [st.units["e"]!] });
  assert.equal(st.units["e"]!.hp, 85, "non-Affliction damage gains +5 (10 → 15)");

  // affliction hit from the same buffed dealer → no bonus.
  const j2 = jarrik("j2"); fuse(j2, "alchemy");
  j2.statuses.push({ kind: "outgoing_damage_mod", name: "Cindersprig Brew", magnitude: 5, duration: 4, appliedBy: "j2", appliedTurn: 0 });
  const st2 = makeState([j2], [enemy("e")]);
  runEffects(st2, [{ op: "damage", amount: 10, dtype: "affliction", to: "target" }], { caster: j2, targets: [st2.units["e"]!] });
  assert.equal(st2.units["e"]!.hp, 90, "Affliction damage gets NO bonus (10 only)");
});

test("Cindersprig Brew on an ally ends when that ally uses a new skill", () => {
  const j = jarrik(); fuse(j, "alchemy");
  const ally = makeUnit({ id: "al", team: "A", kind: "hero",
    statuses: [{ kind: "outgoing_damage_mod", name: "Cindersprig Brew", magnitude: 5, duration: 4, appliedBy: "j", appliedTurn: 0 }] });
  const st = makeState([j, ally], [enemy("e")]);

  emit(st, { type: "skillUsed", caster: "al", skillId: "x", targets: [], tags: [] });
  assert.ok(!ally.statuses.some((s) => s.name === "Cindersprig Brew"), "the ally's next skill ends the buff");
});

// ============================================================================
// apocalypse — Final Breath (passive):
//   "The first time Jarrik dies, he instead becomes Immortal for one turn."
// ============================================================================

test("Final Breath: a lethal hit does not kill Jarrik — he survives and becomes Immortal", () => {
  const j = jarrik(); fuse(j, "apocalypse");
  const e = enemy("e");
  const st = makeState([j], [e]);

  runEffects(st, [{ op: "damage", amount: 999, dtype: "normal", to: "target" }], { caster: e, targets: [j] });
  assert.equal(j.alive, true, "Jarrik is still alive (Final Breath intercepted the death)");
  assert.ok(j.hp > 0, "Jarrik was revived above 0 HP");
  assert.ok(has(j, "immortal"), "Jarrik is Immortal");
});

test("Final Breath control: an un-fused Jarrik taking the same lethal hit dies", () => {
  const j = jarrik(); // no apocalypse fusion
  const e = enemy("e");
  const st = makeState([j], [e]);

  runEffects(st, [{ op: "damage", amount: 999, dtype: "normal", to: "target" }], { caster: e, targets: [j] });
  assert.equal(j.alive, false, "without Final Breath, the lethal hit kills Jarrik");
});

test("Final Breath is once only: after the first save, a second lethal hit kills", () => {
  const j = jarrik(); fuse(j, "apocalypse");
  // Simulate that Final Breath already fired: the "Final Breath" mark is present, no Immortal left.
  j.statuses.push({ kind: "mark", name: "Final Breath", duration: null, appliedBy: "j", appliedTurn: 0 });
  const e = enemy("e");
  const st = makeState([j], [e]);

  runEffects(st, [{ op: "damage", amount: 999, dtype: "normal", to: "target" }], { caster: e, targets: [j] });
  assert.equal(j.alive, false, "the second death is real (Final Breath only saves the first time)");
});

// apocalypse — Last Light:
//   "Jarrik deals damage equal to his missing HP to target enemy."

test("Last Light: deals damage equal to Jarrik's MISSING HP", () => {
  const j = jarrik(); fuse(j, "apocalypse");
  j.hp = 30; // missing 70 of 100
  const e = enemy("e", [], { hp: 200, maxHp: 200 });
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikapocalypse1", targets: ["e"] });
  assert.equal(e.hp, 130, "70 missing HP → 70 damage (200 → 130)");
});

test("Last Light control: at FULL HP Jarrik has 0 missing → deals nothing", () => {
  const j = jarrik(); fuse(j, "apocalypse");
  const e = enemy("e", [], { hp: 200, maxHp: 200 });
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikapocalypse1", targets: ["e"] });
  assert.equal(e.hp, 200, "0 missing HP → 0 damage");
});

// ============================================================================
// brimstone — Scorched Flesh (passive):
//   "Enemies affected by Cinders have the cost of their Strategic skills increased."
// ============================================================================

test("Scorched Flesh: a Cinders-marked enemy's Strategic skill costs MORE (becomes unaffordable)", () => {
  const j = jarrik(); fuse(j, "brimstone");
  const e = enemy("e", [cinders()], {
    skills: [
      skill("estrat", [], { tags: ["Strategic"], targeting: "self", cost: { generic: 1, specific: 0 } }),
    ],
  });
  const st = makeState([j], [e]);
  st.teams.B.energy = { generic: 1 }; // exactly enough for the BASE Strategic cost
  emit(st, { type: "turnStart", team: "A" }); // recompute the Scorched-Flesh cost aura

  const r = performAction(st, { unit: "e", skillId: "estrat", targets: ["e"] });
  assert.equal(r.ok, false, "the Cinders enemy can no longer afford its (now costlier) Strategic skill");
  assert.equal(r.reason, "insufficient-energy");
});

test("Scorched Flesh control: an UNMARKED enemy's Strategic skill is unaffected", () => {
  const j = jarrik(); fuse(j, "brimstone");
  const e = enemy("e", [], { // no Cinders
    skills: [skill("estrat", [], { tags: ["Strategic"], targeting: "self", cost: { generic: 1, specific: 0 } })],
  });
  const st = makeState([j], [e]);
  st.teams.B.energy = { generic: 1 };
  emit(st, { type: "turnStart", team: "A" });

  const r = performAction(st, { unit: "e", skillId: "estrat", targets: ["e"] });
  assert.equal(r.ok, true, "no Cinders → base Strategic cost stands → castable with 1 energy");
});

test("Scorched Flesh control: the aura only touches STRATEGIC skills, not a Harmful one", () => {
  const j = jarrik(); fuse(j, "brimstone");
  const e = enemy("e", [cinders()], {
    skills: [skill("eharm", [], { tags: ["Harmful"], targeting: "self", cost: { generic: 1, specific: 0 } })],
  });
  const st = makeState([j], [e]);
  st.teams.B.energy = { generic: 1 };
  emit(st, { type: "turnStart", team: "A" });

  const r = performAction(st, { unit: "e", skillId: "eharm", targets: ["e"] });
  assert.equal(r.ok, true, "a Harmful skill's cost is NOT raised by Scorched Flesh");
});

// brimstone — Brimsteel Scabbard:
//   "Jarrik's next Blade of Ashes deals triple damage, cannot be countered, and if
//    it strikes an enemy affected by Cinders, it automatically creates a Cinderling."

test("Brimsteel Scabbard: the next Blade of Ashes deals TRIPLE (10 → 30) then reverts", () => {
  const j = jarrik(); fuse(j, "brimstone");
  const e = enemy("e", [], { hp: 200, maxHp: 200 });
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikbrimstone1", targets: ["j"] }); // arm
  const before = e.hp;
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] }); // fire
  assert.equal(before - e.hp, 30, "Blade of Ashes tripled (10 → 30)");

  const before2 = e.hp;
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(before2 - e.hp, 20, "one-shot: the blade reverts to 10, but the now-Cinders enemy also eats the base passive's 10 = 20");
});

test("Brimsteel Scabbard: a Cinders-affected strike auto-creates a Cinderling; a fresh one does not", () => {
  // fresh (unmarked) target — no Cinderling
  {
    const j = jarrik(); fuse(j, "brimstone");
    const e = enemy("e", [], { hp: 200, maxHp: 200 });
    const st = makeState([j], [e]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrikbrimstone1", targets: ["j"] });
    const before = minionsA(st);
    performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
    assert.equal(minionsA(st), before, "an enemy NOT affected by Cinders yields no Cinderling");
  }
  // already-Cinders target — one Cinderling
  {
    const j = jarrik(); fuse(j, "brimstone");
    const e = enemy("e", [cinders()], { hp: 200, maxHp: 200 });
    const st = makeState([j], [e]);
    fund(st);
    performAction(st, { unit: "j", skillId: "jarrikbrimstone1", targets: ["j"] });
    const before = minionsA(st);
    performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
    assert.equal(minionsA(st), before + 1, "a Cinders-affected strike mints a Cinderling");
  }
});

// ============================================================================
// devil — Belphegor's Blade (passive):
//   "Each turn that Jarrik or an enemy affected by Cinders doesn't use a new
//    skill, they receive 15 Affliction damage."
// ============================================================================

// Each unit is evaluated at the end of ITS OWN team's turn (did IT act this turn),
// so Jarrik is checked on team A's turn-end and a Cinders enemy on team B's.
test("Belphegor's Blade: at his own turn-end, an IDLE Jarrik takes 15 Affliction", () => {
  const j = jarrik(); fuse(j, "devil");
  const st = makeState([j], [enemy("e", [cinders()])]);

  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(j.hp, 85, "idle Jarrik takes 15 Affliction at his own turn-end");
});

test("Belphegor's Blade: at its own turn-end, an IDLE Cinders enemy takes 15 Affliction", () => {
  const j = jarrik(); fuse(j, "devil");
  const marked = enemy("e", [cinders()]);
  const st = makeState([j], [marked]);

  emit(st, { type: "turnEnd", team: "B" });
  assert.equal(marked.hp, 75, "15 Belphegor Affliction + base Cinders passive's 10 = 25 at its own turn-end");
});

test("Belphegor's Blade control: an UNMARKED enemy is not punished", () => {
  const j = jarrik(); fuse(j, "devil");
  const clean = enemy("e"); // no Cinders
  const st = makeState([j], [clean]);

  emit(st, { type: "turnEnd", team: "B" });
  assert.equal(clean.hp, 100, "only Cinders-affected enemies (and Jarrik) are punished");
});

test("Belphegor's Blade control: a unit that USED a skill this turn is spared", () => {
  // Jarrik acted this turn → spared at his turn-end.
  {
    const j = jarrik(); fuse(j, "devil");
    const st = makeState([j], [enemy("e", [cinders()])]);
    st.actedThisTurn = ["j"];
    emit(st, { type: "turnEnd", team: "A" });
    assert.equal(j.hp, 100, "Jarrik acted → not punished");
  }
  // The Cinders enemy acted this turn → spared at its turn-end.
  {
    const j = jarrik(); fuse(j, "devil");
    const marked = enemy("e", [cinders()]);
    const st = makeState([j], [marked]);
    st.actedThisTurn = ["e"];
    emit(st, { type: "turnEnd", team: "B" });
    assert.equal(marked.hp, 100, "the Cinders enemy acted → not punished");
  }
});

// devil — Chains of Sloth:
//   "For the next 3 turns, target enemy's skills cost 1 more, increasing by 1 each
//    turn. Each time they use a new skill, this effect's current magnitude
//    decreases by 1."

test("Chains of Sloth: applies a cost penalty (magnitude 1, 3 turns), escalates at turn-end and decays per skill", () => {
  const j = jarrik(); fuse(j, "devil");
  const e = enemy("e");
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikdevil1", targets: ["e"] });
  const chains = e.statuses.find((s) => s.kind === "cost_mod" && s.name === "Chains of Sloth");
  assert.ok(chains, "the enemy carries Chains of Sloth");
  assert.equal(chains!.magnitude, 1, "starts at +1");
  assert.equal(chains!.duration, 3, "lasts 3 turns");

  const mag = (): number | undefined => e.statuses.find((s) => s.kind === "cost_mod" && s.name === "Chains of Sloth")?.magnitude;
  emit(st, { type: "turnEnd", team: "B" });
  assert.equal(mag(), 2, "turn-end escalates +1 → 2");
  emit(st, { type: "skillUsed", caster: "e", skillId: "x", targets: [], tags: [] });
  assert.equal(mag(), 1, "the holder's skill decays −1 → 1");
});

// ============================================================================
// dragon — Drake Transformation (passive):
//   "At the end of each turn and whenever he consumes a mark from Cinders, Jarrik
//    heals 5 HP and permanently deals 5 more Affliction damage."
// ============================================================================

test("Drake Transformation: at end of turn Jarrik heals 5 HP", () => {
  const j = jarrik(); fuse(j, "dragon");
  j.hp = 50;
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" }); // seeds the permanent bonus
  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(j.hp, 55, "turn-end heals 5 (50 → 55)");
});

// FROZEN: "...permanently deals 5 more Affliction damage." The engine implements the
// bonus as an unnamed `outgoing_damage_mod`, which damage.ts sums ONLY for normal/piercing
// ("non-Affliction") damage and NEVER for Affliction — so an Affliction hit gains nothing,
// the exact opposite of the frozen clause. (Probed: a normal hit here DOES gain +5.)
test("Drake Transformation: the permanent bonus raises AFFLICTION damage (dtypes:affliction)", () => {
  const j = jarrik(); fuse(j, "dragon");
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" }); // seed bonus at 0
  emit(st, { type: "turnEnd", team: "A" }); // grow to +5

  // Frozen: "permanently deals 5 more Affliction damage." A 10-Affliction hit should land for 15.
  runEffects(st, [{ op: "damage", amount: 10, dtype: "affliction", to: "target" }], { caster: j, targets: [st.units["e"]!] });
  assert.equal(st.units["e"]!.hp, 85, "the +5 permanent bonus applies to Affliction damage (10 → 15)");
});

// FROZEN: "At the end of each turn AND whenever he consumes a mark from Cinders, Jarrik
// heals 5 HP...". The dragon passive only installs roundStart (seed) + turnEnd (heal+grow)
// triggers — there is NO consume hook — so consuming a Cinders mark heals nothing.
test("Drake Transformation heals 5 when Jarrik consumes a Cinders mark", () => {
  const j = jarrik(); fuse(j, "dragon");
  j.hp = 50;
  const marked = enemy("e", [cinders()]);
  const st = makeState([j], [marked]);
  fund(st);
  emit(st, { type: "roundStart" });

  performAction(st, { unit: "j", skillId: "jarrik3", targets: [] }); // Call Cinders consumes the mark
  assert.ok(!hasMark(marked, "Cinders"), "the Cinders mark was consumed");
  assert.equal(j.hp, 55, "consuming a mark heals Jarrik 5 (50 → 55)");
});

// dragon — Drakken:
//   "Deals 40 Affliction damage to target enemy. After using this skill, Jarrik
//    can no longer apply, trigger, or consume Cinders."

test("Drakken: deals 40 Affliction and then locks Cinders application", () => {
  const j = jarrik(); fuse(j, "dragon");
  const e = enemy("e", [], { hp: 200, maxHp: 200 });
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikdragon1", targets: ["e"] });
  assert.equal(e.hp, 160, "40 Affliction (200 → 160)");
  assert.ok(hasMark(j, "Drakken"), "Jarrik is now Drakken-locked");

  // Cinders can no longer be applied: Blade of Ashes marks nothing.
  performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.ok(!hasMark(e, "Cinders"), "under Drakken, Blade of Ashes applies no Cinders");
});

// ============================================================================
// judgment — Pursuit of Justice (passive):
//   "Jarrik can no longer be stunned or countered."
// ============================================================================

test("Pursuit of Justice: a stunned Jarrik can still act (stun immunity)", () => {
  const j = jarrik(); fuse(j, "judgment");
  const st = makeState([j], [enemy("e")]);
  fund(st);
  emit(st, { type: "roundStart" }); // installs Stun Immunity + uncounterable
  j.statuses.push(status("stun", { duration: 2 }));

  const r = performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(r.ok, true, "the stun does not stop Jarrik");
  assert.notEqual(r.reason, "stunned");
});

test("Pursuit of Justice control: an un-fused Jarrik with the same stun is blocked", () => {
  const j = jarrik(); // no judgment fusion → no Stun Immunity
  const st = makeState([j], [enemy("e")]);
  fund(st);
  j.statuses.push(status("stun", { duration: 2 }));

  const r = performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(r.ok, false, "without immunity the stun blocks the cast");
  assert.equal(r.reason, "stunned");
});

test("Pursuit of Justice: Jarrik's skill cannot be countered", () => {
  const j = jarrik(); fuse(j, "judgment");
  const e = enemy("e");
  e.triggers = [{ on: "skillDeclared", owner: "e", kind: "counter", source: "t",
    effect: [{ op: "damage", amount: 40, to: "eventSource" }] }];
  const st = makeState([j], [e]);
  fund(st);
  emit(st, { type: "roundStart" }); // grants uncounterable
  const jhp = j.hp;

  const r = performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.notEqual(r.countered, true, "the counter never cancels Jarrik's skill");
  assert.equal(e.hp, 90, "Blade of Ashes still lands its 10 damage");
  assert.equal(j.hp, jhp, "the counter's retaliation never reaches Jarrik");
});

test("Pursuit of Justice control: strip the uncounterable status and the same counter fires", () => {
  const j = jarrik(); fuse(j, "judgment");
  const e = enemy("e");
  e.triggers = [{ on: "skillDeclared", owner: "e", kind: "counter", source: "t",
    effect: [{ op: "damage", amount: 40, to: "eventSource" }] }];
  const st = makeState([j], [e]);
  fund(st);
  emit(st, { type: "roundStart" });
  j.statuses = j.statuses.filter((s) => s.kind !== "uncounterable"); // remove the immunity only
  const jhp = j.hp;

  const r = performAction(st, { unit: "j", skillId: "jarrik1", targets: ["e"] });
  assert.equal(r.countered, true, "with immunity gone the counter cancels the skill");
  assert.equal(j.hp, jhp - 40, "and the retaliation reaches Jarrik");
});

// judgment — Execution Sentence:
//   "Target enemy gains 5 stacks of Execution Sentence. Each time they use a skill,
//    one stack will be removed. When they have no more stacks, they are instantly
//    killed."

test("Execution Sentence: applies 5 stacks; the enemy survives 4 skills but dies on the 5th", () => {
  const j = jarrik(); fuse(j, "judgment");
  const e = enemy("e");
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikjudgment1", targets: ["e"] });
  assert.equal(stackMag(e, "Execution Sentence"), 5, "5 stacks applied");

  for (let i = 0; i < 4; i++) emit(st, { type: "skillUsed", caster: "e", skillId: "s" + i, targets: [], tags: [] });
  assert.equal(e.alive, true, "after 4 skills (1 stack left) the enemy is alive");
  emit(st, { type: "skillUsed", caster: "e", skillId: "s4", targets: [], tags: [] });
  assert.equal(e.alive, false, "the 5th skill empties the stacks → instant kill");
});

test("Execution Sentence control: an enemy WITHOUT the stacks is not killed by using skills", () => {
  const j = jarrik(); fuse(j, "judgment");
  const e = enemy("e");
  const st = makeState([j], [e]);

  for (let i = 0; i < 6; i++) emit(st, { type: "skillUsed", caster: "e", skillId: "s" + i, targets: [], tags: [] });
  assert.equal(e.alive, true, "no Execution Sentence → using skills is harmless");
});

// ============================================================================
// mechanic — Blazer Board (passive):
//   "Whenever Jarrik consumes a mark from Cinders, he becomes Invulnerable until
//    the end of his next turn. This effect is automatically activated at the start
//    of each round."
// ============================================================================

test("Blazer Board: auto-activates at round start → Jarrik is Invulnerable", () => {
  const j = jarrik(); fuse(j, "mechanic");
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" });
  assert.ok(has(j, "invulnerable"), "round start makes Jarrik Invulnerable");
});

test("Blazer Board control: an un-fused Jarrik gains no Invulnerable at round start", () => {
  const j = jarrik(); // no mechanic fusion
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" });
  assert.ok(!has(j, "invulnerable"), "no Blazer Board → no Invulnerable");
});

test("Blazer Board: consuming a Cinders mark makes Jarrik Invulnerable", () => {
  const j = jarrik(); fuse(j, "mechanic");
  const marked = enemy("e", [cinders()]);
  const st = makeState([j], [marked]);
  fund(st);
  assert.ok(!has(j, "invulnerable"), "precondition: not Invulnerable before consuming");

  performAction(st, { unit: "j", skillId: "jarrik3", targets: [] }); // Call Cinders consumes the mark
  assert.ok(!hasMark(marked, "Cinders"), "the mark was consumed");
  assert.ok(has(j, "invulnerable"), "consuming a Cinders mark grants Invulnerable");
});

// mechanic — Pop Off:
//   "Jarrik deals 10 Affliction damage to target enemy. If they were marked by
//    Cinders, he consumes the mark. If they weren't, he applies Cinders to them.
//    This skill is only usable the turn after activating Blazer Board."

test("Pop Off: usable only while Blazer Board is active (Jarrik Invulnerable), refused otherwise", () => {
  const j = jarrik(); fuse(j, "mechanic");
  const st = makeState([j], [enemy("e")]);
  fund(st);

  const denied = performAction(st, { unit: "j", skillId: "jarrikmechanic1", targets: ["e"] });
  assert.equal(denied.ok, false, "with Blazer Board inactive Pop Off is refused");
  assert.equal(denied.reason, "requirements-not-met");

  emit(st, { type: "roundStart" }); // Blazer Board activates
  const ok = performAction(st, { unit: "j", skillId: "jarrikmechanic1", targets: ["e"] });
  assert.equal(ok.ok, true, "after activating Blazer Board, Pop Off is usable");
});

test("Pop Off: 10 Affliction; consumes Cinders on a marked enemy, applies Cinders on an unmarked one", () => {
  // unmarked → applies Cinders
  {
    const j = jarrik(); fuse(j, "mechanic");
    const e = enemy("e");
    const st = makeState([j], [e]);
    fund(st);
    emit(st, { type: "roundStart" }); // satisfies the usable gate
    performAction(st, { unit: "j", skillId: "jarrikmechanic1", targets: ["e"] });
    assert.equal(e.hp, 90, "10 Affliction damage");
    assert.ok(hasMark(e, "Cinders"), "an unmarked target gains Cinders");
  }
  // marked → consumes Cinders
  {
    const j = jarrik(); fuse(j, "mechanic");
    const e = enemy("e", [cinders()]);
    const st = makeState([j], [e]);
    fund(st);
    emit(st, { type: "roundStart" });
    performAction(st, { unit: "j", skillId: "jarrikmechanic1", targets: ["e"] });
    assert.equal(e.hp, 80, "10 Pop Off Affliction + the persisted base Cinders passive's 10 (target was already Cinders) = 20");
    assert.ok(!hasMark(e, "Cinders"), "a marked target's Cinders is consumed");
  }
});

// ============================================================================
// plasma — Blue Flame Spirits (passive):
//   "Cinderling minions are replaced by Azure Sparkling minions."
// ============================================================================

test("Blue Flame Spirits: a plasma-fused Jarrik summons Azure Sparkling instead of Cinderling", () => {
  const j = jarrik(); fuse(j, "plasma");
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" }); // installs the Blue Flame Spirits mark

  runEffects(st, [{ op: "summon", template: "Cinderling", count: 1 }], { caster: j, self: j });
  const names = Object.values(st.units).filter((u) => u.kind === "minion" && u.team === "A").map((u) => u.name);
  assert.ok(names.includes("Azure Sparkling"), "the Cinderling summon minted an Azure Sparkling");
  assert.ok(!names.includes("Cinderling"), "no plain Cinderling was created");
});

// plasma — Awakener's Spark:
//   "Deals 5 Piercing damage and applies Cinders to up to 3 different, random enemies."

test("Awakener's Spark: hits 3 different enemies for 5 Piercing + Cinders when 4 are available", () => {
  const j = jarrik(); fuse(j, "plasma");
  const es = [enemy("e1"), enemy("e2"), enemy("e3"), enemy("e4")];
  const st = makeState([j], es);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikplasma1", targets: ["j"] });
  const hit = es.filter((e) => e.hp === 95);
  const marked = es.filter((e) => hasMark(e, "Cinders"));
  assert.equal(hit.length, 3, "exactly 3 distinct enemies took 5 Piercing");
  assert.equal(marked.length, 3, "exactly 3 distinct enemies gained Cinders");
  assert.deepEqual(hit.map((e) => e.id).sort(), marked.map((e) => e.id).sort(), "the damaged and marked sets match");
});

test("Awakener's Spark: a SINGLE enemy is hit once for 5 (different enemies → no triple-dip)", () => {
  const j = jarrik(); fuse(j, "plasma");
  const e = enemy("e");
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarrikplasma1", targets: ["j"] });
  assert.equal(e.hp, 95, "only 5 damage — one distinct enemy is hit once, not three times");
});

// ============================================================================
// ritual — Ritual of the Reaper (passive):
//   "When Jarrik takes or deals damage, he gains that much Ritual Power, up to a
//    maximum of 120."
// ============================================================================

test("Ritual of the Reaper: Jarrik gains Ritual Power equal to damage dealt/taken, capped at 120", () => {
  const j = jarrik(); fuse(j, "ritual");
  const e = enemy("e");
  const st = makeState([j], [e]);

  emit(st, { type: "damageDealt", source: "j", target: "e", amount: 30, dtype: "normal" });
  assert.equal(stackMag(j, "Ritual Power"), 30, "dealing 30 → +30 power");
  emit(st, { type: "damageDealt", source: "e", target: "j", amount: 20, dtype: "normal" });
  assert.equal(stackMag(j, "Ritual Power"), 50, "taking 20 → +20 power (now 50)");
  emit(st, { type: "damageDealt", source: "j", target: "e", amount: 200, dtype: "normal" });
  assert.equal(stackMag(j, "Ritual Power"), 120, "power is capped at 120");
});

test("Ritual of the Reaper control: damage between two enemies grants Jarrik nothing", () => {
  const j = jarrik(); fuse(j, "ritual");
  const st = makeState([j], [enemy("e1"), enemy("e2")]);

  emit(st, { type: "damageDealt", source: "e1", target: "e2", amount: 40, dtype: "normal" });
  assert.equal(stackMag(j, "Ritual Power") ?? 0, 0, "damage not involving Jarrik grants no Ritual Power");
});

// ritual — Scythe of Cinders:
//   "Deals 25 Piercing damage to target enemy and marks them with Cinders. Can only
//    be used if Ritual of the Reaper has at least 60 Ritual Power. If Ritual of the
//    Reaper has 120 Ritual Power, this skill will strike its target twice."

test("Scythe of Cinders: requires >=60 Ritual Power — refused below, allowed at 60", () => {
  const j = jarrik(); fuse(j, "ritual");
  const e = enemy("e", [], { hp: 300, maxHp: 300 });
  const st = makeState([j], [e]);
  fund(st);

  // 59 power → refused.
  j.statuses.push({ kind: "stack", name: "Ritual Power", magnitude: 59, duration: null, appliedBy: "j", appliedTurn: 0 });
  const denied = performAction(st, { unit: "j", skillId: "jarrikritual1", targets: ["e"] });
  assert.equal(denied.ok, false, "below 60 power the skill is unusable");
  assert.equal(denied.reason, "requirements-not-met");

  // bump to 60 → allowed, single 25 Piercing + Cinders.
  j.statuses.find((s) => s.name === "Ritual Power")!.magnitude = 60;
  const hp = e.hp;
  const ok = performAction(st, { unit: "j", skillId: "jarrikritual1", targets: ["e"] });
  assert.equal(ok.ok, true, "at 60 power the skill is usable");
  assert.equal(hp - e.hp, 25, "a single 25-Piercing strike");
  assert.ok(hasMark(e, "Cinders"), "the target is marked with Cinders");
});

test("Scythe of Cinders: at exactly 120 Ritual Power it strikes twice (60 total)", () => {
  const j = jarrik(); fuse(j, "ritual");
  const e = enemy("e", [], { hp: 300, maxHp: 300 });
  const st = makeState([j], [e]);
  fund(st);
  j.statuses.push({ kind: "stack", name: "Ritual Power", magnitude: 120, duration: null, appliedBy: "j", appliedTurn: 0 });

  const hp = e.hp;
  performAction(st, { unit: "j", skillId: "jarrikritual1", targets: ["e"] });
  assert.equal(hp - e.hp, 60, "two 25-Piercing strikes (50) + base Cinders passive's 10 on the second, now-Cinders strike = 60");
});

// ============================================================================
// sun — Dusken Ascendant (passive):
//   "Jarrik is permanently Blinded and creates one Cinder minion at the end of each
//    turn."
// ============================================================================

test("Dusken Ascendant: Jarrik is Blinded at round start", () => {
  const j = jarrik(); fuse(j, "sun");
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" });
  assert.ok(has(j, "blind"), "the sun form is permanently Blinded");
});

test("Dusken Ascendant control: an un-fused Jarrik is not Blinded", () => {
  const j = jarrik();
  const st = makeState([j], [enemy("e")]);
  emit(st, { type: "roundStart" });
  assert.ok(!has(j, "blind"), "no sun form → no Blind");
});

test("Dusken Ascendant: one Cinder minion is created at the end of each turn", () => {
  const j = jarrik(); fuse(j, "sun");
  const st = makeState([j], [enemy("e")]);
  const before = minionsA(st);
  emit(st, { type: "turnEnd", team: "A" });
  assert.equal(minionsA(st), before + 1, "a Cinder minion is summoned at turn-end");
});

// sun — Dawnbreak:
//   "For the next 3 turns, all enemies are treated as though they are affected by
//    Cinders. This effect cannot be consumed to create Cinderling minions."

test("Dawnbreak: marks ALL enemies as Cinders for 3 turns", () => {
  const j = jarrik(); fuse(j, "sun");
  const e1 = enemy("e1");
  const e2 = enemy("e2");
  const st = makeState([j], [e1, e2]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarriksun1", targets: [] });
  assert.ok(hasMark(e1, "Cinders") && hasMark(e2, "Cinders"), "every enemy counts as Cinders-affected");
  const dur = e1.statuses.find((s) => s.kind === "mark" && s.name === "Cinders")?.duration;
  assert.equal(dur, 3, "the Cinders treatment lasts 3 turns");
});

test("Dawnbreak: its Cinders cannot be consumed into Cinderlings by Call Cinders", () => {
  const j = jarrik(); fuse(j, "sun");
  const e = enemy("e");
  const st = makeState([j], [e]);
  fund(st);

  performAction(st, { unit: "j", skillId: "jarriksun1", targets: [] }); // apply Dawnbreak Cinders
  const before = minionsA(st);
  performAction(st, { unit: "j", skillId: "jarrik3", targets: [] }); // Call Cinders tries to consume
  assert.equal(minionsA(st), before, "no Cinderling is created from Dawnbreak's Cinders");
  assert.ok(hasMark(e, "Cinders"), "the Dawnbreak Cinders mark is not consumed");
});
