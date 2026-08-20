/**
 * The event/trigger vocabulary.
 *
 * The engine emits GameEvents at key moments; units carry TriggeredEffects that react
 * to them ("when I take damage…", "when I die…", "at turn end…"). This module is
 * types-only so it sits under the interpreter without an import cycle.
 *
 * Reactive triggers (kind "react") run AFTER the event and do not alter it. The
 * interrupt kinds ("counter", "reflect") — which cancel or redirect a declared skill
 * before it resolves — are defined here but wired in a later increment.
 */
import type { Condition, Effect, Selector } from "./effects/ast.ts";
import type { DamageType, TeamId, UnitId } from "./types.ts";

export type GameEvent =
  | { type: "damageDealt"; source: UnitId | null; target: UnitId; amount: number; dtype: DamageType; sourceId?: string; isNew?: boolean }
  | { type: "shieldDamaged"; unit: UnitId; source: UnitId | null; amount: number }
  | { type: "shieldBroken"; unit: UnitId; source: UnitId | null }
  | { type: "unitDied"; unit: UnitId; killer: UnitId | null }
  | { type: "skillUsed"; caster: UnitId; skillId: string; targets: UnitId[]; tags?: string[]; affected?: UnitId[]; hidden?: boolean }
  // A unit was granted a new skill (a fusion/augment-era mechanic; no base-kit emitter yet).
  | { type: "skillGranted"; unit: UnitId; skillId: string; source: UnitId | null }
  // A minion was just summoned from a template (so "minions of template X gain Y" can hook creation).
  | { type: "minionSummoned"; unit: UnitId; template: string; summoner: UnitId }
  // Emitted before a skill's effects resolve; counter/reflect triggers may interrupt it.
  | { type: "skillDeclared"; caster: UnitId; skillId: string; tags: string[]; targets: UnitId[]; hidden?: boolean }
  | { type: "healReceived"; unit: UnitId; source: UnitId | null; amount: number; overheal?: number }
  | { type: "statusApplied"; unit: UnitId; source: UnitId | null; kind: string; name?: string }
  | { type: "statusExpired"; unit: UnitId; kind: string; name?: string }
  | { type: "statusLost"; unit: UnitId; kind: string; name?: string } // a status EXPLICITLY removed (removeStatus op), distinct from natural expiry
  | { type: "skillRedirected"; caster: UnitId; skillId: string; from: UnitId; to: UnitId }
  | { type: "counterFired"; counterer: UnitId; caster: UnitId; skillId: string }
  // A hero converted Elemental Essence into a unit of specific energy this income step (the essence
  // was consumed). Emitted at the exact moment of the swap so "when X gains energy from Essence" is a
  // real, reactable event rather than a turn-start guess.
  | { type: "energyFromEssence"; unit: UnitId; element: string }
  | { type: "turnStart"; team: TeamId }
  | { type: "turnEnd"; team: TeamId }
  | { type: "roundStart" };

export type TriggerKind = "react" | "counter" | "reflect" | "replace";

export interface TriggeredEffect {
  /** The event that fires this trigger. */
  on: GameEvent["type"];
  /** The unit the trigger belongs to (its `self`/`caster` when it runs). */
  owner: UnitId;
  /** Optional gate, evaluated with the event bound (eventSource/eventTarget/…). */
  when?: Condition;
  /** What runs when it fires. */
  effect: Effect[];
  kind?: TriggerKind;
  /** Consume after firing once (typical for "counters the next skill"). */
  once?: boolean;
  /** reflect only: where the skill is redirected (default = the trigger owner). */
  redirectTo?: Selector;
  /** reflect only: a concrete redirect destination when a selector can't express it (dynamic triggers). */
  redirectToId?: UnitId;
  /**
   * Dynamic-trigger expiry (a "watch window" installed at runtime for N turns). Absent = a permanent
   * static trigger; null = round-permanent (cleared at round start). Ticks at the installer's turn-end; removed at 0.
   */
  duration?: number | null;
  appliedBy?: UnitId;
  appliedTurn?: number;
  /**
   * A human-readable name handle for the registering passive/skill — used by augment surgery
   * (removeTrigger / retunePassiveThreshold match on this string). NOT an id; do not use it for
   * icon/text lookups. For effect provenance (which skill applied a status this trigger fires) use
   * `sourceSkillId`.
   */
  source: string;
  /**
   * The id of the skill/passive that installed this trigger, when known — set from `ctx.skillId`
   * at runtime install (installWatch). Deferred trigger effects run in a fresh context, so this is
   * how a status they apply learns its true source skill (for the client's effect icons). Absent for
   * statically authored triggers, which fall back to the owner's current passive id.
   */
  sourceSkillId?: string;
  /**
   * Where the trigger came from — so a fusion can swap out the base passive's triggers while
   * KEEPING augment-added ones. Absent = base passive (the default for authored hero triggers).
   * "innate" marks a core-identity base trigger (e.g. Syl's Eagle summon) that survives fusion.
   */
  origin?: "passive" | "augment" | "fusion" | "innate";
  id?: string;
}

/** REDIRECT_DEPTH_CAP: guards reflect/counter and reaction-chain recursion. */
export const MAX_TRIGGER_DEPTH = 4;
