/**
 * End-to-end smoke test over a REAL TCP socket: start the server on an ephemeral port and connect two
 * players with Node's built-in global WebSocket (which masks frames exactly like a browser). This is the
 * only test that exercises the full stack — HTTP upgrade handshake, WsConn framing, and message routing —
 * that the double-based tests bypass. It proves two real clients get matched and told the outcome.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION, type Profile, type ServerMsg } from "../net/protocol.ts";
import { startServer } from "./index.ts";
import { START_RATING } from "./accounts.ts";

// Importing index.ts does NOT open a database (the store is created inside startServer). This runs before
// any test calls startServer, so the server uses an in-memory db and never writes a real file.
process.env.ARENA_DB = ":memory:";

type Client = { ws: WebSocket; msgs: ServerMsg[]; wait: (t: ServerMsg["t"]) => Promise<ServerMsg> };

/** Authenticate a guest identity, then join the (casual or ranked) queue with a team. */
async function authQueue(p: Client, team: string[], playerId: string, secret: string, name: string, ranked = false): Promise<void> {
  p.ws.send(JSON.stringify({ t: "auth", playerId, secret, name, protocolVersion: PROTOCOL_VERSION }));
  await p.wait("authed");
  p.ws.send(JSON.stringify({ t: "queue", team, ranked, protocolVersion: PROTOCOL_VERSION }));
}

/** Fetch a profile via the HTTP endpoint (the same path the team-select screen uses). */
async function fetchProfile(port: number, playerId: string, secret: string, name: string): Promise<Profile> {
  const res = await fetch(`http://127.0.0.1:${port}/profile`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ playerId, secret, name }) });
  return (await res.json() as { profile: Profile }).profile;
}

/** Open a WebSocket, collecting parsed server messages; resolves the socket once open. */
function connect(url: string): Promise<{ ws: WebSocket; msgs: ServerMsg[]; wait: (t: ServerMsg["t"]) => Promise<ServerMsg> }> {
  const ws = new WebSocket(url);
  const msgs: ServerMsg[] = [];
  const waiters: { t: string; resolve: (m: ServerMsg) => void }[] = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMsg;
    msgs.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.t === msg.t) { waiters[i]!.resolve(msg); waiters.splice(i, 1); }
    }
  });
  const wait = (t: ServerMsg["t"]) =>
    new Promise<ServerMsg>((resolve) => {
      const found = msgs.find((m) => m.t === t);
      if (found) resolve(found);
      else waiters.push({ t, resolve });
    });
  return new Promise((resolve) => ws.addEventListener("open", () => resolve({ ws, msgs, wait }), { once: true }));
}

test("two real WebSocket clients are matched and driven to a result over TCP", async () => {
  const { stop, http } = startServer(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  let p1: Awaited<ReturnType<typeof connect>> | undefined;
  let p2: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    [p1, p2] = await Promise.all([connect(url), connect(url)]);

    // Both authenticate then queue; the second queue triggers the pairing.
    await authQueue(p1, ["pyrrha", "jarrik", "gommar"], "e2e-alice", "sec-a", "Alice");
    await authQueue(p2, ["ando", "syl", "riverdaughter"], "e2e-bob", "sec-b", "Bob");

    const s1 = (await p1.wait("start")) as Extract<ServerMsg, { t: "start" }>;
    const s2 = (await p2.wait("start")) as Extract<ServerMsg, { t: "start" }>;
    assert.notEqual(s1.you, s2.you, "the two clients are on opposite sides");
    assert.ok(s1.state && s1.state.units, "the start message carries a full MatchState (round-tripped over the wire)");
    assert.equal(s1.opponentName, "Bob", "each side sees the opponent's name");
    assert.equal(s2.opponentName, "Alice");

    // Team A always takes the first turn; that player surrenders, so Team B must win by forfeit.
    const firstMover = s1.you === "A" ? p1 : p2;
    await firstMover.wait("yourTurn");
    firstMover.ws.send(JSON.stringify({ t: "surrender" }));

    const e1 = (await p1.wait("matchEnd")) as Extract<ServerMsg, { t: "matchEnd" }>;
    const e2 = (await p2.wait("matchEnd")) as Extract<ServerMsg, { t: "matchEnd" }>;
    assert.equal(e1.outcome.winner, e2.outcome.winner, "both clients agree on the winner");
    assert.equal(e1.outcome.winner, "B", "the surrendering first-mover (Team A) loses to Team B");
    assert.equal(e1.reason, "forfeit", "a surrender is a forfeit");
  } finally {
    p1?.ws.close();
    p2?.ws.close();
    stop();
  }
});

test("one identity can't hold two concurrent ranked queue entries (rating-clobber guard)", async () => {
  const { stop, http } = startServer(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  let a: Client | undefined;
  let b: Client | undefined;
  try {
    [a, b] = await Promise.all([connect(url), connect(url)]);
    // The SAME identity authenticates on two sockets and tries to queue ranked on both.
    await authQueue(a, ["pyrrha", "jarrik", "gommar"], "dup-id", "dup-sec", "Dup", true);
    await a.wait("queued");
    await authQueue(b, ["ando", "syl", "riverdaughter"], "dup-id", "dup-sec", "Dup", true);
    const err = (await b.wait("error")) as Extract<ServerMsg, { t: "error" }>;
    assert.match(err.message, /ranked/i, "the second ranked queue for the same id is refused");
  } finally {
    a?.ws.close();
    b?.ws.close();
    stop();
  }
});

test("the server rejects a malformed team", async () => {
  const { stop, http } = startServer(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  let p: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    p = await connect(`ws://127.0.0.1:${port}`);
    p.ws.send(JSON.stringify({ t: "auth", playerId: "e2e-mal", secret: "s", name: "Mal", protocolVersion: PROTOCOL_VERSION }));
    await p.wait("authed");
    p.ws.send(JSON.stringify({ t: "queue", team: ["pyrrha", "pyrrha", "pyrrha"], protocolVersion: PROTOCOL_VERSION })); // duplicates
    const err = (await p.wait("error")) as Extract<ServerMsg, { t: "error" }>;
    assert.match(err.message, /invalid team/i);
  } finally {
    p?.ws.close();
    stop();
  }
});

test("a completed match is recorded to both players' profiles (auth → play → record → /profile)", async () => {
  const { stop, http } = startServer(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  let p1: Client | undefined;
  let p2: Client | undefined;
  try {
    [p1, p2] = await Promise.all([connect(url), connect(url)]);
    await authQueue(p1, ["pyrrha", "jarrik", "gommar"], "rec-1", "s1", "Player One");
    await authQueue(p2, ["ando", "syl", "riverdaughter"], "rec-2", "s2", "Player Two");
    const s1 = (await p1.wait("start")) as Extract<ServerMsg, { t: "start" }>;
    await p2.wait("start");

    // Team A takes the first turn and surrenders — so Team A's player loses, the other wins.
    const firstMover = s1.you === "A" ? p1 : p2;
    await firstMover.wait("yourTurn");
    firstMover.ws.send(JSON.stringify({ t: "surrender" }));
    await Promise.all([p1.wait("matchEnd"), p2.wait("matchEnd")]);

    const loser = s1.you === "A" ? { id: "rec-1", sec: "s1", n: "Player One" } : { id: "rec-2", sec: "s2", n: "Player Two" };
    const winner = s1.you === "A" ? { id: "rec-2", sec: "s2", n: "Player Two" } : { id: "rec-1", sec: "s1", n: "Player One" };
    const loserProfile = await fetchProfile(port, loser.id, loser.sec, loser.n);
    const winnerProfile = await fetchProfile(port, winner.id, winner.sec, winner.n);
    assert.deepEqual([loserProfile.wins, loserProfile.losses], [0, 1], "the surrendering player has a recorded loss");
    assert.deepEqual([winnerProfile.wins, winnerProfile.losses], [1, 0], "the opponent has a recorded win");
    assert.equal(loserProfile.rating, START_RATING, "a casual result does NOT change rating");
    assert.equal(winnerProfile.rating, START_RATING);
  } finally {
    p1?.ws.close();
    p2?.ws.close();
    stop();
  }
});

test("a ranked match updates both players' Elo ratings and reports the change in matchEnd", async () => {
  const { stop, http } = startServer(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  let p1: Client | undefined;
  let p2: Client | undefined;
  try {
    [p1, p2] = await Promise.all([connect(url), connect(url)]);
    await authQueue(p1, ["pyrrha", "jarrik", "gommar"], "rank-1", "s1", "Ranked One", true);
    await authQueue(p2, ["ando", "syl", "riverdaughter"], "rank-2", "s2", "Ranked Two", true);
    const s1 = (await p1.wait("start")) as Extract<ServerMsg, { t: "start" }>;
    await p2.wait("start");

    const firstMover = s1.you === "A" ? p1 : p2; // Team A surrenders → loses
    await firstMover.wait("yourTurn");
    firstMover.ws.send(JSON.stringify({ t: "surrender" }));
    const e1 = (await p1.wait("matchEnd")) as Extract<ServerMsg, { t: "matchEnd" }>;
    const e2 = (await p2.wait("matchEnd")) as Extract<ServerMsg, { t: "matchEnd" }>;
    assert.ok(e1.rating && e2.rating, "a ranked matchEnd carries the rating change");
    assert.equal(e1.rating!.delta, -e2.rating!.delta, "the two deltas are equal and opposite (zero-sum)");

    const loser = s1.you === "A" ? { id: "rank-1", sec: "s1", n: "Ranked One" } : { id: "rank-2", sec: "s2", n: "Ranked Two" };
    const winner = s1.you === "A" ? { id: "rank-2", sec: "s2", n: "Ranked Two" } : { id: "rank-1", sec: "s1", n: "Ranked One" };
    const loserProfile = await fetchProfile(port, loser.id, loser.sec, loser.n);
    const winnerProfile = await fetchProfile(port, winner.id, winner.sec, winner.n);
    assert.ok(loserProfile.rating < START_RATING, "the loser's rating dropped");
    assert.ok(winnerProfile.rating > START_RATING, "the winner's rating rose");
    assert.equal(loserProfile.losses, 1);
    assert.equal(winnerProfile.wins, 1);
  } finally {
    p1?.ws.close();
    p2?.ws.close();
    stop();
  }
});
