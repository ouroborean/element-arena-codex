/**
 * Per-player progression / unlocks — a pure, dependency-light module: the schema for the account `progress`
 * blob, the win-award, and every unlock derivation. The client awards on a win (all match types count) and
 * persists it via /save; the draft gate (metagame.ts) and the team-select / draft UI read the same
 * derivations, so a lock is enforced and displayed from one source of truth.
 *
 * Two counters drive everything:
 *   augWins[augId]     — matches won with that augment equipped on its owner hero. Augments are ordinal
 *                        `<hero><1..5>`; the "advanced" augments are 4 & 5.
 *   fusedWins[element] — matches won with one of your heroes fused INTO that fusion element.
 *
 * Unlock rules (single-element heroes start unlocked; fusion-element heroes, advanced augments and Fusion start
 * LOCKED):
 *   • a hero's 4th & 5th augments  ← a win with each of augments 1, 2 and 3
 *   • a hero's Fusion ability       ← (once 4 & 5 are unlocked) a win with each of augments 4 and 5
 *   • a fusion-element hero         ← 3 wins with a hero fused into that hero's native (fusion) element
 */
import { ROSTER } from "./roster.generated.ts";
import { elementComponents } from "../src/elements.ts";

export interface Progress {
  v: 1;
  augWins: Record<string, number>;   // augmentId (`<hero><1..5>`) -> wins with it equipped
  fusedWins: Record<string, number>; // fusion element name        -> wins with a hero fused into it
}

export function emptyProgress(): Progress {
  return { v: 1, augWins: {}, fusedWins: {} };
}

/** Coerce the untrusted stored blob (`Profile.progress` is `unknown`) into a well-formed Progress — drops any
 *  non-positive / non-finite / non-numeric entries so a corrupt or hand-edited blob can't crash a derivation. */
export function asProgress(raw: unknown): Progress {
  const p = emptyProgress();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const [key, dst] of [["augWins", p.augWins], ["fusedWins", p.fusedWins]] as const) {
      const src = o[key];
      if (src && typeof src === "object") {
        for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v) && v > 0) dst[k] = Math.floor(v);
        }
      }
    }
  }
  return p;
}

/** The fusion-element heroes (whose NATIVE element is itself a hybrid) → that element. Derived from the roster:
 *  a hero is fusion-element iff its element has base components. There are 7 today (dennis, fate, scratch,
 *  aramao, sera, galazax, trinity). */
export const FUSION_ELEMENT_HEROES: ReadonlyMap<string, string> = new Map(
  ROSTER.filter((h) => elementComponents(h.element).length > 0).map((h) => [h.id, h.element] as const),
);

const N = (rec: Record<string, number>, k: string): number => rec[k] ?? 0;

/** A hero's advanced (4th & 5th) augments — unlocked by a win with each of augments 1, 2 and 3. */
export function advancedAugmentsUnlocked(p: Progress, hero: string): boolean {
  return N(p.augWins, `${hero}1`) >= 1 && N(p.augWins, `${hero}2`) >= 1 && N(p.augWins, `${hero}3`) >= 1;
}

/** Is one augment unlocked? Augments 1–3 are always available; 4 & 5 need the hero's advanced unlock. An id that
 *  doesn't parse as `<hero><n>` is left ungated (fail-open). */
export function augmentUnlocked(p: Progress, augId: string): boolean {
  const m = /^([a-z]+)([1-9]\d*)$/.exec(augId);
  if (!m) return true;
  return Number(m[2]) <= 3 || advancedAugmentsUnlocked(p, m[1]!);
}

/** A single-element hero's Fusion ability — unlocked (after its advanced augments) by a win with each of 4 & 5. */
export function fusionUnlocked(p: Progress, hero: string): boolean {
  return advancedAugmentsUnlocked(p, hero) && N(p.augWins, `${hero}4`) >= 1 && N(p.augWins, `${hero}5`) >= 1;
}

/** Wins with a hero fused into a fusion element needed to unlock that element's (fusion-element) hero. */
export const FUSION_ELEM_WINS_REQUIRED = 3;

/** Is a hero pickable at team-select? Single-element heroes always are; a fusion-element hero unlocks after
 *  FUSION_ELEM_WINS_REQUIRED wins with a hero fused into its element. */
export function heroUnlocked(p: Progress, hero: string): boolean {
  const el = FUSION_ELEMENT_HEROES.get(hero);
  return el === undefined || N(p.fusedWins, el) >= FUSION_ELEM_WINS_REQUIRED;
}

/** The winner's heroes, minimally: which augments each had equipped and whether (and to what) it fused. */
export interface WinUnit { kind: string; augments?: string[]; fused?: string; }

/** Credit a WIN (pure): for each of the winner's heroes, count every augment it had equipped this match and its
 *  fusion element (if it fused). Augments stack across a match's rounds, so one win can advance several. */
export function creditWin(p: Progress, myUnits: readonly WinUnit[]): Progress {
  const next: Progress = { v: 1, augWins: { ...p.augWins }, fusedWins: { ...p.fusedWins } };
  for (const u of myUnits) {
    if (u.kind !== "hero") continue;
    for (const a of u.augments ?? []) next.augWins[a] = N(next.augWins, a) + 1;
    if (u.fused) next.fusedWins[u.fused] = N(next.fusedWins, u.fused) + 1;
  }
  return next;
}
