/**
 * Seedling — Gaia's core minion (25 HP, earth). Transcribed from its frozen data.
 *
 * Its one skill, Channel Earth, feeds its SUMMONER (Gaia): "Gaia gains Elemental
 * Essence and 1 permanent stack of Channel Earth." Those stacks are what Gaia's
 * Worldfist scales off — so this template demonstrates the minion→summoner link.
 */
import type { MinionTemplate } from "../../src/minions.ts";

export const seedling: MinionTemplate = {
  name: "Seedling",
  maxHp: 25,
  element: "earth",
  skills: [
    {
      id: "seedling1", name: "Channel Earth", element: "earth", targeting: "self",
      klass: "basic", tags: ["Strategic", "Instant"], // minion skills are always BASIC
      cost: { generic: 1, specific: 0 }, cooldown: 0, currentCd: 0,
      // "Gaia gains Elemental Essence and 1 permanent stack of Channel Earth."
      effects: [
        { op: "applyStatus", to: "summoner", status: { kind: "elemental_essence", duration: null } },
        { op: "addStack", name: "Channel Earth", amount: 1, to: "summoner", duration: null },
      ],
    },
  ],
};
