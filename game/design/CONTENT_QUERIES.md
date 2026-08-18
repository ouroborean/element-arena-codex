# Content queries for the designer

Concrete content ambiguities the P0 pass surfaced — separate from the *rules*
questions in [RULINGS.md](RULINGS.md). Each is a naming/definition decision that only
the designer can settle. None blocks P0; each blocks authoring the specific content it
names. Nothing here was auto-"fixed" — under faithful reconstruction we don't invent.

## Naming inconsistencies — ✅ RESOLVED 2026-08-13 (normalized in the freeze)

1. Trinity's red Ranger → **Prisma Crimson** (the 1 "Scarlet" reference normalized).
2. Trinity's yellow Ranger → **Prisma Saffron** (the 1 "Citrine" reference normalized).
3. Keeper → **Keeper of Fables** (the 3 "Keeper of Tales" typos normalized). Resources
   "Tales to Tell" / "Chronicle Fragments" unchanged.

All three applied as NORMALIZE corrections; see `content/frozen/CHANGES.md`.

## Undefined mechanics — ✅ RESOLVED 2026-08-13

4. **"Enhanced" / "Augmented"** → **not a mechanic.** General-purpose words meaning a
   skill has an alternate (usually stronger) effect under some condition; always
   per-skill, no global state to model (`ENHANCED_AUGMENTED` ruling).

5. **Skill taxonomy** → defined. Standard heroes: `0` passive, `1-3` basic, `4`
   defensive, `5` ultimate. Pre-fused (7-skill): `0` passive, `1-3` basic, `4` fusion,
   `5` defensive, `6` ultimate. Trinity: passive + 3 basic only; minion skills always
   basic. Now tagged as `skill_class` on every frozen skill (`SKILL_TAXONOMY` ruling).

## Applied automatically (recorded, FYI — reverse if wrong)

These were normalized in the freeze as safe transcription fixes (see
`content/frozen/CHANGES.md`): `Channelling → Channeling`, `Zek'vir → Zev'kir`,
`Hectors → Hector's`. Minion HP was taken from the glossary on 6 conflicts.

## Accepted as named systems (no decision needed, will be authored later)

`Bramblebarrier`, `Blackened Wounds`, `Evencoin`, `Earth Pillar`, `Chronicle
Fragments`, and ~25 other per-character resources are recorded in
`content/frozen/content_seeds.md` for the status/unit registries.
