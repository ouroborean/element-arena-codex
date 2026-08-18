/**
 * Machine-readable form of the confirmed rulings in game/content/rulings.json.
 *
 * The engine reads THESE constants; flipping one changes behaviour and produces a
 * measurable diff in the golden tests. This file is the machine form; rulings.json
 * is the human/doc form with evidence. Keep them in sync (a codegen step can unify
 * them later). Each entry cites its ruling id + confidence.
 */
export const RULINGS = {
  /** DURATION_ANCHOR (CONFIRMED): "for N turns" ticks at the APPLIER's turn-end. */
  DURATION_ANCHOR: "applier",
  /** ENERGY_POOL_SCOPE (CONFIRMED): one shared pool per team. */
  ENERGY_POOL_SCOPE: "team",
  /**
   * ENERGY_INCOME (CONFIRMED): at a team's turn start each LIVING hero yields 1 energy —
   * 1 GENERIC by default, or (if it holds an Elemental Essence charge, un-Silenced) 1 of
   * its CURRENT element INSTEAD, consuming the charge. One conversion per hero per turn.
   */
  ENERGY_INCOME: "essence-swaps-generic",
  /** HP_CARRYOVER (CONFIRMED): HP resets to full at the start of each round. */
  HP_CARRYOVER: "reset",
  /** PERMANENT_SCOPE (CONFIRMED): "permanent" effects clear at round end. */
  PERMANENT_SCOPE: "round",
  /** DEFAULT_STACK_POLICY (MED): re-applying a status refreshes it; only "stacks" accumulate. */
  DEFAULT_STACK_POLICY: "refresh",
  /** ROUNDING (LOW, provisional): fractional damage/heal floors. */
  ROUNDING: "floor",
  /** IMMORTAL_SCOPE (MED): Immortal floors HP at 1 against damage AND non-damage loss. */
  IMMORTAL_FLOORS_NON_DAMAGE: true,
} as const;

export type Rounding = "floor" | "round";

export function applyRounding(x: number): number {
  return RULINGS.ROUNDING === "floor" ? Math.floor(x) : Math.round(x);
}
