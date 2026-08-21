import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDamage } from "../src/damage.ts";
import { makeUnit } from "./helpers.ts";
import type { Unit } from "../src/types.ts";

// Fidelity Campaign 3, PR 16 — sourceId-scoped incoming damage mods/mults. ayana Word of the Law "+10 damage
// from Voice of Light for 2 turns" was an UNSCOPED +10 to all incoming damage; it now carries
// viaSourceId:"ayana1.hit" so only Voice-of-Light hits (whose damage node id is ayana1.hit) get the +10.

const target = (): Unit => makeUnit({ id: "t", team: "B", hp: 100, maxHp: 100,
  statuses: [{ kind: "incoming_damage_mod", magnitude: 10, viaSourceId: "ayana1.hit", duration: 2, appliedBy: "a", appliedTurn: 0 }] });

test("a source-scoped incoming_damage_mod applies ONLY to damage from its source id", () => {
  const vol = target();
  applyDamage(vol, { amount: 10, type: "normal", isNew: true, sourceId: "ayana1.hit" });
  assert.equal(vol.hp, 80, "Voice of Light (ayana1.hit) hits for 10 + 10 = 20");

  const other = target();
  applyDamage(other, { amount: 10, type: "normal", isNew: true, sourceId: "someone_else" });
  assert.equal(other.hp, 90, "a hit from a different source gets no +10");

  const untagged = target();
  applyDamage(untagged, { amount: 10, type: "normal", isNew: true });
  assert.equal(untagged.hp, 90, "an untagged hit (no sourceId) gets no +10");
});

test("an UNSCOPED incoming_damage_mod still applies to all damage (no regression)", () => {
  const u = makeUnit({ id: "u", team: "B", hp: 100, maxHp: 100,
    statuses: [{ kind: "incoming_damage_mod", magnitude: 5, duration: null, appliedBy: "x", appliedTurn: 0 }] });
  applyDamage(u, { amount: 10, type: "normal", isNew: true, sourceId: "anything" });
  assert.equal(u.hp, 85, "an unscoped +5 applies regardless of source");
});
