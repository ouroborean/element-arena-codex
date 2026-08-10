# Database schema

`database.json` is the full export. It has a `_meta` block plus seven data
collections, each also written as a standalone file. Records cross-reference by
string `id`. All `image` / `source_file` paths are repo-relative (the `res://`
prefix is stripped).

```
database.json
├── _meta            { generator, counts, roster, warnings, info, notes }
├── elements[]       the 66-member Element.Type enum
├── fusion_recipes[] base_a × base_b → result
├── characters[]     28 records (27 roster + darkness)
├── skills[]         622 ability records
├── augments[]       140 augment records
├── masteries[]      135 mastery-tuning records
└── minions[]        38 minion records
```

An **element reference** appears wherever a thing has an element:

```json
"element": { "id": 6, "name": "earth", "display_name": "Earth" }
```

If a `.tscn` omits the `element` property, Godot leaves the typed
`@export var element: Element.Type` at its enum default — the first member,
**Fire (0)** — so the export resolves to Fire at runtime. Those references carry
`"defaulted": true` (same convention as `targeting_type`), e.g. Pyrrha and
Jarrik (both Fire) and their base skills. Every defaulted element is also listed
in `_meta.info`.

---

## elements[]

```json
{
  "id": 6,                     // == Element.Type enum index
  "name": "earth",             // lowercase enum key
  "enum": "EARTH",             // raw enum key
  "display_name": "Earth",
  "is_base": true,             // ids 0-9
  "is_fusion": false,          // ids 10-64
  "is_generic": false,         // id 65 (the "any/colourless" energy type)
  "color": "#4a2f1c",          // base elements only (major panel colour)
  "components": [              // fusion elements only
    { "a": 6, "b": 8, "a_name": "earth", "b_name": "unholy" }
  ]
}
```

The 10 base elements are `fire, ice, water, lightning, wind, poison, earth,
holy, unholy, shadow`. `generic` (id 65) is the wildcard energy type used in
skill costs.

## fusion_recipes[]

The full `base × base → fusion` table (55 unique unordered pairs; fusion is
symmetric, `a ≤ b`).

```json
{ "a": 0, "b": 2, "a_name": "fire", "b_name": "water", "result": 11, "result_name": "alchemy" }
```

## characters[]

```json
{
  "id": "gaia",
  "path_name": "gaia",
  "character_name": "Gaia Worldsoul",   // from the .tscn
  "short_name": "Gaia",                 // from character_name_from_path(); may be null
  "element": { "id": 6, "name": "earth", "display_name": "Earth" },
  "starts_fused": false,                // element id >= 10
  "can_fuse": true,                     // base element AND not in no_fusion_characters
  "can_augment": true,
  "in_roster": true,                    // present in the active roster list
  "roster_index": 12,                   // display order; null if not in roster
  "is_bot": true,
  "titles": { "minor": [...], "middle": [...], "major": [...] },  // flavour word-banks
  "image": "assets/characters/gaia/gaiaprof.png",
  "base_skill_ids": ["gaia0", ... "gaia5"],   // ordered by slot; slot 0 = passive
  "fusion_skills": {                          // one entry per fuseable element
    "grave": { "passive": "gaiagrave0", "active": "gaiagrave1" },
    ...
  },
  "augment_ids": ["gaia1", ... "gaia5"],
  "mastery_multipliers": { "attacker": 0.4, "defender": 0.6, ... },
  "resource_extras": { ... },           // only if a .tres exists (ando, ayana)
  "source_file": "characters/gaia.tscn"
}
```

Notes:
* **Base HP is a uniform 100** for every character (a `Character` class default,
  not per-character data) — so it is not repeated on each record.
* A base-element character has 6 base skills (`0`–`5`); a default-fusion
  character has 7 (`0`–`6`); `trinity` has 4. Fuseable characters additionally
  have one `{passive, active}` fusion pair for each of the 10 elements their base
  combines with.

## skills[]

```json
{
  "id": "gaia2",
  "owner": "gaia",
  "name": "Worldfist",
  "element": { "id": 6, "name": "earth", "display_name": "Earth" },
  "description": "Deals 10 damage to one enemy, increased by 5 ...",
  "cost": { "generic": 0, "specific": 1 },   // GENERIC = any energy, SPECIFIC = this element
  "cooldown": 0,
  "targeting_type": { "id": 0, "name": "single", "defaulted": true },
  "is_passive": false,
  "hidden": false,
  "hidden_targets": false,
  "priority": 100,                          // bot AI hint
  "classes": { "Harmful": true, "Helpful": false, ... },   // full 11-key map
  "classes_active": ["Harmful", "Instant"],                // convenience: the true ones
  "is_minion_skill": false,
  "image": "assets/characters/gaia/gaia2.png",
  "source_file": "skills/gaia/gaia2.tscn",
  "classification": { "kind": "base", "slot": 2 }
}
```

`targeting_type`:
* `null` for passives (targeting is meaningless).
* `{ "defaulted": true }` when the `.tscn` omits `_targeting_type`; Godot's enum
  default is `single (0)`, so that is the effective in-game value.
* names: `single, self, all, all_faction, battle, count`.

`classification.kind`:
* `base` — `{owner}{n}`, `slot` = moveset index (`0` = passive).
* `fusion` — `{owner}{element}{n}`, with `fusion_element` and `slot` (`0` = fusion
  passive, `1` = fusion active).
* `variant` — an alternate form such as `andoX0` (`variant: "X"`).
* `minion` — a skill belonging to a minion (`is_minion_skill: true`).

Damage/heal numbers are **not** fields — they live in each skill's `.gd`
`execute()` logic; the `description` is the canonical human-readable value.

## augments[]

```json
{
  "id": "ando1",
  "owner": "ando",
  "augment_name": "ando1",
  "display_name": "Afterimage",
  "description": "If Ando uses Flash Step while Uncharged, ...",
  "element": { "id": 3, "name": "lightning", "display_name": "Lightning" },
  "index": 1,
  "deploy_mark": true,
  "source_file": "augments/ando/ando1.tscn"
}
```

## masteries[]

Per-character tuning for the five mastery roles (Attacker, Defender, Support,
Disruptor, Strategist).

```json
{
  "id": "gaia_disruptor",
  "owner": "gaia",
  "role": "disruptor",
  "mastery_name": "Disruptor",
  "progress_multiplier": 2.0,
  "progress_increment": 9,
  "type": 3,
  "source_file": "masteries/gaia/disruptormastery.tscn"
}
```

## minions[]

```json
{
  "id": "gaiaminion",
  "character_name": "Seedling",
  "path_name": "gaiaminion",
  "owner": "gaia",                    // best-effort: longest roster prefix of path_name
  "element": { "id": 6, "name": "earth", "display_name": "Earth" },
  "image": "assets/characters/minions/gaiaminionprof.png",
  "base_hp": 25,
  "base_hp_candidates": [25],         // every literal found in spawn code
  "hp_source": "gd-heuristic",        // "gd-heuristic" | "dynamic" | null
  "source_file": "characters/minions/gaiaminion.tscn"
}
```

`hp_source`:
* `gd-heuristic` — a fixed integer recovered from GDScript spawn code.
* `dynamic` — HP is a runtime expression (e.g. inherits the summoner's HP);
  `base_hp` is `null` on purpose.
* `null` — none found (likely display-only or spawned indirectly).

## _meta

```json
{
  "generator": "data_export/extract_database.py",
  "counts": { "elements": 66, "skills": 622, ... },
  "roster": ["pyrrha", ...],          // 27, in display order
  "warnings": [],                     // genuine anomalies (currently none)
  "warning_count": 0,
  "info": [ ... ],                    // benign notes (variant skills, dynamic-HP minions)
  "notes": [ ... ]                    // provenance reminders
}
```
