/**
 * Element Arena — Quick Match server. An authoritative match host: it matchmakes two players from a FIFO
 * queue, then runs the real engine between them (see session.ts), owning the seed and validating every
 * move. Dependency-free — a bare `node game/server/index.ts` starts it (default port 8790).
 *
 *   client --WS--> [ queue ] --pair--> [ Match (authoritative engine) ] --state--> both clients
 *
 * The static browser client (game/web) dials this server's ws:// URL for the "Quick Match" button.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { attachWebSocketServer, type WsConn } from "./ws.ts";
import { Match, type MatchClient } from "./session.ts";
import { parseMessage, PROTOCOL_VERSION, TEAM_SIZE, DEFAULT_PORT, type ClientMsg, type ServerMsg } from "../net/protocol.ts";
import { ROSTER } from "../engine/content/roster.generated.ts";
// Register every native effect handler so fused/augmented/custom skills resolve server-side.
import "../engine/content/custom_effects.ts";
import "../engine/content/fusion_effects.ts";
import "../engine/content/augment_effects.ts";

const HEARTBEAT_MS = 30_000;
const HERO_IDS = new Set(ROSTER.map((h) => h.id));

/** A valid Quick Match team: exactly TEAM_SIZE distinct heroes that exist in the roster. */
function validTeam(team: unknown): team is string[] {
  return (
    Array.isArray(team) &&
    team.length === TEAM_SIZE &&
    team.every((id) => typeof id === "string" && HERO_IDS.has(id)) &&
    new Set(team).size === TEAM_SIZE
  );
}

type ClientState = "idle" | "queued" | "in-match";

/** A connected player: the socket wrapper + its queue/match bookkeeping. Implements MatchClient. */
class Client implements MatchClient {
  conn: WsConn;
  team: string[] = [];
  side?: "A" | "B";
  pendingTurn?: MatchClient["pendingTurn"];
  pendingDraft?: MatchClient["pendingDraft"];
  state: ClientState = "idle";
  match?: Match;

  constructor(conn: WsConn) {
    this.conn = conn;
  }

  send(msg: ServerMsg): void {
    this.conn.send(JSON.stringify(msg));
  }
}

export class MatchServer {
  private queue: Client[] = [];
  private clients = new Set<Client>();

  /** Register a fresh connection and wire its message/close handling. */
  accept(conn: WsConn): void {
    const client = new Client(conn);
    this.clients.add(client);
    conn.onMessage = (raw) => this.route(client, raw);
    conn.onClose = () => this.drop(client);
  }

  private route(client: Client, raw: string): void {
    const msg = parseMessage<ClientMsg>(raw);
    if (!msg) return;
    switch (msg.t) {
      case "queue":
        this.enqueue(client, msg);
        return;
      case "cancelQueue":
        this.dequeue(client);
        return;
      case "turn":
      case "draftChoice":
      case "surrender":
        client.match?.handleMessage(client, msg);
        return;
    }
  }

  private enqueue(client: Client, msg: Extract<ClientMsg, { t: "queue" }>): void {
    if (client.state !== "idle") return; // already queued or in a match
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      client.send({ t: "error", message: `protocol mismatch (server v${PROTOCOL_VERSION})` });
      return;
    }
    if (!validTeam(msg.team)) {
      client.send({ t: "error", message: "invalid team — pick 3 distinct heroes" });
      return;
    }
    client.team = [...msg.team];
    client.state = "queued";
    this.queue.push(client);
    client.send({ t: "queued" });
    this.tryPair();
  }

  private dequeue(client: Client): void {
    const i = this.queue.indexOf(client);
    if (i >= 0) this.queue.splice(i, 1);
    if (client.state === "queued") client.state = "idle";
  }

  /** Pair waiting players FIFO and start their matches. */
  private tryPair(): void {
    while (this.queue.length >= 2) {
      const a = this.queue.shift()!;
      const b = this.queue.shift()!;
      const seed = Math.floor(Math.random() * 1e9); // server-authoritative seed — the client never sets it
      const match = new Match(a, b, seed);
      for (const c of [a, b]) {
        c.state = "in-match";
        c.match = match;
      }
      match.onEnd = () => {
        for (const c of [a, b]) {
          c.match = undefined;
          c.side = undefined;
          c.pendingTurn = undefined;
          c.pendingDraft = undefined;
          if (c.state === "in-match") c.state = "idle"; // may requeue
        }
      };
      // Fire-and-forget; the match drives itself via the provider callbacks and its own timers.
      void match.run();
    }
  }

  private drop(client: Client): void {
    this.clients.delete(client);
    this.dequeue(client);
    client.match?.onDisconnect(client);
  }

  /** Ping every live connection; terminate any that missed the previous ping (dead TCP). */
  heartbeat(): void {
    for (const client of this.clients) {
      if (!client.conn.isAlive) {
        client.conn.destroy();
        continue;
      }
      client.conn.isAlive = false;
      client.conn.ping();
    }
  }

  queueSize(): number {
    return this.queue.length;
  }
}

/** Start the HTTP+WS server. Returns the underlying http server + a stop() (used by tests; pass port 0 for ephemeral). */
export function startServer(port = Number(process.env.ARENA_PORT) || DEFAULT_PORT): { stop: () => void; server: MatchServer; http: ReturnType<typeof createServer> } {
  const matchServer = new MatchServer();
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A tiny health endpoint; everything real happens over the WebSocket upgrade.
    res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/plain" });
    res.end(req.url === "/" ? "Element Arena match server — connect via WebSocket." : "not found");
  });
  attachWebSocketServer(http, (conn) => matchServer.accept(conn));
  const beat = setInterval(() => matchServer.heartbeat(), HEARTBEAT_MS);
  beat.unref?.(); // don't keep the process alive on the heartbeat alone
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
      http.close();
    },
  };
}

// Only auto-start when run directly (so tests can import the pieces without opening a port).
if (import.meta.main) startServer();
