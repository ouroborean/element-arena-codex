# Element Arena — Codex (interactive explorer)

A dependency-free, offline web app for browsing the extracted game database:
heroes, their base skills, every fusion form and its skills, augments,
masteries, elements, the fusion recipe table, and minions.

## Open it

**Easiest — double-click `index.html`.** The database is bundled into
`app/db.js`, so it works straight off disk (no server needed). Images load
from `assets/` next to `index.html`.

**Or serve it** (freshest data, avoids any browser file:// quirks):

```bash
python -m http.server 8000
```

then open <http://localhost:8000/>. When served, the app reads the bundle if
present, otherwise `output/database.json` directly.

## Refreshing after a re-export

```bash
python extract_database.py     # re-export the game data (as before)
python build_data.py           # rebundle app/db.js + reindex assets/
```

## What you can do

| Page | What it shows |
|------|---------------|
| **Roster** | All 28 heroes; filter by element, fuseable / starts-fused / bot, or text |
| **Hero** | Full portrait, element, HP, titles, tabs for base skills, **fusion forms**, augments, minions |
| **Fusion form** | One hero's fusion element: the recipe that produces it, the full fusion-form portrait, and its passive + active |
| **Fusion Lab** | Pick **two teammates** → the fusion element they'd share and each hero's fusion kit for it, side by side |
| **Skills** | All 622 abilities; filter by element, kind (base/fusion/variant/minion), class, targeting, active/passive; full-text search |
| **Elements** | Interactive 10×10 recipe matrix + base / fusion element cards; per-element page lists heroes, fusers and skills |
| **Minions** | Summoned units grouped by summoner, with best-effort HP |

Global search (top-right, or press `/`) jumps to any hero, skill, augment,
element or minion. Element chips and cross-links are clickable everywhere.

## Notes on the data

- **Base HP is a uniform 100** for every hero (a class default, not per-record).
- **Damage / heal numbers are not fields** — they live in each skill's
  `description` text (the canonical human-readable value); the raw math is in
  GDScript, deliberately not scraped.
- **Augment ids reuse skill id strings** (e.g. `ando2`), but they are separate
  records — the app keeps them distinct.
- Minion HP is heuristically recovered from spawn code; some are `dynamic`.

## Files

```
index.html            the app shell
app/styles.css        theme + layout
app/app.js            all views + router + search (vanilla JS, no libraries)
app/db.js             AUTO-GENERATED bundle (database + asset index)
build_data.py         regenerates app/db.js from output/database.json
output/*.json         the extracted database (unchanged)
assets/               images (unchanged)
```
