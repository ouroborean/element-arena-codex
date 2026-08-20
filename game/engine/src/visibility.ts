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

/** Is this unit concealed by a cloak right now? While concealed, the effects it creates and the skills it
 *  uses are Invisible to the enemy. Two cloak kinds, both handled here so this is the one place cloak is
 *  defined: `veiled` (breaks when the holder acts Harmfully) and `cloak` (a timed, non-breaking window,
 *  Keeper "Endless Night"). Laria "Deep, Dark Night" uses `veiled`, so it is covered too. */
export function isConcealed(unit: Unit | undefined): boolean {
  return !!unit && unit.statuses.some((s) => s.kind === "veiled" || s.kind === "cloak");
}

/** Is this SKILL USE Invisible to the opponent? Either the skill is inherently Invisible (isHidden) or its
 *  caster is currently concealed by a cloak. This is the single predicate behind the `hidden` flag on the
 *  skillDeclared/skillUsed events — so a reader like Sera ("non-Invisible") or Keeper ("whenever an
 *  invisible skill is used") reacts to BOTH sources uniformly. */
export function skillIsInvisible(caster: Unit, skill: { isHidden?: boolean }): boolean {
  return !!skill.isHidden || isConcealed(caster);
}

/** Does `viewer`'s team currently see through the opponent's invisibility (a reveal / True Sight)? True while
 *  any unit on the team holds a `reveal` status — Ayana's "Illumination" (while Prism Sentence is active) or
 *  Laria's Deepening Shadows reveal branch. When true, redactState stops hiding the enemy's Invisible effects
 *  from this viewer. */
export function viewerHasReveal(state: MatchState, viewer: TeamId): boolean {
  const t = state.teams[viewer];
  return t.units.some((id) => state.units[id]?.statuses.some((s) => s.kind === "reveal"));
}

/** Should this status be hidden from `viewer`? You always see your own team's effects; otherwise an effect
 *  is hidden when it is invisible (frozen) or its applier is cloaked (dynamic), and the viewer has no reveal. */
function hiddenFrom(state: MatchState, status: Status, bearer: Unit, viewer: TeamId, reveal: boolean): boolean {
  if (statusOwnerTeam(state, status, bearer) === viewer) return false;
  if (reveal) return false;
  return status.invisible === true || isConcealed(state.units[status.appliedBy]);
}

/** An Invisible cast fingerprints the caster OUTSIDE its statuses: the skill it used ticks a cooldown, and
 *  the last-skill ledger names it. Neither is drawn in the UI, but both ride the wire — so from a FOE's view
 *  scrub the cooldown of any Invisible skill and blank a last-skill ledger that names one. Only isHidden
 *  skills are touched, so ordinary skills' cooldowns are unchanged. Returns the unit unchanged if nothing
 *  needs hiding. */
function redactFoeFingerprints(u: Unit): Unit {
  const skills = u.skills;
  let out = u;
  if (skills?.some((s) => s.isHidden && (s.currentCd > 0 || s.cdSetTurn !== undefined))) {
    out = { ...out, skills: skills.map((s) => (s.isHidden && (s.currentCd > 0 || s.cdSetTurn !== undefined) ? { ...s, currentCd: 0, cdSetTurn: undefined } : s)) };
  }
  if (u.lastSkillId && skills?.some((s) => s.id === u.lastSkillId && s.isHidden)) {
    out = { ...out, lastSkillId: undefined };
  }
  return out;
}

/**
 * Project the authoritative state into `viewer`'s view: the opponent's Invisible statuses (and every effect
 * created by a cloaked enemy) are removed, and the wire-only fingerprints of an Invisible cast on a foe
 * (an Invisible skill's cooldown, the last-skill ledger naming it) are scrubbed. Copies only what changes,
 * so an ordinary board with no invisibility returns the input object untouched.
 */
export function redactState(state: MatchState, viewer: TeamId): MatchState {
  const reveal = viewerHasReveal(state, viewer);
  let changed = false;
  const units: Record<string, Unit> = {};
  for (const [id, u] of Object.entries(state.units)) {
    let out = u;
    const visible = u.statuses.filter((s) => !hiddenFrom(state, s, u, viewer, reveal));
    if (visible.length !== u.statuses.length) out = { ...out, statuses: visible };
    // A viewer with True Sight sees the opponent's Invisible skills whole (incl. their cooldowns).
    if (u.team !== viewer && !reveal) out = redactFoeFingerprints(out);
    if (out !== u) changed = true;
    units[id] = out;
  }
  return changed ? { ...state, units } : state;
}
