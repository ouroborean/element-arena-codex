/**
 * Between-round metagame availability — the legal AUGMENT_OR_FUSE choices for a hero, shared by any
 * client. Fusion is unilateral + once per match and re-denominates the hero to recipe(hero.element,
 * teammate.element); so a hero's legal forms depend on which base elements its LIVING teammates carry.
 * Augments are cumulative — each of a hero's five may be taken at most once.
 */
import type { MatchState, Unit } from "../src/types.ts";
import { canFuse, type FusionForm } from "./fusion.ts";
import { fusionForm } from "./fusions.generated.ts";
import { fusionResult } from "./recipes.generated.ts";
import { augmentsFor } from "./augments.generated.ts";
import type { Augment } from "./augment.ts";

/**
 * The fusion forms `unit` may legally take: for each hero teammate, the form keyed by
 * recipe(unit.baseElement, teammate.baseElement). Empty if already fused (once/match), if the unit has
 * no roster id, or if no teammate yields a partner element. Teammates are NOT alive-filtered — this is a
 * between-round draft, and the next round is a fresh battle that revives the whole team.
 */
export function availableFusions(state: MatchState, unit: Unit): FusionForm[] {
  if (!canFuse(unit) || !unit.heroId) return [];
  const out: FusionForm[] = [];
  const seen = new Set<string>();
  for (const id of state.teams[unit.team].units) {
    const mate = state.units[id];
    if (!mate || mate.kind !== "hero" || mate.id === unit.id) continue;
    const result = fusionResult(unit.baseElement, mate.baseElement);
    if (!result || seen.has(result)) continue;
    seen.add(result);
    const form = fusionForm(unit.heroId, result);
    if (form) out.push(form);
  }
  return out;
}

/** The augments `unit` may still take: its roster augments minus the ones already applied. */
export function availableAugments(unit: Unit): Augment[] {
  if (unit.kind !== "hero" || !unit.heroId) return [];
  const taken = new Set(unit.augments ?? []);
  return augmentsFor(unit.heroId).filter((a) => !taken.has(a.id));
}
