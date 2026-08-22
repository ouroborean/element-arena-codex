/**
 * Core domain types for the rules engine.
 *
 * MatchState is the single authoritative game-state object: fully serializable
 * (no functions, no class instances beyond plain data), so it can be snapshotted,
 * diffed, sent over the wire, and replayed. Effects operate on it; nothing mutates
 * the DOM or reaches outside it.
 */

import type { SkillInstance } from "./skill.ts";
import type { TriggeredEffect } from "./events.ts";
import type { Effect, NodeId } from "./effects/ast.ts";

/** An augment patch whose target skill lives on this hero's minion TEMPLATES, not the hero itself
 *  (Trinity's "The Power of Friendship" appends to the Rangers' Ruby/Sapphire/Citrine Lens skills). It is
 *  recorded when an augment's appendEffect / setSkillMeta / patchNode names a skill the hero does not own,
 *  then replayed onto each minion this hero summons — so the upgrade reaches the per-instance minion skill
 *  without mutating the shared template (no cross-team / cross-summon leak). */
export interface MinionSkillPatch {
  op: "appendEffect" | "prependEffect" | "setSkillMeta" | "patchNode";
  skillId: string;
  effect?: Effect[];
  meta?: Record<string, unknown>;
  nodeId?: NodeId;
  replace?: Effect;
}

export type TeamId = "A" | "B";
export type UnitId = string;
export type UnitKind = "hero" | "minion";

/** The four damage channels + a non-damage sibling handled outside this union. */
export type DamageType = "normal" | "piercing" | "affliction" | "true";

/** Which skill classes a Stun stops (Stun can be scoped, per the glossary). */
export type SkillClass = "basic" | "defensive" | "ultimate" | "fusion" | "passive";

export type StatusKind =
  | "damage_reduction" // magnitude: flat DR
  | "incoming_damage_mod" // magnitude: +N = takes N more (e.g. gommarwinter0)
  | "incoming_heal_mod" // magnitude: +N added to every heal this unit RECEIVES, from any source; non-stacking (MAX across instances) — ayana:anointment Blessed Leylines
  | "outgoing_damage_mod" // magnitude: +N = the DEALER deals N more (normal/piercing only)
  | "incoming_damage_mult" // magnitude: multiplier on incoming damage (0.5 = half, 2 = double); newDamageOnly gates to skill hits
  | "outgoing_damage_mult" // magnitude: multiplier on the DEALER's outgoing damage (e.g. triple)
  | "outgoing_dtype_override" // dtype: forces the holder's outgoing damage to this type (e.g. Piercing)
  | "conditional_bypass" // the holder's damage ignores DR+Shield against targets that satisfy bypassCond
  | "shield_absorb_cap" // magnitude: max Shield the holder may spend absorbing a single hit (overflow falls through to HP)
  | "shield_grant_bonus" // magnitude: N added to every Shield grant the holder receives (keeperlich0 Licherature)
  | "shield_non_absorbing" // the holder's Shield stops absorbing incoming damage (still a resource pool) — keepermyth0 Wise Old Man
  | "split_incoming" // the holder's single-target hits are split evenly among the holder + opposing-team bearers of mark `name`
  | "skill_damage_bonus" // skillId-scoped: flat bonus added to the named skill's damage-op hits while it holds (empowerThornPrick)
  | "skill_targeting_override" // skillId-scoped: overrides the named skill's targeting; name = the new category (bannerAffectsAllEnemies)
  | "damage_becomes_heal" // inverted HP: incoming damage heals the holder instead
  | "heal_becomes_damage" // inverted HP: incoming healing damages the holder instead
  | "dies_at_max" // inverted HP: the holder dies at MAX hp, and does not die at 0
  | "shatter" // voids DR / Invulnerable / Shield benefit
  | "damage_ignore" // ignores all damage from any source
  | "non_damage_ignore" // immune to harmful non-damage effects
  | "immortal" // HP cannot drop below 1
  | "revive_ward" // intercept a lethal hit: revive to `magnitude` HP and consume the ward
  | "invulnerable" // cannot be targeted by NEW harmful skills
  | "isolated" // cannot be targeted by NEW helpful skills
  | "untargetable" // cannot be targeted by ANY of another unit's skills (self-targeting still works)
  | "elemental_essence" // a one-shot charge: swaps the holder's next income from 1 generic to 1 of its element, then is consumed
  | "cost_mod" // magnitude: delta added to the holder's skill costs (+N pricier, -N cheaper)
  | "cost_currency_remap" // skillId-scoped: the named skill's remaining Specific cost is payable as Generic (any color)
  | "cooldown_mod" // magnitude: delta added to the cooldown the holder's skills go on when used
  | "silence" // suppresses Elemental Essence income
  | "paralysis" // cooldowns do not advance
  | "stealth" // does not trigger enemy effects
  | "veiled" // concealed until the veiled unit uses a Harmful skill (removed then, unless doesNotBreakVeil); the concealment itself is server-side redaction
  | "cloak" // a timed, NON-breaking concealment window (keeper "Endless Night"): the holder's effects + skill-uses are Invisible to the enemy for its duration, and — unlike veiled — a Harmful action does NOT strip it
  | "reveal" // True Sight: while any unit on a team holds this, that team sees THROUGH the opponent's invisibility (redactState stops hiding the enemy's Invisible effects from it) — ayana:prism "Illumination", laria:night reveal branch
  | "taunt" // forced to target a specific unit
  | "blind" // single-target skills retarget at random
  | "stun" // cannot use skills (optionally tag-scoped)
  | "channeling" // caster is sustaining a Channel skill (name = skill id); re-runs each turn
  | "dot" // named damage-over-time: deals `magnitude` `dtype` per applier turn
  | "regen" // named heal-over-time: heals `magnitude` per applier turn (the twin of dot)
  | "heal_lock" // blocks incoming heals (unitRef = the only allowed healer; absent = block all)
  | "uncounterable" // the holder's skills cannot be countered/reflected
  | "stack_read_mod" // adjusts the EFFECTIVE stackCount read of a named stack (mode: mult|floorZero|missingHp) — "treated as though they had N stacks"
  | "instant_cast" // skillId-scoped: suppresses the named skill's channel so it resolves entirely on cast
  | "coil_damage_bonus" // magnitude: extra per-active-coil damage added to each Saya Coil hit (0 if absent)
  | "mark" // a named marker (name required)
  | "stack"; // a named accumulating resource (name required)

/** A Stun can stop only, or all-but, skills carrying a given class tag ("Strategic"). */
export interface StunScope {
  tag: string;
  mode: "only" | "except";
}

export interface Status {
  kind: StatusKind;
  /** Flat magnitude for DR / incoming-mod / stack count / dot tick. */
  magnitude?: number;
  /** Identifier for mark/stack/dot effects ("Fan the Flames", "Charge", ...). */
  name?: string;
  /** For a dot: the damage type it ticks (default affliction). */
  dtype?: DamageType;
  /** For an outgoing_damage_mod: which damage types it boosts (default: normal + piercing). jarrik:dragon
   *  "+5 Affliction" -> ["affliction"]; fate:ember "+5 non-Affliction" -> ["normal","piercing","true"]. */
  dtypes?: DamageType[];
  /** For a non_damage_ignore: which harmful non-damage status kinds it wards off (default: ALL). "ignore stuns"
   *  (hector Mindfog, scratch Deal, gommar:glacier) -> ["stun"]; "ignore non-damage effects" stays unscoped. */
  ignoreKinds?: string[];
  /** For a damage_ignore: ignore only PERIODIC (dot-tick) damage, not new/direct hits (gommar:lich Icy Blood
   *  "ignores periodic Affliction damage"). */
  periodicOnly?: boolean;
  /** Re-applying this status ACCUMULATES its magnitude (and refreshes duration) instead of the default refresh
   *  — for named dots/effects whose frozen text says "This effect stacks" (keeper Tale of a Distant Future,
   *  pyrrha Festering Burns' Fan the Flames). */
  stacks?: boolean;
  /** For a scoped Stun: which class tag it keys on (absent = stops all skills). */
  scope?: StunScope;
  /** For a Taunt: the unit the bearer is forced to target. */
  unitRef?: UnitId;
  /** For channeling: the targets the sustained skill re-runs against each turn. */
  channelTargets?: UnitId[];
  /** For a multi-copy channel (galazax1 Twin Storms): distinguishes concurrent channeling instances of one
   *  skill id. Absent = the single-slot default (one channel per skill id). */
  instanceId?: string;
  /** Effects to run when this status expires naturally (see onExpire). */
  onExpire?: Effect[];
  /** Turns remaining. null = lasts until end of round (a round-"permanent" effect). */
  duration: number | null;
  /** Unit that applied it — anchors duration ticking (DURATION_ANCHOR = applier). */
  appliedBy: UnitId;
  /** Global turn index at application (so it is not ticked on its own turn of birth). */
  appliedTurn: number;
  /** Skill / augment id that produced it, for provenance + dedupe. */
  sourceId?: string;
  /** Redaction: this effect is Invisible — the opponent's wire-state omits it (see redactState in
   *  visibility.ts). Set FROZEN at apply time, either from an isHidden skill's execution context or from a
   *  status-spec `invisible:true` (e.g. Zephyrex Wind Step's hidden DR). The owning team is derived from
   *  `appliedBy`, so a status applied by a HERO stays scoped correctly for the match (dead heroes persist);
   *  a status applied by a MINION reverts to the bearer's team once the minion is swept — no current
   *  Invisible skill is minion-owned, so this is a known forward-looking limitation, not a live leak.
   *  Dynamic team cloak (veiled/Endless Night) is layered on at redaction time, not frozen here. */
  invisible?: boolean;
  /** Display disguise: in the OPPONENT's view this status is shown as if it came from skill `disguiseAs`
   *  (its source icon) and re-labelled `disguiseName` — zephyrex:mist "Cleave the Veil" displayed as Elegant
   *  Sweep. redactState performs the swap and strips these fields; the owner (and a True-Sight viewer) see
   *  the real effect. Cosmetic only — the mechanic is unchanged. */
  disguiseAs?: string;
  disguiseName?: string;
  /** For a cost_mod / cooldown_mod that applies to ONE skill only (absent = all skills). */
  skillId?: string;
  /** For a cost_mod: per-channel deltas applied to Generic / Specific independently (floored, no cross-channel
   *  spill) — for "reduce Generic by 1 AND Specific by 1" which a single scalar magnitude cannot express. */
  genericDelta?: number;
  specificDelta?: number;
  /** For an incoming_damage_mult: apply only to NEW skill hits (isNew), not ongoing DoT ticks. */
  newDamageOnly?: boolean;
  /** For an incoming_damage_mod / incoming_damage_mult: apply ONLY to damage whose source id matches (the
   *  damage node's id, e.g. "ayana1.hit") — scopes a bonus/mult to one skill (ayana Word of the Law: "+10
   *  from Voice of Light"). Absent = applies to all incoming damage. */
  viaSourceId?: string;
  /** For a conditional_bypass: the target must hold this status (kind + optional name) for the bypass to apply. */
  bypassCond?: { kind: StatusKind; name?: string };
  /** For a stack_read_mod: how it adjusts the effective stack read. mult = actual x magnitude; floorZero =
   *  if actual is 0, read magnitude; missingHp = actual + floor(missingHp / magnitude). */
  mode?: "mult" | "floorZero" | "missingHp";
  /** For a stack_read_mod: apply only while the holder has >=1 RAW stack of this named resource (a live gate). */
  readModIf?: string;
  /** For an outgoing_dtype_override: apply only while the holder has 0 RAW stacks of this named resource. */
  overrideIfStackZero?: string;
}

/** One shield grant: a breakable, optionally-timed absorb pool. */
export interface ShieldInstance {
  amount: number;
  /** Turns remaining; null = lasts the round. Ticks at the applier's turn-end. */
  duration: number | null;
  appliedBy: UnitId;
  appliedTurn: number;
  id?: string;
}

export interface Unit {
  id: UnitId;
  kind: UnitKind;
  name: string;
  /** The roster hero id this unit was loaded from (e.g. "syl") — for looking up its augments/fusion forms. */
  heroId?: string;
  team: TeamId;
  hp: number;
  maxHp: number;
  /** Consumable shields (absorb before HP; not for Affliction/True). Total = sum of amounts. */
  shields: ShieldInstance[];
  /** Base element never changes; current element changes on fusion (heroes). */
  baseElement: string;
  currentElement: string;
  /** Formation slot (0..2) within the team, for positional heroes; undefined for minions. */
  slot?: number;
  statuses: Status[];
  alive: boolean;
  /** The unit's usable skills (with live cooldowns). Optional for bare test units. */
  skills?: SkillInstance[];
  /** Reactive/interrupt triggers (from the unit's passive and lasting effects). */
  triggers?: TriggeredEffect[];
  /** For a minion: the hero that summoned it (referenced by its skills/triggers). */
  summoner?: UnitId;
  /** A second template name this minion also answers to in `template:` selectors (an Azure Sparkling is a
   *  plasma re-skin of Cinderling, so base-kit "Cinderling" selectors must count/consume it). */
  templateAlias?: string;
  /** The id of the last skill this unit successfully used (set on cast, reset each round). */
  lastSkillId?: string;
  /** The fusion form this hero took, if any (once per match — the between-round metagame). */
  fused?: string;
  /** Augment ids applied to this hero so far (cumulative across rounds). */
  augments?: string[];
  /** Augment patches whose target skill lives on this hero's minion templates (see MinionSkillPatch);
   *  replayed onto every minion this hero summons. */
  minionSkillPatches?: MinionSkillPatch[];
  /** This hero stands in for a named minion template (Dennis for Hector's "Dennis the Apprentice") — a
   *  selector naming that exact template resolves to this hero. Set at match build for a cross-hero pairing. */
  understudyFor?: string;
}

/** Energy is a shared per-team pool (ENERGY_POOL_SCOPE = team). */
export type EnergyPool = Record<string, number>; // element name | "generic" -> count

export interface Team {
  id: TeamId;
  /** Hero + minion ids currently on the field. */
  units: UnitId[];
  energy: EnergyPool;
  /** Rounds this team has won (match is best-of-N). */
  roundsWon: number;
}

export interface MatchState {
  round: number;
  /** Monotonic turn counter across the whole match. */
  turn: number;
  activeTeam: TeamId;
  units: Record<UnitId, Unit>;
  teams: Record<TeamId, Team>;
  /** Serialized RNG state (see Rng). */
  rngState: number;
  seed: number;
  /** Monotonic counter for unique summoned-minion ids. */
  minionSeq: number;
  /** Deferred effects awaiting their fire turn (see the `schedule` effect). */
  scheduled: ScheduledEntry[];
  /** Unit ids that have taken an action during the current turn (cleared each turn start). */
  actedThisTurn: UnitId[];
  /**
   * Optional per-color budget (remaining) the active team chose to cover this turn's GENERIC costs —
   * any color may pay generic. `pay` drains generic from these colors first, then the default order for
   * any remainder. Set before resolving a turn; cleared by resolveTurn. Absent = the default auto order.
   */
  genericPay?: EnergyPool;
  log: string[];
}

/** A deferred effect: fires after `turns` of the caster's turn-ends elapse. */
export interface ScheduledEntry {
  effect: Effect[];
  caster: UnitId;
  targets: UnitId[];
  turns: number;
  appliedTurn: number;
  /** The skill/passive that scheduled it — carried across the delay so applied statuses keep their source. */
  skillId?: string;
  /** Redaction: scheduled by an Invisible cast (the schedule op under ctx.invisible) — redactState omits it
   *  from the opponent's wire so a pending Invisible payload isn't laid bare before it fires. */
  invisible?: boolean;
}
