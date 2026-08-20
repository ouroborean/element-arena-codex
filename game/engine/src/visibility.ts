/**
 * Perspective redaction — the single pass that turns the authoritative MatchState into what one team is
 * allowed to see. An "Invisible" effect (a status the opponent must not perceive) is stripped from the
 * opponent's copy here and NOWHERE else, so the whole feature is one agnostic transform rather than a rule
 * scattered across the renderer.
 *
 * A status is Invisible to a viewer when it is invisible AND owned by the other team AND the viewer holds no
 * reveal. "Invisible" has two sources that this pass unions:
 *   - FROZEN provenance: `status.invisible === true`, stamped at apply time from an isHidden skill's
 *     execution context or a status-spec `invisible:true` (see buildStatus). Permanent for that status.
 *   - DYNAMIC cloak: the status's applier is currently concealed (holds a cloak like `veiled`). This is
 *     recomputed every pass, so effects re-appear the moment the cloak drops.
 *
 * The server calls this once per seat inside wireState(viewer); the local vs-bot client calls it for the
 * human's view. It is PURE — it never mutates the input, and it always leaves `statuses` an array so the
 * renderer (which does `for (const s of u.statuses)`) never trips on a missing field.
 */
import type { MatchState, Status, TeamId, Unit } from "./types.ts";

/** The team that created a status — the scope of its invisibility. Derived from the applier; if that unit
 *  has left the board, fall back to the bearer's team (an orphaned effect is treated as the bearer's own). */
export function statusOwnerTeam(state: MatchState, status: Status, bearer: Unit): TeamId {
  return state.units[status.appliedBy]?.team ?? bearer.team;
}

/** Is this unit concealed by a team cloak right now? While concealed, the effects it creates and the skills
 *  it uses are Invisible to the enemy. Today the sole cloak is the `veiled` status; a later PR folds in the
 *  Keeper "Endless Night" mark and Laria "Deep, Dark Night" so this stays the one place cloak is defined. */
export function isConcealed(unit: Unit | undefined): boolean {
  return !!unit && unit.statuses.some((s) => s.kind === "veiled");
}

/** Does `viewer`'s team currently see through the opponent's invisibility (a reveal / True Sight)? Wired in a
 *  later PR (Ayana's Prism Sentence, Laria's Deepening Shadows); until then no team has reveal. */
export function viewerHasReveal(_state: MatchState, _viewer: TeamId): boolean {
  return false;
}

/** Should this status be hidden from `viewer`? You always see your own team's effects; otherwise an effect
 *  is hidden when it is invisible (frozen) or its applier is cloaked (dynamic), and the viewer has no reveal. */
function hiddenFrom(state: MatchState, status: Status, bearer: Unit, viewer: TeamId, reveal: boolean): boolean {
  if (statusOwnerTeam(state, status, bearer) === viewer) return false;
  if (reveal) return false;
  return status.invisible === true || isConcealed(state.units[status.appliedBy]);
}

/**
 * Project the authoritative state into `viewer`'s view: the opponent's Invisible statuses (and every effect
 * created by a cloaked enemy) are removed. Copies only the units whose statuses actually change, so an
 * ordinary board with no invisibility returns the input object untouched.
 */
export function redactState(state: MatchState, viewer: TeamId): MatchState {
  const reveal = viewerHasReveal(state, viewer);
  let changed = false;
  const units: Record<string, Unit> = {};
  for (const [id, u] of Object.entries(state.units)) {
    const visible = u.statuses.filter((s) => !hiddenFrom(state, s, u, viewer, reveal));
    if (visible.length === u.statuses.length) {
      units[id] = u;
    } else {
      units[id] = { ...u, statuses: visible };
      changed = true;
    }
  }
  return changed ? { ...state, units } : state;
}
