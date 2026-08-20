/**
 * The server projects a per-seat view: each state-bearing message is built by wireState(viewer), which runs
 * redactState so a client never receives the opponent's Invisible effects. This drives the real Match with a
 * message-recording double, injects an Invisible status into the authoritative state, and asserts the two
 * seats receive DIFFERENT states — the owner keeps it, the opponent never sees it — while the server's own
 * authoritative copy is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import "../engine/content/custom_effects.ts";
import "../engine/content/fusion_effects.ts";
import "../engine/content/augment_effects.ts";
import type { MatchState, TeamId } from "../engine/src/types.ts";
import { Match, type MatchClient } from "./session.ts";
import type { ServerMsg } from "../net/protocol.ts";

class Recorder implements MatchClient {
  team: string[];
  side?: TeamId;
  messages: ServerMsg[] = [];
  constructor(team: string[]) { this.team = team; }
  send(msg: ServerMsg): void { this.messages.push(msg); }
  lastState(t: ServerMsg["t"]): MatchState | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && m.t === t && "state" in m) return (m as { state: MatchState }).state;
    }
    return undefined;
  }
}

test("wireState redacts per seat — a team's Invisible status is hidden from the opponent, kept for the owner", () => {
  const a = new Recorder(["pyrrha", "jarrik", "gommar"]);
  const b = new Recorder(["ando", "syl", "riverdaughter"]);
  const match = new Match(a, b, 12345);

  // Reach into the authoritative state and give one of A's own heroes an Invisible mark.
  const st = (match as unknown as { state: MatchState }).state;
  const aSide = a.side!; // assigned by the Match constructor's coin flip
  const aUnit = st.teams[aSide].units[0]!;
  st.units[aUnit]!.statuses.push({ kind: "mark", name: "Ghost Ward", duration: null, appliedBy: aUnit, appliedTurn: 0, invisible: true });

  // A `resumed` broadcast to each seat is built by wireState(seat.side) — the redaction seam.
  match.onSeatReconnect(a);
  match.onSeatReconnect(b);

  const aSeen = a.lastState("resumed")!;
  const bSeen = b.lastState("resumed")!;
  const hasWard = (s: MatchState): boolean => s.units[aUnit]!.statuses.some((x) => x.name === "Ghost Ward");

  assert.ok(hasWard(aSeen), "the owner (A) receives its own Invisible status");
  assert.ok(!hasWard(bSeen), "the opponent (B) does NOT receive A's Invisible status");
  assert.ok(st.units[aUnit]!.statuses.some((x) => x.name === "Ghost Ward"), "the server's authoritative state still holds it (redaction is a copy)");
});
