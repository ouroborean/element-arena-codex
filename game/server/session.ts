/**
 * One authoritative Quick Match between two players. The server holds the single true MatchState, runs
 * the real engine loop (client/loop.ts `runMatch`), validates every action through it, and broadcasts the
 * full state after each phase. Players only ever submit their own committed turn / draft choice.
 *
 * The class talks to an abstract `MatchClient` (not a socket) so it can be driven by scripted doubles in
 * tests. Timeouts fill a silent turn (auto-hold) or an auto-draft; a disconnect forfeits the match.
 */
import type { Action } from "../engine/src/scheduler.ts";
import type { MatchState, TeamId } from "../engine/src/types.ts";
import type { MatchOutcome } from "../engine/content/match.ts";
import { buildMatch } from "../engine/content/match.ts";
import { runMatch } from "../client/loop.ts";
import { applyDraftChoice, autoDraft, hasDraftOptions, type DraftChoice } from "../client/draft.ts";
import { ROUNDS_TO_WIN, TURN_MS, DRAFT_MS, type ClientMsg, type ServerMsg, type EndReason } from "../net/protocol.ts";

type TurnMsg = Extract<ClientMsg, { t: "turn" }>;
type DraftMsg = Extract<ClientMsg, { t: "draftChoice" }>;

/** What a match needs of a connected player — a real WsConn wrapper in production, a double in tests. */
export interface MatchClient {
  team: string[];
  /** Assigned by the match at start (the coin-flip who-goes-first). */
  side?: TeamId;
  /** Set by the match while it awaits this player's turn; the router resolves it on an inbound `turn`. */
  pendingTurn?: (msg: TurnMsg) => void;
  /** Set while awaiting this player's between-round draft choice. */
  pendingDraft?: (msg: DraftMsg) => void;
  send(msg: ServerMsg): void;
}

const other = (side: TeamId): TeamId => (side === "A" ? "B" : "A");
const HOLD: TurnMsg = { t: "turn", actions: [] };
const SKIP: DraftMsg = { t: "draftChoice", choice: { kind: "skip" } };

/** Keep only well-formed actions; the engine still validates legality per action (illegal → a no-op). */
function sanitizeActions(actions: unknown): Action[] {
  if (!Array.isArray(actions)) return [];
  const out: Action[] = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const { unit, skillId, targets } = a as Record<string, unknown>;
    if (typeof unit !== "string" || typeof skillId !== "string") continue;
    out.push({ unit, skillId, targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : undefined });
  }
  return out;
}

/** A player's generic-payment plan only ever reallocates that player's OWN pool, so shape-checking suffices. */
function sanitizeGenericPay(g: unknown): Record<string, number> | undefined {
  if (!g || typeof g !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  return out;
}

function sanitizeChoice(c: unknown): DraftChoice {
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (o.kind === "fuse" && typeof o.unitId === "string" && typeof o.formKey === "string") return { kind: "fuse", unitId: o.unitId, formKey: o.formKey };
    if (o.kind === "augment" && typeof o.unitId === "string" && typeof o.augmentId === "string") return { kind: "augment", unitId: o.unitId, augmentId: o.augmentId };
  }
  return { kind: "skip" };
}

export class Match {
  private a: MatchClient;
  private b: MatchClient;
  private state: MatchState;
  private bySide: Record<TeamId, MatchClient>;
  private over = false;
  private aborted: { winner: TeamId } | null = null;
  private turnMs: number;
  private draftMs: number;
  /** Set by the owner (server) to detach client→match routing once the match ends. */
  onEnd?: () => void;

  constructor(a: MatchClient, b: MatchClient, seed: number, opts: { turnMs?: number; draftMs?: number } = {}) {
    this.a = a;
    this.b = b;
    this.turnMs = opts.turnMs ?? TURN_MS;
    this.draftMs = opts.draftMs ?? DRAFT_MS;
    // Random side assignment IS the first-move coin flip (Team A always takes a round's first turn).
    const aIsA = Math.random() < 0.5;
    a.side = aIsA ? "A" : "B";
    b.side = aIsA ? "B" : "A";
    this.bySide = aIsA ? { A: a, B: b } : { A: b, B: a };
    this.state = buildMatch({ A: this.bySide.A.team, B: this.bySide.B.team, seed });
  }

  /** Deliver an inbound client message to this match's pending resolver (or handle a surrender). */
  handleMessage(from: MatchClient, msg: ClientMsg): void {
    if (this.over) return;
    if (msg.t === "turn" && from.pendingTurn) {
      const resolve = from.pendingTurn;
      from.pendingTurn = undefined;
      resolve(msg);
    } else if (msg.t === "draftChoice" && from.pendingDraft) {
      const resolve = from.pendingDraft;
      from.pendingDraft = undefined;
      resolve(msg);
    } else if (msg.t === "surrender") {
      this.abort(from === this.a ? this.b : this.a);
    }
    // Anything else (a stray/out-of-turn message) is ignored.
  }

  /** A player dropped (socket closed) — the opponent wins by forfeit. */
  onDisconnect(who: MatchClient): void {
    this.abort(who === this.a ? this.b : this.a);
  }

  /** Mark the match aborted in `survivor`'s favour and unblock any awaited input so the loop unwinds. */
  private abort(survivor: MatchClient): void {
    if (this.over || this.aborted) return;
    this.aborted = { winner: survivor.side! };
    for (const c of [this.a, this.b]) {
      c.pendingTurn?.(HOLD);
      c.pendingTurn = undefined;
      c.pendingDraft?.(SKIP);
      c.pendingDraft = undefined;
    }
  }

  async run(): Promise<void> {
    this.a.send({ t: "start", you: this.a.side!, opponentTeam: this.b.team, state: this.state });
    this.b.send({ t: "start", you: this.b.side!, opponentTeam: this.a.team, state: this.state });

    let outcome: MatchOutcome | null = null;
    try {
      outcome = await runMatch(this.state, (_st, side) => this.provideTurn(side), {
        roundsToWin: ROUNDS_TO_WIN,
        hooks: {
          onResults: () => this.broadcastState(), // both sides see the just-resolved turn before the next one
          onRoundEnd: () => this.broadcastState(),
        },
        onBetweenRounds: (_st, loser) => this.runDraftPhase(loser),
      });
    } catch {
      /* aborted, or an unexpected engine error — disambiguated by `this.aborted` below */
    }

    if (this.aborted) return this.end(this.forfeitOutcome(this.aborted.winner), "opponent-left");
    if (!outcome) {
      for (const c of [this.a, this.b]) c.send({ t: "error", message: "the match ended unexpectedly" });
      this.finish();
      return;
    }
    this.end(outcome, outcome.winner === null ? "stalemate" : "decided");
  }

  private provideTurn(side: TeamId): Promise<Action[]> {
    if (this.aborted) throw new Error("aborted");
    const active = this.bySide[side];
    const waiting = this.bySide[other(side)];
    return new Promise<Action[]>((resolve) => {
      const deadline = Date.now() + this.turnMs;
      active.send({ t: "yourTurn", state: this.state, deadline });
      waiting.send({ t: "opponentTurn", state: this.state });
      const timer = setTimeout(() => {
        active.pendingTurn = undefined;
        resolve([]); // auto-hold: a timed-out player does nothing this turn
      }, this.turnMs);
      active.pendingTurn = (msg) => {
        clearTimeout(timer);
        this.state.genericPay = sanitizeGenericPay(msg.genericPay);
        resolve(sanitizeActions(msg.actions));
      };
    });
  }

  private async runDraftPhase(loser: TeamId): Promise<void> {
    for (const side of [loser, other(loser)]) { // the round loser drafts first
      if (this.aborted) throw new Error("aborted");
      if (!hasDraftOptions(this.state, side)) continue; // nothing to pick — skip the prompt
      const drafter = this.bySide[side];
      const waiting = this.bySide[other(side)];
      const choice = await new Promise<DraftChoice>((resolve) => {
        const deadline = Date.now() + this.draftMs;
        drafter.send({ t: "yourDraft", state: this.state, deadline });
        waiting.send({ t: "opponentDraft", state: this.state });
        const timer = setTimeout(() => {
          drafter.pendingDraft = undefined;
          resolve(autoDraft(this.state, side));
        }, this.draftMs);
        drafter.pendingDraft = (msg) => {
          clearTimeout(timer);
          resolve(sanitizeChoice(msg.choice));
        };
      });
      const res = applyDraftChoice(this.state, choice); // validates availability; an illegal pick is a no-op
      if (res.ok && choice.kind !== "skip") this.state.log.push(`draft — Team ${side}: ${res.desc}`);
      this.broadcastState();
    }
  }

  private forfeitOutcome(winner: TeamId): MatchOutcome {
    return { winner, rounds: this.state.round, roundsWon: { A: this.state.teams.A.roundsWon, B: this.state.teams.B.roundsWon } };
  }

  /** Push the current authoritative state to both players as a neutral "render + wait" update. */
  private broadcastState(): void {
    for (const c of [this.a, this.b]) c.send({ t: "opponentTurn", state: this.state });
  }

  private end(outcome: MatchOutcome, reason: EndReason): void {
    if (this.over) return;
    this.over = true;
    this.a.send({ t: "matchEnd", outcome, reason, you: this.a.side! });
    this.b.send({ t: "matchEnd", outcome, reason, you: this.b.side! });
    this.onEnd?.();
  }

  private finish(): void {
    if (this.over) return;
    this.over = true;
    this.onEnd?.();
  }
}
