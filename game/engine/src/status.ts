/**
 * Status / effect application, stacking and duration ticking.
 *
 * Two rulings drive this file:
 *   - DEFAULT_STACK_POLICY (MED): re-applying a status REFRESHES it (duration and
 *     magnitude take the new values); only kind "stack" accumulates a count.
 *   - DURATION_ANCHOR (CONFIRMED): a status applied "for N turns" decrements at the
 *     end of the APPLIER's turn — but NOT on the turn it was born, so "for 1 turn"
 *     survives the opponent's upcoming turn and expires at the applier's next turn-end.
 */
import type { MatchState, Status, TeamId, Unit, UnitId } from "./types.ts";

export interface ExpiredStatus {
  unitId: UnitId;
  status: Status;
}

/** Two statuses address the same effect if kind (+name for named effects) match. */
function sameSlot(a: Status, b: Status): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "mark" || a.kind === "stack" || a.kind === "dot" || a.kind === "stack_read_mod") return a.name === b.name;
  // A skill-scoped cost/cooldown mod (or instant_cast / currency remap) occupies its own slot per skill.
  if (a.kind === "cost_mod" || a.kind === "cooldown_mod" || a.kind === "instant_cast" || a.kind === "cost_currency_remap"
    || a.kind === "skill_damage_bonus" || a.kind === "skill_targeting_override") return a.skillId === b.skillId;
  // Concurrent channels of one skill occupy distinct slots by instanceId (undefined = the single-slot default).
  if (a.kind === "channeling") return a.instanceId === b.instanceId;
  // Elemental Essence is a COUNTABLE resource ("gains 3 Elemental Essence", "consumes 3 Elemental Essence"):
  // every grant is its own charge, so it never shares a slot (each applyStatus pushes a distinct charge and
  // grantIncome consumes exactly one per income tick).
  if (a.kind === "elemental_essence") return false;
  return true;
}

/**
 * Apply a status to a unit. Refreshes an existing matching status (new duration +
 * magnitude win) unless it is a "stack", which accumulates its count.
 */
export function applyStatus(unit: Unit, status: Status): void {
  const existing = unit.statuses.find((s) => sameSlot(s, status));
  if (!existing) {
    unit.statuses.push({ ...status });
    return;
  }
  if (status.kind === "stack") {
    existing.magnitude = (existing.magnitude ?? 0) + (status.magnitude ?? 1);
    // A fresh stack refreshes the shared duration to the longer of the two.
    existing.duration = longerDuration(existing.duration, status.duration);
    existing.appliedTurn = status.appliedTurn;
    return;
  }
  if (status.stacks) {
    // "This effect stacks": a re-applied named dot/effect ACCUMULATES magnitude (and refreshes duration/source)
    // instead of the default refresh.
    existing.magnitude = (existing.magnitude ?? 0) + (status.magnitude ?? 0);
    existing.duration = status.duration;
    existing.appliedBy = status.appliedBy;
    existing.appliedTurn = status.appliedTurn;
    existing.sourceId = status.sourceId;
    return;
  }
  // Refresh.
  existing.duration = status.duration;
  if (status.magnitude !== undefined) existing.magnitude = status.magnitude;
  existing.appliedBy = status.appliedBy;
  existing.appliedTurn = status.appliedTurn;
  existing.sourceId = status.sourceId;
  existing.invisible = status.invisible; // a re-application under a (non-)invisible context updates concealment
  // Merge scope: the BROADER stun/invulnerable wins — an unscoped (full) status must not be narrowed by a
  // scoped refresh, and a scoped status IS broadened to unscoped when a full one lands (gommar5: the "also
  // stunned" full stun over the AoE except-Strategic stun must fully stun him, not leave Ice Body castable).
  existing.scope = existing.scope === undefined || status.scope === undefined ? undefined : status.scope;

}

function longerDuration(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null; // null = round-permanent, the longer
  return Math.max(a, b);
}

/** Remove a named mark/stack outright (e.g. a skill that "consumes" the resource). */
export function removeStatus(unit: Unit, kind: Status["kind"], name?: string): void {
  unit.statuses = unit.statuses.filter(
    (s) => !(s.kind === kind && (name === undefined || s.name === name)),
  );
}

/** The untransformed stack magnitude — the "actual" count, used for read-mod gates/zero-tests (no recursion). */
export function rawStackCount(unit: Unit, name: string): number {
  const s = unit.statuses.find((x) => x.kind === "stack" && x.name === name);
  return s?.magnitude ?? 0;
}

export function stackCount(unit: Unit, name: string): number {
  let n = rawStackCount(unit, name);
  // "Treated as though they had N stacks": stack_read_mod statuses adjust the EFFECTIVE read so every
  // stack-scaled skill (all read stacks through here) sees the modified value. Gates/zero-tests read the
  // RAW count so a floorZero mod does not mask its own "0 stacks" condition.
  for (const m of unit.statuses) {
    if (m.kind !== "stack_read_mod" || m.name !== name) continue;
    if (m.readModIf !== undefined && rawStackCount(unit, m.readModIf) <= 0) continue;
    if (m.mode === "mult") n = n * (m.magnitude ?? 1);
    else if (m.mode === "floorZero") { if (rawStackCount(unit, name) === 0) n = m.magnitude ?? 0; }
    else if (m.mode === "missingHp") n = n + Math.floor(Math.max(0, unit.maxHp - unit.hp) / (m.magnitude ?? 1));
  }
  return n;
}

/**
 * Decrement, at the end of `team`'s turn, every timed status that team applied —
 * except ones born this very turn — and remove any that reach 0. Returns the
 * statuses that expired (so callers can run on-expire hooks later).
 *
 * Round-permanent statuses (duration === null) are untouched here; they clear at
 * round end (ruling PERMANENT_SCOPE).
 */
export function tickDurationsForTeam(state: MatchState, team: TeamId): ExpiredStatus[] {
  const expired: ExpiredStatus[] = [];
  for (const unit of Object.values(state.units)) {
    const kept: Status[] = [];
    for (const s of unit.statuses) {
      const owner = state.units[s.appliedBy];
      const appliedByTeam = owner ? owner.team === team : false;
      // A dot/regen ticks on its apply turn (tickDots counts it too), so its duration must decrement then as
      // well — otherwise a duration-N ticking effect would land N+1 ticks. A firstTickNextTurn dot/regen skips
      // the apply turn (and so does its duration). Every OTHER status keeps the birth-turn skip (a 1-turn
      // mark/buff applied this turn must survive into the next turn, not expire now).
      const countsApplyTurn = (s.kind === "dot" || s.kind === "regen") && !s.firstTickNextTurn;
      const started = countsApplyTurn ? s.appliedTurn <= state.turn : s.appliedTurn < state.turn;
      if (appliedByTeam && s.duration !== null && started) {
        const next = s.duration - 1;
        if (next <= 0) {
          expired.push({ unitId: unit.id, status: s });
          continue;
        }
        s.duration = next;
      }
      kept.push(s);
    }
    unit.statuses = kept;
  }
  return expired;
}

/** Clear round-scoped state (ruling PERMANENT_SCOPE): every status goes at round end. */
export function clearRoundStatuses(state: MatchState): void {
  for (const unit of Object.values(state.units)) unit.statuses = [];
}
