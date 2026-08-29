/**
 * Fusion — the once-per-match transformation a hero may take instead of augmenting. A hero has
 * a fixed set of fusion FORMS (aurora / storm / vengeance / …); choosing one re-elements the
 * hero, grants a new active skill in the 4th slot (base kit stays: 3 basics, [fusion], defensive,
 * ultimate — the ultimate remains last), and swaps in the fusion passive's triggers. Unilateral
 * and once per match (rulings: unilateral fusion, once/match), and it persists across rounds —
 * `startRound` resets HP/cooldowns but never touches skills/triggers/element, so the fused kit
 * carries over as intended.
 */
import type { Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { HeroTrigger, PassiveDef } from "./hero.ts";

export interface FusionForm {
  /** Form key, e.g. "storm". */
  key: string;
  /** The hero this form belongs to (provenance; not enforced). */
  hero: string;
  /** The hero's new current element after fusing (baseElement is left untouched). */
  element: string;
  /** The fusion passive (display) + the triggers it installs. */
  passive: PassiveDef;
  passiveTriggers?: HeroTrigger[];
  /**
   * Does the fusion passive ADD to the base passive's triggers (DEFAULT) or REPLACE them? A fused hero
   * keeps its full native kit — the base passive is integral and must persist — so the fusion passive layers
   * on top, exactly like the fusion skill. "replace" (legacy, rarely needed) drops the ENTIRE base passive.
   * Either way, augment-added triggers (origin "augment") and innate ones are always kept.
   */
  passiveMode?: "replace" | "add";
  /**
   * For an "instead of X" form (e.g. Shroomtender: "Instead of Seedling minions…"): the SOURCE strings of the
   * specific base-passive triggers to drop, while keeping the rest of the base passive. Surgical alternative to
   * the blunt "replace". Ignored in "replace" mode (which already drops all base triggers).
   */
  suppressesBaseTriggers?: string[];
  /** The fusion active skill gained on fusing. */
  skill: SkillInstance;
  /** Insertion index for the fusion skill (default 3 = the 4th slot, after the 3 basics). */
  slot?: number;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A hero may fuse iff it is a hero and has not already fused this match. */
export function canFuse(unit: Unit): boolean {
  return unit.kind === "hero" && !unit.fused;
}

/**
 * Fuse a hero into `form` (once per match). Re-elements it, inserts the fusion skill at its slot,
 * and installs the fusion passive's triggers ON TOP of the native passive (add is the default). Throws on
 * a second fusion — a re-fuse is a caller bug, not a silent no-op.
 */
export function applyFusion(unit: Unit, form: FusionForm): void {
  if (unit.fused) throw new Error(`${unit.id} is already fused (${unit.fused}); fusion is once per match`);

  unit.currentElement = form.element;

  const skills = unit.skills ?? [];
  const fusionSkill: SkillInstance = { ...clone(form.skill), currentCd: 0 };
  const at = form.slot ?? 3; // the 4th slot, after the three basics
  skills.splice(Math.min(at, skills.length), 0, fusionSkill);
  unit.skills = skills;

  const fusedTriggers = (form.passiveTriggers ?? []).map((t) => ({ ...clone(t), owner: unit.id, origin: "fusion" as const }));
  const existing = unit.triggers ?? [];
  // DEFAULT "add": the fusion passive LAYERS onto the NATIVE PASSIVE — origin "passive" triggers persist (the
  // passive is integral to the hero), minus any an "instead of" form names in suppressesBaseTriggers. Base
  // SKILL-reactive triggers (origin undefined) are still dropped, as fused forms re-author the base skills and
  // re-implement what they need. Augment/innate triggers are always kept (a fusion doesn't undo an augment).
  // Legacy "replace" drops the native passive too (only augment/innate survive).
  const suppressed = new Set(form.suppressesBaseTriggers ?? []);
  const keepUnderAdd = (t: HeroTrigger) =>
    t.origin === "augment" || t.origin === "innate" ||
    (t.origin === "passive" && !suppressed.has(t.source ?? ""));
  unit.triggers = (form.passiveMode ?? "add") === "replace"
    ? [...existing.filter((t) => t.origin === "augment" || t.origin === "innate"), ...fusedTriggers]
    : [...existing.filter(keepUnderAdd), ...fusedTriggers];

  unit.fused = form.key;
}
