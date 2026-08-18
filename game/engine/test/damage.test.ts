import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDamage, applyHeal, applyHealthLoss, totalShield } from "../src/damage.ts";
import { makeUnit, status } from "./helpers.ts";

// Golden cases transcribed from the glossary's damage rules. Each asserts one row of
// the type x mitigation matrix; together they pin the DAMAGE_CHANNELS ruling.

test("normal damage is reduced by Damage Reduction", () => {
  const u = makeUnit({ hp: 100, statuses: [status("damage_reduction", { magnitude: 8 })] });
  const r = applyDamage(u, { amount: 20, type: "normal" });
  assert.equal(r.hpLost, 12);
  assert.equal(u.hp, 88);
});

test("PIERCING ignores Damage Reduction but NOT incoming mods", () => {
  const u = makeUnit({
    hp: 100,
    statuses: [
      status("damage_reduction", { magnitude: 8 }), // ignored by piercing
      status("incoming_damage_mod", { magnitude: 5 }), // still applies
    ],
  });
  const r = applyDamage(u, { amount: 20, type: "piercing" });
  assert.equal(r.hpLost, 25, "20 + 5 incoming, DR bypassed");
});

test("PIERCING is still absorbed by Shield", () => {
  const u = makeUnit({ hp: 100, shield: 30, statuses: [status("damage_reduction", { magnitude: 10 })] });
  const r = applyDamage(u, { amount: 25, type: "piercing" });
  assert.equal(r.shieldAbsorbed, 25);
  assert.equal(r.hpLost, 0);
  assert.equal(totalShield(u), 5);
});

test("AFFLICTION ignores Damage Reduction AND Shield", () => {
  const u = makeUnit({
    hp: 100,
    shield: 40,
    statuses: [status("damage_reduction", { magnitude: 15 })],
  });
  const r = applyDamage(u, { amount: 20, type: "affliction" });
  assert.equal(r.shieldAbsorbed, 0);
  assert.equal(r.hpLost, 20);
  assert.equal(totalShield(u), 40, "shield untouched by affliction");
});

test("AFFLICTION still respects incoming damage mods", () => {
  const u = makeUnit({ hp: 100, statuses: [status("incoming_damage_mod", { magnitude: 5 })] });
  const r = applyDamage(u, { amount: 10, type: "affliction" });
  assert.equal(r.hpLost, 15);
});

test("TRUE damage ignores mods, DR and Shield", () => {
  const u = makeUnit({
    hp: 100,
    shield: 40,
    statuses: [
      status("damage_reduction", { magnitude: 15 }),
      status("incoming_damage_mod", { magnitude: 5 }),
    ],
  });
  const r = applyDamage(u, { amount: 20, type: "true" });
  assert.equal(r.hpLost, 20);
  assert.equal(totalShield(u), 40);
});

test("Damage Ignore voids all damage, even TRUE", () => {
  const u = makeUnit({ hp: 100, statuses: [status("damage_ignore")] });
  assert.equal(applyDamage(u, { amount: 50, type: "true" }).hpLost, 0);
  assert.equal(u.hp, 100);
});

test("Shatter voids DR and Shield for normal damage", () => {
  const u = makeUnit({
    hp: 100,
    shield: 30,
    statuses: [status("damage_reduction", { magnitude: 10 }), status("shatter")],
  });
  const r = applyDamage(u, { amount: 25, type: "normal" });
  assert.equal(r.shieldAbsorbed, 0);
  assert.equal(r.hpLost, 25);
});

test("incoming damage mod can amplify (gommarwinter0: +5 received)", () => {
  const u = makeUnit({ hp: 100, statuses: [status("incoming_damage_mod", { magnitude: 5 })] });
  assert.equal(applyDamage(u, { amount: 10, type: "normal" }).hpLost, 15);
});

test("Shield partially absorbs, overflow hits HP", () => {
  const u = makeUnit({ hp: 100, shield: 10 });
  const r = applyDamage(u, { amount: 25, type: "normal" });
  assert.equal(r.shieldAbsorbed, 10);
  assert.equal(r.hpLost, 15);
  assert.equal(totalShield(u), 0);
  assert.equal(u.hp, 85);
});

test("Immortal floors HP at 1 against lethal damage", () => {
  const u = makeUnit({ hp: 12, statuses: [status("immortal")] });
  const r = applyDamage(u, { amount: 999, type: "true" });
  assert.equal(u.hp, 1);
  assert.equal(r.lethal, false);
  assert.equal(u.alive, true);
});

test("lethal damage marks the unit dead", () => {
  const u = makeUnit({ hp: 10 });
  const r = applyDamage(u, { amount: 10, type: "normal" });
  assert.equal(u.hp, 0);
  assert.equal(r.lethal, true);
  assert.equal(u.alive, false);
});

test("heal clamps at maxHp unless overheal allowed", () => {
  const u = makeUnit({ hp: 90, maxHp: 100 });
  assert.equal(applyHeal(u, 25).healed, 10);
  assert.equal(u.hp, 100);
  const u2 = makeUnit({ hp: 90, maxHp: 100 });
  assert.equal(applyHeal(u2, 25, { allowOverheal: true }).finalHp, 115);
});

test("non-damage health loss bypasses shield/DR but Immortal still floors", () => {
  const u = makeUnit({
    hp: 20,
    shield: 50,
    statuses: [status("damage_reduction", { magnitude: 15 })],
  });
  assert.equal(applyHealthLoss(u, 20), 20, "ignores shield + DR (gaiagrave1)");
  assert.equal(totalShield(u), 50);

  const u2 = makeUnit({ hp: 5, statuses: [status("immortal")] });
  applyHealthLoss(u2, 999);
  assert.equal(u2.hp, 1);
});
