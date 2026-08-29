/**
 * The match-setup layer: turn a drafted team into a playable MatchState, and drive it
 * through the RULINGS.md phase machine to a winner.
 *
 *   draft (hero ids + seed)  ──buildMatch──▶  MatchState  ──playMatch──▶  winning TeamId
 *
 * buildMatch is pure setup (no round started yet) so a client can drive turns by hand;
 * playMatch is the reference game loop (per round: startRound → alternating team turns of
 * startTurn/RESOLVE/endTurn until a wipe → endRound) for tests, replays, and AI runs. The
 * per-turn action set comes from an ActionProvider — player input in the client, a policy
 * (e.g. defaultPolicy) for automated play.
 */
import type { Action } from "../src/scheduler.ts";
import type { MatchState, TeamId, Unit } from "../src/types.ts";
import { canUse, endRound, endTurn, resolveTurn, roundWinner, startRound, startTurn } from "../src/scheduler.ts";
import { loadHero } from "./hero.ts";
import type { HeroDef } from "./hero.ts";
import { ROSTER } from "./roster.generated.ts";

const BY_ID = new Map<string, HeroDef>(ROSTER.map((h) => [h.id, h]));

/** Look up an authored hero by id (throws on an unknown id — a draft typo is a hard error). */
export function heroById(id: string): HeroDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`no such hero in the roster: ${id}`);
  return def;
}

export interface Draft {
  /** Team A hero ids, in formation-slot order (slot 0..2). */
  A: string[];
  /** Team B hero ids, in formation-slot order. */
  B: string[];
  /** RNG seed — the whole match is deterministic in this one number. */
  seed?: number;
}

/** Unit id for a drafted hero: side + slot (unique even in a mirror draft or a repeated pick). */
function unitId(team: TeamId, slot: number): string {
  return `${team.toLowerCase()}${slot + 1}`;
}

/** Assemble a fresh MatchState from a draft: heroes loaded onto their teams in slot order. */
export function buildMatch(draft: Draft): MatchState {
  const seed = draft.seed ?? 1;
  const units: Record<string, Unit> = {};

  const load = (team: TeamId, ids: string[]): string[] => {
    if (!ids.length) throw new Error(`team ${team} drafted no heroes`);
    return ids.map((heroId, slot) => {
      const id = unitId(team, slot);
      const unit = loadHero(heroById(heroId), team, id);
      unit.slot = slot;
      units[id] = unit;
      return id;
    });
  };
  const aIds = load("A", draft.A);
  const bIds = load("B", draft.B);

  // Dennis "Second-Rate Copy" Part A: a hero Dennis sharing Hector's team stands in for Hector's summoned
  // "Dennis the Apprentice" minion — so Hector's roundStart summon (count-guarded) is suppressed and every
  // Dennis-by-template reference in Hector's kit (Protect Me! redirect, Serum targets) resolves to hero-Dennis.
  for (const ids of [aIds, bIds]) {
    const team = ids.map((id) => units[id]).filter((u): u is Unit => !!u);
    // Tag exactly ONE Dennis (first in slot order) — the frozen prose assumes a single Dennis, and a lone
    // understudy keeps every reference (redirect[0], all-target refreshes) operating on the same hero.
    const dennis = team.find((u) => u.heroId === "dennis");
    if (dennis && team.some((u) => u.heroId === "hector")) dennis.understudyFor = "Dennis the Apprentice";
  }

  return {
    round: 0, // startRound increments to 1 for the first fresh battle
    turn: 1,
    roundStartTurn: 1, // startRound refreshes this each round; the first turn of a round is turn === roundStartTurn
    activeTeam: "A",
    units,
    teams: {
      A: { id: "A", units: aIds, energy: {}, roundsWon: 0 },
      B: { id: "B", units: bIds, energy: {}, roundsWon: 0 },
    },
    rngState: seed,
    seed,
    minionSeq: 0,
    scheduled: [],
    actedThisTurn: [],
    log: [],
  };
}

/** Supplies one team's committed actions for a turn (player input, or a bot policy). */
export type ActionProvider = (state: MatchState, side: TeamId) => Action[];

export interface MatchOutcome {
  /** null = the turn cap was hit with no wipe (a stalemate — surfaced, never hidden). */
  winner: TeamId | null;
  rounds: number;
  roundsWon: Record<TeamId, number>;
}

/**
 * Play a whole match to a best-of-N decision. Each round is a fresh battle; within a round
 * the active team takes a turn (income/cooldowns via startTurn → its committed actions RESOLVE
 * in staging order → endTurn ticks DoTs/durations and hands over) until one side is wiped.
 * `maxTurns` bounds a pathological stalemate rather than looping forever.
 */
export function playMatch(
  state: MatchState,
  provide: ActionProvider,
  opts: {
    roundsToWin?: number;
    maxTurns?: number;
    /**
     * The between-round AUGMENT_OR_FUSE seam. Called after a round is decided but before the
     * next fresh battle, with the just-finished round's winner. Apply augments/fusions to any
     * heroes here (via content/augment.ts + content/fusion.ts) — they persist into the next round.
     */
    onBetweenRounds?: (state: MatchState, roundWinner: TeamId) => void;
  } = {},
): MatchOutcome {
  const roundsToWin = opts.roundsToWin ?? 3;
  const maxTurns = opts.maxTurns ?? 400;
  let matchWinner: TeamId | null = null;

  while (matchWinner === null) {
    startRound(state); // fresh battle: HP/cooldown reset, round-scoped state cleared, summon passives
    let roundWon: TeamId | null = null;
    for (let t = 0; t < maxTurns && roundWon === null; t++) {
      startTurn(state);
      resolveTurn(state, provide(state, state.activeTeam));
      roundWon = roundWinner(state);
      if (roundWon === null) endTurn(state); // hand the turn over; a wipe ends the round immediately
    }
    if (roundWon === null) {
      // Turn cap hit without a decision — report the stalemate rather than spinning.
      return { winner: null, rounds: state.round, roundsWon: { A: state.teams.A.roundsWon, B: state.teams.B.roundsWon } };
    }
    matchWinner = endRound(state, roundWon, roundsToWin);
    // The between-round AUGMENT_OR_FUSE draft: apply upgrades that carry into the next battle.
    if (matchWinner === null) opts.onBetweenRounds?.(state, roundWon);
  }
  return { winner: matchWinner, rounds: state.round, roundsWon: { A: state.teams.A.roundsWon, B: state.teams.B.roundsWon } };
}

/** Living units on a side, in slot/list order. */
function living(state: MatchState, side: TeamId): Unit[] {
  return state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.alive);
}

/**
 * A simple deterministic bot: each living unit (heroes AND acting minions like Rangers/Eagles)
 * takes its first usable skill, preferring an offensive one. Only a HARMFUL single-target skill is
 * aimed at an enemy; every other single-target skill (Helpful OR a neither-tagged utility like
 * Hector's Serums) aims at the lowest-HP ally — a non-Harmful skill on an enemy only wastes the turn
 * or helps them. Good enough to drive a match to completion for tests/replays; not a strong AI.
 */
export function defaultPolicy(state: MatchState, side: TeamId): Action[] {
  const enemies = living(state, side === "A" ? "B" : "A");
  const actions: Action[] = [];
  for (const actor of living(state, side)) {
    const usable = (actor.skills ?? []).filter((s) => canUse(state, actor, s));
    if (!usable.length) continue;
    // Prefer a Harmful skill; otherwise take the first usable (defensive/utility).
    const pick = usable.find((s) => s.tags.includes("Harmful")) ?? usable[0]!;
    let targets: string[] | undefined;
    if (pick.targeting === "single") {
      if (pick.tags.includes("Harmful")) {
        const enemy = enemies[0];
        if (!enemy) continue; // nothing to hit
        targets = [enemy.id];
      } else {
        // Helpful OR a neither-tagged Strategic/utility skill (Hector's Serums "inject Dennis", not the enemy):
        // aim at a friendly unit, never an enemy.
        const allies = living(state, side).filter((u) => u.id !== actor.id);
        const ally = allies.slice().sort((a, b) => a.hp - b.hp)[0] ?? actor;
        targets = [ally.id];
      }
    }
    actions.push({ unit: actor.id, skillId: pick.id, targets });
  }
  return actions;
}
