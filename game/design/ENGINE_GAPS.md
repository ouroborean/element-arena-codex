# Engine gaps — what authoring the roster revealed

## P3 content — augments LANDED (2026-08-17); fusions in progress

The P3 authoring pipeline mirrors the base roster: `tools/validate_p3.py` (reuses the base
effect/trigger walkers + validates fusion-form / augment-patch shapes) → `tools/build_p3.py`
(codegen to `content/{fusions,augments}.generated.ts`) → `test/p3.smoke.test.ts` (apply every
form/augment to a fresh hero, resolve on a live match, no throw).

**Augments: all 135 authored** (9-agent workflow) — 0 structural errors, tsc clean, smoke green.
Patch-op mix: appendEffect 56, addTrigger 49, replaceSkill 43, setSkillMeta 18, removeTrigger 12,
custom 8. The authors reached for 22 distinct `custom` fns; all are backed by handlers in
`content/augment_effects.ts` (14 effect-level, 8 patch-level). Most are faithful (reuse scoped
`cost_mod`, scoped `damage_ignore`, shields, the acted-this-turn ledger, scheduling, across-slot,
a new "Stun Immunity" mark honoured by `isStunnedFor`, and a `maxHp` bump). Six are **honest
partials with tracked debt** — each applies an observable marker, never a silent no-op:

| custom (augment) | why it's partial |
|---|---|
| `splitIncomingSingleTargetDamageAcrossCinders` (jarrik4) | redistributing incoming damage needs a pre-mitigation pipeline hook |
| `capShieldAbsorbPerHit` (keeper4) | a per-hit shield-absorb cap is a damage-pipeline modifier the engine lacks |
| `channelCopies` (galazax1) | the engine keys one `channeling` status per skill id; two concurrent copies aren't representable |
| `conditionalCostReduction` (keeper3) | the cost gate is evaluated once at apply, not re-checked per cast |
| `scaleCoilDamage` (saya2) | retuning a live per-tick amount inside an existing trigger's Value tree has no general rewrite |
| `jealousyBasicsToGeneric` (titania5) | converting a skill's specific cost to generic currency has no primitive (`cost_mod` is a flat delta) |

**Fusions: all 200 forms authored** (20-agent workflow) — structurally valid (0 errors, after fixing
3 `with:{has}` filters + 4 invalid `sum`/`var` Values, and closing the validator gap that let those
through) and tsc-clean as typed `FusionForm[]` literals. The fusion forms are the mechanically-densest
content in the game: they reference **126 distinct `custom` mechanics**, of which only **6 reuse an
existing handler — 120 are bespoke and PENDING native handlers.** Each is authored as a `custom` node
with a precise intent `note`, so the content (the *what*) is captured as data; the *how* (120 one-off
game-logic handlers) is a large follow-on. Until each lands, `content/fusion_pending.ts` registers a
**tracked, logged stub** (pushes "unimplemented fusion mechanic: <fn>" to `state.log` — never a silent
no-op) so the framework runs and the gap is measurable. The p3 smoke test prints the
`implemented / pending` split. **This is the honest state: fusion forms authored + validated +
compiling; 120 mechanics await real handlers** (best tackled in themed batches — charge/mark systems,
minion/summon variants, damage-link/redirect, cost/economy, etc.).

**Handler clusters (implementing the pending mechanics, themed):** handlers land in
`content/fusion_effects.ts`; each implemented fn drops off `fusion_pending`'s stub list automatically.
- **Cluster 1 — combat-event reactions ✅ (2026-08-17):** 7 fns that read the firing event's values
  (damage/heal amount, `sourceId`) or the acted-this-turn ledger — `storeDamageDealt`, `storeHealing`,
  `gainRitualPower`, `repeatDamageDealt`, `healAlliesWhenCurseOfThornsDeals`,
  `healLockUnitsDamagedByCurseOfThorns`, `addCurseStackIfMaggieDidNotAct`. Fully faithful (they read
  the real event off the context — the DSL exposes no `event.amount`/`event.sourceId` to a
  Value/Condition). `test/fusion_effects.test.ts`. Pending: **120 → 113**.
- **Cluster 2 — watch windows ✅ (2026-08-17):** 16 fns of the form "for N turns, when X happens, do Y"
  (`singularityWatch`, `searchAndRescueWatch`, `shadowSeekersWatch`, `stunEnemiesThatBecomeInvulnerable`,
  `consecrationRetaliation`, `moongloveTrap`, `icySmileWatch`, `soulstealWindow`, `breakStunOnDamage`,
  `clearBlindWhenTargetInvulnerable`, `armSkillUseTrap`, `armSkillUseReward`, `oppositesAttract`,
  `notTodayReflect`, `handOfMichaelWatch`, `personalMagnetism`). Built on a new **dynamic-trigger
  subsystem**: `TriggeredEffect` gained `duration`/`appliedBy`/`appliedTurn` (a trigger installed at
  runtime that expires at the installer's turn-end, `scheduler.tickTriggersForTeam`), plus
  `redirectToId` (a concrete reflect destination) and `once`-removal for react triggers. Windows tag
  their target with a private mark so the later-firing trigger can name it. Also added an
  `eventStatusKind` Condition (gate on the applied/expired status's kind — fixes a re-entrancy where a
  watch re-fired on the status it itself applied). `test/fusion_effects.test.ts`. Pending: **113 → 97**.
- **Cluster 3 — self-skill mutation ✅ (2026-08-17):** 13 fns that edit the hero's OWN skill instances
  (`bumpSkillDamage`, `bumpSkillDamageOnSkill`, `setSkillDamageType`, `patchElegantSweepAngel`,
  `escalateSkillCost`, `enterDreamscapeAffectsAll`, `modifyEnterDreamscape`, `flamesOfGreedRewrite`,
  `dragonsHungerRewrite`, `festeringBurnsRewrite`, `solarFlareRewrite`, `bannerAffectsAllEnemies`,
  `empowerThornPrick`). Two hazards handled: **clone-safety** (`mutableSkill` deep-detaches a base skill on
  first edit so the shared `HeroDef`/teammates are never corrupted) and **idempotency** (roundStart rewrites
  fire each round but a `once` ledger keyed on the stable clone applies compounding ones a single time; per-
  trigger/per-use bumps intentionally compound). `bannerAffectsAllEnemies`' temporary window and
  `empowerThornPrick`'s +damage half are tracked partials. `test/fusion_effects.test.ts`. Pending: **97 → 84**.

  A 3-area adversarial review of clusters 2+3 (each finding independently verified) confirmed **7 real
  bugs — all fixed** with locking tests: (1) `mutableSkill` swapped the skill object, orphaning a
  reference `performAction` held mid-resolution → now detaches internals **in place**; (2) Consecration's
  retaliation emitted `damageDealt` and tripped Taryn's own Guardian passive → now non-emitting
  (`dealNoEmit`); (3) Personal Magnetism ignored the countered skill's class → now branches Helpful/Harmful;
  (4) Singularity fired on any enemy skill → gated to Harmful (added optional `tags` to the `skillUsed`
  event); (5) hectorfaerie's enemy branch stunned unconditionally → added a cancel-on-skill-use watch;
  (6) Shadow Seekers fired on any ally's damage → restricted to Syl/Eagle; (7) **dynamic watch triggers
  leaked across rounds** → `startRound` now clears them (they're round-scoped like statuses).
- **Cluster 4 — HP manipulation ✅ (2026-08-17):** 4 fns implemented **to exact prose** (each clause
  mapped to code, self-reviewed): `swapHp`/`swapCurrentHp` (swap two units' CURRENT hp only, max
  untouched — xyriscurse1 "Dream Weaving", lariamirror0 "Black Reflection"), `setMaxHpToCurrent`
  (pyrrharitual1 "Tormentor's Brand" — sets max HP to the post-damage current HP), `healWithOverhealToMaxHp`
  (riverdaughterslime1 "Congeal" — heal 15, only the portion past max raises Max HP). `test/fusion_effects.test.ts`.
  Pending: **84 → 80**. **Deferred (not approximated):** the Xyris "curse" identity
  (`curseDamageHeals`/`curseHealDamages`/`curseStartAtOneHp`, xyriscurse0 "Hypnagogic Curse" — "damage
  heals him, healing damages him, dies when he reaches 100 HP") is a genuinely *inverted-HP* system that
  needs a damage/heal-inversion pipeline hook + an inverted death threshold, not a post-hoc trigger — left
  pending for its own careful pass.
- **Cluster 5 — resource & charge systems ✅ (2026-08-17):** 6 fns to exact prose — `reduceLeylineCostOnEssence`
  (syl5 scoped-cost discount on essence gain), `suppressLeylineCostDecay` (a mark `decaySkillCost` respects),
  `scorchedFleshCostAura` (+1 generic to Cinders-enemies' Strategic skills only), `magneticFieldCharge`
  (single-polarity charge; same-polarity re-use → 15 dmg + stun; Strategic clears; alternating flips — caught
  the flip-must-clear-opposite detail in self-review), `coldAndAloneAccrue` (stack Invuln/Isolated enemies at
  their turn-end, stun+reset at 3), `capacitorUpgradeOnExpel` (Expel Energy → perStack×stacks bonus, consume).
  `test/fusion_effects.test.ts`. Pending: **80 → 74**. Deferred (not approximated): `lightningRod` (persistent
  dual-mechanic keyed on essence-*income*, which has no event hook).
- **Cluster 6 — minion & summon variants ✅ (2026-08-17):** 5 self-contained fns to exact prose —
  `distributeShieldOnDeathRoundedTo5` (split Keeper's shield among living allied heroes, each rounded up to 5),
  `minionsIgnoreCountersAndStuns` (uncounterable + Stun-Immunity on the named minion templates),
  `createScavengerPile` (any death spawns a Pile, but a Pile does not spawn a Pile), `eagleKillScavenger`
  (Syl's Eagle killing a Pile → +25 heal + Leyline −1 specific), `pickTheBonesDamage` (15, doubled vs a Pile,
  team Essence on a kill). `test/fusion_effects.test.ts`. Pending: **74 → 69**. Deferred (need
  currently-unauthored fusion-minion content or new tracking, not approximated): `cloneBasicSkillsOntoSimulacrum`,
  `cloneLastUsedSkillOntoMinion` (last-used-skill ledger), `grantSkillToTemplate` (Living Lash skill def),
  `winterExileSummon` (summon replacement), `mountainRescueTeam` (skill retargeting rules).
- **Cluster 7 — damage multipliers ✅ (2026-08-17):** a new **multiplicative** damage primitive (the additive
  `*_damage_mod` couldn't express ×0.5/×2/×3): status kinds `incoming_damage_mult` (defender; applied after the
  additive incoming mods, gated by `!cap.mods` so True ignores it; a `newDamageOnly` flag scopes it to skill hits)
  and `outgoing_damage_mult` (attacker; applied in the interpreter's `damage` op, all types). 3 fns to exact prose:
  `incomingDamageMultiplier` (gommarcrystal0 — ×0.5 from *new* Harmful skills), `ritualDoubleAllDamage`
  (pyrrharitual0 — permanent ×2 on *every* unit at 75 Ritual Power), `tripleDamageThisTurn` (titaniafaerie1 —
  ×3 outgoing for a turn). `test/fusion_effects.test.ts`. Pending: **69 → 66**.
- **Cluster 8 — damage-type override & conditional bypass ✅ (2026-08-17):** two primitives — status
  `outgoing_dtype_override` (forces the dealer's damage type, applied in the interpreter's `damage` op) and
  `conditional_bypass` (a `bypassCond` target-condition; when the target holds it, the hit sets
  `DamageInstance.bypass`, which skips DR **and** Shield in the pipeline). 3 fns to exact prose:
  `damageBecomesPiercing` (tarynvigilante0, while outnumbered), `bypassVsIsolated` (sylghost0 — Syl + her
  minions vs Isolated targets), `bypassVsDreamscapeAffected` (xyrisninja0 — vs the Enter-the-Dreamscape mark;
  re-authored its trigger from `skillDeclared`, which react-triggers never fire on, to `roundStart`).
  `test/fusion_effects.test.ts`. Pending: **66 → 63**.
- **Cluster 9 — heal↔damage conversion & inverted HP ✅ (2026-08-17):** the twice-deferred Xyris curse, done
  right. Three pipeline status kinds — `heal_becomes_damage` (applyHeal reduces HP instead), `damage_becomes_heal`
  (applyDamage heals instead), `dies_at_max` (dies at MAX hp; death-at-0 suppressed in applyDamage/applyHealthLoss)
  — plus a `unitDied` emit in the interpreter's `heal` op (a heal can now be lethal). 2 fns to exact prose:
  `healReceivedBecomesAffliction` (titaniaantidote1 — 3-turn heal→damage), and `curseStartAtOneHp` (xyriscurse0 —
  set 1 HP + install all three inverted-HP statuses); the two post-hoc `curseDamageHeals`/`curseHealDamages`
  triggers were removed (the pipeline statuses subsume them, avoiding the death-at-0-before-heal-back ordering bug).
  `test/fusion_effects.test.ts` (damage→21, heal→11, survives at 0, dies at 100). Pending: **63 → 59**. Deferred:
  `overhealAsAffliction` (needs the overheal amount exposed from the heal path).
- **Cluster 10 — skill-use triggers, cleanses & status ops ✅ (2026-08-17):** a 12-fn chunk to exact prose.
  Skill-use triggers (fire on `skillUsed` of a specific id by self): `invulnOnSkill`, `onStalwartShield`,
  `skylanceTauntAndShield` (taunt via `unitRef`), `ominousRumbleOnWindStep`. Status ops: `paralyzeCooldowns`,
  `setStatusDuration` (sets duration in place — no re-emit loop), `grantTieredShieldByAlliesActed` (20/30/45 by
  the acted-ledger), `essenceHeal` (essence→+10 + heal_lock, direct heal bypasses it), `escalatingHeal`
  (5 now, 10/15 scheduled). Cleanses, backed by a harmful/beneficial status classification (signed mods judged
  by magnitude) + applier-provenance: `cleanseBeneficial` (one buff off an enemy), `removeOneHarmful` (one
  debuff off an ally), `cleanseEnemyEffects` (all *enemy-applied* effects). Fixed the `eventTarget`-vs-`eventTargets`
  mismatch for `skillUsed`-triggered handlers with a fallback. `test/fusion_effects.test.ts`. Pending: **59 → 47**.
- **Cluster 11 — ledger punishes, chance procs, execute, links & targeting ✅ (2026-08-17):** an 8-fn chunk.
  `belphegorsBladeIdlePunish` (idle Jarrik/Cinders-enemies take 15 at turn-end, via the acted-ledger),
  `fivePlaguesProc` (10%/stack on affliction damage → random debuff, seeded rng), `thornPrickExecute`
  (execute a minion dropped below 20 HP by Thorn Prick), `risingGeyserLink` (a round-permanent damage-link
  between marked units — replicated damage is applied directly so it can't loop), `doubleGodOfThunder`
  (extra hit = Ando's outgoing_damage_mod), `constantFluxCoilTick` (per-coil base ± step-variance, seeded rng),
  `untargetableByBlindedSkills` (a "Blind-Untargetable" mark `legalTargets` honours in the Blind branch),
  `revealEnemyInvisibleEffects` (faithful no-op — the isHidden concept is unmodelled/cosmetic). Two small
  engine enablers: round-permanent (`null`-duration) dynamic triggers, and the Blind-targeting exclusion.
  `test/fusion_effects.test.ts`. Pending: **47 → 39**.
- **Cluster 12 — shields, watch-afflict, clone & stack mechanics ✅ (2026-08-17):** a 6-fn chunk.
  `prismaticShielding` (Plasma Shield → all allied heroes get 40 shield + 2-turn Affliction immunity),
  `purifyingShieldHeal` (on Taryn's shield break, heal 5 per enemy-applied effect on him/marked allies),
  `afflictOnHelpfulUse` (isolate the target + a round-permanent watch: 20 Affliction when it uses a Helpful
  skill), `cloneBasicSkillsOntoSimulacrum` (summon a 30-HP Simulacrum with the target's Basic skills,
  re-elemented to Xyris), `freezingBrineOnRiptide` (Riptide adds Call-Tides-many Freezing Brine stacks; at 5
  → stun + consume), `shieldPerTurnForDuration` (consume Call Tides → 10 team shield now + scheduled per
  remaining turn). `test/fusion_effects.test.ts`. Pending: **39 → 33**.
- **Cluster 13 — empower windows, retaliation & stack-spend ✅ (2026-08-17):** a 4-fn chunk.
  `lightningCrashSkylanceEmpower` (3-turn window: each Skylance also hits 2 random enemies for 5 Piercing +
  grants Essence), `forcedHarmonyBonus` (Inspiring Thrust deals a double hit to Forced-Harmony-marked
  targets), `restrainRetaliate` (damaging Taryn during Restrain extends the attacker's stun by 1),
  `spendStack` (each 50 banked healing → Essence + 15 Affliction to all enemies, looped). `test/fusion_effects.test.ts`.
  Pending: **33 → 29**.
- **Adversarial review of clusters 9–13 + the damage pipeline (2026-08-17):** a 3-area review (each finding
  independently verified) confirmed **9 fixes**, all now landed: (1) typed `heal_becomes_damage` (titania's
  Affliction) now routes through the damage pipeline + emits `damageDealt` (was raw HP loss, skipping mults/
  immunity); (2,3) `escalatingHeal`/`cleanseEnemyEffects` gated to Soothe (`riverdaughter4`) — they'd fired on
  *every* RD skill, healing/cleansing enemies she attacked; (4) `removeOneHarmful` gated to a Serum applied/
  expiring on an ally (was any status, and helped enemies); (5) `constantFluxCoilTick` deals normal (was
  affliction); (6) `thornPrickExecute` now matches the direct hit (gave titania1's damage node an id);
  (7,8) `risingGeyserLink`/`restrainRetaliate` react to NEW damage only (added `isNew` to `damageDealt`) and
  restrain only *extends* an existing stun; (9) `prismaticShielding` no longer double-shields Saya. All in
  `test/fusion_effects.test.ts`; **230 tests green.**
- **Cluster 14 — Hector's serums, summon-swap & channeled skill-mods ✅ (2026-08-17):** 5 fns.
  `applyRandomSerum` (on the new `energyFromEssence` event, applies a random Serum the target lacks — by
  re-running the real serum skill's effect so every stack/rider is faithful; faerie form is once-per-turn),
  `avatarSerum` (a per-turn watch re-counts serums on Hector → 5×count Affliction to all enemies for 3 turns
  + `non_damage_ignore`), `mirrorUsedSerumToSelf` (a serum Hector uses is also applied to himself),
  `winterExileSummon` (Summer Clique re-badges her Summer Courtesans as Winter Loyalists),
  `mistyMireBubblePrison` (Bubble Prison adds a per-turn 15 Piercing *bypass* strike to a random enemy for
  its 1 + Call-Tides-stacks duration).
- **New primitive — `energyFromEssence` event (2026-08-17):** essence is consumed in `grantIncome` *before*
  the `turnStart` emit, so the old "`turnStart` while holding essence" gate for "gains energy from Essence"
  could never hold. Added a dedicated event emitted at the exact swap moment; re-authored hector:battery and
  used it for saya:storm's `lightningRod` stack-gain. Precise, reactable, no turn-start guessing.
- **Cluster 15 — delayed/per-turn strikes & heal→damage redirects ✅ (2026-08-17):** 4 fns.
  `cleaveTheVeil` (marks a target + schedules 45 Piercing at the end of his next turn; an interrupt watch
  cancels it if a new Harmful skill lands on Zephyrex first), `lightningRod` (two round-permanent watches:
  5-per-stack random-enemy strike each turn + a stack gained on `energyFromEssence`; skill `requires` blocks
  recast while active), `doubleLaughingPowder` (doubles the dot's magnitude, gated to the dot's own
  application so unrelated statuses don't re-double — its "on transfer, current target takes 15 Affliction"
  rider is unreachable: the base dot has no transfer mechanic to hook), `overhealAsAffliction` (RD's overheal
  — now reported on the `healReceived` event — is dealt to a random enemy as Affliction).
- **Cluster 16 — positional & targeting restrictions ✅ (2026-08-17):** 2 fns. `flutterInTheFog` (a 3-state
  cycle at Syl's turn-end: self-invuln → Eagle-invuln → skip), `restrictTargetingToMaggieOrBramblelash` (the
  reanimated ally becomes Immortal + can only target Maggie or Bramblelash-marked enemies — enforced in
  `legalTargets` via a "Reanimated" mark — and dies when the 3-turn duration ends via an `onExpire` defeat).
  `test/fusion_effects.test.ts`; **245 tests green.** Pending: **28 → 17** (17 hardest holdouts remain:
  derived stack-reads, skill-cloning/rewrites, serum-avatar edge cases, eagle-stage/extra-target reads).
- **Spec+critique workflow before clusters 17–19 (2026-08-17):** 5 parallel deep-readers produced clause-mapped
  specs for the 10 hardest fns; an adversarial completeness critic caught 5 defects pre-implementation — the
  Boulder round-start sweep grants to zero Boulders (Boulders are made mid-round → needs a summon-time hook);
  `stack_read_mod` collided in `sameSlot` (name-agnostic → one read-mod per unit); the affliction override
  missed DoT ticks; the dreamscape payback re-mitigated; absorbed hits counted as "dealt damage." All five were
  folded into the implementation below rather than found after the fact.
- **New primitives (2026-08-17):** (1) `stack_read_mod` StatusKind + `rawStackCount`/`stackCount` rewrite —
  "treated as though they had N stacks" (modes `mult`/`floorZero`/`missingHp`, live `readModIf` gate); every
  stack-scaled skill reads through `stackCount`, so the transform reaches them all; gates/zero-tests read RAW.
  `sameSlot` now slots read-mods by name. (2) `outgoing_dtype_override.overrideIfStackZero` — a live-gated type
  override (Affliction only while raw stacks = 0), now honored in `tickDots` too so DoT damage converts. (3)
  `instant_cast` StatusKind + a `performAction` gate that skips the channel install for the named skill. (4)
  `minionSummoned` event emitted from `summonMinion` — lets "minions of template X gain Y" hook creation.
- **Cluster 17 — derived stack-reads ✅ (2026-08-17):** 3 fns (+`afflictSelfIfRawStackZero`).
  `evencoinTripleShadows` (triple Deepening Shadows for Evencoin holders — a gated `mult` read-mod on all heroes),
  `stinkingMarshZeroStackMod` (raw 0 Call Tides → reads 2 via `floorZero` + gated Affliction override on direct
  hits *and* DoT ticks; the "10 Affliction on 0-stack skill use" re-authored to test the RAW count),
  `callTidesFromMissingHp` (+1 Call Tides per 15 missing HP via a `missingHp` read-mod).
- **Cluster 18 — eagle/minion skill mods, granted skills & channel-instant ✅ (2026-08-17):** 5 fns
  (+`applyDreamscapeMark`). `extendEagleSkillDurations` (detach the eagle's shared skill trees + `once`-guarded
  +1 to every status/stack/shield duration), `skyDropEagleStageBonus` (+10 dmg & +1 stun per eagle evolution
  stage, read from the eagle's name), `grantSkillToTemplate` (Boulders gain a transcribed Living Lash on the
  `minionSummoned` hook), `skillCastsInstantlyWhileMarked` (an `instant_cast` for Elegant Sweep for the 3-turn
  window — resolves on cast, no channel sustain), `dreamscapeEndDamage` (companion mark + `storeDamageDealt`
  banker + a `true`-damage payback equal to the damage taken while marked).
- **Cluster 19 — summon-execute & Fae-Prince accrual ✅ (2026-08-17):** 2 fns (+`recordDamagedZephyrex`).
  `barrenRealmExecute` (Summer Clique deletes its Courtesans and deals 10 Affliction per would-be Courtesan to
  the lowest-HP enemy — invuln-bypassing since direct affliction ignores the targeting gate + DR/shield),
  `faePrinceAccrue`/`faePrinceConsume` (+ a per-turn `Damaged Zephyrex` ledger written only on real hits): each
  enemy hero that didn't damage Zephyrex on their turn stocks +10 for his next hit, consumed (×count) then
  cleared. `test/fusion_effects.test.ts`; **260 tests green.** Pending: **17 → 6** (6 hardest remain:
  `whimsyEngine`, `cloneLastUsedSkillOntoMinion`, `ionCoilRules`, `hiveFormationRedirect`, `mountainRescueTeam`,
  `shieldPerExtraTarget` — skill-replacement/cloning, taunt-redirect, coil-rewrite, extra-target reads).
- **Adversarial review of clusters 17–19 + primitives (2026-08-17):** 5 review areas, each finding independently
  verified (21 findings → **8 CONFIRMED, 0 uncertain**). **6 fixed:** (1) `shieldPerTurnForDuration` now reads
  `stackCount` (was raw `stackOf`), so Stinking Marsh's floor empowers Rising Bog's shield at 0 stacks — it was
  granting **zero** shield exactly when the floor should give 2; (2) Rapid Mutation's "5 Affliction at each of
  his turn-ends" was **dead** — `sameUnit[eventUnit,self]` on `turnEnd` (which carries no `unit`) is always
  false; added a `eventTeamIsSelf` condition primitive and re-authored the gate (this had starved
  `callTidesFromMissingHp` of the HP loss that drives it); (3,4) `barrenRealmExecute` reworked to hook
  `minionSummoned` (delete-on-create frees the cap slot so the count equals Prance, not the ≤6 survivors, and it
  now also converts the titania4 augment's Courtesans); (5) `extendEagleSkillDurations` now filters to the Eagle
  (was bumping *every* allied minion's durations); (6) it also floors duration-0 statuses to 1 before +1 (a
  duration-0 and duration-1 status are lifetime-identical, so `+1` on a 0 was a no-op). **2 documented, not
  patched:** (#3) the Stinking-Marsh "10 Affliction on 0-stack skill use" reads Call Tides *post*-resolution
  (`skillUsed` fires after the skill's own effects) — the clean fix (a pre-resolution react emit) would silently
  **activate 6 currently-dormant react `skillDeclared` triggers** elsewhere in the roster, a larger regression
  than the narrow mis-timing, so it is deferred to a dedicated `skillDeclared`-react-dispatch pass; (#6) Syl's
  Eagle can't actually summon/evolve (her roster refs template *ids* while the registry keys by *display name*,
  and fusion "replace" mode drops her base eagle-summon trigger), so `extendEagleSkillDurations`/
  `skyDropEagleStageBonus` are correct handlers that no-op until that base-wiring is fixed — a separate Syl-kit
  task. `test/fusion_effects.test.ts`; **265 tests green.**
- **Spec+critique workflow before the final 6 (2026-08-17):** 6 parallel deep-readers + a feasibility critic
  assessed the hardest holdouts and flagged the must-fixes folded in below (the `lastSkillId` round-reset;
  the `requires` deep-clone for ion; the `replace`-TriggerKind path for whimsy over the Uncounterable-leaky
  counter-rail; whimsy/mountain unobservability notes).
- **New primitives (2026-08-17):** (1) `Unit.lastSkillId` — set on a successful cast in `performAction`, reset
  per-round in `startRound` (units persist across rounds, so re-instantiation does NOT clear it). (2) a
  `replace` `TriggerKind` — a `skillDeclared` trigger checked in `resolveDeclaration` *before* the Uncounterable
  early-return (via `findReplace`), which cancels the declared skill and substitutes another; it runs its effect
  via `runInContext` (effects only) so it never recurses into declaration. (3) an `affected` ledger —
  `runEffects` now returns the set of unit ids the skill's `damage`/`applyStatus` ops touched, surfaced on the
  `skillUsed` event as `affected`, for "additional targets affected" reads.
- **Final cluster — the 6 hard holdouts ✅ (2026-08-17):** `cloneLastUsedSkillOntoMinion` (clones the target's
  last-used skill onto a Dream Reflection, re-elementing its cost; the handler owns the summon so it fails
  cleanly with no minion), `hiveFormationRedirect` (a 4-turn watch rewrites Barbed Wit's taunt slot to a random
  Hive-Formation ally), `shieldPerExtraTarget` (10 Shield per affected enemy beyond the declared target, via the
  new ledger), `mountainRescueTeam` (Swoop gains a stunned-ally→invuln mode via a detach+once tree-edit; Feed is
  a documented no-op — no stun-targeting restriction exists to relax; unobservable until the Eagle wiring is
  fixed), `whimsyEngine` (a `replace`-kind window that swaps every marked unit's declared skill for a random one
  of its own with random targets — covers Uncounterable skills, terminates because the replacement runs effects
  not a declaration), `ionCoilRules` (Saya Coil rewritten to add 2 plain coils with the cap lowered to 2;
  `panicIgnoresCoils` is moot — replace-mode drops the Panic-arming trigger). `test/fusion_effects.test.ts`;
  **272 tests green. Pending: 6 → 0 — all 125 fusion custom mechanics implemented.**
- **Adversarial review of the final 6 + declaration/ledger primitives (2026-08-17):** 4 areas, each finding
  verified (12 findings → **6 CONFIRMED, 0 uncertain**). **6 fixed:** (1) HIGH — ion Saya's coils dealt **zero**
  per-turn damage: the base coil-damage is a hero `turnEnd` trigger, and fusion replace-mode wipes base triggers,
  so the whole "Miniature Ion Cannons" fusion was inert; re-declared the coil damage trigger in saya:ion (as the
  storm/current siblings do); (2) The Whimsy Engine now installs its `replace` watch on **every** unit, so the
  field effect survives Titania's death within its window; (3) `mountainRescueTeam`'s "Feed can now target any
  stunned ally" was a real dropped clause (Feed heals Syl's Eagle specifically) — added a stunned-ally heal
  branch to Feed (observable, since Syl exists); (4) the whimsied replacement now emits `skillUsed` so other
  reactions observe it; (5) whimsy's random targeting now routes through `legalTargets` (invuln/isolated/taunt/
  blind honoured); (6) `mountainRescueTeam`'s Swoop half remains inert only because Syl's Eagle never summons —
  the same base-wiring gap already tracked as a task. `test/fusion_effects.test.ts`; **275 tests green.**
- **Tracked gaps closed (2026-08-17):** the three deferred items above are now resolved.
  - **Syl's Eagle wiring ✅** — (a) her roster's summon/transform/count-selector `template` refs used made-up
    ids (`sylminion`/`syladultminion`/`sylancientminion`) while the minion registry keys by display name, so
    `getMinionTemplate` missed and the Eagle never really formed; retargeted them to `Hatchling/Adult/Ancient
    Eagle` (skill ids `sylminion1..3` untouched). (b) fusion replace-mode dropped her base Eagle-summon
    trigger; added a new `origin: "innate"` (survives replace-mode alongside `augment`) and marked the Two-as-One
    summon innate, so a fused Syl still fields her Eagle. `extendEagleSkillDurations`/`skyDropEagleStageBonus`/
    `mountainRescueTeam`'s Swoop are now live. (`fusion.test.ts` proves the fused-Syl Eagle summons.)
  - **`skillDeclared` react dispatch ✅** — `performAction` now emits a react `skillDeclared` (post-cancel,
    pre-`runEffects`), so react-kind `skillDeclared` triggers fire. This (1) activates **6 previously-dormant**
    authored reactions (gaia:sanctuary, gommar:aurora, keeper:glacier, maggie:ghost, riverdaughter:mist/ocean),
    and (2) lets the Stinking Marsh 0-stack penalty read Call Tides **pre-resolution** — fixing the old
    false-positive where a Call-Tides-consuming skill self-triggered the penalty. Interrupt-kind (counter/
    reflect/replace) still dispatch only through `resolveDeclaration`; a cancelled/whimsied skill emits no react.
  - **Dead team-scoped gates ✅** — `turnEnd`/`turnStart` carry only `{team}`, so gates using
    `sameUnit[eventUnit,self]` / `isFaction:eventUnit` were permanently false. Added the `eventTeamIsSelf`
    condition and re-authored the survivors: **laria0** (her signature "gain Deepening Shadows at end of each
    turn" passive was entirely dead — now fires) and **zevkir:ocean** Chains of Atlantis (a `forEach` over
    channeling allies at her team turn-end). A full audit found no other dead team-scoped event-unit gates.
  - **`test/fusion_effects.test.ts` + `test/fusion.test.ts`; 277 tests green, validators + tsc clean.**
- **Adversarial review of the gap-closing work (2026-08-17):** 5 areas, each finding verified (14 → **6
  CONFIRMED, 0 uncertain**) — mostly latent bugs the new dispatch/eagle-fix *exposed*. **All 6 fixed:**
  (1,2) HIGH — keeper:glacier's Iced Shelf break-gate used `of:eventTarget`, which is unresolvable on
  `skillDeclared` (the event carries plural `targets`) and silently fell back to the owner (always a bearer),
  so activating the trigger broke the shelf on *any* Helpful/Harmful declaration; re-gated on a `count` over
  `{filter:"eventTargets", with: Iced Shelf mark} > 0` (regression-tested). (3) HIGH — `mountainRescueTeam`'s
  Swoop branch never installed: at roundStart the Eagle is a Hatchling (no Swoop), and `transform` re-mints the
  Eagle's skills on evolution; added a `skillUsed` re-patch trigger (idempotent via the per-instance once-guard).
  (4) MED — same root cause dropped Great Roc's `+1`-turn bump on evolution; same `skillUsed` re-patch fix.
  (5) MED — marking only the Eagle *summon* innate left fused Syl's Leyline Nest at a flat cost that never
  decays (strictly worse); marked both Leyline cost triggers `innate` too and gave Stormchaser a permanent
  "Leyline Decay Suppressed" mark so its per-essence decay doesn't double with the (now-surviving) per-turn one.
  (6) LOW — gommar:aurora's Dazzling Lights applied `magnitude:65` (a **transcription of the `[65]` generic-energy
  icon** — should be `+1`) and `duration:1` (anchored to gommar's team, so it expired before biting the enemy's
  next turn); fixed to `magnitude:1, duration:2`. Added the `replace` TriggerKind to the validator allowlist.
  `test/fusion_effects.test.ts` + `test/fusion.test.ts`; **279 tests green, validators + tsc clean.**
- **Two as One essence survives fusion ✅ (2026-08-17):** the eagle-wiring fix marked only the Eagle *summon*
  innate, so a fused Syl kept her Eagle but lost the other half of Two as One (Syl + Eagle acting the same turn →
  Essence — those two `skillUsed` triggers were still dropped by replace-mode). Marked both `innate`. Guarded the
  double with syl:mechanic (which re-declares essence-on-every-skill while shielded): the base grant is suppressed
  only while mechanic's round-permanent `Aerie Essence Override` mark **and** its Aerie shield both hold, so
  mechanic owns essence while shielded and the base same-turn grant resumes once the shield breaks — no double,
  no shield-down dead zone. (dur-0 "acted" marks persist ~2 turns, so a once-per-turn guard mark was not viable —
  verified empirically.) `test/fusion.test.ts` (+3 cases); **282 tests green, validators + tsc clean.**
- **Fusion-summoned minions authored ✅ (2026-08-17):** a content audit against the frozen export found the
  hero/skill/augment/fusion-form layers complete, but **21 fusion-summoned minion templates were referenced by
  `summon`/`transform` yet never registered** — so ~20 of the 200 fusion forms spawned broken 1-HP placeholder
  stubs (the Syl-Eagle bug class, at scale). Authored all 21 (Mushroom, World Tree, Gaia's Fury, Zombie, Troll
  Stonethrower, Slimeball, Stonecap, Grave, Skeleton, Saya Cell, Shady Assistant, Saya-Brand Monstrosity, Bjorn,
  Frozen Beast, Synthesizer, Simulacrum, Revenant, Angel, Shadow Clone, Slime, Sparrowrider) to their exact
  frozen skills, added to each owner hero's `minions[]`. Self-sacrifice minions (Grave's Arise!, Saya Cell's
  Divert Charge) use the native `{op:"defeat",to:"self"}`; Moon Spike scales via the existing `div` op. Three new
  handlers: `synthesizeSerum`/`catalyzeSerum` (the Synthesizer stores/re-applies Hector's serums via its
  summoner) and `cloneBasicSkillsOntoRevenant` (Maggie's Revenant copies a killed hero's basics). Fixed 4
  made-up-id summon refs (→ display names) and removed xyris:mirror's double Simulacrum summon. **0 unregistered
  summon templates remain.** `test/fusion_minions.test.ts`; **288 tests green, validators + tsc clean.**
- **Adversarial review of the minions (2026-08-18):** 4 areas, each finding verified (6 → **4 CONFIRMED, 0
  uncertain**). **All fixed:** (1,2) HIGH — the summon-ref retargets updated the `summon` op but not *sibling
  selectors* that referenced the same minion by its old id: ayana:angel's Chorus death-guard counted
  `template:"ayanaangelminion"` (always 0 → Chorus ended while an Angel still lived) and rd:slime's Congeal
  healed `template:"riverdaughterslimeminion"` (matched nothing → healed no Slime); a full recursive audit found
  exactly these two and both are retargeted to the display name. (3) MED — Troll's Hurl was three additive damage
  nodes (per-instance DR + up to 3× `damageDealt` reactions); rebuilt as one combined hit per branch (10/20/30/40)
  plus the single Boulder destroy. (4) LOW — the Revenant/Simulacrum clone finder could overwrite an older
  populated instance when the summon no-op'd at the minion cap; both now filter to empty-skilled (un-populated)
  minions, and the Revenant template is authored skill-less (dropping the invented placeholder id).

---


**Method.** We attempted to author all 26 remaining hero base kits (160 base skills +
26 passives) into the effect DSL in parallel (13 authoring agents), then synthesized the
gaps and ran an adversarial completeness audit against the frozen data. Findings below
are **fact-checked against `game/content/frozen/skills.json` and the engine source.**

**Headline.** Of 134 base *active* skills, **56 (42%) are fully expressible today**, 71
are hard gaps, 7 need the `custom` escape hatch. Passives are worse: 5 of 26 clean (they
concentrate the hardest mechanics). But the ~137 raw gaps collapse into a **short list of
systemic primitives** — and just the Wave-1 four unblock the large majority.

> **Do not bulk-author until Wave 1 lands.** Shield, named-selection, duration
> manipulation, and Channel are prerequisites cited across nearly every hero; skills
> authored without them need rework.

---

## Bulk authoring — ✅ LANDED (2026-08-16)

All **27 heroes** are authored into the DSL and compiled into the engine:
`game/content/roster.authored.json` (27 heroes, 139 skills, 13 minion templates) →
`game/tools/build_roster.py` codegen → `game/engine/content/roster.generated.ts`
(typed `HeroDef[]`). The "compilation is the oracle" pipeline ran clean end-to-end:

1. **Structural validate** — `tools/validate_content.py`, 0 errors.
2. **Codegen → tsc** — the roster as `HeroDef[]` literals type-checks with **0 errors**
   (the codegen strips authoring-only keys — `note`, and the deferred cosmetic
   `invisible`/`isHidden` — via a `COSMETIC_KEYS` allowlist, and normalises triggers).
3. **Runtime smoke** — `test/roster.smoke.test.ts`: all 27 load, **every skill resolves**
   and **every passive/trigger survives a round-start** without throwing. Green.

**Engine suite: 140 tests green** (smoke + `cooldownmod` + the 14-case `debt` suite).

### `custom` escape-hatch handlers (14 ops, 10 heroes) — `content/custom_effects.ts`
The smoke test only exercised the 8 ops reachable from unconditional triggers/skill trees;
a full inventory found **14** (6 more hide in conditional counter/reflect/skillUsed triggers
that the harness never satisfied — latent "not registered" landmines). All 14 are now
registered and backed by real primitives — **every one faithful** (debt closed 2026-08-17):

| op (hero) | primitive it leans on |
|---|---|
| `equalizeHp` (syl4) | floored HP average |
| `cooldownMod`/`clearCooldownMod` (hector3/5) | `cooldown_mod` status → `effectiveCooldown` |
| `setSkillCosts` (saya5) | direct cost set — specific IS the caster's element (ruling) |
| `decaySkillCost` + `resetScopedCostMod` (syl) | **skillId-scoped `cost_mod`** (grow discount / drop on use) |
| `exileActingAlone` (blackknight) | **acted-this-turn ledger** (`state.actedThisTurn`), read at his turn-end |
| `aoeBecomesSingleTarget` (xyris3) | mark + `resolveTargets` narrows all-* → one for a marked caster |
| `grantEssenceIfSkillReceivedWithin` (zephyrex4) | window mark + standing **`skillGranted`** trigger (dormant until a fusion-era emitter) |
| `consumeShield` (keeper×4) | **`spendShield`** (drain the real Shield pool) |
| `cloneCounteredSkillOntoMinion` (xyris4) | clone the countered skill onto the fresh Dream Reflection, re-element via minion `currentElement` |
| `repeatEventSkill` (xyris5) | re-run the just-used skill via `runInContext` (reads the dynamic event skillId) |
| `swapWithAllyAcrossFromTarget` (aramao1) | slot swap with the ally in the target's slot |
| `uncounterableThisSkill` (gommar3) | replaced by the **`uncounterableIf`** skill gate + re-author (custom node removed) |
| `augmentIfHelpful_healAndInvuln` (scratch) | tag lookup on the used skill → heal + invuln |

New engine primitives this pass: **ENERGY_INCOME corrected** (essence *swaps* generic→element
and is consumed — the engine had never matched the CONFIRMED ruling); **`cooldown_mod`** and
**skillId-scoped `cost_mod`** statuses; the **acted-this-turn ledger**; **conditional
`uncounterableIf`**; the **`skillGranted`** event; **mark-gated AoE→single**; **`spendShield`**.
Covered by `test/{cooldownmod,debt}.test.ts` (15 golden cases). **No custom fn is a stub.**

A 7-area adversarial review against the frozen prose (each finding independently verified) cleared
6 areas and surfaced one real edge case: `cloneCounteredSkillOntoMinion` corrupted a pre-existing
Dream Reflection when the 6-minion cap silently blocked the summon. Fixed — it now clones only onto a
FRESH reflection (identified by its intact placeholder skill) and no-ops if the cap blocked the summon
(regression test in `debt.test.ts`).

## Re-authoring validation (2026-08-13) — the jump landed

Re-authoring all 26 base kits against the Wave-1+2 engine (same 13-agent workflow + adversarial audit):

| | Before (pass 1) | After Waves 1–2 |
|---|---|---|
| Active skills fully `ok` | 56/134 (42%) | **102/134 (76%)** |
| Passives `ok` | 5/26 (19%) | **19/26 (73%)** |
| Gap-verdicts (active+passive) | 92 | **36 (−61%)** |

The audit confirmed the jump is **real and understated** — it found ~5 *false* gaps (e.g. Jarrik's
"retarget" ult is a status-gated `forEach`, the pattern already accepted for Ando/Ayana/Zev'kir), so
true expressibility is ~80%+. Of the 58 remaining gap line-items, **55 are hero-local, 3 systemic.**
The audit's one real cross-hero miss — **`untargetable`** (Galazax "Thunder Deafens", not just Trinity) —
is now implemented (`legalTargets` + `test/targeting.test.ts`). **24 of 26 heroes are authorable today.**

### Wave 3 small primitives — ✅ COMPLETE (2026-08-13)
`revive` + `revive_ward`, `transform` (retemplate-in-place), `useSkill` (invoke a named skill),
`isKind` condition, `sum` aggregate Value, and `untargetable` targeting — 113 engine tests green
(`test/wave3.test.ts`). Remaining Wave-3 fidelity debt (opportunistic): skillId-scoped `cost_mod` with
Value, next-skill echo (xyris5), an "acted-this-turn" ledger (blackknight0), and the cosmetic
`isHidden` flag. The two SUBSYSTEMS below are the remaining build before bulk authoring.

### Wave 3 — small, high-leverage (original list, for reference)
- **revive / would-die interception** — keeper5, hector5, fate6 (dead units are already selectable; only the state-flip is missing)
- **transform / retemplate-in-place** — gaia5, syl5 (summon+kill loses identity + mis-fires `unitDied`)
- **useSkill / invoke a named skill** (+ next-skill echo for xyris5) — dennis6, taryn, aramao, xyris
- **unit-kind/template Condition predicate** + an "acted-this-turn" flag — gaia3-style, blackknight0
- **skillId-scoped `cost_mod` taking a `Value`**, and a **lazy/aggregate `Value`** (sum/reduce, live-scaling magnitude) — riverdaughter, ayana0, fate0, blackknight2

### Formerly "architecturally blocked" — status
- **Trinity — ✅ RESOLVED (design, 2026-08-13), no subsystem.** Reframed as a conventional hero:
  Prisma Trinity is an untargetable + `damage_ignore` shell carrying a `RangersAlive` stack (=3); her
  passive summons three Ranger minions; each Ranger's on-death trigger decrements the summoner's stack
  and `defeat`s her when it hits 0. Needed only one tiny primitive — the `defeat` effect (kill a unit
  outright, not damage). Sub-skill delegation uses the Wave-3 `useSkill`. Proven in `test/trinity.test.ts`.
  The composite-unit container is **cancelled**.
- **Aramao — ✅ RESOLVED (2026-08-13), compact model not a subsystem.** A 3v3 formation is just 3 slots
  per side, so this needed only a `Unit.slot` field + `across`/`adjacent` selectors + `swapPositions` /
  `shuffleTeam` effects (`test/positional.test.ts`). "Directly across" = same slot; "adjacent" = ±1 slot;
  the "does not break Veiled" clauses are the deferred cosmetic `isHidden` flag. No board engine.

**Net: there are no remaining engine blockers for ANY hero.** The whole roster is authorable at full
fidelity. Remaining is small tracked debt (`isHidden` flag, xyris5 echo, blackknight0 acted-this-turn,
skillId-scoped cost) — none blocks a hero — plus the content-authoring work itself.

Cosmetic follow-up (zero mechanical consequence, batch anytime): an `isHidden`/"invisible" skill flag
(one minor real predicate — Sera's Eyes of Vengeance keys on "non-Invisible" enemy skills).

## Wave 1 — ✅ COMPLETE (implemented + tested, 2026-08-13)

All four built in `game/engine`, covered by `test/{shield,selection,duration,channel}.test.ts`
(94 engine tests green): the Shield system (instance pool + timed expiry + break events),
named-status/template selection, status-duration manipulation (delta/computed/read), and
the Channel construct. Detail retained below for reference.

## Wave 1 — foundational, build first (in order)

1. **Shield system** — *critical, 58 skills.* The single biggest blocker. The engine
   *reads* `{ref:'shield'}` and the damage pipeline *absorbs* it, but **nothing writes
   it** (verified: no effect op, no `shield` status kind). Add
   `grantShield{amount:Value, to?, duration?}`, a spend/modify path, and `shieldBroken` /
   `shieldDamaged` trigger events. Blocks Keeper, Roland, Saya, Gaia, Jarrik, Taryn, Fate,
   Maggie, Sera outright.
2. **Named-status & minion-template selection/counting** — *high, ~14.* Selectors/counts
   key only on `StatusKind` and `kind:'hero'|'minion'` — never a status **name** or a
   minion **template**. So "count Cinders marks", "all Seedling minions", "every Fox Fire"
   are impossible. Add `name?` to `filter`/`count`, a `template?` filter to minion
   selectors, and let `summon` tag/bind what it creates. Foundational — later primitives
   need to name what they operate on.
3. **Status-duration manipulation** — *high, ~13.* Durations are static `number|null`.
   Add `durationDelta` to `modifyStatus`, allow `duration:Value`, a `{ref:'statusDuration'}`
   read, and a `tickOwner`/`thisTurn` mode. *(Audit correction: "refresh to N" is already
   expressible by re-applying the status; the real gaps are extend-by-delta, reading
   duration, and computed durations.)*
4. **Channel construct** — *critical, ~23 (roster-wide).* The `Channel` tag has zero
   behaviour. Needs a caster-owned effect re-run each turn until interrupted, a queryable
   `channeling` status, an interrupt-on-new-skill/stun model, and a `doesNotInterrupt`
   opt-out. Central to Galazax, Zev'kir, Laria, Fate. Depends on #3.

## Wave 2 — ✅ COMPLETE (implemented + tested, 2026-08-13)

Built in `game/engine`, covered by `test/wave2.test.ts` (106 engine tests green): outgoing-damage
modifier, cost/cooldown mutation, delayed/scheduled effects (+ status `onExpire`), the expanded
trigger-event vocabulary (+ `eventTargets`), and the audit's additions — type/source-scoped damage
immunity, `regen` (heal-over-time), a `requires` cast-gate, `uncounterable`, and `heal_lock` (anti-heal).
The only deferred audit item is the "does-not-break-Veiled/Stealth" flag (there is nothing to break yet —
the stealth-break-on-action rule is not implemented). Detail below for reference.

## Wave 2 — high-frequency systemic

5. **Outgoing-damage-modifier status** — *~10.* All damage-mod statuses are defender-side.
   Add an attacker-side `outgoing_damage_mod` summed before mitigation. *(Audit: only for
   **lingering** dealer-side buffs/debuffs — within-cast bonus damage is just a `Value` in
   `damage.amount`.)*
6. **Expanded trigger events** — *~15.* Add `statusApplied`, `statusExpired`,
   `healReceived`, `skillReceived`, `skillRedirected`, `counterFired`, and an
   `eventTargets` plural. Unblocks reactive passives and makes reflect observable.
7. **Skill cost + cooldown mutation** — *~18.* `cost`/`cooldown` are static metadata no
   effect touches. Add per-unit `cost_mod` / `cooldown_mod` statuses (+ optional `Value`
   cost fields).
8. **Delayed / scheduled effects** — *~5 (after audit).* `schedule{delayTurns, effect}`
   and per-cast `watch{on, window, do}`. *(Audit: many "following turn" cases are
   self-coupling — a self-status the caster's own later skill reads — needing no scheduler.
   Genuine scheduling only where there's no owning re-cast, e.g. `maggie2`, `scratch6`.)*

## Also missing (surfaced by the audit — fold into Wave 2)

- **Type/source-filtered damage immunity** — `damage_ignore` is all-or-nothing; `saya4`
  ("ignores affliction only"), `maggie5` ("ignores Curse of Thorns only") need a scoped
  immunity.
- **Heal-source restriction / anti-heal** — no status filters incoming healing (`fate0`
  "healed only by his own skills").
- **Skill castability preconditions** — a declared `requires:Condition` gate distinct from
  in-effect `if` (which still pays cost/cooldown). ~6 gates: `ando5` (only while
  Supercharged), `galazax6`, `zephyrex3`.
- **Counter-immunity as a status** + conditional `Uncounterable` (`gommar3` while
  Frost-Covered, `hector3`).
- **Heal-over-time / regen** — the symmetric twin of `dot`. Common (~7): `dennis5`,
  `hector2`, `taryn2`.
- **"Does not break Veiled/Stealth" per-skill flag** (`aramao1`, `aramao2`).

## Wave 3–4 — hero-local, treat as isolated tickets (do NOT block the roster)

- **Unit lifecycle**: `transform` / `destroy` / `revive` (Eagle growth, `fate6` revive).
- **Skill invocation / delegation / copy** (`dennis6`, Trinity dispatchers, `xyris5` echo).
- **Positional model** (Aramao's "across from") — high cost, ~1 hero of reuse; candidate
  for **redesign** to avoid lanes.
- **Composite unit** (Trinity: death derived from member minions), **reaction suppression**
  (Titania's Whimsy), **guardian redirect** (Taryn), **untargetable** status.
- **Cross-hero identity/rebinding** (the entire Hector→Dennis coupling) — high complexity,
  two heroes; consider a lighter design.

## False gaps — already expressible (do NOT build)

- **"Skill-modifier layer" for self-augmentation** — a hero conditionally changing its
  *own* skills is plain `if`/`forEach` reading its own state (exactly Ando's charge
  system, which authored fine). Only genuinely *cross-hero* skill modification is a real
  gap.
- **Status "refresh"** — re-applying overwrites the remaining duration.
- **Within-cast bonus damage** — a `Value` expression in `damage.amount`.
