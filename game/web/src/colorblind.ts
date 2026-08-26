/**
 * Colorblind support: an accessibility mode that replaces every energy ICON with a text label — the
 * element's name in brackets, coloured in that element's colour — so energy types are told apart by NAME,
 * not colour alone. The base-element palette is the requested high-contrast scheme; a fusion element blends
 * its two component base colours (and is still named, e.g. "[Mirror]"); generic is neutral. Every label
 * also carries a luminance-aware contrast halo (a light colour gets a dark halo, a dark colour a light one)
 * so even "shadow" (black) or "water" (dark blue) stay readable on the dark board.
 *
 * State is per-device (localStorage), read synchronously by the pure render fns in view.ts / main.ts.
 */
import { elementComponents } from "../../engine/src/elements.ts";

const KEY = "arenaColorblind";

// Requested base-element palette: Fire orange, Water dark blue, Ice light blue, Wind white, Lightning
// purple, Holy yellow, Shadow black, Unholy dark red, Earth brown, Poison light green.
const BASE_CB: Record<string, string> = {
  fire: "#f07a1e", water: "#2746c8", ice: "#7fd4f5", wind: "#f4f6f8", lightning: "#a24ce0",
  holy: "#f2cf1a", shadow: "#101014", unholy: "#9e1616", earth: "#9b6a34", poison: "#79db72",
};
const GENERIC_CB = "#cbd0da"; // generic energy has no element — a neutral light grey

let enabled = read();
function read(): boolean { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } }
/** Whether colorblind energy labels are currently on (read by the render paths). */
export function cbEnabled(): boolean { return enabled; }
/** Turn colorblind labels on/off and persist the choice per-device. */
export function setColorblind(v: boolean): void {
  enabled = v;
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* private mode — the module var keeps it stable this session */ }
}
/** Flip the setting; returns the new state. */
export function toggleColorblind(): boolean { setColorblind(!enabled); return enabled; }

const rgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (r: number, g: number, b: number): string => "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");

/** The colorblind label colour for any element: base → palette, generic → neutral, fusion → the blend of
 *  its two base components (so Mirror = water+shadow reads as a dark navy, while its label still names it). */
export function cbColor(el: string): string {
  if (el in BASE_CB) return BASE_CB[el]!;
  if (el === "generic") return GENERIC_CB;
  const comp = elementComponents(el);
  if (comp.length) {
    const a = rgb(BASE_CB[comp[0]!] ?? GENERIC_CB), b = rgb(BASE_CB[comp[comp.length - 1]!] ?? GENERIC_CB);
    return toHex((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  }
  return GENERIC_CB;
}

/** The contrast halo (text-shadow colour) for `color` — dark colours get a light halo, light ones a dark halo. */
export function cbHalo(color: string): string {
  const [r, g, b] = rgb(color);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.5 ? "rgba(244,246,248,.95)" : "rgba(10,10,14,.9)";
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** The bracketed label text for an element, e.g. "[Fire]", "[Mirror]", "[Generic]". */
export function cbLabel(el: string): string { return `[${cap(el)}]`; }

const escAttr = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** HTML for a colorblind energy label — for the string-building render paths in view.ts. */
export function cbEnergyHtml(el: string, extra = ""): string {
  const c = cbColor(el);
  return `<span class="cb-en${extra ? " " + extra : ""}" style="color:${c};--halo:${cbHalo(c)}" title="${escAttr(el)}">${escAttr(cbLabel(el))}</span>`;
}

/** A DOM node for a colorblind energy label — for the imperative render paths in main.ts. */
export function cbEnergyEl(el: string, extra = ""): HTMLSpanElement {
  const c = cbColor(el);
  const s = document.createElement("span");
  s.className = "cb-en" + (extra ? " " + extra : "");
  s.style.color = c;
  s.style.setProperty("--halo", cbHalo(c));
  s.title = el;
  s.textContent = cbLabel(el);
  return s;
}
