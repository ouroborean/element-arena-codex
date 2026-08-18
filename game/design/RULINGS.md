# RULINGS — the rules the export never stated

The codex export gives us every skill's cost, cooldown, class, element and prose
description — but **not the rules those descriptions assume**. "For 1 turn" appears
136+ times and means different things depending on when the counter ticks;
"permanently" appears 47 times with no scope; nothing anywhere defines what wins a
match. If those rules get implicitly baked into hundreds of call sites, correcting
one later is a rewrite.

So every open question gets **one named constant, one chosen default, and its
evidence**, recorded here and in [`../content/rulings.json`](../content/rulings.json).
Code reads the JSON; golden replay tests are parameterized over it. Flipping a
default is a one-line change that produces a **measurable diff** in the test
snapshots — not an archaeology project.

> **Oracle = faithful reconstruction** (see [DECISIONS.md](DECISIONS.md) · D1). These
> defaults are **provisional** — they exist to unblock *engine scaffolding*, not to
> stand as the final rules. The authoritative answer for each comes from the original
> **GDScript**, then the **designer**, then the description. When the source lands,
> resolve each ruling from code, flip the default here, and review the golden-test
> diff. Engine work proceeds on defaults now; **final content does not freeze against
> an unresolved `designer_question: true` ruling.**

## How to use this

- **Never** hardcode one of these values at a call site. Import the constant.
- When you author a skill whose behaviour depends on one of these, reference the
  constant by name in a code comment so a later flip is greppable.
- When the designer answers, change the default here + in `rulings.json`, run the
  golden suite, and review the diff. That diff is the blast radius.
- Confidence: **HIGH** = grounded in the glossary/data · **MED** = inferred from a
  strong signal · **LOW** = genuine guess, on the designer list.

---

## Summary

Legend: **✔ = designer-confirmed (authoritative)** · ● = still on the designer list.

| Constant | Default (short) | Conf. | Ask? |
|---|---|---|---|
| `WIN_CONDITION` | round = battle to elimination; match = best-of-N | **✔** | — |
| `HP_CARRYOVER` | HP resets to full each round | **✔** | — |
| `FUSION_MODEL` | **unilateral** — one hero transforms, borrows a teammate's element | **✔** | — |
| `ENERGY_POOL_SCOPE` | per-team shared pool | **✔** | — |
| `DURATION_ANCHOR` | ticks at the applier's turn-end | **✔** | — |
| `PERMANENT_SCOPE` | round-scoped (follows from fresh-battle rounds) | **✔** | — |
| `ENERGY_INCOME` | +1/living hero; Essence consumed → element **instead of** generic | **✔** | — |
| `MULTIPLIER_COMPOSITION` | flats first, then multiplicative (×2·×2 = ×4) | **✔** | — |
| `ROUNDING` | round down (floor) | **✔** | — |
| `MINION_CAP` | 6/player; Trinity's Rangers count normally | **✔** | — |
| `RESOLUTION_ORDER` | staging order = resolution order | MED | — |
| `MITIGATION_ORDER` | mods → ignore → DR → shield | MED | — |
| `DAMAGE_CHANNELS` | **two** channels: incoming-mods vs DR | HIGH | — |
| `IS_NEW` | a skill instance initiated this resolution | MED | — |
| `ROUNDS_PER_MATCH` | up to 5, first to majority (exact N open) | LOW | ● |
| `FIRST_PLAYER` | simultaneous commit; seeded tie-break | LOW | ● |
| `ACCUMULATORS_READ` | post-mitigation | LOW | ● |
| `FUSION_PARTNER_RULES` | fuse once/match ✔; partner-alive/cost open | MED | ● |
| `DEFAULT_STACK_POLICY` | refresh unless text says "stacks" | MED | — |
| `MINION_HP_SOURCE` | glossary wins the 6 conflicts | MED | — |
| `IMMORTAL_SCOPE` | floors at 1 vs all sources | MED | — |
| `REDIRECT_DEPTH_CAP` | cap 4; user pinned to caster | safety | — |

Full evidence for each is in `rulings.json`. The load-bearing ones are expanded below.

**Ten confirmed (2026-08-13):** fresh-battle rounds with HP reset, unilateral fusion
(once per match), per-team energy pool, Essence-consumed income, applier-anchored
durations, round-scoped "permanent", floor rounding, multiplicative multipliers, and a
6-minion cap (Trinity's Rangers count). These drive the P1 MatchState + damage pipeline.

---

## The load-bearing four

### `DAMAGE_CHANNELS` — two defender channels, not one (HIGH)
The single most likely source of silent, systematic balance drift. The glossary
proves **incoming damage-mods** and **Damage Reduction** are different things:
Piercing *ignores DR* but "interacts normally with damage boosts", so a `+5
received damage` effect (gommarwinter0) must still apply to a Piercing hit while DR
does not. Implement two ordered subtraction stages with different bypass masks.
Merging them disables a whole class of effect against all **53** Piercing skills and
misprices ~a quarter of the roster. Property test both in P1.

### `FUSION_MODEL` — unilateral, additive, re-denominating ✔ CONFIRMED
**Only the initiating hero transforms.** It borrows a living teammate's base element;
its new element = `recipe(hero.element, teammate.element)`. The teammate is unchanged
and keeps its base kit. For the fusing hero: the fusion passive swaps into slot 0, the
fusion active appends as skill 7, `currentElement` changes, and every *specific* energy
pip on **its** base skills, fusion skills and minions re-denominates to the fusion
element. The teammate's pips are untouched. This is simpler than a mutual model — team
state changes for one hero per fusion, not two — but a hero still needs a teammate with
a valid partner element (455 of 2,925 three-hero teams can never fuse at all). Open
sub-questions in `FUSION_PARTNER_RULES`: partner-alive requirement, re-fusion limit.

### `ENERGY_POOL_SCOPE` ✔ CONFIRMED / `ENERGY_INCOME` (MED, ask)
Pool is **per-team, shared** — any hero draws from it; minions spend but generate none.
Income is still inferred: at a team's turn start, +1 generic per living hero, plus +1 of
a hero's element per hero with Elemental Essence; Silence suppresses a hero's Essence.
**Ask the designer for the real income numbers** — the whole cost curve (265 skills free,
slot-1 actives ~1 pip) is priced against them.

### `HP_CARRYOVER` + `WIN_CONDITION` — match structure ✔ CONFIRMED
A round is a **fresh battle**: HP resets to full at `ROUND_START`, round-scoped effects
and "permanent" buffs clear, a team loses the round when all 3 heroes are dead, and the
match is best-of-N (exact N still open → `ROUNDS_PER_MATCH`). This drives the P1
MatchState reset procedure and the turn-scheduler loop.

---

## Turn structure

The canonical phase list the scheduler implements. Validated against the ~60 "each
turn" skills. Bracketed gates reference the effects that toggle them.

```
ROUND_START  (apply HP_CARRYOVER, reset round-scoped state, resolve start-of-round passives)
  └─ per team turn:
       TURN_START(side)
       ESSENCE_GAIN        [gated by Silence]
       COOLDOWN_ADVANCE    [gated by Paralysis]
       PLAN                (both sides stage actions; nothing resolves)
       COMMIT              (assignments lock — RESOLUTION_ORDER frozen here)
       RESOLVE             (staged actions resolve in staging order, interleaved by initiative)
       DOT_TICK            (Affliction / damage-over-time)
       TURN_END
       DURATION_DECREMENT  [DURATION_ANCHOR fires here for the acting side]
       EXPIRY              (remove effects whose duration hit 0; run on-expire hooks)
ROUND_END    (check WIN_CONDITION; if match continues → AUGMENT_OR_FUSE draft → next ROUND_START)
```

Two things this ordering makes explicit:
- **Cancelled ≠ expired.** Channel/Control skills cancel mid-flight (their user is
  stunned or acts again); that is a different branch from a duration reaching 0.
  Both must run distinct hooks.
- **Delayed payloads** ("at the end of his next turn") are a pending-action queue
  drained at the owner's `TURN_END`, before `DURATION_DECREMENT`.

---

## Designer questions — the batch list

Ten questions, each answerable in a sentence, several of which unblock whole
characters. Send before writing effect logic; proceed on defaults meanwhile.

> Resolved 2026-08-13: unilateral fusion (once/match) · fresh-battle rounds + HP reset ·
> shared team pool · Essence-consumed income · applier-anchored durations · floor
> rounding · multiplicative multipliers · 6-minion cap (Rangers count) · Ranger + Keeper
> naming. Remaining open questions:

**Content-defining (block specific heroes):**
1. **"Enhanced" / "Augmented"** — what does a skill being "enhanced" concretely change?
   Gates **23** skills across **Ando, Black Knight, Gommar, Saya**; undefined anywhere.
2. **"Basic skills" / "Ultimate"** — define the buckets; maggielich0's Revenant copies
   "their 3 Basic skills" (3 "basic" refs, 1 "ultimate" ref).
3. **`deploy_mark`** — the augment flag's meaning.
4. **Syl's Eagle** — the growth-ladder stages and HP-equalization rule (defer to Syl).

**Engine-tuning (have provisional defaults; low stakes):**
5. **Match length** — exact N for best-of-N (`ROUNDS_PER_MATCH`).
6. **Initiative** — who acts first / tie-break each turn (`FIRST_PLAYER`).
7. **Accumulator reads** — stored-damage/shield scaling read pre- or post-mitigation
   (`ACCUMULATORS_READ`).
8. **Fusion partner rules** — must the partner be alive; does fusing cost the partner
   or void old-passive augments (`FUSION_PARTNER_RULES`, re-fusion already settled).
