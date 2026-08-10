# Anima Arena — data export

Scripts that extract the game's data out of the Godot project (`.tscn` / `.tres`
/ `.gd` source) into a clean, engine-independent JSON database. Nothing here
imports Godot or any game code — it reads the source files as text — so it is
safe to run against the live project and safe to keep using after the rewrite
begins.

## Run

```bash
python data_export/extract_database.py      # build the JSON database
python data_export/copy_assets.py           # copy the image assets (see below)
```

Outputs land in `data_export/output/`:

| File | Contents |
|------|----------|
| `database.json` | Everything, plus a `_meta` block (counts, warnings, info notes) |
| `elements.json` | Element enum + fusion recipes |
| `fusion_recipes.json` | Just the `base_a × base_b → result` table |
| `characters.json` | Roster + character records |
| `skills.json` | All 600+ ability records |
| `augments.json` | Augment records |
| `masteries.json` | Per-character mastery tuning |
| `minions.json` | Minion records (with best-effort HP) |
| `asset_manifest.json` | Which image file backs each record + copy stats |

See [`SCHEMA.md`](SCHEMA.md) for the shape of every record.

## Assets

`copy_assets.py` mirrors `assets/characters/` (character portraits, per-skill
ability icons, fusion-form art, and minion art) into `data_export/assets/`,
**dropping every Godot `.import` sidecar**. The directory structure is preserved,
so the `image` paths in the JSON (e.g. `assets/characters/gaia/gaia2.png`)
resolve directly when the web app is rooted at `data_export/`.

* ~1100 PNGs (~130 MB); every `image` referenced by the database is guaranteed
  present (the script fails loudly if any ref is missing).
* Portraits / fusion-form art that the game loads dynamically (not via a `.tscn`
  `image` field) are copied too, and listed under
  `asset_manifest.json → images_not_referenced_by_db`.
* `--referenced-only` copies just the images the database points at, if you want
  the smaller set.

## How it works

| Module | Responsibility |
|--------|----------------|
| `godot_parser.py` | A real recursive-descent parser for the `.tscn` / `.tres` text format. Turns a scene file into `{ext_resources, properties}`, resolving `ExtResource("id")` refs to paths and parsing multi-line dictionaries (`cost`, `classes`). **No per-field regex.** |
| `elements.py` | Reads `components/types/element.gd` — the `Element.Type` enum, base-element colours, and the `hybrids()` fusion table. |
| `metadata.py` | Reads `components/character/character_database.gd` — roster order, bot list, fusion/augment eligibility, and the title word-banks. |
| `extract_database.py` | Orchestrates all of the above into the JSON database and runs consistency checks. |

## Data provenance & known gaps

Almost all data is **canonical** — it comes straight from the `.tscn`/`.tres`
files (costs, cooldowns, classes, descriptions, elements, targeting, images) or
from the two authoritative `.gd` registries (elements, roster).

Two things are **not** cleanly stored as data in the Godot project, and are
handled explicitly rather than silently:

1. **Skill damage / heal numbers** live inside each skill's `.gd` `execute()`
   logic, not as fields. The human-readable values are in each skill's
   `description`. We do **not** scrape numbers out of GDScript logic — that is a
   rewrite concern, not a data-extraction one.
2. **Minion base HP** is assigned in the summoner's GDScript spawn code, not in
   the minion `.tscn`. We recover it with a best-effort text scan and tag every
   value `hp_source: "gd-heuristic"`. Minions whose HP is a runtime expression
   (e.g. Gaia's Fury inherits the summoner's HP) are tagged `hp_source:
   "dynamic"` with `base_hp: null`.

Character **base HP is a uniform 100** — it is a default on the `Character`
class, not per-character data, so it is documented here rather than duplicated
onto every record.

Every anomaly the extractor notices is recorded in `database.json` →
`_meta.warnings` (real problems, currently 0) and `_meta.info` (benign notes:
variant skills, dynamic-HP minions).
