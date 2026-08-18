# Element Arena — web client

A browser client for the engine. Unlike the terminal client, the browser can't run
the engine's TypeScript directly, so it's **bundled** with esbuild into `dist/app.js`
(the engine itself stays Node-native / zero-build). The bundle is committed so the page
works when served statically (like `app/db.js` in the reference explorer).

## Play

```bash
cd game/web && python -m http.server 8000   # then open http://localhost:8000/
```

Start on the **team-select** screen: pick 3 heroes from the roster; the AI's team is
shown and re-rollable. Then in battle, click one of your heroes → pick a skill → pick a
target (enemies glow); leave a hero unpicked to hold it, then **Resolve turn**. The AI
opponent uses the engine's `defaultPolicy`. First to 2 rounds wins. Between rounds each
team currently auto-drafts an upgrade (an interactive draft UI is the next increment).

## Build

```bash
cd game/web
npm install          # esbuild (dev-only; not shipped)
npm run build        # -> dist/app.js   (rebuild after changing src/)
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
```

## Layout

- `index.html` / `styles.css` — the page shell + styling.
- `src/main.ts` — app: builds a match, drives the engine's async loop (`../client/loop.ts`),
  resolves the human turn from board clicks, AI from `defaultPolicy`.
- `src/view.ts` — pure DOM rendering: the team-select screen (`renderSetup`) and the board / skills / log (`renderApp`) from `(MatchState, UiState)`.

Reuses the engine + `game/client/{loop,draft}.ts`. `render.ts` in the terminal client is
ANSI-specific; the browser has its own `view.ts`.
