/**
 * Element relationships derived from the (single, forward) fusion recipe table. A fusion element is a HYBRID
 * of two base components; its energy may substitute for either component's SPECIFIC cost — one-directional:
 * Mirror (Water+Shadow) energy can pay a Water or Shadow specific cost, but Water energy can never pay a
 * Mirror cost. Both directions are derived from `fusionResult` so there is no duplicated component data.
 *
 * All fusion recipes combine two BASE elements (never a hybrid), so the structure is strictly two-level:
 * hybridsFor(aHybrid) === [] and elementComponents(aBase) === [].
 */
import { fusionResult } from "../content/recipes.generated.ts";

/** The ten base elements — every fusion recipe combines two of these. */
export const BASE_ELEMENTS = ["fire", "ice", "water", "lightning", "wind", "poison", "earth", "holy", "unholy", "shadow"] as const;

const COMPONENTS = new Map<string, string[]>(); // fusion element  -> its base components (1–2)
const HYBRIDS = new Map<string, string[]>();    // base element    -> fusion elements that contain it
for (let i = 0; i < BASE_ELEMENTS.length; i++) {
  for (let j = i; j < BASE_ELEMENTS.length; j++) {
    const a = BASE_ELEMENTS[i]!, b = BASE_ELEMENTS[j]!;
    const r = fusionResult(a, b);
    if (!r) continue;
    const comp = COMPONENTS.get(r) ?? [];
    if (!comp.includes(a)) comp.push(a);
    if (!comp.includes(b)) comp.push(b); // same-element fusion (dragon = fire+fire) dedupes to one component
    COMPONENTS.set(r, comp);
    for (const c of new Set([a, b])) {
      const h = HYBRIDS.get(c) ?? [];
      if (!h.includes(r)) h.push(r);
      HYBRIDS.set(c, h);
    }
  }
}

/** The base component elements of a fusion element (mirror → [water, shadow]); [] for a base element. */
export function elementComponents(el: string): string[] {
  return COMPONENTS.get(el) ?? [];
}
/** The fusion (hybrid) elements whose energy can substitute for a base element `el`; [] for a hybrid element.
 *  Keyed off the COST element, this gives the one-directional rule for free: a hybrid cost has no hybrids. */
export function hybridsFor(el: string): string[] {
  return HYBRIDS.get(el) ?? [];
}
