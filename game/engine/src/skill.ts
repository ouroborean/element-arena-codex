/**
 * Runtime skill form: a SkillDef (targeting + effect tree) plus the combat metadata
 * the scheduler needs — energy cost, cooldown, and the live cooldown counter.
 *
 * Kept in its own module so `types.ts` can reference it for `Unit.skills` with a
 * type-only import (no runtime cycle with the effect AST).
 */
import type { Condition, SkillDef, Value } from "./effects/ast.ts";
import type { SkillClass, UnitKind } from "./types.ts";

/** GENERIC = any energy; SPECIFIC = energy of the skill's current element. */
export interface EnergyCost {
  generic: number;
  specific: number;
}

export interface SkillInstance extends SkillDef {
  cost: EnergyCost;
  cooldown: number;
  /** Turns until usable again; 0 = ready. */
  currentCd: number;
  /** The turn `currentCd` was last set on — advanceCooldowns skips this "birth turn" so cooldown N blocks N turns. */
  cdSetTurn?: number;
  klass: SkillClass;
  /** Active class tags (Harmful, Instant, Strategic, Affliction, ...) — drives stun scoping. */
  tags: string[];
  /** Restrict a single-target skill's legal targets to this unit kind (e.g. Syl's Feed → "minion" only). */
  targetKind?: UnitKind;
  /** Channel skills (tag "Channel"): how many extra turns they re-run (null = until interrupted). */
  channelTurns?: number | null;
  /** Max concurrent copies of this channel the caster may sustain (galazax1 Twin Storms = 2). Absent/1 =
   *  the single-channel default. >1 gives each live copy a distinct instanceId and preserves siblings on recast. */
  channelCopies?: number;
  /** Using this skill does NOT interrupt an active channel (per-skill opt-out). */
  doesNotInterrupt?: boolean;
  /** Using this Harmful skill does NOT break the caster's Veiled status (aramao1/aramao2 opt-out). */
  doesNotBreakVeil?: boolean;
  /** A hard castability precondition (unselectable if false) — distinct from in-effect if/else. */
  requires?: Condition;
  /** If this holds at declaration, the skill cannot be countered/reflected (conditional Uncounterable). */
  uncounterableIf?: Condition;
  /** Per-cast conditional cost deltas, evaluated live at each cast (keeper3 "Plot Twist": -1 while solo).
   *  `magnitude` may be a Value, so the delta can scale with live state (zevkir5: -1 per Call Tides stack).
   *  Distinct from cost_mod statuses (which the round-wipe clears) — this rides on the skill, which persists. */
  costMods?: Array<{ magnitude: number | Value; when?: Condition }>;
}
