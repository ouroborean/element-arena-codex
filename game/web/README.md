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
you bottom); each of your heroes carries its skill icons — **click a skill** to see its detail
**in the midbar** (name, cost, what it does) and highlight the portraits it can hit. The panel
lives between the lanes so it never covers a target. **Every skill requires clicking a target**
(even self/auto ones highlight and confirm on click). Active **effects** appear as small
skill-art icons on a portrait — the art of the skill/passive that applied them — hover (or tap)
one for a description of what it's doing.
The left panel is your shared **energy pool**; **Surrender** concedes. The AI uses
`defaultPolicy`. First to 2 rounds wins; between rounds each team auto-drafts (draft UI TBD).

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
- `src/assets.ts` — portrait / skill-icon / minion-art URLs + a per-element colour.
- `src/skilltext.generated.ts` — skill id → {name, description} (from `frozen/skills.json`).
- `src/statussource.generated.ts` — status name → the skill/passive that applies it (for
  *named* effects, whatever path applied them).
- `src/skillicon.generated.ts` — skill id → icon path, from `frozen/skills.json`'s `image`
  field. Resolves hero **and** minion skill art in one map (the image field carries the
  irregular minion filenames); `assets.ts` `iconOf()` falls back to the hero-folder path.
- `src/minionart.generated.ts` — minion name → portrait art (from `frozen/minions.json`'s
  `image` field, which resolves the irregular minion-asset filenames).

Effect-source resolution (`view.ts` `statusSource`) is most-precise-first: a named status →
`statussource.generated`; else the engine-stamped `sourceId` (skill-cast provenance — the engine
now records which skill applied each status); else a scoped cost/cooldown mod's `skillId`; else
the applier's passive, so an effect is always at least hero-correct (no bare lettered chips).
Regenerate the maps with `python game/web/tools/gen_skillicon.py` after art/skill changes.

Reuses the engine + `game/client/{loop,draft}.ts`. `render.ts` in the terminal client is
ANSI-specific; the browser has its own `view.ts`.
