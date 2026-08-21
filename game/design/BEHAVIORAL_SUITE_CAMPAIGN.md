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
- Wave 2 (14): gaia, roland, ayana, taryn, blackknight, maggie, laria, xyris, fate, scratch, aramao, sera, galazax, trinity — _pending_

### Phase 2 — fusion forms — _pending_
### Phase 3 — augments — _pending_

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
