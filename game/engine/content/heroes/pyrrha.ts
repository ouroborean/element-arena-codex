/**
 * Pyrrha, the Mage in Ivory — fire, 100 HP.
 *
 * Every skill is transcribed from its exact frozen description (the oracle). Her kit
 * is a self-contained affliction-DoT engine: "Fan the Flames" lays a stacking burn
 * that her other skills read (Feed the Fire), amplify (Pyrokinesis), and re-apply
 * (Wraith in White). Damage type is Affliction throughout — it ignores DR and Shield.
 */
import type { Effect } from "../../src/effects/ast.ts";
import type { HeroDef } from "../hero.ts";

// "Deals 15 Affliction damage to target enemy, then 5 Affliction damage for the next
//  3 turns." Reused verbatim by Pyrokinesis while Wraith in White is active.
const fanTheFlames: Effect[] = [
  { op: "damage", amount: 15, dtype: "affliction", to: "target", id: "fan.hit" },
  {
    op: "applyStatus",
    to: "target",
    id: "fan.dot",
    status: { kind: "dot", name: "Fan the Flames", magnitude: 5, dtype: "affliction", duration: 3, firstTickNextTurn: true },
  },
];

export const pyrrha: HeroDef = {
  id: "pyrrha",
  name: "Pyrrha, the Mage in Ivory",
  element: "fire",
  maxHp: 100,

  passive: {
    name: "Burning Up",
    description:
      "When an enemy affected by Fan the Flames damages Pyrrha, she gains Elemental Essence. " +
      "When Pyrrha dies, she deals 10 Affliction damage to all targetable enemies.",
  },

  triggers: [
    // "When an enemy affected by Fan the Flames damages Pyrrha, she gains Elemental Essence."
    {
      on: "damageDealt",
      source: "Burning Up",
      when: {
        and: [
          { sameUnit: ["eventTarget", "self"] },
          { has: "dot", name: "Fan the Flames", of: "eventSource" },
        ],
      },
      effect: [{ op: "applyStatus", to: "self", status: { kind: "elemental_essence", duration: null } }],
    },
    // "When Pyrrha dies, she deals 10 Affliction damage to all targetable enemies."
    {
      on: "unitDied",
      source: "Burning Up",
      when: { sameUnit: ["eventUnit", "self"] },
      effect: [{ op: "damage", amount: 10, dtype: "affliction", to: { faction: "enemies" } }],
    },
  ],

  skills: [
    // slot 1
    {
      id: "pyrrha1", name: "Fan the Flames", element: "fire", targeting: "single",
      klass: "basic", tags: ["Harmful", "Instant", "Affliction"],
      cost: { generic: 1, specific: 0 }, cooldown: 0, currentCd: 0,
      // "Using this skill on an affected enemy will refresh the duration." — applyStatus
      // refreshes a same-named dot by default (DEFAULT_STACK_POLICY).
      effects: fanTheFlames,
    },
    // slot 2
    {
      id: "pyrrha2", name: "Feed the Fire", element: "fire", targeting: "single",
      klass: "basic", tags: ["Harmful", "Instant"],
      cost: { generic: 0, specific: 0 }, cooldown: 2, currentCd: 0,
      // "Deals 10 Affliction damage to target enemy affected by Fan the Flames.
      //  Pyrrha heals 10 HP and gains Elemental Essence."
      effects: [
        {
          op: "if",
          cond: { has: "dot", name: "Fan the Flames", of: "target" },
          then: [{ op: "damage", amount: 10, dtype: "affliction", to: "target" }],
        },
        { op: "heal", amount: 10, to: "caster" },
        { op: "applyStatus", to: "caster", status: { kind: "elemental_essence", duration: null } },
      ],
    },
    // slot 3
    {
      id: "pyrrha3", name: "Pyrokinesis", element: "fire", targeting: "single",
      klass: "basic", tags: ["Harmful", "Instant", "Affliction"],
      cost: { generic: 1, specific: 1 }, cooldown: 1, currentCd: 0,
      // "Deals 20 Affliction damage to target enemy. If the target is affected by Fan
      //  the Flames, they take 5 more damage from it for the rest of its duration."
      // Wraith in White: "using Pyrokinesis on an enemy will first use Fan the Flames."
      effects: [
        { op: "if", cond: { has: "mark", name: "Wraith in White", of: "caster" }, then: fanTheFlames },
        { op: "damage", amount: 20, dtype: "affliction", to: "target" },
        {
          op: "if",
          cond: { has: "dot", name: "Fan the Flames", of: "target" },
          then: [{ op: "modifyStatus", kind: "dot", name: "Fan the Flames", magnitudeDelta: 5, from: "target" }],
        },
      ],
    },
    // slot 4 (defensive)
    {
      id: "pyrrha4", name: "Flashbang", element: "fire", targeting: "single",
      klass: "defensive", tags: ["Harmful", "Instant"],
      cost: { generic: 1, specific: 0 }, cooldown: 4, currentCd: 0,
      // "Stuns target enemy's non-Strategic skills for 1 turn. Pyrrha becomes
      //  Invulnerable for 1 turn."
      effects: [
        { op: "applyStatus", to: "target", status: { kind: "stun", scope: { tag: "Strategic", mode: "except" }, duration: 1 } },
        { op: "applyStatus", to: "caster", status: { kind: "invulnerable", duration: 1 } },
      ],
    },
    // slot 5 (ultimate)
    {
      id: "pyrrha5", name: "Wraith in White", element: "fire", targeting: "self",
      klass: "ultimate", tags: ["Strategic", "Instant"],
      cost: { generic: 0, specific: 2 }, cooldown: 3, currentCd: 0,
      // "Pyrrha ignores non-damage effects for 2 turns. During this time, using
      //  Pyrokinesis on an enemy will first use Fan the Flames."
      effects: [
        { op: "applyStatus", to: "caster", status: { kind: "non_damage_ignore", duration: 2 } },
        { op: "applyStatus", to: "caster", status: { kind: "mark", name: "Wraith in White", duration: 2 } },
      ],
    },
  ],
};
