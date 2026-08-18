/**
 * The between-round AUGMENT_OR_FUSE draft — I/O-free logic so the CLI (and any future client) and the
 * tests share it. Provisional ruling (the exact draft structure is open in RULINGS.md): each round the
 * match continues, EACH team makes ONE choice — fuse one hero, augment one hero, or hold — with the
 * round loser choosing first. Fusion is once-per-hero and partner-gated (see engine `availableFusions`).
 */
import type { MatchState, TeamId, Unit } from "../engine/src/types.ts";
import { applyFusion } from "../engine/content/fusion.ts";
import { applyAugment } from "../engine/content/augment.ts";
import { fusionForm } from "../engine/content/fusions.generated.ts";
import { augmentById } from "../engine/content/augments.generated.ts";
import { availableFusions, availableAugments } from "../engine/content/metagame.ts";

export type DraftChoice =
  | { kind: "fuse"; unitId: string; formKey: string }
  | { kind: "augment"; unitId: string; augmentId: string }
  | { kind: "skip" };

/** The heroes on a side, in slot order — every hero may draft (the loser is wiped at draft time, but the
 *  next round revives the whole team, so alive-status is irrelevant here). */
export function draftableHeroes(state: MatchState, side: TeamId): Unit[] {
  return state.teams[side].units
    .map((id) => state.units[id])
    .filter((u): u is Unit => !!u && u.kind === "hero");
}

/** Does this side have any upgrade available at all (a fusion or an untaken augment)? */
export function hasDraftOptions(state: MatchState, side: TeamId): boolean {
  return draftableHeroes(state, side).some((u) => availableFusions(state, u).length > 0 || availableAugments(u).length > 0);
}

export interface DraftResult { ok: boolean; desc: string }

/** Validate a choice against the live availability rules, then apply it (mutating the hero). */
export function applyDraftChoice(state: MatchState, choice: DraftChoice): DraftResult {
  if (choice.kind === "skip") return { ok: true, desc: "held — no upgrade" };
  const unit = state.units[choice.unitId];
  if (!unit || unit.kind !== "hero") return { ok: false, desc: "no such hero" };

  if (choice.kind === "fuse") {
    if (!availableFusions(state, unit).some((f) => f.key === choice.formKey)) return { ok: false, desc: "that fusion isn't available" };
    const form = fusionForm(unit.heroId ?? "", choice.formKey);
    if (!form) return { ok: false, desc: "unknown fusion form" };
    applyFusion(unit, form);
    return { ok: true, desc: `${unit.name} fused → ${form.key} (${form.passive.name})` };
  }

  if (!availableAugments(unit).some((a) => a.id === choice.augmentId)) return { ok: false, desc: "that augment isn't available" };
  const aug = augmentById(choice.augmentId);
  if (!aug) return { ok: false, desc: "unknown augment" };
  applyAugment(unit, aug);
  return { ok: true, desc: `${unit.name} gained augment: ${aug.name}` };
}

/**
 * A simple deterministic bot draft: fuse the first hero that still can (fusion is the bigger power
 * spike), otherwise augment the first hero with an untaken augment, otherwise hold.
 */
export function autoDraft(state: MatchState, side: TeamId): DraftChoice {
  for (const u of draftableHeroes(state, side)) {
    const forms = availableFusions(state, u);
    if (forms.length) return { kind: "fuse", unitId: u.id, formKey: forms[0]!.key };
  }
  for (const u of draftableHeroes(state, side)) {
    const augs = availableAugments(u);
    if (augs.length) return { kind: "augment", unitId: u.id, augmentId: augs[0]!.id };
  }
  return { kind: "skip" };
}
