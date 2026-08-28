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
import { legalTargets, effectiveTargeting } from "../engine/src/scheduler.ts";
import { affectedUnits, resolveHighlightSelector } from "../engine/src/effects/interpret.ts";
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

/**
 * The full set of portraits a UI should HIGHLIGHT when aiming `skill`, honoring the skill's *effective*
 * targeting — a temporary skill_targeting_override (e.g. Black Knight's ultimate widening Oathbreaker Strike
 * to all-enemies / all) makes a normally single-target skill light up its whole group. This is the seam that
 * used to read the STATIC skill.targeting in each client, so a dynamically-widened skill still looked
 * single-target in the UI. A single-target skill defers to poolFor (faction narrowing); the group categories
 * resolve to their living set; self/none confirms on the caster.
 */
/** The units a natively group-targeted skill's effects actually reach, CONSTRAINED to its targeting category's
 *  faction — so a self-buff / self-cleanup rider on an all-enemies skill (removeStatus from:self, applyStatus
 *  to:self, …) never lights up the caster's own (ally) portrait. Returns null when the reach can't be fully
 *  determined (a custom op) or the filtered set is empty, so the caller falls back to the coarse category
 *  (over-including is acceptable there; under-including a real target would not be). */
function reachInCategory(state: MatchState, u: Unit, skill: SkillInstance, eff: string): Set<string> | null {
  const reach = affectedUnits(state, u, skill);
  if (!reach.complete) return null;
  const keep = (id: string): boolean => {
    const un = state.units[id];
    if (!un || !un.alive) return false;
    if (eff === "all-enemies") return un.team !== u.team;
    if (eff === "all-allies") return un.team === u.team;
    return true; // "all" — both teams
  };
  const filtered = new Set([...reach.units].filter(keep));
  return filtered.size ? filtered : null;
}

export function highlightFor(state: MatchState, u: Unit, skill: SkillInstance): Set<string> {
  // A single-target skill — aimed normally OR dynamically widened to an AoE by an override — reaches exactly
  // its legal pool, so highlight THAT. poolFor already encodes the fusion widenings (evil Oathbreaker reaches
  // ally HEROES, never the caster or ally minions), so a widened cast lights up precisely the units it hits;
  // using the coarse widened category ("all") instead would wrongly light up the caster and ally minions.
  if (skill.targeting === "single") return new Set(poolFor(state, u, skill).map((x) => x.id));
  const eff = effectiveTargeting(state, u, skill);
  if (eff === "self" || eff === "none") return new Set([u.id]); // confirm on the caster
  // An explicit reach override (for a custom-op skill the walker can't read) wins outright.
  if (skill.highlightSelector) return resolveHighlightSelector(state, u, skill.highlightSelector);
  // A natively group-targeted skill: highlight EXACTLY what its effects reach within the category (honoring
  // includeSelf / kind / status filters), not the raw living-team set — so it never lights up a portrait it
  // can't affect. Fall back to the coarse category when the reach is uncertain or empty.
  const reach = reachInCategory(state, u, skill, eff);
  if (reach) return reach;
  const enemyTeam: TeamId = u.team === "A" ? "B" : "A";
  switch (eff) {
    case "all-enemies": return new Set(livingOnTeam(state, enemyTeam).map((x) => x.id));
    case "all-allies": return new Set(livingOnTeam(state, u.team).map((x) => x.id));
    default: return new Set([...livingOnTeam(state, u.team), ...livingOnTeam(state, enemyTeam)].map((x) => x.id)); // "all"
  }
}

/**
 * The units a QUEUED action will actually hit, for the plan-order telegraph: its explicit single target(s),
 * else the whole group its *effective* targeting implies (self/none → the caster; all-* / a widened
 * single-target → that living group). Shares effectiveTargeting with highlightFor so the telegraph and the
 * aim-highlight can never disagree.
 */
export function telegraphFor(state: MatchState, a: { unit: string; skillId: string; targets?: string[] }): string[] {
  const u = state.units[a.unit];
  const skill = (u?.skills ?? []).find((s) => s.id === a.skillId);
  if (!u || !skill) return a.targets ?? [];
  // A queued SINGLE-target action can still SPREAD past its picked target (Supercharged Electroblade / Dive
  // Undertow hit a whole faction in some state while keeping the single pick that Charge Absorption / the
  // Undertow stun need). Compute the real reach with the target bound; if it's a superset, telegraph the
  // spread — dropping any self-bookkeeping unit the player didn't actually target.
  if (a.targets && a.targets.length) {
    const spreadReach = affectedUnits(state, u, skill, a.targets);
    if (spreadReach.complete && spreadReach.units.size > a.targets.length) {
      // A spread stays within the picked target's faction: a Harmful single hit that also CONSUMES the caster's
      // own Boulders / self-cleans a mark (rolandsun1, riverdaughter2) must not telegraph those ally-side units.
      const targetTeams = new Set(a.targets.map((id) => state.units[id]?.team).filter((t): t is TeamId => !!t));
      const spread = [...spreadReach.units].filter((id) => { const un = state.units[id]; return !!un && targetTeams.has(un.team); });
      if (spread.length > a.targets.length) return spread;
    }
    return a.targets;
  }
  // A widened single-target skill queued without an explicit target hits its whole legal pool — mirror
  // highlightFor (poolFor), so the plan telegraph and the aim-highlight agree and never over-show self/minions.
  if (skill.targeting === "single") return poolFor(state, u, skill).map((x) => x.id);
  const eff = effectiveTargeting(state, u, skill);
  if (eff === "self" || eff === "none") return [u.id]; // self / none → the caster
  if (skill.highlightSelector) return [...resolveHighlightSelector(state, u, skill.highlightSelector)];
  const reach = reachInCategory(state, u, skill, eff); // mirror highlightFor: telegraph the effects' real reach
  if (reach) return [...reach];
  const enemyTeam: TeamId = u.team === "A" ? "B" : "A";
  switch (eff) {
    case "all-enemies": return livingOnTeam(state, enemyTeam).map((x) => x.id);
    case "all-allies": return livingOnTeam(state, u.team).map((x) => x.id);
    default: return [...livingOnTeam(state, u.team), ...livingOnTeam(state, enemyTeam)].map((x) => x.id); // "all"
  }
}

/**
 * Does aiming `skill` require the player to click exactly ONE target? True only for the 'single' category.
 * Crucially this reads the EFFECTIVE targeting: a single-target skill dynamically widened by a
 * skill_targeting_override (Black Knight's ultimate, Taryn's Banner) returns false, so the client
 * auto-resolves the whole group instead of forcing a one-target click. The web client used to compute this
 * from the STATIC skill.targeting, which is precisely why a widened AoE still demanded a single click.
 */
export function isSingleTargetPick(state: MatchState, u: Unit, skill: SkillInstance): boolean {
  return effectiveTargeting(state, u, skill) === "single";
}
