/**
 * Integration tests for a server-authoritative Match, driven by scripted client doubles (no sockets).
 * A double implements MatchClient and reacts to the server's prompts on a microtask — because the match
 * sets `pendingTurn` synchronously right AFTER sending `yourTurn`, a reply must be deferred a tick, which
 * mirrors real async network delivery. Covers: a full match to a decision, turn timeout (auto-hold), and
 * a disconnect forfeit. Registers the native effect handlers the engine needs, exactly like the server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import "../engine/content/custom_effects.ts";
import "../engine/content/fusion_effects.ts";
import "../engine/content/augment_effects.ts";
import { defaultPolicy } from "../engine/content/match.ts";
import type { TeamId } from "../engine/src/types.ts";
import { Match, type MatchClient } from "./session.ts";
import type { ServerMsg } from "../net/protocol.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A scripted player: auto-attacks on its turn and skips drafts, unless `silent`. Records every message. */
class Double implements MatchClient {
  team: string[];
  side?: TeamId;
  pendingTurn?: MatchClient["pendingTurn"];
  pendingDraft?: MatchClient["pendingDraft"];
  match!: Match;
  messages: ServerMsg[] = [];
  silent = false; // when true, never replies (to exercise timeouts/forfeits)

  constructor(team: string[]) {
    this.team = team;
  }

  send(msg: ServerMsg): void {
    this.messages.push(msg);
    if (this.silent) return;
    // Reply on a microtask: the match sets pendingTurn AFTER this synchronous send returns.
    if (msg.t === "yourTurn") {
      const state = msg.state;
      queueMicrotask(() => this.match.handleMessage(this, { t: "turn", actions: defaultPolicy(state, this.side!) }));
    } else if (msg.t === "yourDraft") {
      queueMicrotask(() => this.match.handleMessage(this, { t: "draftChoice", choice: { kind: "skip" } }));
    }
  }

  got(t: ServerMsg["t"]): ServerMsg[] {
    return this.messages.filter((m) => m.t === t);
  }
  end(): Extract<ServerMsg, { t: "matchEnd" }> | undefined {
    return this.messages.find((m): m is Extract<ServerMsg, { t: "matchEnd" }> => m.t === "matchEnd");
  }
}

function pair(aTeam: string[], bTeam: string[], opts?: { turnMs?: number; draftMs?: number }) {
  const a = new Double(aTeam);
  const b = new Double(bTeam);
  const match = new Match(a, b, 12345, { turnMs: 40, draftMs: 40, ...opts });
  a.match = match;
  b.match = match;
  return { a, b, match };
}

test("a full Quick Match plays to a decisive winner and both players are told the same outcome", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"]);
  await match.run();

  // Both were told their side up front.
  assert.equal(a.got("start").length, 1, "A received start");
  assert.equal(b.got("start").length, 1, "B received start");
  const aStart = a.messages.find((m) => m.t === "start") as Extract<ServerMsg, { t: "start" }>;
  const bStart = b.messages.find((m) => m.t === "start") as Extract<ServerMsg, { t: "start" }>;
  assert.notEqual(aStart.you, bStart.you, "the two players are assigned opposite sides");

  // Each acted at least once (yourTurn prompts were delivered and answered).
  assert.ok(a.got("yourTurn").length > 0 && b.got("yourTurn").length > 0, "both sides took turns");

  const aEnd = a.end();
  const bEnd = b.end();
  assert.ok(aEnd && bEnd, "both players received matchEnd");
  assert.equal(aEnd!.reason, "decided", "the match ended by a best-of-N decision, not a forfeit");
  assert.notEqual(aEnd!.outcome.winner, null, "there is a decisive winner (no stalemate)");
  assert.equal(aEnd!.outcome.winner, bEnd!.outcome.winner, "both are told the same winning side");
  assert.equal(aEnd!.you, aStart.you, "each matchEnd carries that player's own side");
});

test("a silent player is auto-held every turn, and the active opponent wins", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"]);
  b.silent = true; // B never submits a turn — the server must auto-hold B's turns
  await match.run();

  const aEnd = a.end();
  assert.ok(aEnd, "the match still concludes despite B stalling");
  assert.equal(aEnd!.reason, "decided");
  const aSide = (a.messages.find((m) => m.t === "start") as Extract<ServerMsg, { t: "start" }>).you;
  assert.equal(aEnd!.outcome.winner, aSide, "the active player (A) beats the auto-held player (B)");
  assert.equal(b.got("turn" as ServerMsg["t"]).length, 0, "B never sent a turn (all its turns timed out)");
});

test("a disconnect mid-match forfeits to the surviving opponent", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"]);
  a.silent = true; // park the match awaiting A's first turn
  const running = match.run();
  await tick(); // let provideTurn(A) install A's pendingTurn
  match.onDisconnect(a); // A's socket dropped
  await running;

  const bEnd = b.end();
  assert.ok(bEnd, "the survivor is notified");
  assert.equal(bEnd!.reason, "opponent-left", "the reason is a forfeit");
  const bSide = (b.messages.find((m) => m.t === "start") as Extract<ServerMsg, { t: "start" }>).you;
  assert.equal(bEnd!.outcome.winner, bSide, "the surviving player wins");
});

test("a surrender hands the win to the opponent", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"]);
  a.silent = true;
  const running = match.run();
  await tick();
  match.handleMessage(a, { t: "surrender" }); // A concedes
  await running;

  const aEnd = a.end();
  const bEnd = b.end();
  assert.ok(aEnd && bEnd, "both are notified of the surrender outcome");
  const bSide = (b.messages.find((m) => m.t === "start") as Extract<ServerMsg, { t: "start" }>).you;
  assert.equal(bEnd!.outcome.winner, bSide, "the opponent of the surrendering player wins");
  assert.equal(aEnd!.you !== bEnd!.you, true, "each side is told its own perspective");
});
