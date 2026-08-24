/**
 * Augments — the between-round upgrades that MODIFY a hero's kit. Each is a declarative list
 * of `Patch`es over the hero's live skills/triggers, applied cumulatively across rounds (a hero
 * may take one augment per round, up to five). Because augments are arbitrary prose ("X also
 * marks a second target", "Y is now permanent"), the patch vocabulary is small but composable:
 * add a trigger, add/replace a skill, tweak a skill's metadata, append to a skill's effect tree,
 * or rewrite a single addressable node inside it (the `id`-addressed surgery the whole metagame
 * bets on). A `custom` escape hatch covers anything the data can't say.
 *
 * Clone discipline: `loadHero` shares a hero's skill objects (and their effect arrays, `tags`,
 * `cost`) with the authored `HeroDef`. Every patch that mutates a skill first deep-clones it onto
 * the unit, so one hero's augment never leaks into the shared content or a teammate.
 */
import type { MinionSkillPatch, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { Effect, NodeId } from "../src/effects/ast.ts";
import { replaceNode } from "../src/effects/patch.ts";
import type { HeroTrigger } from "./hero.ts";

/** Fields an augment may overwrite on a skill (metadata only — effects go through patchNode/appendEffect).
 *  `isHidden` lets an augment make a skill Invisible ("Elegant Sweep is now invisible", Fate's Deals
 *  "invisible until triggered"): it flows through the normal isHidden path (redaction + the unified hidden
 *  event flag), so the skill's cast and every effect it applies become concealed. */
type SkillMeta = Partial<Pick<SkillInstance,
  "name" | "cost" | "cooldown" | "tags" | "targeting" | "element" | "klass" | "requires" | "uncounterableIf" | "channelTurns" | "doesNotInterrupt" | "isHidden">>;

export type Patch =
  | { op: "addTrigger"; trigger: HeroTrigger }
  | { op: "removeTrigger"; source: string }
  | { op: "addSkill"; skill: SkillInstance; slot?: number }
  | { op: "replaceSkill"; skillId: string; skill: SkillInstance }
  | { op: "setSkillMeta"; skillId: string; meta: SkillMeta }
  | { op: "appendEffect"; skillId: string; effect: Effect[] }
  | { op: "prependEffect"; skillId: string; effect: Effect[] }
  | { op: "patchNode"; skillId: string; nodeId: NodeId; replace: Effect }
  | { op: "custom"; fn: string; args?: Record<string, unknown> };

export interface Augment {
  id: string;
  /** The hero this augment belongs to (provenance; which hero it may be drafted onto). */
  owner?: string;
  name: string;
  /** The exact prose (the oracle). */
  description: string;
  patches: Patch[];
}

/** Native handlers for the rare augment clause no patch op can express. */
export type AugmentFn = (unit: Unit, args: Record<string, unknown>) => void;
const AUGMENT_CUSTOM = new Map<string, AugmentFn>();
export function registerAugmentCustom(name: string, fn: AugmentFn): void {
  AUGMENT_CUSTOM.set(name, fn);
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Park a patch whose target skill the hero does not own — it addresses a skill on the hero's minion
 *  TEMPLATES (Trinity's Lens skills). summonMinion replays these onto each minion the hero summons. */
function recordMinionPatch(unit: Unit, p: MinionSkillPatch): void {
  unit.minionSkillPatches = [...(unit.minionSkillPatches ?? []), p];
}

/** Find a skill by id, replace it on the unit with a deep clone, and return the clone to mutate. */
export function mutableSkill(unit: Unit, skillId: string): SkillInstance | undefined {
  const skills = unit.skills ?? [];
  const i = skills.findIndex((s) => s.id === skillId);
  if (i < 0) return undefined;
  const copy = clone(skills[i]!);
  skills[i] = copy;
  unit.skills = skills;
  return copy;
}

export function applyPatch(unit: Unit, patch: Patch): void {
  switch (patch.op) {
    case "addTrigger":
      // Tagged augment-origin so a later fusion's passive swap preserves it (see content/fusion.ts).
      unit.triggers = [...(unit.triggers ?? []), { ...clone(patch.trigger), owner: unit.id, origin: "augment" }];
      return;
    case "removeTrigger":
      unit.triggers = (unit.triggers ?? []).filter((t) => t.source !== patch.source);
      return;
    case "addSkill": {
      const skills = unit.skills ?? [];
      const skill: SkillInstance = { ...clone(patch.skill), currentCd: 0 };
      const at = patch.slot ?? skills.length;
      skills.splice(at, 0, skill);
      unit.skills = skills;
      return;
    }
    case "replaceSkill": {
      const skills = unit.skills ?? [];
      const i = skills.findIndex((s) => s.id === patch.skillId);
      if (i >= 0) {
        skills[i] = { ...clone(patch.skill), currentCd: 0 };
        unit.skills = skills;
      } else {
        // The named skill belongs to a MINION this hero summons, not the hero — park the replacement so it is
        // replayed onto each summoned minion (trinity Grand Sonata / Golden Fantasia replace Azure/Saffron skills).
        recordMinionPatch(unit, { op: "replaceSkill", skillId: patch.skillId, skill: clone(patch.skill) });
      }
      return;
    }
    case "setSkillMeta": {
      const s = mutableSkill(unit, patch.skillId);
      if (s) Object.assign(s, clone(patch.meta));
      else recordMinionPatch(unit, { op: "setSkillMeta", skillId: patch.skillId, meta: clone(patch.meta) as Record<string, unknown> });
      return;
    }
    case "appendEffect": {
      const s = mutableSkill(unit, patch.skillId);
      if (s) s.effects = [...s.effects, ...clone(patch.effect)];
      else recordMinionPatch(unit, { op: "appendEffect", skillId: patch.skillId, effect: clone(patch.effect) });
      return;
    }
    case "prependEffect": {
      // Runs the added effects BEFORE the base skill's — for "at use time" reads (ayana Answered Prayers must
      // check the target's HP before Prayer's +10 heal).
      const s = mutableSkill(unit, patch.skillId);
      if (s) s.effects = [...clone(patch.effect), ...s.effects];
      else recordMinionPatch(unit, { op: "prependEffect", skillId: patch.skillId, effect: clone(patch.effect) });
      return;
    }
    case "patchNode": {
      const s = mutableSkill(unit, patch.skillId);
      if (s) replaceNode(s.effects, patch.nodeId, clone(patch.replace));
      else recordMinionPatch(unit, { op: "patchNode", skillId: patch.skillId, nodeId: patch.nodeId, replace: clone(patch.replace) });
      return;
    }
    case "custom": {
      const fn = AUGMENT_CUSTOM.get(patch.fn);
      if (!fn) throw new Error(`augment custom not registered: ${patch.fn}`);
      fn(unit, patch.args ?? {});
      return;
    }
  }
}

/** Apply an augment's patches to a hero and record it (cumulative across the match). */
export function applyAugment(unit: Unit, aug: Augment): void {
  for (const p of aug.patches) applyPatch(unit, p);
  unit.augments = [...(unit.augments ?? []), aug.id];
}
