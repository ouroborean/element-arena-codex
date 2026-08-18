/**
 * The interactive match loop: the async twin of the engine's `playMatch`. It runs the exact same
 * phase machine (startRound → per-turn startTurn/RESOLVE/endTurn until a wipe → endRound) but AWAITS
 * each team's actions, so a human can be prompted mid-turn. Rendering is delegated to `hooks` and the
 * provider, keeping this file free of any I/O — a scripted provider drives it in tests.
 */
import type { MatchState, TeamId } from "../engine/src/types.ts";
import type { Action, ActionResult } from "../engine/src/scheduler.ts";
import { startRound, startTurn, resolveTurn, endTurn, roundWinner, endRound } from "../engine/src/scheduler.ts";
import type { MatchOutcome } from "../engine/content/match.ts";

/** Supplies the active team's committed actions for a turn (human input, or a bot policy). May be async. */
export type AsyncProvider = (state: MatchState, side: TeamId) => Action[] | Promise<Action[]>;

export interface LoopHooks {
  onRoundStart?(state: MatchState): void;
  onTurnStart?(state: MatchState, side: TeamId): void | Promise<void>;
  onResults?(state: MatchState, side: TeamId, results: ActionResult[], newLog: string[]): void;
  onRoundEnd?(state: MatchState, winner: TeamId): void;
}

export interface RunOpts {
  roundsToWin?: number;
  maxTurns?: number;
  hooks?: LoopHooks;
  /** The between-round AUGMENT_OR_FUSE seam (apply upgrades that carry into the next battle). */
  onBetweenRounds?(state: MatchState, roundWinner: TeamId): void | Promise<void>;
}

export async function runMatch(state: MatchState, provide: AsyncProvider, opts: RunOpts = {}): Promise<MatchOutcome> {
  const roundsToWin = opts.roundsToWin ?? 3;
  const maxTurns = opts.maxTurns ?? 400;
  const hooks = opts.hooks ?? {};
  let matchWinner: TeamId | null = null;

  while (matchWinner === null) {
    startRound(state);
    hooks.onRoundStart?.(state);
    let roundWon: TeamId | null = null;
    for (let t = 0; t < maxTurns && roundWon === null; t++) {
      startTurn(state);
      const side = state.activeTeam;
      await hooks.onTurnStart?.(state, side);
      const logStart = state.log.length;
      const results = resolveTurn(state, await provide(state, side));
      hooks.onResults?.(state, side, results, state.log.slice(logStart));
      roundWon = roundWinner(state);
      if (roundWon === null) endTurn(state); // hand over; a wipe ends the round immediately
    }
    if (roundWon === null) {
      return { winner: null, rounds: state.round, roundsWon: { A: state.teams.A.roundsWon, B: state.teams.B.roundsWon } };
    }
    hooks.onRoundEnd?.(state, roundWon);
    matchWinner = endRound(state, roundWon, roundsToWin);
    if (matchWinner === null) await opts.onBetweenRounds?.(state, roundWon);
  }
  return { winner: matchWinner, rounds: state.round, roundsWon: { A: state.teams.A.roundsWon, B: state.teams.B.roundsWon } };
}
