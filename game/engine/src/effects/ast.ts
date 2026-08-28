/**
 * The skill effect DSL — a declarative, serializable AST.
 *
 * Every skill's behaviour is DATA (a tree of effect nodes), not a function. Two
 * reasons this matters:
 *   1. Augments and fusion passives are ordered PATCHES to a sibling skill. A patch
 *      addresses a node by its `id` and rewrites it ("change the damage node's
 *      amount from 10 to 15", "wrap the whole effect in a condition"). That is only
 *      possible if effects are inspectable data.
 *   2. The same tree runs on client and server and serializes into a replay.
 *
 * The primitives here were chosen from the measured mechanic frequency across the
 * 762 descriptions (damage 30%, durations 22%, stacks 15%, conditionals 14%,
 * per-each 9%, summon 4%). The `custom` escape hatch covers the ~3% that need
 * bespoke native code.
 */
import type { DamageType, StatusKind, StunScope } from "../types.ts";

/** Optional stable id so a patch can address this exact node. */
export type NodeId = string;

// --------------------------------------------------------------------------- //
//  Values — numeric expressions evaluated against the resolution context.
// --------------------------------------------------------------------------- //
export type Value =
  | number
  | { ref: "stackCount"; name: string; of?: Selector }
  | { ref: "missingHp"; of?: Selector }
  | { ref: "currentHp"; of?: Selector }
  | { ref: "shield"; of?: Selector }
  | { ref: "spendableShield"; of?: Selector } // totalShield + 10 per Chronicle Fragments stack (keeper:crystal: Fragments count as 10 Shield each when paying a Shield cost)
  | { ref: "count"; of: Selector }
  | { ref: "statusDuration"; kind: StatusKind; name?: string; of?: Selector } // remaining turns (0 if absent/permanent)
  | { ref: "statusMag"; kind: StatusKind; name?: string; of?: Selector } // a status's magnitude (0 if absent)
  | { ref: "statusCount"; kind: StatusKind; name?: string; of?: Selector } // how many status instances of this kind (+name) the unit holds
  | { ref: "sum"; metric: "missingHp" | "currentHp" | "shield"; of: Selector } // aggregate a metric across a selector
  | { ref: "stackSum"; name: string; of: Selector } // total stacks of a named resource summed across a selector (laria:night "10+ total Deepening Shadows")
  | { ref: "var"; name: string }
  | { op: "add" | "sub" | "mul" | "min" | "max"; args: Value[] }
  | { op: "div"; num: Value; by: number; floor?: boolean };

// --------------------------------------------------------------------------- //
//  Selectors — resolve to a set of units.
// --------------------------------------------------------------------------- //
export type Faction = "allies" | "enemies" | "all";

/** A status match: a bare kind, or a kind + a specific name (for marks/stacks/dots). */
export type StatusMatch = StatusKind | { kind: StatusKind; name?: string; magLt?: number };

export type Selector =
  | "self" // the acting unit (caster, or the minion for a minion skill)
  | "caster" // the hero who owns the skill
  | "target" // the skill's chosen primary target(s)
  | "summoner" // for a minion: the hero that summoned it (else self)
  | "it" // the current unit inside a forEach
  | "eventSource" // in a trigger: the unit that caused the event (dealer/caster)
  | "eventTarget" // in a trigger: the event's target
  | "eventTargets" // in a trigger: ALL of a multi-target skill's targets
  | "eventAffected" // in a skillUsed trigger: every unit the skill actually touched (damaged OR statused)
  | "eventUnit" // in a trigger: the subject of a unit event (e.g. the unit that died)
  | "eventCounterer" // (counterFired) the unit that fired the counter — for "when I counter…" (eventSource is the countered attacker)
  | "across" // the living enemy hero in the SAME formation slot as self
  | "adjacent" // living allied heroes in a neighbouring formation slot to self
  // alive defaults to true (living units); alive:false selects the DEAD. `template`
  // filters minions by their template name (e.g. only Seedlings).
  | { faction: Faction; alive?: boolean; includeSelf?: boolean; kind?: "hero" | "minion"; template?: string }
  | { pick: "random" | "lowestHp" | "highestHp"; from: Selector; count?: number }
  | { filter: Selector; with?: StatusMatch; without?: StatusMatch };

// --------------------------------------------------------------------------- //
//  Conditions.
// --------------------------------------------------------------------------- //
export type Condition =
  | { has: StatusKind; name?: string; of?: Selector }
  | { hasEssenceIncome: Selector } // the unit "has Elemental Essence" the way the glow means it: it generates
  //   element energy each turn — the MIDDLE-slot hero (always) OR any elemental_essence charge — unless Silenced.
  //   (Distinct from `has: elemental_essence`, which counts only a literal charge and misses the middle hero.)
  | { cmp: ">" | ">=" | "<" | "<=" | "==" | "!="; left: Value; right: Value }
  | { sameUnit: [Selector, Selector] } // identity equality of the first unit each resolves to
  | { unitIn: [Selector, Selector] } // membership: the first selector's unit is among the second selector's set
  | { isFaction: Selector; faction: "ally" | "enemy" } // relative to the acting unit's team
  | { isKind: Selector; kind: "hero" | "minion" } // is the selected unit a hero or a minion?
  | { isNamed: Selector; name: string } // the selected unit's display name equals this (e.g. a specific minion template, "Stonecap Mushroom")
  | { fused: string; of?: Selector } // the selected unit's active fusion form equals this (of defaults to "self"; e.g. Black Knight's "evil" form widens Oathbreaker Strike to allies)
  | { skillOnCooldown: string } // the caster's own skill (by id) is currently on cooldown (zephyrex3 requires Wind Step down)
  | { declaredTargetsSelf: true } // (skillDeclared) the trigger owner is among the declared targets
  | { eventTargetsFaction: "allies" | "enemies" } // (skillUsed/Declared) any declared target is on self's team / the opposing team
  | { eventHasTag: string } // (skillDeclared/skillUsed) the skill carries this class tag
  | { eventSkillId: string } // (skillUsed/skillDeclared/skillGranted/skillRedirected/counterFired) the event's skillId matches — scopes a skill-reaction to ONE skill
  | { eventStatusKind: string; name?: string } // (statusApplied/statusExpired) the event's status kind (+name) matches
  | { eventStatusNameIncludes: string } // (statusApplied/statusExpired) the event's status NAME contains this substring, any kind (hectorspore0: "a Serum effect ends" = a "...Serum"-named status expires)
  | { eventSourceId: string } // (damageDealt) the event's sourceId matches — a dot's name (dot ticks) or a damage node's id (direct hits); scopes a reaction to one source skill/effect
  | { eventTeamIsSelf: true } // (turnStart/turnEnd) the event's team is the trigger owner's team ("my team's turn")
  | { eventSourceSummonedBySelf: true } // (any event with a source) the event's source unit is a minion the trigger owner summoned (gaia3: only "Gaia's minions")
  | { eventRedirectedToSelf: true } // (skillRedirected) the reflected skill was redirected ONTO the trigger owner (reads `to`)
  | { eventHidden: boolean } // (skillUsed/skillDeclared) whether the used skill is Invisible (isHidden) — Sera's "non-Invisible" filter
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }
  | { chance: number }; // 0..1, draws from the deterministic rng

// --------------------------------------------------------------------------- //
//  Status specification (what applyStatus authors).
// --------------------------------------------------------------------------- //
export interface StatusSpec {
  kind: StatusKind;
  magnitude?: Value;
  name?: string;
  /** For a dot: the damage type it ticks (default affliction). */
  dtype?: DamageType;
  /** For an outgoing_damage_mod: which damage types it boosts (default: normal + piercing). */
  dtypes?: DamageType[];
  /** For a non_damage_ignore: which harmful non-damage status kinds it wards off (default: ALL). */
  ignoreKinds?: string[];
  /** For a damage_ignore: ignore only PERIODIC (dot-tick) damage, not new/direct hits. */
  periodicOnly?: boolean;
  /** Re-applying this status ACCUMULATES magnitude (+refreshes duration) instead of the default refresh
   *  ("This effect stacks" named dots/effects). */
  stacks?: boolean;
  /** For a scoped stun, or a tag-scoped cost_mod (titania Hallucinogenic Spores). */
  scope?: StunScope;
  /** For a cost_mod: per-channel deltas applied to Generic / Specific independently (scratch3 "-1 each"). */
  genericDelta?: number;
  specificDelta?: number;
  /** For a skillId-scoped status (skill_damage_bonus / cost_mod / cooldown_mod applying to ONE named skill). */
  skillId?: string;
  /** For an incoming_damage_mod / incoming_damage_mult: scope the bonus/mult to damage from one source id
   *  (a damage node's id, e.g. "ayana1.hit"). Absent = all incoming damage. */
  viaSourceId?: string;
  /** Multiplies REFLECTED incoming hits only (zevkir Lens of the Deep mark: x2 from reflected skills). */
  reflectedDamageMult?: number;
  /** For an incoming_damage_mod: scope the bonus to damage dealt by ONE unit (resolved from a selector at apply
   *  time) — zephyrex Prod boosts only the prodded enemy's hits on Zephyrex. */
  onlyFromUnitRef?: Selector;
  /** For a taunt: the unit to force the bearer to target (resolved at apply time). */
  unitRef?: Selector;
  /** Effects to run when this status expires naturally (duration lapse). */
  onExpire?: Effect[];
  /** Turns; null = round-permanent. May be a Value expression (computed at apply time). */
  duration: Value | null;
  /** "This effect is Invisible": the opponent's wire-state omits this status (redactState). A per-effect
   *  flag on an otherwise-visible skill (e.g. Zephyrex Wind Step's hidden DR self-buff). A whole-skill
   *  isHidden already makes ALL of its applied statuses invisible via the execution context, so this is only
   *  needed to hide one effect of a visible skill. */
  invisible?: boolean;
}

// --------------------------------------------------------------------------- //
//  Effects — executed for their side effects on MatchState.
// --------------------------------------------------------------------------- //
export type Effect =
  | { op: "damage"; amount: Value; dtype?: DamageType; to?: Selector; from?: Selector; bypass?: boolean; id?: NodeId } // from = the credited dealer (default: the caster); bypass:true = this hit ignores DR+Shield regardless of the dealer's status (ayana Prism Sentence's Bypassing spread)
  | { op: "heal"; amount: Value; to?: Selector; overheal?: boolean; id?: NodeId }
  | { op: "healthLoss"; amount: Value; to?: Selector; id?: NodeId }
  | { op: "grantShield"; amount: Value; to?: Selector; duration?: number | null; id?: NodeId }
  | { op: "applyStatus"; status: StatusSpec; to?: Selector; id?: NodeId }
  | { op: "removeStatus"; kind: StatusKind; name?: string; from?: Selector; id?: NodeId }
  | { op: "modifyStatus"; kind: StatusKind; name?: string; magnitudeDelta?: Value; durationDelta?: Value; from?: Selector; id?: NodeId }
  | { op: "addStack"; name: string; amount?: Value; duration?: Value | null; to?: Selector; id?: NodeId }
  | { op: "grantEnergy"; element: string; amount: Value; id?: NodeId }
  | { op: "modifyCooldown"; delta: Value; skillId?: string; of?: Selector; id?: NodeId }
  | { op: "summon"; template: string; count?: Value; hp?: Value; id?: NodeId }
  | { op: "defeat"; to?: Selector; id?: NodeId } // outright-kill a unit (not damage; bypasses shield/DR/immunity)
  | { op: "revive"; to?: Selector; hp: Value; id?: NodeId } // bring a dead unit back at `hp`
  | { op: "transform"; to?: Selector; template: string; keepHp?: boolean; id?: NodeId } // retemplate in place (no death)
  | { op: "useSkill"; skillId: string; by?: Selector; on?: Selector; id?: NodeId } // invoke a named skill inline
  | { op: "swapPositions"; a: Selector; b: Selector; id?: NodeId } // swap two units' formation slots
  | { op: "shuffleTeam"; team?: "allies" | "enemies"; id?: NodeId } // randomly reassign a team's hero slots
  | { op: "if"; cond: Condition; then: Effect[]; else?: Effect[]; id?: NodeId }
  | { op: "forEach"; each: Selector; do: Effect[]; id?: NodeId }
  | { op: "seq"; steps: Effect[]; id?: NodeId }
  | { op: "schedule"; delayTurns: number; effect: Effect[]; to?: Selector; invisible?: boolean; id?: NodeId } // invisible:true hides the queued entry from the opponent's wire (a concealed/"hidden-target" preparation)
  | { op: "custom"; fn: string; args?: Record<string, unknown>; id?: NodeId };

/** A skill's authored form: targeting + the effect tree its active use runs. */
export interface SkillDef {
  id: string;
  name: string;
  element: string;
  /** How the primary target(s) are chosen when cast. */
  targeting: "single" | "self" | "all-enemies" | "all-allies" | "all" | "none";
  effects: Effect[];
  /** "This effect is Invisible": the skill is hidden from the opponent. The mechanical consumers are the
   *  eventHidden Condition (Sera's non-Invisible filter, Keeper's invisible-skill reader); the concealment
   *  itself is a redaction concern (server-side, out of scope here). */
  isHidden?: boolean;
  /** Display disguise: to the opponent, this skill's cast (its log telegraph) and the effects it applies are
   *  shown as skill `disguiseAs` — Cleave the Veil displayed as Elegant Sweep. Cosmetic; effects unchanged. */
  disguiseAs?: string;
  /** Auto-target: while any living enemy bears this mark, this single-target skill is forcibly aimed at it
   *  (zephyrex Ominous Rumble — "marked enemies are automatically targeted by Arcadian Duet and Jolt"). */
  autoTargetMark?: string;
  /** Revive skills (keeper5 Hero's Return, keeper3 Plot Twist) may select a DEAD ally as their target;
   *  legalTargets/resolveTargets otherwise filter out non-alive units. */
  canTargetDead?: boolean;
  /** This single-target skill may be aimed at EITHER faction — an enemy OR an ally (laria1 Nightwrap
   *  "damage an enemy or heal an ally", fate1 Fox Fire, taryn2 Refrain, …). A CLIENT-targeting hint: the
   *  engine's legalTargets has no faction filter, but the clients otherwise narrow the offered pool by the
   *  Harmful/Helpful tags, which is wrong for a cross-faction skill. Tags are NOT a reliable proxy (maggie's
   *  Bog Witch's Bargain is Harmful+Helpful yet targets only an enemy — its Helpful tag is a self-heal), so
   *  this is authored explicitly on exactly the skills whose prose says "enemy or ally". */
  targetsEitherFaction?: boolean;
  /** A single-target skill may not legally target a unit bearing a mark of this name (scratch Bump Those
   *  Numbers: a Deal can only affect each hero once per round — the round-scoped "Deal-Locked" mark). */
  excludeMarkedTargets?: string;
  /** This skill may only target a unit with this NAME (hector's Serums only target "Dennis the Apprentice"),
   *  unless targetNameRelaxIfNamedDead lifts it once no living unit of that name remains on the caster's team.
   *  Set by the hector5 augment at apply time, not authored on the base skill. */
  targetMustBeName?: string;
  /** The caster may not target themselves (xyris5 Echoes of Desire — "Cannot target Xyris"). A target-legality
   *  rule; requires-conditions can't express it because the target isn't bound at the requires check. */
  cannotTargetSelf?: boolean;
}

// Node addressing (findNode / replaceNode / mapNode) lives in ./patch.ts — the single walker
// that recurses every composite op (if/forEach/seq/schedule) AND applyStatus.onExpire. Keeping
// one implementation avoids the divergence where a second copy silently misses a branch.
