# Fidelity Campaign 3 — remaining roster-wide skill approximations

**Status of this document:** a complete, single-source list of the skill-fidelity gaps a roster-wide
audit (workflow `wf_f3a7b9d1-e81`, 2026-08-20) surfaced *beyond* the enumerated debt that Campaign 1
(engine fidelity, PRs #33–52) and Campaign 2 (visibility, PRs #53–64) already closed.

**Read the verification caveat first.** The audit scanned all 96 authored notes containing debt-language
and classified them: **38 WORKING_AS_INTENDED**, **5 STALE_NOTE**, **53 REAL_GAP**. The 53 are
**flagged, not confirmed** — the audit demonstrably over-flags (see False Positives below: Merciless is
fully implemented). So **PR 0 is a verification pass**: independently confirm each item against shipping
code *before* fixing it. Numbers here are the audit's; treat them as leads.

**Guiding principle (per user feedback):** most of these are a *missing gate/flag* or a *narrowed scope*,
not a missing system. Before writing a primitive, confirm an existing one doesn't already express it. Each
item below names the **primitive** the fix should use and a size — **S** (one-line/small content edit on an
existing primitive), **M** (a few edits or one small engine addition), **L** (new primitive + several
wire-ups, or a multi-part unimplemented suite). Batch same-primitive fixes into one PR.

---

## Progress

- **PR 0 — verification pass: COMPLETE** (adversarial, `wf_d45665c2-711`). Of the 53 flagged: **49 CONFIRMED
  + 3 PARTIAL = 52 real**, **1 FALSE_POSITIVE (Merciless — removed)**. Sizes: **22 S / 22 M / 8 L**; 20 need a
  new primitive but they cluster into the ~8 below (notably one `eventSourceId`/`eventViaSkill` condition
  unlocks 4–5). Verified per-item fixes: `scratchpad/verified_gaps.json`.
- **PR 1 — visibility misses: DONE** (merged): maggie:grave Bloodrose Offering `isHidden`; saya Kinetic
  Converter augment restored `isHidden` + the dropped Enhanced→Plasma Charge branch; zev'kir Static Maelstrom
  `cost_mod`→`cost_currency_remap` (×3 sites).

---

## Existing primitives to reuse (verify each is present in PR 0, then wire — do NOT rebuild)

- `eventHasTag` — class-tag test on skillUsed/skillDeclared (used by Sera).
- `eventStatusKind` (+name) — which status the statusApplied/Expired event carried (ast.ts).
- `statusLost` event — emitted by the removeStatus op (added PR #43); "or is removed" / "on consume" hooks.
- dynamic `costMods` (Value magnitude, per-cast) — sera-style scaling cost (added PR #37).
- `cost_currency_remap` — a skill's Specific cost payable as Generic (added PR #34).
- `stackSum` — sum of a named stack's magnitude across a selector (audit reports interpret.ts:244; **confirm**).
- `stack_read_mod` — treat a unit as holding N stacks of a resource.
- skill-id-scoped `skill_damage_bonus` / `cost_mod` (skillId field) — per-named-skill bonuses.
- `skill_targeting_override` — retarget a named skill (added PR #36).
- `conditional_bypass` — damage ignores DR/Shield vs targets meeting a condition (added PR #48).
- `uncounterableIf` / an `uncounterable` status — "cannot be countered/reflected".
- `isHidden` / status `invisible` + redactState — the visibility system (Campaign 2).
- `grantStunImmunity` + "Stun Immunity" status — true stun immunity (audit reports augment_effects.ts:45; **confirm**).

## Genuinely-new primitives needed (the short list — everything else reuses the above)

1. **Per-hit damage source override** — `forEach enemy → damage`, attributing each hit to `it` (the enemy),
   not `ctx.caster`. A `source?` field on the damage op (or forEach rebinding caster). Unlocks dennis4/Fury.
2. **`incoming_heal_mod` status kind** — read by `applyHeal` (damage.ts). Unlocks ayana "+N healing received".
3. **Unstunnable skill flag** — a `SkillDef` flag `isStunnedFor` exempts. Unlocks "this skill cannot be stunned".
4. **`modifyStatus` magnitude clamp/floor** — an option so a decaying magnitude stops at 0 instead of flipping
   sign. Unlocks the gommar3 buff-flip bug. (Alternatively re-model the decay as duration-based.)
5. **`eventSkillId` condition** — match the event's `sourceId` (the skill that caused it). One small Condition
   unlocks several scoped-trigger fixes (Consecrate exclusion, Worldfist-scope, Voice-of-Light-scope, pyrrha).
6. **Two-component / per-channel cost reduction** — "-1 Generic AND -1 Specific" as two independent
   reductions rather than one −2 scalar. Small extension to the cost model. Unlocks scratch3.
7. **"Affected by a skill" hook** (targeted, not damaged) — for Black Knight "all enemy targets affected".
   May be expressible via skillUsed `affected`/`targets` on a trigger; confirm before adding an event.
8. **Fusion base-skill metadata patch channel** — let a fusion re-author a *base* skill's cost/targeting/legal
   targets (not just append effects). Unlocks gaia "Branch of the World Tree". (Merciless needed this per the
   audit but is already done another way — see False Positives.)

---

## False positives / stale — EXCLUDE from the fix work (confirm in PR 0, then delete the stale note)

- **#17 Merciless (blackknight:evil)** — **CONFIRMED false positive.** Clause 2 (+10 on ally kill) IS wired
  (`unitDied` + eventSource==self + eventUnit isFaction ally → permanent +10). Clause 1 (target allied Heroes)
  works via the engine's faction-free `legalTargets` + the client's ally-offering (PR #52). Nothing to do.
- **#48 zevkir Atlantean (dup)** — same node as #47; the "no stun-immunity exists" premise is stale
  (`grantStunImmunity` exists). Fold into #47.
- Watch for stale "removeStatus emits no event" notes (#25, #45) — `statusLost` exists since PR #43.
- Watch for stale "no primitive / cosmetic isHidden" notes — the primitives now exist (Campaigns 1–2).

---

## PR plan (ordered: quick existing-primitive wins first, true bugs early, big suites last)

### PR 0 — Verification pass (no code)
Independently confirm each of the 53 against shipping code; drop false positives (Merciless), confirm the
"primitive exists, unused" claims (stackSum, grantStunImmunity, eventStatusKind, cost_currency_remap). Output:
a de-duplicated, confirmed gap list. Run adversarially (a skeptic per item) — the audit over-flags.

### PR 1 — Visibility misses (existing: `isHidden` / `cost_currency_remap`) — S
- **#30 maggiegrave1 Bloodrose Offering** — "This effect is invisible" not applied → set `invisible:true` on the mark.
- **#49 saya4 Kinetic Converter** — the augment's `replaceSkill` drops `isHidden:true` (base saya4 has it) → restore it.
- **#44 zevkir Static Maelstrom** — "while Channeling, costs become Generic" uses a magnitude-less `cost_mod`
  (no-op) → use `cost_currency_remap` instead.

### PR 2 — statusApplied over-fires → gate on `eventStatusKind` (existing) — S
All fire on *any* status landing while a state holds, instead of on the specific status being applied:
- **#7 ando:battery Capacitor Upgrade**, **#8 ando:reanimation heal-on-Charged** — gate on the Charged/Supercharged status being *applied*.
- **#50 dennis1 Auto-Injectors** — gate on a *stun* being applied (not "while holding a stun").
- **#42 / #74 titania Ritual Power** — gate on *elemental_essence* being gained (not any status on an essence-holder).
- **#36 (part) pyrrha Burning Plasma** — gate on *Fan the Flames* being applied (name-match), not any status on a burning enemy.

### PR 3 — "ends on new skill / or is removed" → `skillUsed` self-trigger + `statusLost` (existing) — S/M
- **#45 pyrrha Flickering Form** — heal should fire on "expires **or is removed**" → add a `statusLost` branch (mirror the Gommar/Flashfreeze fix from PR #43).
- **#35 pyrrha Blastoff** — 2-turn Invulnerable should end early "when she uses a new skill" → add a `skillUsed` self-trigger that removes it.
- **#21 jarrik Cindersprig Brew** — +5 buff "ends if they use a new skill" → same self-trigger on the buffed unit.
- **#25 jarrik Blazer Board** — Invulnerable "whenever Jarrik consumes a Cinders mark" → a `statusLost` (Cinders) trigger (works for the whole base kit, not just Pop Off).

### PR 4 — tag / team gates (existing `eventHasTag`; small `eventTargetsTeam` if needed) — S
- **#5 aramao Trial of the Sands** — retaliates on "any enemy that uses a **Harmful** skill on him" → add `{eventHasTag:"Harmful"}` to the trigger `when`. **(One-line — the example the user flagged.)**
- **#51 pyrrha (Flames on enemy skill)** — should require the enemy skill target Pyrrha or an ally → a team-targets test on `eventTargets` (extend `declaredTargetsSelf` to a faction variant if none exists).

### PR 5 — quick existing-primitive wires — S
- **#34 pyrrha Judgment Day** — "cannot be countered or reflected" → add `uncounterableIf`/uncounterable.
- **#47 (+#48) zevkir Atlantean Waters** — "ignores stuns" → use `grantStunImmunity` instead of per-tick stun-wipe.
- **#52 laria4 Nightwalker** — "Bypass" mark is inert → apply `conditional_bypass` to the 3+-stack holders.

### PR 6 — stack-magnitude reads → `stackSum` / `stack_read_mod` (existing) — S/M
- **#1 saya Well-Used Panic Button** — detonation counts mine-*bearing* enemies → use `stackSum` of Spider Mine.
- **#29 laria Ritual of Culling Night** — "1 Ritual Power per **stack**" counts *holders* → `stackSum` of Deepening Shadows.
- **#28 laria:ninja Shadow Clones** — clones should "count as Deepening Shadows stacks" → `stack_read_mod`.

### PR 7 — scoped triggers → new `eventSkillId` condition, then wire — M
One new Condition (`{eventSkillId: "<id>"}`, matching the event `sourceId`) unlocks:
- **#12 Hallowed Footsteps** — exclude Consecrate's own dot ticks (`not eventSkillId Consecrate`).
- **#19 Roiling Life** — scope to Worldfist damage, not all Gaia damage.
- **#31 pyrrha Ice Age**, **#32 pyrrha Flames-on-dot** — scope to the intended source skill / dot tick.

### PR 8 — cost fidelity — S/M
- **#6 sera6 Divinity Engine** — "-1 Specific per dead ally" → dynamic `costMods` (Value magnitude; primitive exists, unused).
- **#41 titania (non-Strategic cost)** — the `scope{tag:Strategic,except}` on the cost_mod is recorded but
  `effectiveCost` ignores it → make `effectiveCost` honor the tag scope. (Small engine fix.)
- **#4 scratch3 Deal: Realize Your Potential** — "-1 Generic AND -1 Specific" is a flat −2 → new two-component cost reduction (primitive #6).

### PR 9 — true bugs (wrong output) — M/L
- **#46 gommar3 Winter's Howl** — decay has no floor → on the 4th use the −15 debuff flips to a **+5 buff** for the enemy. Add a `modifyStatus` clamp (primitive #4) or re-model the decay.
- **#2 dennis4 Shared Agony / #51 dennis4 augment** — retaliation/fanned hits credited to Dennis, not each enemy → **Fury taunts the wrong unit.** Per-hit damage source override (primitive #1).
- **#53 trinity4 The Power of Friendship** — augment `appendEffect`s the Ranger *minions'* Lens skills but is applied to the Trinity *hero* (which lacks them) → apply to the minion templates (mirror the Trinity minion pattern).

### PR 10 — new status primitives — M
- **#9 ayana Blessed Leylines** — "+5 healing received from all sources" is an inert mark → new `incoming_heal_mod` (primitive #2), read by `applyHeal`.
- **#10 ayana Verse of Ascension** — "this skill cannot be stunned" → new Unstunnable flag (primitive #3).

### PR 11 — targeting overrides → `skill_targeting_override` (existing) / targeting-pool — M
- **#43 titania (auto-target marked)** — "marked enemies are automatically targeted by Arcadian Duet and Jolt" → `skill_targeting_override`.
- **#62 sylvan Swoop (stunned-ally invuln)** — the invuln branch can't be aimed at an ally because Swoop's pool is enemies-only → allow the ally target (client/targeting, à la Black Knight #52) or a Helpful sub-pool.
- **#79 zephyrex (Ominous Rumble retarget)** — marked-enemy auto-target for Arcadian Duet/Jolt (same family).

### PR 12 — ayana Voice-of-Light-scoped clauses — M
Base Voice of Light (ayana1) must read the marks the fusion applies:
- **#11 Prism Sentence** — enemy takes double damage from VoL; casting VoL also casts it on the enemy team (Bypassing). (Illumination reveal sub-part already done in Campaign 2.)
- **#13 Divine Ire** — consume the +5 stack for bonus VoL damage.
- **#14 Word of the Law** — the +10 is scoped to VoL only, not all incoming damage (skill-id-scoped incoming mod / `eventSkillId`).

### PR 13 — Black Knight fusion — M
- **#15 Plaguebringer** — the base "Exile" enhanced-state maintainer (an origin-less base trigger) is dropped by default replace-mode fusion → preserve it so the permanent 5-affliction dot arms.
- **#16 Hellfire**, **#18 Ethereal Form** — "affected by a skill" approximated as "damaged by" / "targeted while holding an ignore status" → use the affected/targets hook (primitive #7) once its shape is confirmed.

### PR 14 — gaia fusion — M
- **#3 gaia3 Channel Vitality** — window is a duration-1 mark (bleeds into next turn) and heals for *any* allied
  minion → scope to "this turn" and to Gaia's own summons (a `summoner` test).
- **#20 gaia Branch of the World Tree** — passive that re-authors Channel Vitality's cost/targeting/legal-targets
  installs nothing → fusion base-skill patch channel (primitive #8).

### PR 15 — taryn fusion — M
- **#38 taryn (Radiant Glory)** — during Radiant Glory, taryn3/4 should auto-cast Holy Word: Peace (taryndivine1), not base Refrain (taryn2) → conditional swap in the existing auto-cast wiring.
- **#39 taryn Wingman** — base Stalwart Shield should stop granting Taryn Shield and become "fully Invisible" → augment patches the base skill (null the shield-grant node + set `isHidden`).

### PR 16 — titania misc — M
- **#40 titania Arcadian Advancement** — "all my applied effects last +1 turn per stack" — the counter accrues
  but nothing reads it → a duration-bonus read on the applied-status path (new small primitive or a status the
  duration stamp consults).

### PR 17 — jarrik fusion suite (largest; may split into 2–3 PRs) — L
- **#22 Brimsteel Scabbard** — arm a rider on the next Blade of Ashes (triple damage, uncounterable, Cinderling
  on Cinders-hit) → `skill_damage_bonus` + `uncounterable` + a consume-on-use (mirror empowerThornPrick / the
  removeMarkOnSkillUse pattern).
- **#23 Chains of Sloth** — "+1 cost each turn" escalation + "-1 per skill the target uses" decay → scheduled
  `modifyStatus` + a `skillUsed` decay trigger.
- **#24 Drakken (Cinders lock)** — "Jarrik can no longer apply/trigger/consume Cinders" → gate his Cinders
  interactions on the absence of the Drakken mark.
- **#26 Blue Flame Spirits** — Cinderling summons replaced by Azure Sparkling minions → new minion template +
  a summon-replacement hook. **(Genuinely new content — no template exists.)**
- **#27 Dawnbreak** — Dawnbreak-applied Cinders "cannot be consumed to create Cinderlings" → a non-consumable
  Cinders variant (a flag on the mark the consume path checks).

---

## Not in scope (already correct) — for completeness

- **38 WORKING_AS_INTENDED**: deliberate design rulings + implemented custom-fn escape hatches that faithfully
  realize the frozen text. No action.
- **5 STALE_NOTE**: the mechanic is implemented; only the note's debt-language is obsolete. Clean the notes
  during the touching PR.
- Source of truth for the full classification: audit output `wi4g1p45g` /
  `scratchpad/real_gaps_full.json`.
