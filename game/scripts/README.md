# Element Arena — local dev/test scripts

Runnable scripts for standing up the **Quick Match server** locally. No build step — they run on bare
Node 24+ (native `.ts` + global `WebSocket`), like the rest of the repo.

## `local-pvp-web.ts` — manual PvP: two real web clients you drive yourself

The one for hands-on testing. It starts the match server **and** a static web host, then opens **two browser
windows of the real web client** — one per side — so you can navigate the menus and pick skills/targets
yourself. Each window gets its own guest identity via `?player=1` / `?player=2`, so pressing **Quick Match**
in both (with a full 3-hero team) pairs them against each other.

```bash
node game/scripts/local-pvp-web.ts
```

- Serves the client from the **repo root** (so its `../../assets/…` portraits/icons resolve) at
  `http://localhost:8000/game/web/`.
- Opens `…/game/web/?player=1` and `…/game/web/?player=2`. Two tabs in one browser normally share a guest
  identity — and the server never self-pairs one identity — so the `?player=` override gives each window a
  **distinct** identity (`local-1`, `local-2`) that will pair.
- Stays running so you can play; **Ctrl+C** stops the server + web host. The account store is in-memory, so
  records/ratings reset when you stop it.

Flags: `--serverPort` (8790), `--webPort` (8000), `--no-open` (print the URLs instead of launching a
browser), `--browser=<cmd>` (force a specific browser). If you change `--serverPort`, the URLs get a matching
`&server=ws://localhost:<port>` automatically.

> The `?player=<key>` override is a small local-testing hook in the web client (`game/web/src/main.ts`,
> `identity()`): with the param present the window uses a deterministic guest identity and does **not** touch
> the normal persisted `arenaIdentity`. Any two different keys work (`?player=alice`, `?player=bob`, …).

## `local-pvp.ts` — automated bot-vs-bot smoke test (no browser)

Starts the server, launches two **headless bot clients** that get matched and play a full match with the
engine's own AI (`defaultPolicy` for turns, `autoDraft` for the between-round upgrade), then reports
**PASS/FAIL**. Good for a quick "is the netcode healthy" check in one command.

```bash
node game/scripts/local-pvp.ts                 # casual, port 8790, two preset teams
node game/scripts/local-pvp.ts --ranked        # ranked queue (exercises the Elo path)
node game/scripts/local-pvp.ts --port=8899 --teamA=pyrrha,jarrik,gommar --teamB=ando,syl,riverdaughter
```

Exit code `0` only if both clients reached a clean `matchEnd`; a safety net aborts after `--timeoutMs`
(default 180s). In-memory account store, so nothing is written to disk.

## `bot-client.ts` — a standalone headless client

The client `local-pvp.ts` launches, usable on its own against **any** running server — e.g. drop a bot
opponent into a server you're testing by hand:

```bash
node game/server/index.ts &                                  # start the server first
node game/scripts/bot-client.ts --name=Bot --team=ando,syl,riverdaughter
```

Flags: `--server` (default `ws://127.0.0.1:8790`), `--name`, `--team` (comma-separated hero ids), `--ranked`,
`--id` / `--secret` (guest identity; default derived from the name), `--idleMs` (give up if the server goes
quiet, default 90s).

## npm scripts (from this directory)

```bash
npm run web          # node local-pvp-web.ts   (manual two-client PvP)
npm run pvp          # node local-pvp.ts        (bot-vs-bot smoke test)
npm run bot          # node bot-client.ts       (one standalone bot)
npm run typecheck    # tsc --noEmit against scripts/tsconfig.json
```

## Notes

- `game/client/cli.ts` is a separate single-player terminal client (vs the built-in AI); it does **not** talk
  to the server. The networked interactive client is the browser one under `game/web/`.
- The bots play with `defaultPolicy` and omit `genericPay`, so the server auto-allocates generic energy for
  them (they don't optimise multi-colour payment the way the web UI lets a human do).
