# Behavioral test-suite campaign

Goal: a **spec-derived, adversarial** behavioral test for every skill / fusion form / augment — tests written from the FROZEN prose (the oracle), asserting the expected outcome with a control that must NOT fire, so they fail if the skill is broken and are never "written to succeed."

Method (per surface): read the frozen text for WHAT to assert; read authored/generated content only for HOW to drive (skill id, cost, targeting). Positive + control. If a spec-derived test fails, do NOT weaken it — either fix a mis-encoded test, or mark it `test.skip("SUSPECTED BUG: …")` and log the suspect for triage+fix.

## Surface inventory
- Base hero skills: 139 (27 heroes)
- Fusion forms: 200
- Augments: 135
- **Total: ~474**

## Progress
Suite files land as `engine/test/suite_<hero>_base.test.ts`, `suite_<hero>_fusions.test.ts`, `suite_<hero>_augments.test.ts`.

### Phase 1 — base kits
- Wave 1 (13): pyrrha, jarrik, gommar, keeper, riverdaughter, zevkir, saya, ando, zephyrex, syl, hector, dennis, titania — **DONE (290 tests, 18 suspects)**
- Wave 2 (14): gaia, roland, ayana, taryn, blackknight, maggie, laria, xyris, fate, scratch, aramao, sera, galazax, trinity — **DONE (298 tests, 10 suspects)**

**Phase 1 base kits: DONE — 588 tests, 27 heroes, 28 suspects (5 fixed so far).**

### Wave 2 backlog (10)
**Systemic (clusters forming):**
- **turnEnd over-fire (no `eventTeamIsSelf`)**: roland0 Living Stone (also saya1 from wave 1). → scan all turn triggers.
- **"until a new skill" buff stripped by its OWN granting cast** (skillUsed reactor missing an eventSkillId/appliedTurn guard): laria4 Vanish.
- **skillUsed reactor missing a Harmful gate** (fires on any enemy skill): trinityazure2 Prisma Whirl (cf. fate2 target-side scope).
- **`requires` target-selector inert** (evalSkillCondition binds targets:[] so `sameUnit[target,caster]` never holds): xyris5 "cannot target Xyris".

**Individual:** taryn4 target-invisibility not stamped · maggie1 essence-half unwired · fate0 outgoing_damage_mod skips True damage ("non-Affliction" should include True) · fate2 retaliation not scoped to on-Fate-team · sera2 in-cast modifyCooldown overwritten by the cd set · sera5 authored cooldown 3 ≠ frozen 4.

### Fixed so far (PR #109 + follow-ups)
- **permanent (`duration:null`) dot/regen now ticks** → titania1, dennis5 (+ revived 15 more dead dots/regens).
- **`non_damage_ignore` now enforced** → pyrrha5, dennis3, hector3. _(Follow-up: scope Mindfog/Absolute Power to stuns.)_

### Phase 2 — fusion forms
- Wave 1 (13): pyrrha…titania — **DONE (496 tests, 45 suspects)**
- Wave 2 (14): gaia, roland, ayana, taryn, blackknight, maggie, laria, xyris, fate, scratch, aramao, sera, galazax, trinity — **DONE (478 tests, 37 suspects)**

**Phase 2 (fusions) complete: 974 tests, 82 suspects.** Wave 2 reconfirms the systemic classes (scope-blind invulnerable — rolandmyth0/gaia; skillUsed over-fire with no skill gate — rolandmoon0/gaiaslime0; missing requires/usability gate; unread marks Magnetized/Mooncursed; damage `from` unset so a launched-Boulder's source is the hero; template-scoped respawn — gaiagrave0/rolandgrave0 Boulder).

Big systemic clusters from fusion wave 1 (fix once → clears many across base+fusion+augment):
- **scope-blind `invulnerable`** (ignores its `scope`, blocks ALL harmful): gommar4, gommaraurora1, …
- **`outgoing_damage_mod` only applies to normal/piercing** — not Affliction or True ("non-Affliction"/"more Affliction" clauses dead): jarrikdragon0, fate0, …
- **`non_damage_ignore` over-broad** (no stun-only/scoped variant): gommar apocalypse/glacier, hector Mindfog, scratch1.
- **`damage_ignore` over-broad** (no "periodic-only" scope): gommarlich0.
- **no `requires`/usability gate primitive** ("cannot be used if…"): gommarmyth1, xyris5, …
- **`has(of: …)` uses resolveOne (first target only)** → "each affected enemy" filters mis-fire: pyrrha dragon, …

### Phase 3 — augments
- Wave 1 (13) — **DONE (201 tests, 16 suspects)**
- Wave 2 (14) — **DONE (224 tests, 14 suspects)**

## COVERAGE COMPLETE (2026-08-21)
Every base skill, fusion form, and augment now has a spec-derived behavioral suite. Full suite ~2642 tests, 0 fail, 128 skipped. **~140 suspected bugs found, ~17 fixed → the 128 skips are the live fixing backlog.**

New systemic class from augments: **`addStack` never emits `statusApplied`** (only the `applyStatus` op does), so statusApplied triggers meant to react to a stack landing (Nightwalker/laria4 Bypass, laria5 Vanish) never fire via a real skill — my earlier fidelity3_cov_nightwalker test masked it with a hand-rolled emit. Also: **in-cast self-cooldown reduction is clobbered** by performAction's `effectiveCooldown` overwrite (xyris3, sera2) — needs the engine to fold pending self-cd deltas.

## Suspected-bug backlog (spec-derived tests that fail → likely broken skills; each is a `test.skip` in its suite)
### Wave 1 (18) — grouped by root cause
**Systemic (one fix clears several + helps future waves):**
- **`non_damage_ignore` status never enforced** (applied but no code reads it on the apply path; contrast `damage_ignore`): pyrrha5, hector3 (Mindfog on Dennis), dennis3.
- **permanent (`duration:null`) dot/regen never ticks** (`tickDots` gates on `duration !== null`): titania1 (permanent 5 affliction), dennis5 (regen 5/turn).
- **`counterFired` `eventSource` binds to the ATTACKER, not the counterer** (so "when I counter" gates can't fire): riverdaughter0 (Healing Tears counter-half dead). [zevkir4 related.]

**Individual:**
- keeper5 Hero's Return: revive on a dead ally is unreachable (single-target filters dead) → wastes 2 energy + 75 Shield, nobody revived.
- gommar0: Essence granted on ANY `outgoing_damage_mod`, not only REDUCED damage (needs a magnitude/sign gate).
- gommar4: `invulnerable` not scoped to non-Strategic (blocks all Harmful).
- gommar5: unconditional full stun swallowed by the earlier scoped stun (`sameSlot` ignores scope → refresh keeps the scoped one).
- riverdaughter5: River Clone cost never re-priced to [65] the turn after Dive.
- zevkir4: counter runs Call Tides inline (useSkill) instead of BEGINNING a channel.
- saya1: end-of-turn Essence grant has no team gate → fires on the enemy turn-end too.
- ando3: "cannot be stunned" not honored (blocked while stunned).
- zephyrex2: telegraph channel runs on cast AND next turn → 25 piercing lands twice.
- syl3: empowered Talon Rake's +1 cooldown lost; the "this turn" mark (duration 0) persists to a later turn.
- pyrrha0 (PLAUSIBLE): on-death burst hits untargetable enemies ("targetable" restriction not modeled).
