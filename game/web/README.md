# Element Arena — web client

A browser client for the engine. Unlike the terminal client, the browser can't run
the engine's TypeScript directly, so it's **bundled** with esbuild into `dist/app.js`
(the engine itself stays Node-native / zero-build). The bundle is committed so the page
works when served statically (like `app/db.js` in the reference explorer).

Character portraits and skill icons come from the committed art under `assets/characters/`,
referenced as `../../assets/…`, so the page must be **served from the repo root** (not from
`game/web/`) — which is also how GitHub Pages serves it.

## Play

```bash
python -m http.server 8000     # run from the REPO ROOT, then open
                               # http://localhost:8000/game/web/
```

Start on the **team-select** screen: a portrait grid of all 27 heroes — click one to view
its passive + skills (icons + descriptions), then **Add to team** (pick 3). The AI's team is
shown and re-rollable. In battle, the board shows both teams as portrait cards (enemies top,
you bottom); each of your heroes carries its skill icons — click a skill (unusable ones are
dimmed), pick a target if it needs one (enemies glow), then **Resolve turn**. The left panel
is your shared **energy pool**; **Surrender** concedes. The AI uses `defaultPolicy`. First to
2 rounds wins; between rounds each team auto-drafts an upgrade (interactive draft UI TBD).

## Build

```bash
cd game/web
npm install          # esbuild (dev-only; not shipped)
npm run build        # -> dist/app.js   (rebuild after changing src/)
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
```

## Layout

- `index.html` / `styles.css` — the page shell + styling (portrait-card board).
- `src/main.ts` — app: builds a match, drives the engine's async loop (`../client/loop.ts`),
  resolves the human turn from board clicks, AI from `defaultPolicy`.
- `src/view.ts` — pure DOM rendering: `renderSetup` (portrait grid + skill viewer) and
  `renderApp` (the two-lane board, skill tiles, energy pool) from `(MatchState, UiState)`.
- `src/assets.ts` — portrait / skill-icon URLs + a per-element colour.
- `src/skilltext.generated.ts` — skill id → {name, description}, generated from
  `content/frozen/skills.json` (the engine carries no prose; this is display-only).

Reuses the engine + `game/client/{loop,draft}.ts`. `render.ts` in the terminal client is
ANSI-specific; the browser has its own `view.ts`.
