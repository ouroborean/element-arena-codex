/**
 * Runtime skill form: a SkillDef (targeting + effect tree) plus the combat metadata
 * the scheduler needs — energy cost, cooldown, and the live cooldown counter.
 *
 * Kept in its own module so `types.ts` can reference it for `Unit.skills` with a
 * type-only import (no runtime cycle with the effect AST).
 */
import type { Condition, SkillDef } from "./effects/ast.ts";
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
  /** A deferred Channel (e.g. Elegant Sweep, "on the following turn…") runs NO payload on the cast turn;
   *  its effects land only when the channel resolves. Default (absent/false) is a sustained channel that
   *  also fires on cast. */
  channelDeferred?: boolean;
  /** Using this skill does NOT interrupt an active channel (per-skill opt-out). */
  doesNotInterrupt?: boolean;
  /** A hard castability precondition (unselectable if false) — distinct from in-effect if/else. */
  requires?: Condition;
  /** If this holds at declaration, the skill cannot be countered/reflected (conditional Uncounterable). */
  uncounterableIf?: Condition;
}
