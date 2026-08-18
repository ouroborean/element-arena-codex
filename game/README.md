# Element Arena — game build

Rebuilding the 3v3 elemental strategy game described in the codex as a
mobile-friendly web app. This directory is the **game**; the repo root is the
**codex** (the static reference app + the data export the game is built from).

See the full plan: [Implementation Roadmap](https://claude.ai/code/artifact/3c1040ba-14e0-4971-9763-b6b0e0133887).

## Why the export is the hard part

The original GDScript `execute()` bodies were never exported, so each record's
prose `description` is the **only** surviving spec for every damage number,
duration and trigger. This is not a port — it's a ~762-record authoring project.
The engine's job is to make one record cheap to author. The one architectural bet
that makes the metagame expressible: **skills are declarative data with
individually addressable effect nodes, not functions**, because augments and fusion
passives are ordered *patches* to named sibling skills.

## Where we are — Phase 0 (rules charter & content pipeline) — ✅ complete

| Artifact | What it is | State |
|---|---|---|
| `design/RULINGS.md` + `content/rulings.json` | 21 unstated rules; 6 designer-confirmed | ✅ |
| `design/DECISIONS.md` | Oracle = faithful reconstruction (no source) | ✅ |
| `design/CONTENT_QUERIES.md` | Content ambiguities for the designer | ✅ |
| `tools/lint_content.py` | Import pipeline + reference linter | ✅ `--strict` green |
| `content/reference_exceptions.json` + `_corrections.json` | Adjudicated allowlist (109 accepted, 3 fixes, 2 flags) | ✅ |
| `tools/build_content.py` → `content/frozen/` | The frozen canonical source + audit trail | ✅ |
| `content/patch_map.suggested.json` | Augment→target scaffold | ⏳ P3 review |
| `content/frozen/content_seeds.md` | ~30 resources + units to author | ⏳ registry (P1/P2) |

**P0 exit criteria met:** `python game/tools/lint_content.py --strict` exits 0 — every
reference in all 762 descriptions resolves or is adjudicated, and a novel bad reference
or id collision fails the build. `content/frozen/` is the clean canonical source with a
14-mutation audit trail in `frozen/CHANGES.md`.

Nothing here is TypeScript yet. The P0 pipeline is stack-neutral Python that
extends the existing `data_export` tooling; the engine language/monorepo decision
is deferred to P1 (the roadmap recommends isomorphic TypeScript).

## Build

```bash
python game/tools/lint_content.py --strict   # audit references + ids (CI gate)
python game/tools/build_content.py           # emit content/frozen/ from the export
```

## The pipeline

```bash
python game/tools/lint_content.py          # regenerate all reports
python game/tools/lint_content.py --strict # also fail on WARN (for CI)
```

It reads the repo's `output/*.json` (read-only) and writes to `game/content/`:

- **Namespaced ids + collision audit** — the id spaces overlap on purpose
  (138 augment ids equal a skill id; an augment `ando1` *patches* a skill, it is
  not skill `ando1`). Every id is re-emitted as `skill:` / `aug:` / `char:` /
  `minion:`, and any *new* collision fails the build. Emits `ids.generated.ts`.
- **Reference lint** — resolves every Title-Case phrase in all 762 descriptions;
  splits the residue into `reports/status_registry.seed.md` (the ~30 undocumented
  per-character resource systems) and `reports/reference_lint.md` (typo / unknown
  name candidates like `Bramblebarrier`).
- **Augment patch-map** — `patch_map.suggested.json`. See below.
- **Repairs manifest** — `reports/repairs.manifest.json`, the known data fixes.

## The augment patch-map — read this before trusting it

There is **no** number-to-number relationship between an augment and the skill it
changes. Measured across all 140:

| Augment shape | Count |
|---|---|
| Patches exactly 1 owner skill | 78 |
| Patches 2+ owner skills | 34 |
| Patches no specific skill (targets the unit / a resource / a minion template) | 23 |
| Empty (`darkness` placeholders) | 5 |
| Skills that are patched by **more than one** augment | 28 |

So the map cannot be derived — `patch_map.suggested.json` is a **heuristic
starting point** with `review_required: true` on every real entry, and the
`PatchFold` engine (P3) must support ordered multi-patch onto one skill and patch
targets that are not skills at all (e.g. `gaia3` patches a *minion template*:
"Gaia's minions are created with 10 more maximum HP").

## Layout

```
game/
├── README.md
├── design/            human-facing charter & specs
│   └── RULINGS.md
├── tools/             build & lint scripts (Python, stack-neutral)
│   └── lint_content.py
└── content/           generated + hand-authored game content (the frozen source)
    ├── rulings.json
    ├── ids.generated.ts
    ├── patch_map.suggested.json
    └── reports/
```
