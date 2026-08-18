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
   * Does the fusion passive REPLACE the base passive's triggers (default) or ADD to them? Either
   * way, augment-added triggers (origin "augment") are always kept — fusion doesn't undo augments.
   */
  passiveMode?: "replace" | "add";
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
 * and installs the fusion passive's triggers (replacing the base passive's by default). Throws on
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
  // "replace" swaps out the BASE PASSIVE's triggers but KEEPS augment-added ones (an early-round
  // augment is not undone by a later fusion); "add" layers the fusion passive on top of everything.
  unit.triggers = (form.passiveMode ?? "replace") === "add"
    ? [...existing, ...fusedTriggers]
    : [...existing.filter((t) => t.origin === "augment" || t.origin === "innate"), ...fusedTriggers];

  unit.fused = form.key;
}
