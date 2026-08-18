# @arena/engine — rules engine kernel (P1)

The deterministic, serializable core of the game. No framework, no DOM, no I/O — it
takes a `MatchState` and effect inputs and produces a new state. The same code will
run on the client (prediction) and the server (authority).

## Run

```bash
node --test          # 289 golden tests, zero install (Node 24 type-strips TS)
npm run typecheck    # strict tsc --noEmit (needs `npm i` once, for typescript)
```

No build step: Node 24 executes the `.ts` sources directly via type-stripping.
TypeScript is a dev dependency only, used for `tsc --noEmit` type-checking.

## What's here (increment 1)

| Module | Responsibility |
|---|---|
| `rulings.ts` | Machine form of the confirmed rulings the engine reads. Flipping one changes behaviour + a golden diff. Mirror of `../content/rulings.json`. |
| `rng.ts` | Deterministic mulberry32 PRNG; whole state is one uint32 → serializes into `MatchState`. Every source of chance draws from it (replays, netcode). |
| `types.ts` | `MatchState`, `Unit` (hero\|minion), `Team`, `Status`, `EnergyPool`. All plain serializable data. |
| `damage.ts` | **The two-channel damage pipeline** (ruling `DAMAGE_CHANNELS`) + heal + non-damage health loss. |
| `status.ts` | Status apply/refresh/stack + duration ticking anchored to the applier's turn-end. |
| `effects/ast.ts` | **The effect DSL** — the serializable node tree every skill authors into. |
| `effects/interpret.ts` | The interpreter: resolves selectors/values, runs effects, deterministic via the rng. |

## The effect DSL (increment 2)

Skills are **data, not functions** — a tree of effect nodes (`damage`, `heal`,
`applyStatus`, `addStack`, `summon`, `if`, `forEach`, `seq`, `custom`) whose amounts
are `Value` expressions (literals, `stackCount`, `missingHp`, `count`, arithmetic) and
whose targets are `Selector`s (`self`/`target`/`caster`, factions, `pick` random/
lowest/highest, status filters). Every node carries an optional `id` so an augment or
fusion passive can **address and rewrite one node** — the bet the whole metagame rests
on (`test/effects.test.ts` proves a 10→15 damage patch). A `custom` escape hatch covers
the ~3% of skills that need native code.

`test/effects.test.ts` transcribes real skills (`gommarglacier1`, `gaia2`, `gaiagrave1`,
`laria3`'s conditional True-damage) straight from their prose and asserts the numbers.

## The load-bearing decision: two defender channels

`damage.ts` encodes, as a per-type capability mask (never as if-chains), that **incoming
damage-mods** and **Damage Reduction** are different subtraction stages:

| Type | incoming mods | Damage Reduction | Shield |
|---|:---:|:---:|:---:|
| normal | applies | applies | applies |
| piercing | applies | **ignored** | applies |
| affliction | applies | **ignored** | **ignored** |
| true | **ignored** | **ignored** | **ignored** |

`Damage Ignore` zeroes any type; `Shatter` suppresses DR + Shield; `Immortal` floors HP
at 1 (including against non-damage loss). Each row is a golden test in
`test/damage.test.ts`.

## The turn scheduler (increment 3) — `scheduler.ts`

Makes a match *runnable*. Implements the `RULINGS.md` phase machine on the confirmed
rulings: alternating team turns keyed on the monotonic `state.turn`; `startRound`
resets HP + clears round-scoped statuses + resets cooldowns (fresh battle); `startTurn`
grants shared-pool energy income and advances cooldowns (gated by Paralysis);
`performAction` validates legality (alive / not stunned / off cooldown / can pay), pays
the cost (GENERIC from any energy, SPECIFIC from the skill's element), runs the effect
tree, and sets the cooldown; `endTurn` ticks the acting team's applied durations then
hands over; `roundWinner`/`endRound` decide the round (all 3 heroes dead) and the
best-of-N match. `test/scheduler.test.ts` plays a full 1v1 to a deterministic win.

## First authored hero (increment 4) — `content/`

`content/heroes/pyrrha.ts` transcribes Pyrrha's 5 active skills from their exact prose
into DSL trees; `content/hero.ts`'s `loadHero` instantiates her onto a team. Authored
content lives beside the engine and is type-checked by tsc, so a bad effect node is a
compile error. `test/pyrrha.test.ts` asserts her real numbers: Fan the Flames' 15 + 5×3
Affliction burn, Pyrokinesis amplifying that burn 5→10, Feed the Fire's conditional
damage, Flashbang's non-Strategic stun + self-Invulnerable, and Wraith in White making
Pyrokinesis lead with Fan the Flames.

Authoring her drove three general engine additions: DoT ticking (`scheduler.tickDots`),
the `modifyStatus` primitive, and **tag-based stun scoping** (stuns key off class tags
like "Strategic", not slot-class — a correctness fix surfaced by real content).

## The reactive trigger bus (increment 5) — `events.ts` + `interpret.ts`

The engine emits `GameEvent`s (`damageDealt`, `unitDied`, `skillUsed`, `turnStart`,
`turnEnd`, `roundStart`); units carry `TriggeredEffect`s that react. A trigger runs its
effect tree in a context with the event bound, so effects can address `eventSource` /
`eventTarget` / `eventUnit`. The bus:

- **depth-guards** re-entrant chains at `MAX_TRIGGER_DEPTH` (4) — reflect/react ping-pong terminates
- fires triggers in **deterministic order** (team A then B, unit order)
- honours **Stealth**: a stealthed actor doesn't set off its enemies' triggers

Pyrrha's passive **Burning Up** is now fully wired as two triggers — on-death (10
Affliction to all enemies) and on-damaged-by-a-Fan-affected-enemy (gain Essence) — and
tested.

### Counters & Reflects — the interrupt flow (increment 6)

A skill emits `skillDeclared` before its effects resolve; `resolveDeclaration` lets a
`counter`/`reflect` trigger intercept it. A **Counter** negates the skill (effects don't
run), puts it on cooldown, and runs its own effect (e.g. punish the attacker); it's
usually `once` (consumed). A **Reflect** redirects the skill's target (`redirectTo`,
default the reflector) and re-checks — so reflect-vs-reflect terminates at the bounce
cap. Conditions `declaredTargetsSelf` and `eventHasTag` express "counter the next
Harmful skill aimed at me". `test/counters.test.ts` covers all of it.

### Targeting legality (increment 7) — `scheduler.legalTargets`

Enforced at skill-cast time, from the skill's class tags: **Invulnerable** blocks new
Harmful targeting, **Isolated** blocks Helpful, **Bypassing** ignores both, **Taunt**
forces a single-target Harmful skill onto the taunter (the `Status.unitRef`), and
**Blind** retargets a single-target skill to a random valid unit (via the seeded rng).
A single-target Harmful/Helpful skill with no legal target is rejected
(`no-legal-target`) before its cost is paid; AoE skills simply skip illegal units.
`test/targeting.test.ts` covers each rule, and `pyrrha.test.ts` proves Flashbang's
self-Invulnerable actually stops an enemy attack.

### Minion lifecycle (increment 8) — `minions.ts`

Minions are summoned from named **templates** (`registerMinion`) carrying HP, element,
skills and triggers. The `summon` effect instantiates one, links it to its `summoner`,
and respects the 6-per-team cap. A new selector, `summoner`, lets a minion's skill reach
the hero that made it — so the Seedling's *Channel Earth* feeds Gaia's stacks
(`content/minions/seedling.ts`, real data). Dead minions are swept off the field
(`removeDeadMinions`, freeing a cap slot) while dead heroes remain for the win check;
`startRound` clears the field so round-start passives re-summon into a fresh battle.
`test/minions.test.ts` covers summon-from-template, the summoner link, the cap, death
cleanup, no-energy-from-minions, and the round refresh.

### Wave 1 gap-closing primitives (increment 9) — from `../design/ENGINE_GAPS.md`

Authoring the roster surfaced the missing primitives; Wave 1 closes the four
prerequisites:
- **Shield system** — `grantShield{amount:Value, to?, duration?}`, an instance pool
  (`Unit.shields`) absorbed in order, timed expiry at the applier's turn-end, and
  `shieldDamaged`/`shieldBroken` trigger events. Was the #1 blocker (58 skills).
- **Named-status & minion-template selection** — `filter`/`count` match a status by
  `{kind, name}`; minion selectors take `template`. ("count Cinders marks", "my Seedlings".)
- **Status-duration manipulation** — `modifyStatus.durationDelta`, `Value`-typed
  durations, and a `{ref:'statusDuration'}` read. (Refresh already worked via re-apply.)
- **Channel construct** — a Channel-tagged skill installs a `channeling` status that
  re-runs its effects each of the caster's turns; cancelled by Stun or by using a new
  skill (`doesNotInterrupt` opts out); finite via `channelTurns`.

`test/{shield,selection,duration,channel}.test.ts` cover them.

### Wave 2 gap-closing primitives (increment 10) — from `../design/ENGINE_GAPS.md`

- **Outgoing-damage modifier** — attacker-side `outgoing_damage_mod` status (normal/piercing only).
- **Cost & cooldown mutation** — a `cost_mod` status (via `effectiveCost`) + a `modifyCooldown` effect.
- **Delayed effects** — a `schedule{delayTurns, effect}` effect (fires at the caster's later turn-end)
  and a status `onExpire` hook (delayed-kill on duration lapse).
- **Expanded trigger events** — `healReceived`, `statusApplied`, `statusExpired`, `skillRedirected`,
  `counterFired`, plus an `eventTargets` selector.
- **Audit additions** — type/source-scoped `damage_ignore`, `regen` (heal-over-time, twin of `dot`),
  a `requires` cast-gate, `uncounterable`, and `heal_lock` (anti-heal).

`test/wave2.test.ts` covers all of it.

### Wave 3 — fidelity primitives (increment 11, small set)

`revive` + a `revive_ward` (lethal-hit interception, fate6), `transform` (retemplate-in-place with no
death, gaia5/syl5), `useSkill` (invoke a named skill inline, dennis6), an `isKind` condition (gaia3),
and a `sum` aggregate `Value` (blackknight2). Plus `untargetable` targeting (galazax). `test/wave3.test.ts`.

### Positional model (increment 12) — `slot` + across/adjacent/swap/shuffle

A 3v3 formation is 3 slots/side, so Aramao needed only a `Unit.slot`, the `across`/`adjacent` selectors,
and `swapPositions`/`shuffleTeam` effects — a compact model, not a board engine (`test/positional.test.ts`).

### The full roster (increment 13) — `content/roster.generated.ts`

All **27 heroes** are authored (`../content/roster.authored.json`, 139 skills + 13 minion
templates) and codegen'd into typed `HeroDef[]` by `../tools/build_roster.py`. The pipeline
is the oracle: structural validate (0 errors) → emit as TS literals (`tsc` checks every
node, 0 errors) → `test/roster.smoke.test.ts` loads all 27, resolves every skill, and
fires every passive without throwing. The ~3% of clauses the DSL can't express author a
`custom` node backed by a native handler in `content/custom_effects.ts` (8 ops / 6 heroes);
this pass added the `cooldown_mod` status primitive (`test/cooldownmod.test.ts`). Per-op
fidelity (faithful vs. tracked debt) is tabled in `../design/ENGINE_GAPS.md`.

### The match-setup layer (increment 14) — `content/match.ts`

The connective tissue that makes the engine *playable*: `buildMatch(draft)` turns a draft
(three hero ids per side + a seed) into a live `MatchState` — heroes looked up from the roster,
`loadHero`'d onto their teams in formation-slot order, pools empty (income arrives at turn start).
`playMatch(state, provider)` is the reference game loop over the `RULINGS.md` phase list: per
round `startRound` (fresh battle + summon passives) → alternating team turns of `startTurn` →
the provider's committed actions RESOLVE in staging order → `endTurn` (DoTs, durations, hand-off)
until a wipe → `endRound`, to a best-of-N decision (a turn cap surfaces a stalemate rather than
looping). The per-turn action set comes from an `ActionProvider` — player input in the client, or
`defaultPolicy` (a deterministic bot) for tests/replays. `scheduler.canUse` is the read-only
"is this skill usable right now" preview the provider and a future client both need.
`test/match.test.ts` builds a 3v3, plays full matches twice on one seed for identical results, and
runs mechanically-heavy cross-roster drafts; a full-roster sweep confirmed all 27 heroes play to a
deterministic winner with no crashes.

### The between-round metagame (increment 15) — `content/{fusion,augment}.ts` + `src/effects/patch.ts`

The P3 progression layer. **Fusion** (`content/fusion.ts`) is the once-per-match transformation:
`applyFusion(hero, form)` re-elements the hero, inserts the fusion active skill in the 4th slot
(kit stays 3 basics → [fusion] → defensive → ultimate, ultimate last), and swaps in the fusion
passive's triggers — persisting across rounds (startRound never touches skills/element). **Augments**
(`content/augment.ts`) are the cumulative upgrades: each is a list of declarative `Patch`es —
`addTrigger`/`removeTrigger`, `addSkill`/`replaceSkill`, `setSkillMeta`, `appendEffect`, and
`patchNode` (rewrite one `id`-addressed node inside a skill's effect tree — the surgery the whole
metagame bets on), plus a `custom` escape hatch. The node walker (`src/effects/patch.ts`) recurses the
four composite ops (`if`/`forEach`/`seq`/`schedule`). Every patch deep-clones before mutating, so one
hero's upgrade never leaks into the shared `HeroDef` or a teammate (proven in `test/augment.test.ts`).
`playMatch`'s `onBetweenRounds` hook is the AUGMENT_OR_FUSE seam; `test/fusion.test.ts` proves a
between-round fusion survives the next fresh battle. An adversarial review hardened three edges: the
node walker now descends into `applyStatus.onExpire`, the two divergent `findNode` copies are unified
into `patch.ts` (the walker that covers every composite), and fusion's passive swap keeps augment-added
triggers (via trigger `origin` provenance) so a later fusion never undoes an earlier augment.

**P3 content pass** (`content/{fusions,augments}.generated.ts`, via `tools/{validate_p3,build_p3}.py`
+ `test/p3.smoke.test.ts`): all **135 augments** are authored, validated, and **fully faithful** (22
custom fns backed by real handlers in `content/augment_effects.ts`, 6 documented partials). All **200
fusion forms** are authored, validated, and tsc-clean, but they encode **126 custom mechanics of which
120 are bespoke and PENDING handlers** — `content/fusion_pending.ts` registers tracked logged stubs for
those so the framework runs; the forms are captured as data, the 120 one-off handlers are the next big
step. See `../design/ENGINE_GAPS.md`.

## Engine status: the roster is authored, playable, and has a metagame

Both heroes once thought to need subsystems (Trinity, Aramao) turned out expressible with
small primitives; the full roster loads, resolves, **plays a full match end to end**, and now has the
between-round fusion/augment machinery. What's left:

- Bulk-author the 200 fusion forms + 140 augments into the DSL/patch format (the P3 content pass)
- Augment + fusion-skill authoring (P3) on top of the addressable-node DSL
- The base-kit custom-op debt is **closed** (all 14 `custom` handlers faithful — energy/essence
  model, acted-this-turn ledger, `uncounterableIf`, `skillGranted`, scoped `cost_mod`, AoE→single,
  `spendShield`; `test/debt.test.ts`). Remaining: the cosmetic `isHidden`/Veiled flag, and the
  event-team-scoping of a few pure-DSL turn-end passives (saya's Conduit) — see `../design/ENGINE_GAPS.md`

Everything above operates on the `MatchState` and primitives defined here.
