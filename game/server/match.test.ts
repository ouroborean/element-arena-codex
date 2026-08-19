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
import { Match, filterTurnActions, type MatchClient } from "./session.ts";
import type { ServerMsg } from "../net/protocol.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Ordered record of which side was prompted to draft first (shared across a pair's two doubles). */
interface DraftEvent { side: TeamId; myRoundsWon: number; oppRoundsWon: number; }

/** A scripted player: auto-attacks on its turn and skips drafts, unless `silent`. Records every message. */
class Double implements MatchClient {
  team: string[];
  side?: TeamId;
  pendingTurn?: MatchClient["pendingTurn"];
  pendingDraft?: MatchClient["pendingDraft"];
  match!: Match;
  messages: ServerMsg[] = [];
  silent = false; // when true, never replies (to exercise timeouts/forfeits)
  disconnected = false; // when true, sends are dropped and no replies happen (simulates a dead socket)
  draftLog: DraftEvent[] = []; // shared array (set by pair()) recording yourDraft order across both doubles

  constructor(team: string[]) {
    this.team = team;
  }

  send(msg: ServerMsg): void {
    if (this.disconnected) return; // a dropped socket receives nothing (mirrors seat.conn === null)
    this.messages.push(msg);
    if (msg.t === "yourDraft") {
      const rw = msg.state.teams;
      this.draftLog.push({ side: this.side!, myRoundsWon: rw[this.side!].roundsWon, oppRoundsWon: rw[this.side! === "A" ? "B" : "A"].roundsWon });
    }
    if (this.silent) return;
    // Reply on a microtask: the match sets pendingTurn AFTER this synchronous send returns.
    if (msg.t === "yourTurn" || (msg.t === "resumed" && msg.control === "turn")) {
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

function pair(aTeam: string[], bTeam: string[], opts?: { turnMs?: number; draftMs?: number; graceMs?: number }) {
  const a = new Double(aTeam);
  const b = new Double(bTeam);
  const draftLog: DraftEvent[] = [];
  a.draftLog = b.draftLog = draftLog; // shared, so first-to-draft ordering is observable across both
  const match = new Match(a, b, 12345, { turnMs: 40, draftMs: 40, graceMs: 5000, ...opts });
  a.match = match;
  b.match = match;
  return { a, b, match, draftLog };
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

test("a disconnect that outlasts the grace window forfeits to the surviving opponent", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"], { graceMs: 30 });
  a.silent = true; // park the match awaiting A's first turn
  const running = match.run();
  await tick(); // let provideTurn(A) install A's pendingTurn
  a.disconnected = true;
  match.onSeatDisconnect(a); // A's socket dropped
  assert.ok(b.messages.some((m) => m.t === "opponentDisconnected"), "B is told the grace window has opened");
  await tick(60); // exceed the 30ms grace window with no reconnect
  await running;

  const bEnd = b.end();
  assert.ok(bEnd, "the survivor is notified");
  assert.equal(bEnd!.reason, "opponent-left", "an un-recovered drop forfeits");
  const bSide = (b.messages.find((m) => m.t === "start") as Extract<ServerMsg, { t: "start" }>).you;
  assert.equal(bEnd!.outcome.winner, bSide, "the surviving player wins");
});

test("a disconnected player can reconnect within the grace window and resume — no forfeit", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"], { graceMs: 5000 });
  a.silent = true; // park the match at A's turn so it doesn't finish before the drop
  const running = match.run();
  await tick(); // reach A's turn
  a.disconnected = true;
  match.onSeatDisconnect(a); // A drops mid-match
  assert.ok(b.messages.some((m) => m.t === "opponentDisconnected"), "B is told A dropped");
  const beforeResume = a.messages.length;
  a.disconnected = false;
  a.silent = false; // A comes back ready to play again
  match.onSeatReconnect(a); // ...within the grace window
  const resumed = a.messages.slice(beforeResume).find((m) => m.t === "resumed") as Extract<ServerMsg, { t: "resumed" }> | undefined;
  assert.ok(resumed, "A is resumed at the live state");
  assert.equal(resumed!.control, "turn", "and told it is A's turn to act");
  assert.equal(resumed!.opponentDisconnected, false, "and told the opponent is present");
  assert.ok(b.messages.some((m) => m.t === "opponentReconnected"), "B is told A is back");
  await running;
  const aEnd = a.end();
  assert.ok(aEnd, "the match still concludes");
  assert.equal(aEnd!.reason, "decided", "it finished by a normal decision, not a forfeit");
});

test("a redundant rejoin on a still-connected seat refreshes state without spamming the opponent", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"], { graceMs: 5000 });
  a.silent = true; // park the match at A's turn
  const running = match.run();
  await tick();
  const bReconnectsBefore = b.messages.filter((m) => m.t === "opponentReconnected").length;
  const aResumedBefore = a.messages.filter((m) => m.t === "resumed").length;
  match.onSeatReconnect(a); // A never disconnected — a redundant/abusive rejoin
  assert.equal(a.messages.filter((m) => m.t === "resumed").length, aResumedBefore + 1, "A still gets a state refresh");
  assert.equal(b.messages.filter((m) => m.t === "opponentReconnected").length, bReconnectsBefore, "the opponent is NOT notified (nobody actually reconnected)");
  match.handleMessage(b, { t: "surrender" }); // end the match cleanly
  await running;
});

test("reconnecting while the opponent is also offline resumes with the opponent-disconnected flag set", async () => {
  const { a, b, match } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"], { graceMs: 30 });
  a.silent = true; // park at A's turn (A stays silent so it won't auto-play on resume)
  const running = match.run();
  await tick();
  a.disconnected = true; match.onSeatDisconnect(a);
  b.disconnected = true; match.onSeatDisconnect(b); // both offline
  const before = a.messages.length;
  a.disconnected = false; match.onSeatReconnect(a); // A returns while B is still gone
  const resumed = a.messages.slice(before).find((m) => m.t === "resumed") as Extract<ServerMsg, { t: "resumed" }> | undefined;
  assert.ok(resumed, "A is resumed");
  assert.equal(resumed!.opponentDisconnected, true, "and told the opponent is still offline");
  await tick(60); // B's 30ms grace expires with no reconnect → forfeit to A
  await running;
  assert.equal(a.end()!.reason, "opponent-left", "B not returning forfeits to A");
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
  assert.equal(bEnd!.reason, "forfeit", "a surrender is reported as a forfeit, not an opponent-left");
  assert.equal(aEnd!.you !== bEnd!.you, true, "each side is told its own perspective");
});

test("filterTurnActions keeps only the active side's own units, one action each", () => {
  const units = { a1: { team: "A" }, a2: { team: "A" }, b1: { team: "B" } } as const;
  const submitted = [
    { unit: "b1", skillId: "x" }, // an OPPONENT unit — must be dropped
    { unit: "a1", skillId: "s1", targets: ["b1"] },
    { unit: "a1", skillId: "s2" }, // a SECOND action for a1 — must be dropped (one per unit)
    { unit: "ghost", skillId: "z" }, // an unknown unit — dropped
    { unit: "a2", skillId: "s3" },
  ];
  const kept = filterTurnActions(submitted, "A", units);
  assert.deepEqual(kept.map((a) => a.unit), ["a1", "a2"], "opponent, duplicate, and unknown units are filtered out");
  assert.equal(kept[0]!.skillId, "s1", "the FIRST action for a unit is the one kept");
});

test("the round LOSER drafts first between rounds", async () => {
  // Two aggressive teams that both have fusion options at round 2, so a real draft phase occurs.
  const { match, draftLog } = pair(["pyrrha", "jarrik", "gommar"], ["ando", "syl", "riverdaughter"]);
  await match.run();
  assert.ok(draftLog.length >= 2, "a between-round draft happened (both sides prompted)");
  const first = draftLog[0]!;
  assert.ok(first.myRoundsWon < first.oppRoundsWon, "the side prompted first has fewer round wins — i.e. the loser drafts first");
});
