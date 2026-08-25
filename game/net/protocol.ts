/**
 * The Quick Match wire protocol — the single source of truth for the message shapes the browser client
 * and the authoritative match server exchange. Types-only + constants, so it imports NOTHING at runtime
 * (every engine import is `import type`, erased by the bundler / Node's type-stripping) and is safe to
 * pull into both the Node server and the esbuild browser bundle.
 *
 * Model: the SERVER is authoritative. It owns the seed, runs the real engine, validates every action,
 * and broadcasts the full MatchState after each phase. A client only ever sends its own committed turn /
 * draft choice; it never simulates the match itself (it keeps the engine solely for read-only previews of
 * the state the server sent). Turns strictly alternate — exactly one side is asked to act at a time.
 */
import type { Action } from "../engine/src/scheduler.ts";
import type { MatchState, TeamId, EnergyPool } from "../engine/src/types.ts";
import type { MatchOutcome } from "../engine/content/match.ts";
import type { DraftChoice } from "../client/draft.ts";

/** Bumped on any breaking change to the messages below; the server rejects a mismatched client. */
export const PROTOCOL_VERSION = 1;

/** Default port the match server listens on (overridable via ARENA_PORT / the client's ?server=). */
export const DEFAULT_PORT = 8790;

/** Best-of-N: first side to this many round wins takes the match (server-enforced, never client-set). */
export const ROUNDS_TO_WIN = 2;

/** Every drafted team is exactly this many heroes. */
export const TEAM_SIZE = 3;

/** How long a player has to submit a turn / a draft choice before the server fills it (auto-hold / autoDraft). */
export const TURN_MS = 60_000;
export const DRAFT_MS = 45_000;

/** After a player's socket drops, how long the match is held open for them to reconnect before it forfeits. */
export const RECONNECT_GRACE_MS = 45_000;

/** Why a match ended — a clean best-of-N decision, or one side dropping out. */
export type EndReason = "decided" | "forfeit" | "opponent-left" | "stalemate";

/** A guest player's public profile: a persistent identity + display name + record (rating anchors Ranked). */
export interface Profile {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  rating: number;
}

/** Max display-name length (server-clamped). */
export const MAX_NAME_LEN = 20;

// --------------------------------------------------------------------------- //
//  Client → server
// --------------------------------------------------------------------------- //
export type ClientMsg =
  /** Enter the queue with a chosen 3-hero team. `ranked` uses Elo + rating-window matchmaking. */
  | { t: "queue"; team: string[]; ranked?: boolean; protocolVersion: number }
  /** The active player's committed turn: one action per acting hero (+ the optional generic-payment plan). */
  | { t: "turn"; actions: Action[]; genericPay?: EnergyPool }
  /** The drafting player's between-round upgrade choice (fuse / augment / skip). */
  | { t: "draftChoice"; choice: DraftChoice }
  /** Concede the match immediately (the opponent wins by forfeit). */
  | { t: "surrender" }
  /** Concede only the CURRENT round (the opponent takes it); the match continues into the between-round
   *  draft, or ends normally if this decides the best-of-N. Distinct from `surrender` (whole match). */
  | { t: "concedeRound" }
  /** Leave the queue before being matched. */
  | { t: "cancelQueue" }
  /** Rejoin an in-progress match after a disconnect (a new socket presenting the seat's rejoin token). */
  | { t: "rejoin"; matchId: string; token: string; protocolVersion: number }
  /** Authenticate a guest identity on this connection (create-or-verify). Sent before queue/rejoin. */
  | { t: "auth"; playerId: string; secret: string; name: string; protocolVersion: number };

// --------------------------------------------------------------------------- //
//  Server → client
// --------------------------------------------------------------------------- //
export type ServerMsg =
  /** Your guest identity was accepted; here is the persisted profile (name + record + rating). */
  | { t: "authed"; profile: Profile }
  /** Authentication was refused (the player id exists with a different secret). */
  | { t: "authError"; message: string }
  /** Acknowledged: you are waiting in the queue. */
  | { t: "queued" }
  /** Matched. `you` is your team id; `state` is the initial board; `matchId`/`token` let you rejoin on a drop. */
  | { t: "start"; you: TeamId; opponentTeam: string[]; opponentName: string; state: MatchState; matchId: string; token: string }
  /** A successful rejoin: here is where the match stands, what you should be doing, and whether the
   *  opponent is currently disconnected (so a double-disconnect resumes with an accurate banner). */
  | { t: "resumed"; you: TeamId; state: MatchState; control: "turn" | "wait" | "draft" | "waitDraft"; deadline?: number; opponentDisconnected: boolean; opponentName: string }
  /** Your opponent's connection dropped; the match is held open `graceMs` for them to return. */
  | { t: "opponentDisconnected"; graceMs: number }
  /** Your opponent reconnected — carry on. */
  | { t: "opponentReconnected" }
  /** A rejoin attempt failed (the match ended, or the token/match id did not match). */
  | { t: "rejoinFailed"; message: string }
  /** It is YOUR turn — plan and reply with a `turn`. `deadline` is an epoch-ms timeout. */
  | { t: "yourTurn"; state: MatchState; deadline: number }
  /** The opponent is acting; just render `state` and wait. */
  | { t: "opponentTurn"; state: MatchState }
  /** It is YOUR between-round draft — reply with a `draftChoice`. */
  | { t: "yourDraft"; state: MatchState; deadline: number }
  /** The opponent is drafting; render `state` and wait. */
  | { t: "opponentDraft"; state: MatchState }
  /** The match is over. `rating` is present for a ranked match: your new Elo and the change from it. */
  | { t: "matchEnd"; outcome: MatchOutcome; reason: EndReason; you: TeamId; rating?: { rating: number; delta: number } }
  /** A recoverable problem (bad team, protocol mismatch, illegal message); usually terminal for this attempt. */
  | { t: "error"; message: string };

/** Narrowing parse of an inbound JSON string to a typed message, or null if it is not a well-formed object. */
export function parseMessage<T extends { t: string }>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && typeof (v as { t?: unknown }).t === "string" ? (v as T) : null;
  } catch {
    return null;
  }
}
