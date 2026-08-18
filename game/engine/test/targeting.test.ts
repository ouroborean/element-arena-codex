import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { makeState, makeUnit, skill, status } from "./helpers.ts";

const harmful = (dmg: number, over = {}) =>
  skill("atk", [{ op: "damage", amount: dmg, to: "target" }], { tags: ["Harmful", "Instant"], ...over });

test("Invulnerable blocks a new Harmful skill (no legal target)", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [harmful(30)] });
  const d = makeUnit({ id: "d", team: "B", hp: 100, statuses: [status("invulnerable", { duration: 1 })] });
  const state = makeState([a], [d]);
  const r = performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(r.reason, "no-legal-target");
  assert.equal(d.hp, 100);
});

test("Bypassing ignores Invulnerability", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [harmful(30, { tags: ["Harmful", "Bypassing"] })] });
  const d = makeUnit({ id: "d", team: "B", hp: 100, statuses: [status("invulnerable", { duration: 1 })] });
  const state = makeState([a], [d]);
  assert.equal(performAction(state, { unit: "a", skillId: "atk", targets: ["d"] }).ok, true);
  assert.equal(d.hp, 70);
});

test("Isolated blocks a Helpful skill", () => {
  const mend = skill("mend", [{ op: "heal", amount: 20, to: "target" }], { tags: ["Helpful"] });
  const a = makeUnit({ id: "a", team: "A", skills: [mend] });
  const ally = makeUnit({ id: "al", team: "A", hp: 50, statuses: [status("isolated", { duration: 1 })] });
  const state = makeState([a, ally], [makeUnit({ id: "e", team: "B" })]);
  assert.equal(performAction(state, { unit: "a", skillId: "mend", targets: ["al"] }).reason, "no-legal-target");
  assert.equal(ally.hp, 50);
});

test("AoE Harmful skips Invulnerable enemies but hits the rest", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [harmful(20, { targeting: "all-enemies" })] });
  const safe = makeUnit({ id: "safe", team: "B", hp: 100, statuses: [status("invulnerable", { duration: 1 })] });
  const exposed = makeUnit({ id: "exp", team: "B", hp: 100 });
  const state = makeState([a], [safe, exposed]);
  performAction(state, { unit: "a", skillId: "atk" });
  assert.equal(safe.hp, 100, "invulnerable enemy untouched");
  assert.equal(exposed.hp, 80, "exposed enemy hit");
});

test("Taunt forces a single-target Harmful skill onto the taunter", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [harmful(25)] });
  const other = makeUnit({ id: "d", team: "B", hp: 100 });
  const taunter = makeUnit({ id: "t", team: "B", hp: 100 });
  a.statuses = [status("taunt", { unitRef: "t", duration: 2 })];
  const state = makeState([a], [other, taunter]);
  performAction(state, { unit: "a", skillId: "atk", targets: ["d"] });
  assert.equal(other.hp, 100, "chosen target ignored");
  assert.equal(taunter.hp, 75, "forced onto the taunter");
});

test("Taunt can be applied through the DSL (unitRef selector = caster)", () => {
  const provoke = skill("provoke", [{ op: "applyStatus", to: "target", status: { kind: "taunt", unitRef: "caster", duration: 2 } }], { tags: ["Harmful"] });
  const c = makeUnit({ id: "c", team: "A", hp: 100, skills: [provoke] });
  const enemy = makeUnit({ id: "e", team: "B", skills: [harmful(20)] });
  const cAlly = makeUnit({ id: "ally", team: "A", hp: 100 });
  const state = makeState([c, cAlly], [enemy]);

  performAction(state, { unit: "c", skillId: "provoke", targets: ["e"] }); // taunt enemy to target c
  performAction(state, { unit: "e", skillId: "atk", targets: ["ally"] }); // enemy tries to hit ally
  assert.equal(cAlly.hp, 100, "ally protected by the taunt");
  assert.equal(c.hp, 80, "enemy forced onto the provoker");
});

test("Untargetable blocks any enemy skill (Galazax Thunder Deafens), but self-targeting still works", () => {
  const a = makeUnit({ id: "a", team: "A", skills: [harmful(30)] });
  const g = makeUnit({
    id: "g", team: "B", hp: 100, statuses: [status("untargetable", { duration: 1 })],
    skills: [skill("buff", [{ op: "grantShield", amount: 20, to: "self" }], { tags: ["Strategic"], targeting: "self" })],
  });
  const state = makeState([a], [g]);
  assert.equal(performAction(state, { unit: "a", skillId: "atk", targets: ["g"] }).reason, "no-legal-target", "enemy can't target it");
  assert.equal(performAction(state, { unit: "g", skillId: "buff" }).ok, true, "self-target still works");
});

test("Blind retargets a single-target skill to a random valid enemy, deterministically", () => {
  function run() {
    const a = makeUnit({ id: "a", team: "A", skills: [harmful(15)], statuses: [status("blind", { duration: 1 })] });
    const enemies = [1, 2, 3, 4].map((i) => makeUnit({ id: `e${i}`, team: "B", hp: 100 }));
    const state = makeState([a], enemies, 7);
    performAction(state, { unit: "a", skillId: "atk", targets: ["e1"] });
    return enemies.find((e) => e.hp < 100)?.id;
  }
  const hit = run();
  assert.ok(hit, "some enemy was hit");
  assert.equal(hit, run(), "same seed → same random target");
});
