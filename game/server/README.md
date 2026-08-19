# Element Arena — Quick Match server

An **authoritative** match server for PvP "Quick Match". It matchmakes two players from a FIFO queue,
then runs the **real engine** between them: it owns the RNG seed, validates every move through
`performAction`, and broadcasts the full `MatchState` after each phase. Clients never simulate the match —
they submit their own turn / draft choice and render the state the server sends.

Dependency-free (a hand-rolled RFC 6455 WebSocket in `ws.ts`), so it runs on a bare `node` like the engine.

## Run

```bash
node game/server/index.ts        # listens on :8790 (override with ARENA_PORT)
```

Player profiles persist to a SQLite file (`arena.db` in the cwd by default; override with `ARENA_DB`, or
`:memory:` for an ephemeral store). It uses the built-in `node:sqlite` — no dependency, no flag.

Then open the web client (served from the repo root, see `game/web/README.md`) and press **Quick Match**
with a full team of 3. The client dials `ws://<page-host>:8790` by default; override with
`?server=wss://host` on the page URL or `localStorage.arenaServer`.

## Shape

```
client --WS--> [ FIFO queue ] --pair--> [ Match: authoritative engine ] --state--> both clients
```

- `ws.ts` — dependency-free WebSocket transport (handshake + frame codec; unit-tested in `ws.test.ts`).
- `session.ts` — one `Match`: drives `client/loop.ts` `runMatch` with network-backed turn/draft providers;
  server-assigned seed + first-move coin flip; turn timeout → auto-hold; between-round draft (loser first)
  → autoDraft on timeout; surrender / disconnect → forfeit. Talks to an abstract `MatchClient`, so it is
  tested with scripted doubles (no sockets).
- `index.ts` — HTTP + WS entry, the matchmaking queue, team validation, a heartbeat, and the `POST /profile`
  endpoint.
- `accounts.ts` — the SQLite guest-identity store (create-or-verify, win/loss record, rating).
- `../net/protocol.ts` — the shared wire protocol (imported by both this server and the browser client).

## Accounts (guest identity)

Each player holds a client-generated `{playerId, secret}` (in `localStorage`). Trust-on-first-use: the first
`auth` for an id creates a profile bound to a scrypt hash of its secret; later calls verify it. Profiles hold
a display name, a W/L/D record, and a `rating` (seeded 1000) that anchors future Ranked. The match server
records each result to both players; the team-select screen reads a profile over `POST /profile`.

## Test

```bash
cd game/server
npm test          # node --test — codec, Match integration, and a real-TCP end-to-end
npm run typecheck # tsc --noEmit
```

## Reconnection

A player's **seat** in a match outlives any single socket. When a socket drops, the match isn't forfeited
immediately — it opens a **grace window** (`RECONNECT_GRACE_MS`, 45s) and tells the opponent. A new socket
that presents the seat's `rejoin` token (`{matchId, token}`, both handed to the client in `start`) rebinds
the seat and is `resumed` at the live state; only if nobody returns before the window closes does it forfeit.
The web client stores the token in `sessionStorage`, so even a full page reload rejoins automatically.

## Scope (MVP)

Quick Match: queue → team reveal → alternating turns → between-round draft → win/forfeit, plus turn timeout,
disconnect handling, **reconnection**, and **guest accounts** (name + persisted record). Ranked/MMR is next
(the `rating` column is in place). Anti-cheat
covers the two things a client controls — the seed is server-held (RNG can't be precomputed) and every
action is validated by the same engine the UI uses (illegal moves are rejected). Hidden-info redaction is a
no-op today because the engine has no visibility primitive (invisible statuses are display-only).
