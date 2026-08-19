/**
 * Asset paths for the committed game art (assets/characters/<hero>/…), referenced relative to the page.
 * Portraits are `<hero>_portrait.png` (fusion forms: `<hero><key>_portrait.png`); skill icons are named by
 * the skill id (`saya1.png`, `sayaaurora1.png`, …). Served from the repo root so `../../assets` resolves.
 */
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { MINION_ART } from "./minionart.generated.ts";
import { SKILL_ICON } from "./skillicon.generated.ts";

const BASE = "../../assets/characters";

/** A hero's portrait — the fused form's portrait once it has fused. */
export function heroPortrait(heroId: string, fused?: string | null): string {
  return fused ? `${BASE}/${heroId}/${heroId}${fused}_portrait.png` : `${BASE}/${heroId}/${heroId}_portrait.png`;
}

/**
 * A skill/passive icon by its id — the one true resolver for hero, fusion AND minion skill art.
 * Prefers the generated map (frozen `image` field, which resolves the irregular minion filenames);
 * falls back to the hero-folder path for the few image-less skills. Returns null when nothing maps.
 */
export function iconOf(skillId: string, heroId?: string): string | null {
  const mapped = SKILL_ICON[skillId];
  if (mapped) return mapped;
  const hid = heroId ?? heroIdOfSkill(skillId);
  return hid ? `${BASE}/${hid}/${skillId}.png` : null;
}

/** A minion's portrait art, mapped from its display name (or null → use a labelled fallback). */
export function minionPortrait(name: string): string | null {
  return MINION_ART[name] ?? null;
}

/** The square energy icon for an element (or "generic") — for the energy pool + skill-cost pips. */
export function energyIcon(el: string): string {
  return `../../assets/energy_tooltips/${el}_energy.png`;
}

/** The angular roster-card art for a hero (character-select buttons). */
export function characterButton(heroId: string): string {
  return `../../assets/ui/character_buttons/${heroId}button.png`;
}

/** The character-select background scene. */
export const CS_BACKGROUND = "../../assets/ui/backgrounds/background.png";

// hero ids longest-first, so "sayaaurora1" prefix-matches "saya" (not a shorter accidental match).
const HERO_IDS = ROSTER.map((h) => h.id).sort((a, b) => b.length - a.length);
/** The hero that owns a skill id (its icon lives under that hero's folder) — for effect source icons. */
export function heroIdOfSkill(skillId: string): string | undefined {
  return HERO_IDS.find((id) => skillId.startsWith(id));
}

/** A muted, distinct colour per element — for energy pips and element tags. */
export const ELEMENT_COLOR: Record<string, string> = {
  fire: "#e0563a", ice: "#79d0ec", water: "#4a8ff0", lightning: "#ecc94a", earth: "#c39a5a",
  wind: "#8fd8a0", poison: "#a86ad8", shadow: "#7a6ad8", light: "#f0e6a0", grave: "#7a8899",
  slime: "#7fc86a", nomad: "#c9a26a", myth: "#e0b84a", moon: "#b8c0e8", spore: "#9ad86a",
  battery: "#e8d24a", stasis: "#8fd0e8", reanimation: "#c86a8a", faerie: "#e89ad0", ninja: "#8a8a9a",
  angel: "#f0e6c0", prism: "#d86ad0", aurora: "#6ad8c0", generic: "#8a8fa8",
  apocalypse: "#c0392b", devil: "#b0304a", holy: "#f0e0a0", serum: "#6ac8a0", storm: "#6a9fd8",
  unholy: "#8a5ad0", vengeance: "#d05a6a",
};
export const elColor = (el: string): string => ELEMENT_COLOR[el] ?? "#8a8fa8";
