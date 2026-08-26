/**
 * Client-side target OFFERING — which units a UI should let the player click for a single-target skill.
 * Shared by BOTH clients (terminal cli.ts and the browser web/src/main.ts) so the faction rules live in ONE
 * place (they used to be duplicated verbatim, which is how the dual-tag bug hid in two clients at once).
 *
 * The ENGINE's legalTargets has no faction filter — it accepts any unit and lets the skill's effect branch on
 * faction. This is purely the client narrowing the *offered* candidates by intent:
 *   - a cross-faction skill (targetsEitherFaction) → either team
 *   - a Harmful-only skill  → enemies
 *   - a Helpful-only skill  → allies
 *   - neither tag           → either team
 *   - a couple of fusion widenings (Merciless, Swoop) special-cased below
 * The chosen pool is then run through the engine's legalTargets (taunt / blind / invulnerable / isolated /
 * untargetable / dead), so this only ever *widens or narrows the offer*, never overrides the engine's rules.
 *
 * Node-dependency-free (imports only engine modules) so it bundles cleanly into the browser client.
 */
import type { MatchState, TeamId, Unit } from "../engine/src/types.ts";
import type { SkillInstance } from "../engine/src/skill.ts";
import { legalTargets } from "../engine/src/scheduler.ts";
import { Rng } from "../engine/src/rng.ts";

export const livingOnTeam = (state: MatchState, side: TeamId): Unit[] =>
  state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.alive);

/** The candidate targets to OFFER for `skill` cast by `u`, run through the engine's legalTargets. */
export function poolFor(state: MatchState, u: Unit, skill: SkillInstance): Unit[] {
  const enemyTeam: TeamId = u.team === "A" ? "B" : "A";
  const enemies = () => livingOnTeam(state, enemyTeam);
  const allies = () => livingOnTeam(state, u.team);
  const both = () => [...allies(), ...enemies()];

  // Fusion targeting expansions (the engine allows the ally target; these only widen the offered pool):
  //  - Merciless (black knight "evil"): Oathbreaker Strike may target allied Heroes.
  //  - Mountain Rescue Team (syl "winter"): the Eagle's Swoop may target a stunned ally (for invuln).
  const merciless = skill.id === "blackknight1" && u.fused === "evil";
  const swoopRescue = skill.id === "sylminion2" && state.units[u.summoner ?? ""]?.fused === "winter";
  // Roland's "Strength From The Earth" targets an enemy OR one of his ally Boulders (which it launches).
  const rolandLaunch = skill.id === "roland1";

  const pool = merciless
    ? [...enemies(), ...allies().filter((x) => x.kind === "hero" && x.id !== u.id)]
    : swoopRescue
    ? [...enemies(), ...allies().filter((x) => x.id !== u.id && x.statuses.some((s) => s.kind === "stun"))]
    : rolandLaunch
    ? [...enemies(), ...allies().filter((x) => x.kind === "minion" && x.name === "Boulder")]
    // A cross-faction skill ("target an enemy OR an ally") offers both teams. This is authored per-skill —
    // NOT derived from tags, which are an unreliable proxy (Bog Witch's Bargain is Harmful+Helpful but
    // enemies-only; Tormentor's Brand is Harmful-only but targets either faction).
    : skill.targetsEitherFaction ? both()
    : skill.tags.includes("Harmful") ? enemies()
    : skill.tags.includes("Helpful") ? allies()
    : both();

  return legalTargets(state, u, skill, pool, Rng.fromState(state.rngState));
}
