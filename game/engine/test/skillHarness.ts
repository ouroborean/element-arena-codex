/**
 * Shared harness for skill-behavior tests: build a faithful fresh-battle 3v3 from real roster heroes
 * (so passives/triggers are installed and round-start effects fire), flush with energy so cost never
 * blocks a cast, and drive it through the real scheduler. Assertions read the live MatchState.
 *
 * Unit ids follow buildMatch's convention: team A = a1/a2/a3, team B = b1/b2/b3, in slot order.
 */
import "../content/fusion_effects.ts"; // registers the native custom-effect handlers some skills use
import { buildMatch } from "../content/match.ts";
import { startRound, startTurn, endTurn, performAction, canUse, effectiveCost, legalTargets } from "../src/scheduler.ts";
import { emit } from "../src/effects/interpret.ts";
import type { MatchState, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";

/** Generous energy of every base element + generic, so a skill's cost never blocks a behavior test. */
export function flushEnergy(): Record<string, number> {
  const pool: Record<string, number> = { generic: 99 };
  for (const el of ["fire", "ice", "wind", "lightning", "water", "earth", "poison", "shadow", "holy", "unholy"]) pool[el] = 99;
  return pool;
}

/**
 * A fresh-battle 3v3 with the given hero ids in slots 0..2. `startRound` runs so passives and
 * round-start effects (summons, self-marks, etc.) are applied; both teams are flush with energy.
 */
export function battle(aTeam: string[], bTeam: string[], seed = 1): MatchState {
  const state = buildMatch({ A: aTeam, B: bTeam, seed });
  startRound(state);
  state.teams.A.energy = flushEnergy();
  state.teams.B.energy = flushEnergy();
  return state;
}

export const unit = (s: MatchState, id: string): Unit => s.units[id]!;
export const skillOf = (u: Unit, id: string): SkillInstance => (u.skills ?? []).find((k) => k.id === id)!;
export const hasStatus = (u: Unit, kind: string, name?: string): boolean =>
  u.statuses.some((x) => x.kind === kind && (name === undefined || x.name === name));
/** A named stack's magnitude on a unit (0 if absent). */
export const stackMag = (u: Unit, name: string): number =>
  u.statuses.filter((x) => x.kind === "stack" && x.name === name).reduce((a, x) => a + (x.magnitude ?? 0), 0);
/** Total shield on a unit. */
export const shieldTotal = (u: Unit): number => u.shields.reduce((a, s) => a + s.amount, 0);

export { performAction, canUse, effectiveCost, legalTargets, startTurn, endTurn, startRound, emit };
