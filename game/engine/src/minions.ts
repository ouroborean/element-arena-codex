/**
 * Minion templates + registry.
 *
 * A minion is summoned from a named template (its HP, element, skills and triggers).
 * The `summon` effect looks the template up here and instantiates a Unit. Content
 * registers templates at load time (like the custom-effect registry), so the engine
 * stays free of content imports.
 */
import type { SkillInstance } from "./skill.ts";
import type { TriggeredEffect } from "./events.ts";

export interface MinionTemplate {
  name: string;
  maxHp: number;
  /** Defaults to the summoner's current element when omitted. */
  element?: string;
  skills?: SkillInstance[];
  /** Triggers, minus `owner` (bound to the minion's id when summoned). */
  triggers?: Omit<TriggeredEffect, "owner">[];
}

const REGISTRY = new Map<string, MinionTemplate>();

export function registerMinion(t: MinionTemplate): void {
  REGISTRY.set(t.name, t);
}
export function getMinionTemplate(name: string): MinionTemplate | undefined {
  return REGISTRY.get(name);
}
export function clearMinionRegistry(): void {
  REGISTRY.clear();
}
