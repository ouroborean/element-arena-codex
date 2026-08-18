/**
 * Authored hero content — the hand-written DSL trees that give the frozen
 * descriptions their behaviour. This is the first real content: skills are
 * transcribed FROM their prose (the oracle) into effect trees, type-checked by tsc.
 *
 * Lives beside the engine (not inside `src/`) and imports the engine's public types,
 * so a typo in an authored effect is a compile error. It can move to its own package
 * later without touching the engine.
 */
import type { TeamId, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { TriggeredEffect } from "../src/events.ts";
import "./custom_effects.ts"; // side-effect: registers the roster's `custom` handlers
import "./augment_effects.ts"; // side-effect: registers the augments' `custom` handlers
import "./fusion_effects.ts"; // side-effect: registers implemented fusion `custom` handlers (by cluster)

/** A trigger authored on a hero, minus `owner` (bound to the unit id at load time). */
export type HeroTrigger = Omit<TriggeredEffect, "owner">;

export interface PassiveDef {
  name: string;
  /** The exact prose (the oracle). */
  description: string;
  /** Why it isn't wired yet, if it needs a not-yet-built subsystem. */
  pending?: string;
}

export interface HeroDef {
  id: string;
  name: string;
  element: string;
  maxHp: number;
  passive: PassiveDef;
  /** The active skills (slots 1..N), authored as runtime instances. */
  skills: SkillInstance[];
  /** Reactive triggers (usually from the passive). */
  triggers?: HeroTrigger[];
}

/** Instantiate a hero onto a team: fresh HP, fresh per-unit cooldowns. */
export function loadHero(def: HeroDef, team: TeamId, id: string = def.id): Unit {
  return {
    id,
    kind: "hero",
    name: def.name,
    team,
    hp: def.maxHp,
    maxHp: def.maxHp,
    shields: [],
    baseElement: def.element,
    currentElement: def.element,
    statuses: [],
    alive: true,
    // Clone each skill so its currentCd is per-unit; effect trees are read-only and shared.
    skills: def.skills.map((s) => ({ ...s, currentCd: 0 })),
    triggers: (def.triggers ?? []).map((t) => ({ ...t, owner: id })),
  };
}
