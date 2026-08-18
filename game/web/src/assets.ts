/**
 * Asset paths for the committed game art (assets/characters/<hero>/…), referenced relative to the page.
 * Portraits are `<hero>_portrait.png` (fusion forms: `<hero><key>_portrait.png`); skill icons are named by
 * the skill id (`saya1.png`, `sayaaurora1.png`, …). Served from the repo root so `../../assets` resolves.
 */
const BASE = "../../assets/characters";

/** A hero's portrait — the fused form's portrait once it has fused. */
export function heroPortrait(heroId: string, fused?: string | null): string {
  return fused ? `${BASE}/${heroId}/${heroId}${fused}_portrait.png` : `${BASE}/${heroId}/${heroId}_portrait.png`;
}

/** A skill icon by its id (works for base + fusion skills, whose ids start with the hero id). */
export function skillIcon(heroId: string, skillId: string): string {
  return `${BASE}/${heroId}/${skillId}.png`;
}

/** A muted, distinct colour per element — for energy pips and element tags. */
export const ELEMENT_COLOR: Record<string, string> = {
  fire: "#e0563a", ice: "#79d0ec", water: "#4a8ff0", lightning: "#ecc94a", earth: "#c39a5a",
  wind: "#8fd8a0", poison: "#a86ad8", shadow: "#7a6ad8", light: "#f0e6a0", grave: "#7a8899",
  slime: "#7fc86a", nomad: "#c9a26a", myth: "#e0b84a", moon: "#b8c0e8", spore: "#9ad86a",
  battery: "#e8d24a", stasis: "#8fd0e8", reanimation: "#c86a8a", faerie: "#e89ad0", ninja: "#8a8a9a",
  angel: "#f0e6c0", prism: "#d86ad0", aurora: "#6ad8c0", generic: "#8a8fa8",
};
export const elColor = (el: string): string => ELEMENT_COLOR[el] ?? "#8a8fa8";
