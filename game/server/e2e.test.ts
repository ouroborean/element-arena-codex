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
import { startServer } from "./index.ts";
import { PROTOCOL_VERSION, type ServerMsg } from "../net/protocol.ts";

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

    // Both queue with valid teams; the second one triggers the pairing.
    p1.ws.send(JSON.stringify({ t: "queue", team: ["pyrrha", "jarrik", "gommar"], protocolVersion: PROTOCOL_VERSION }));
    p2.ws.send(JSON.stringify({ t: "queue", team: ["ando", "syl", "riverdaughter"], protocolVersion: PROTOCOL_VERSION }));

    const s1 = (await p1.wait("start")) as Extract<ServerMsg, { t: "start" }>;
    const s2 = (await p2.wait("start")) as Extract<ServerMsg, { t: "start" }>;
    assert.notEqual(s1.you, s2.you, "the two clients are on opposite sides");
    assert.ok(s1.state && s1.state.units, "the start message carries a full MatchState (round-tripped over the wire)");

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

test("the server rejects a malformed team", async () => {
  const { stop, http } = startServer(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  let p: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    p = await connect(`ws://127.0.0.1:${port}`);
    p.ws.send(JSON.stringify({ t: "queue", team: ["pyrrha", "pyrrha", "pyrrha"], protocolVersion: PROTOCOL_VERSION })); // duplicates
    const err = (await p.wait("error")) as Extract<ServerMsg, { t: "error" }>;
    assert.match(err.message, /invalid team/i);
  } finally {
    p?.ws.close();
    stop();
  }
});
