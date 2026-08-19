/**
 * Element Arena — Quick Match server. An authoritative match host: it matchmakes two players from a FIFO
 * queue, then runs the real engine between them (see session.ts), owning the seed and validating every
 * move. Dependency-free — a bare `node game/server/index.ts` starts it (default port 8790).
 *
 *   client --WS--> [ queue ] --pair--> [ Match (authoritative engine) ] --state--> both clients
 *
 * A player's SEAT in a match outlives any single socket: on a drop the match holds a grace window, and a
 * new socket presenting the seat's rejoin token (a `rejoin` message) rebinds and resumes it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { attachWebSocketServer, type WsConn } from "./ws.ts";
import { Match, type MatchClient, type RatingChanges } from "./session.ts";
import { AccountStore, START_RATING, elo, type ResultKind } from "./accounts.ts";
import { parseMessage, PROTOCOL_VERSION, TEAM_SIZE, DEFAULT_PORT, type ClientMsg, type ServerMsg } from "../net/protocol.ts";
import type { TeamId } from "../engine/src/types.ts";
import { ROSTER } from "../engine/content/roster.generated.ts";
// Register every native effect handler so fused/augmented/custom skills resolve server-side.
import "../engine/content/custom_effects.ts";
import "../engine/content/fusion_effects.ts";
import "../engine/content/augment_effects.ts";

const HEARTBEAT_MS = 30_000;
const MAX_CONNS = 4096; // a coarse global cap so a client can't farm unbounded sockets
const HERO_IDS = new Set(ROSTER.map((h) => h.id));

// Ranked matchmaking: the acceptable rating gap starts at RANKED_BASE_WINDOW and widens by
// RANKED_WIDEN_PER_SEC per second either player has waited, so a match is always found eventually.
const RANKED_BASE_WINDOW = 100;
const RANKED_WIDEN_PER_SEC = 60;
const RANKED_TICK_MS = 2000; // re-run ranked pairing so widening windows match waiters without a new join

/** A valid Quick Match team: exactly TEAM_SIZE distinct heroes that exist in the roster. */
function validTeam(team: unknown): team is string[] {
  return (
    Array.isArray(team) &&
    team.length === TEAM_SIZE &&
    team.every((id) => typeof id === "string" && HERO_IDS.has(id)) &&
    new Set(team).size === TEAM_SIZE
  );
}

/**
 * A player's persistent seat in a match. It implements MatchClient and survives reconnects: `conn` (the live
 * socket) is swapped on rejoin, and `send` is a no-op while disconnected (the match resends the live state
 * on reconnect, so dropped intermediate messages don't matter). `owner` is the Conn currently bound to it.
 */
class Seat implements MatchClient {
  team: string[];
  side?: TeamId;
  playerId?: string;
  name?: string;
  rating: number; // captured at match start; the Elo update reads these pre-match ratings
  token = randomUUID();
  matchId: string;
  pendingTurn?: MatchClient["pendingTurn"];
  pendingDraft?: MatchClient["pendingDraft"];
  conn: WsConn | null;
  owner: Conn | null;
  match!: Match;

  constructor(team: string[], matchId: string, owner: Conn) {
    this.team = team;
    this.matchId = matchId;
    this.owner = owner;
    this.conn = owner.ws;
    this.playerId = owner.playerId;
    this.name = owner.name;
    this.rating = owner.rating ?? START_RATING;
  }

  send(msg: ServerMsg): void {
    this.conn?.send(JSON.stringify(msg));
  }
}

type Phase = "idle" | "queued" | "playing";

/** One live WebSocket connection and what it is currently doing. */
class Conn {
  ws: WsConn;
  phase: Phase = "idle";
  team: string[] = []; // when queued
  playerId?: string; // set once authenticated
  name?: string;
  rating?: number; // from the authenticated profile
  ranked = false; // which queue this connection is in
  queuedAt = 0; // epoch-ms it entered the queue (drives the ranked rating window)
  seat?: Seat; // when playing (invariant while current: seat.owner === this && seat.conn === this.ws)

  constructor(ws: WsConn) {
    this.ws = ws;
  }

  send(msg: ServerMsg): void {
    this.ws.send(JSON.stringify(msg));
  }
}

export class MatchServer {
  private queue: Conn[] = []; // casual (Quick Match), FIFO
  private rankedQueue: Conn[] = []; // ranked, rating-window matchmaking
  private conns = new Set<Conn>();
  private matches = new Map<string, Match>();
  private seats = new Map<string, Seat>(); // by rejoin token
  private store: AccountStore;

  constructor(store: AccountStore) {
    this.store = store;
  }

  /** Register a fresh connection and wire its message/close handling. */
  accept(ws: WsConn): void {
    if (this.conns.size >= MAX_CONNS) { ws.destroy(); return; } // refuse past the global cap
    const conn = new Conn(ws);
    this.conns.add(conn);
    ws.onMessage = (raw) => this.route(conn, raw);
    ws.onClose = () => this.drop(conn);
  }

  private route(conn: Conn, raw: string): void {
    const msg = parseMessage<ClientMsg>(raw);
    if (!msg) return;
    try {
      switch (msg.t) {
        case "auth": void this.authenticate(conn, msg); return;
        case "queue": this.enqueue(conn, msg); return;
        case "cancelQueue": this.dequeue(conn); return;
        case "rejoin": this.rejoin(conn, msg); return;
        case "turn":
        case "draftChoice":
        case "surrender":
          conn.seat?.match.handleMessage(conn.seat, msg);
          return;
      }
    } catch {
      /* a malformed message must never crash the server; drop it */
    }
  }

  /** Verify (or create) the connection's guest identity and bind it for this session. */
  private async authenticate(conn: Conn, msg: Extract<ClientMsg, { t: "auth" }>): Promise<void> {
    if (msg.protocolVersion !== PROTOCOL_VERSION) { conn.send({ t: "authError", message: "protocol mismatch" }); return; }
    try {
      const profile = await this.store.authenticate(msg.playerId, msg.secret, msg.name);
      if (!profile) { conn.send({ t: "authError", message: "that player id is taken by someone else" }); return; }
      conn.playerId = profile.playerId;
      conn.name = profile.name;
      conn.rating = profile.rating;
      conn.send({ t: "authed", profile });
    } catch {
      conn.send({ t: "authError", message: "sign-in failed, please retry" }); // a DB fault must not crash the server
    }
  }

  private enqueue(conn: Conn, msg: Extract<ClientMsg, { t: "queue" }>): void {
    if (conn.phase !== "idle") return; // already queued or in a match
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      conn.send({ t: "error", message: `protocol mismatch (server v${PROTOCOL_VERSION})` });
      return;
    }
    if (!conn.playerId) {
      conn.send({ t: "error", message: "authenticate before queueing" });
      return;
    }
    if (!validTeam(msg.team)) {
      conn.send({ t: "error", message: "invalid team — pick 3 distinct heroes" });
      return;
    }
    conn.team = [...msg.team];
    conn.phase = "queued";
    conn.ranked = !!msg.ranked;
    conn.queuedAt = Date.now();
    conn.send({ t: "queued" });
    if (conn.ranked) { this.rankedQueue.push(conn); this.matchmakeRanked(); }
    else { this.queue.push(conn); this.tryPair(); }
  }

  private dequeue(conn: Conn): void {
    for (const q of [this.queue, this.rankedQueue]) {
      const i = q.indexOf(conn);
      if (i >= 0) q.splice(i, 1);
    }
    if (conn.phase === "queued") conn.phase = "idle";
  }

  /** A new socket rejoining an in-progress match: verify the token, rebind the seat, and resume it. */
  private rejoin(conn: Conn, msg: Extract<ClientMsg, { t: "rejoin" }>): void {
    if (conn.phase !== "idle") return;
    if (msg.protocolVersion !== PROTOCOL_VERSION) { conn.send({ t: "rejoinFailed", message: "protocol mismatch" }); return; }
    const seat = this.seats.get(msg.token);
    if (!seat || seat.matchId !== msg.matchId) { conn.send({ t: "rejoinFailed", message: "that match has ended or was not found" }); return; }
    // Rebind. Reap any previous owner (a stale/duplicate socket): reset it to idle and close it so it isn't
    // left as a pinned zombie in `conns`, then adopt this connection.
    if (seat.owner && seat.owner !== conn) {
      const prev = seat.owner;
      prev.seat = undefined;
      prev.phase = "idle";
      prev.ws.close();
    }
    seat.owner = conn;
    seat.conn = conn.ws;
    conn.seat = seat;
    conn.phase = "playing";
    seat.match.onSeatReconnect(seat);
  }

  /** Pair casual players FIFO — but never pair two connections that share one identity (self-collusion). */
  private tryPair(): void {
    while (this.queue.length >= 2) {
      const ca = this.queue[0]!;
      const bi = this.queue.findIndex((c, i) => i > 0 && c.playerId !== ca.playerId);
      if (bi === -1) break; // only same-identity connections are waiting — hold until a distinct player arrives
      const cb = this.queue[bi]!;
      this.queue.splice(bi, 1); // remove cb (higher index) first…
      this.queue.shift(); // …then ca at the front
      this.pairAndStart(ca, cb, false);
    }
  }

  /** The acceptable rating gap for a connection that has waited `waitedMs` — widens without bound over time. */
  private rankedWindow(waitedMs: number): number {
    return RANKED_BASE_WINDOW + (Math.max(0, waitedMs) / 1000) * RANKED_WIDEN_PER_SEC;
  }

  /**
   * Pair ranked players by rating proximity. Sorted by rating so the closest pairs are adjacent; two are
   * matched when their gap fits the WIDER of their two windows (so a long-waiter isn't held back by a fresh
   * arrival). Runs on each ranked enqueue and on a periodic tick so widening windows eventually match anyone.
   */
  matchmakeRanked(): void {
    const now = Date.now();
    const q = this.rankedQueue;
    q.sort((a, b) => (a.rating ?? START_RATING) - (b.rating ?? START_RATING));
    for (let i = 0; i < q.length - 1; ) {
      const a = q[i]!, b = q[i + 1]!;
      if (a.playerId === b.playerId) { i++; continue; } // never self-pair
      const gap = Math.abs((a.rating ?? START_RATING) - (b.rating ?? START_RATING));
      const window = Math.max(this.rankedWindow(now - a.queuedAt), this.rankedWindow(now - b.queuedAt));
      if (gap <= window) {
        q.splice(i, 2); // remove the pair
        this.pairAndStart(a, b, true);
      } else {
        i++;
      }
    }
  }

  /** Create the seats + Match for a pair and start it. `ranked` decides how the result updates records/ratings. */
  private pairAndStart(ca: Conn, cb: Conn, ranked: boolean): void {
    const matchId = randomUUID();
    const seatA = new Seat(ca.team, matchId, ca);
    const seatB = new Seat(cb.team, matchId, cb);
    ca.phase = cb.phase = "playing";
    ca.seat = seatA;
    cb.seat = seatB;
    this.seats.set(seatA.token, seatA);
    this.seats.set(seatB.token, seatB);
    const seed = Math.floor(Math.random() * 1e9); // server-authoritative seed — the client never sets it
    const match = new Match(seatA, seatB, seed);
    seatA.match = seatB.match = match;
    this.matches.set(matchId, match);
    match.onResult = (winner) => this.recordResults(seatA, seatB, winner, ranked);
    match.onEnd = () => this.endMatch(matchId, [seatA, seatB]);
    void match.run(); // fire-and-forget; the match drives itself via the provider callbacks and its own timers
  }

  /**
   * Persist the outcome. Casual: just tally W/L/D. Ranked: apply Elo from the pre-match ratings, update both
   * records + ratings, and return each side's new rating + delta to fold into matchEnd.
   */
  private recordResults(a: Seat, b: Seat, winner: TeamId | null, ranked: boolean): RatingChanges | void {
    const resultFor = (seat: Seat): ResultKind => (winner === null ? "draw" : seat.side === winner ? "win" : "loss");
    if (!ranked) {
      for (const seat of [a, b]) if (seat.playerId) this.store.recordResult(seat.playerId, resultFor(seat));
      return;
    }
    const sa = winner === null ? 0.5 : a.side === winner ? 1 : 0;
    const [na, nb] = elo(a.rating, b.rating, sa);
    if (a.playerId) this.store.recordRankedResult(a.playerId, resultFor(a), na);
    if (b.playerId) this.store.recordRankedResult(b.playerId, resultFor(b), nb);
    const changes: RatingChanges = {};
    changes[a.side!] = { rating: na, delta: na - a.rating };
    changes[b.side!] = { rating: nb, delta: nb - b.rating };
    return changes;
  }

  /** Tear down a finished match: forget its seats and free both connections to requeue. */
  private endMatch(matchId: string, seats: Seat[]): void {
    this.matches.delete(matchId);
    for (const seat of seats) {
      this.seats.delete(seat.token);
      const owner = seat.owner;
      if (owner && owner.seat === seat) {
        owner.seat = undefined;
        if (owner.phase === "playing") owner.phase = "idle"; // may requeue
      }
      seat.owner = null;
      seat.conn = null;
    }
  }

  private drop(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.phase === "queued") { this.dequeue(conn); return; }
    // Only the seat's CURRENT connection dropping starts the grace window; a stale (already-rebound) one is ignored.
    const seat = conn.seat;
    if (seat && seat.owner === conn) {
      seat.owner = null;
      seat.conn = null;
      seat.match.onSeatDisconnect(seat);
    }
  }

  /** Ping every live connection; terminate any that missed the previous ping (dead TCP). */
  heartbeat(): void {
    for (const conn of this.conns) {
      if (!conn.ws.isAlive) {
        conn.ws.destroy();
        continue;
      }
      conn.ws.isAlive = false;
      conn.ws.ping();
    }
  }

  queueSize(): number {
    return this.queue.length;
  }
}

const CORS = {
  "access-control-allow-origin": "*", // the static client is served from a different origin (GitHub Pages / :8140)
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Start the HTTP+WS server. Returns the underlying http server + a stop() (used by tests; pass port 0 for ephemeral). */
export function startServer(port = Number(process.env.ARENA_PORT) || DEFAULT_PORT): { stop: () => void; server: MatchServer; http: ReturnType<typeof createServer> } {
  const store = new AccountStore();
  const matchServer = new MatchServer(store);
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    // POST /profile {playerId, secret, name} -> the guest profile (create-or-verify). Lets the team-select
    // screen show a name + record without opening a match socket.
    if (req.method === "POST" && req.url === "/profile") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on("end", async () => {
        try {
          const { playerId, secret, name } = JSON.parse(body) as { playerId?: string; secret?: string; name?: string };
          const profile = await store.authenticate(playerId ?? "", secret ?? "", name ?? "");
          res.writeHead(profile ? 200 : 401, { ...CORS, "content-type": "application/json" });
          res.end(JSON.stringify(profile ? { profile } : { error: "authentication failed" }));
        } catch {
          res.writeHead(400, { ...CORS, "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
      return;
    }
    // A tiny health endpoint; the match itself runs over the WebSocket upgrade.
    res.writeHead(req.url === "/" ? 200 : 404, { ...CORS, "content-type": "text/plain" });
    res.end(req.url === "/" ? "Element Arena match server — connect via WebSocket." : "not found");
  });
  attachWebSocketServer(http, (conn) => matchServer.accept(conn));
  const beat = setInterval(() => matchServer.heartbeat(), HEARTBEAT_MS);
  beat.unref?.(); // don't keep the process alive on the heartbeat alone
  const rankedTick = setInterval(() => matchServer.matchmakeRanked(), RANKED_TICK_MS);
  rankedTick.unref?.(); // widening rating windows pair waiters even without a new join
  http.listen(port, () => {
    const addr = http.address();
    const bound = addr && typeof addr === "object" ? addr.port : port;
    console.log(`[arena] Quick Match server listening on :${bound}`);
  });
  return {
    server: matchServer,
    http,
    stop: () => {
      clearInterval(beat);
      clearInterval(rankedTick);
      http.close();
      store.close();
    },
  };
}

// Only auto-start when run directly (so tests can import the pieces without opening a port).
if (import.meta.main) startServer();
