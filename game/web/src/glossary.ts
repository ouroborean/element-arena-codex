/**
 * In-match hover-keyword glossary: mechanical terms in any description or effect tooltip become dashed-underline
 * links that, on hover (or tap), open a small panel with the term's definition — and that definition's own text
 * carries the same links, so panels chain. A panel can be pinned to stay open. Adapted from the codex app.
 *
 * Text is annotated to an HTML string (glossHtml) so it composes with the existing description renderers; each
 * link carries data-gk (the matched keyword, lowercased). The description HTML is rebuilt on every render and
 * holds no listeners, so hovering/opening/chaining is driven by document-level DELEGATED events (initGloss);
 * only the floating panels (built imperatively, appended to <body>) carry their own listeners.
 */
import { GLOSSARY_DEFS } from "./glossary.generated.ts";

// Godot colour-constant names -> dark-theme-legible hex, so a term keeps the game's hue coding.
const GODOT_COLORS: Record<string, string> = {
  RED: "#ff6b6b", DARK_RED: "#e46a6a", INDIAN_RED: "#e0836f", CORAL: "#ff8a5c",
  LIGHT_SALMON: "#ffab86", SADDLE_BROWN: "#cc9366", TAN: "#dcc79a", BISQUE: "#f0d6b2",
  ORANGE: "#ffa838", GOLD: "#ffcf45", GOLDENROD: "#e8b83f", YELLOW: "#ffe867",
  GREEN_YELLOW: "#c2e356", GREEN: "#63d16a", DARK_CYAN: "#43bbbb", AQUA: "#54e4e4",
  AQUAMARINE: "#7cf0c8", MEDIUM_AQUAMARINE: "#7ed5b0", CADET_BLUE: "#8fbcc2",
  SKY_BLUE: "#82caf1", LIGHT_BLUE: "#aadcec", CORNFLOWER_BLUE: "#84a9f3",
  DARK_BLUE: "#8aa0f6", REBECCA_PURPLE: "#b992e8", DARK_GRAY: "#c6cad1", DIM_GRAY: "#aab0ba",
};
const DEF_COLOR = "var(--acc)";
const glossColor = (name: string): string => GODOT_COLORS[name] ?? DEF_COLOR;

interface Cand { lckey: string; len: number; color: string; }
interface Term { term: string; definition: string; color: string; }

// Keyword index: first-char (lowercase) -> candidates sorted longest-first; and lckey -> the term it opens.
const BUCKET = new Map<string, Cand[]>();
const TERM_BY_KEY = new Map<string, Term>();
{
  const seen = new Set<string>();
  for (const d of GLOSSARY_DEFS) {
    const color = glossColor(d.color);
    for (const kw of d.keywords) {
      const lc = kw.toLowerCase();
      if (!lc || seen.has(lc)) continue;
      seen.add(lc);
      TERM_BY_KEY.set(lc, { term: d.term, definition: d.definition, color });
      const f = lc.charAt(0);
      let arr = BUCKET.get(f);
      if (!arr) { arr = []; BUCKET.set(f, arr); }
      arr.push({ lckey: lc, len: kw.length, color });
    }
  }
  for (const arr of BUCKET.values()) arr.sort((a, b) => b.len - a.len);
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const isWordChar = (ch: string): boolean => ch !== "" && /[A-Za-z0-9]/.test(ch);

/** Annotate plain text -> HTML: keyword occurrences (whole-word, longest-match, case-insensitive) become gloss
 *  links; everything else is HTML-escaped. Safe on authored/frozen description strings. */
export function glossHtml(textIn: string | null | undefined): string {
  const text = textIn ?? "";
  if (!text || !BUCKET.size) return esc(text);
  let out = "", buf = "", i = 0;
  const n = text.length;
  const flush = () => { if (buf) { out += esc(buf); buf = ""; } };
  while (i < n) {
    const bucket = BUCKET.get(text.charAt(i).toLowerCase());
    let matched: string | null = null, mcolor = DEF_COLOR;
    if (bucket) {
      for (const c of bucket) {
        if (i + c.len > n) continue;
        const slice = text.substr(i, c.len);
        if (slice.toLowerCase() !== c.lckey) continue;
        const beforeOK = !isWordChar(slice.charAt(0)) || !isWordChar(text.charAt(i - 1) ?? "");
        const afterOK = !isWordChar(slice.charAt(c.len - 1)) || !isWordChar(text.charAt(i + c.len) ?? "");
        if (beforeOK && afterOK) { matched = slice; mcolor = c.color; break; }
      }
    }
    if (matched) {
      flush();
      out += `<span class="gloss" data-gk="${esc(matched.toLowerCase())}" style="--gc:${mcolor}">${esc(matched)}</span>`;
      i += matched.length;
    } else { buf += text.charAt(i); i++; }
  }
  flush();
  return out;
}

// ── chainable, pinnable hover panels ──────────────────────────────────────────────────────────────── //
interface Panel { id: number; el: HTMLElement; anchor: HTMLElement; parent: Panel | null; level: number; pinned: boolean; pinBtn: HTMLElement; }
const panels: Panel[] = [];
const hovered = new Set<Element>();
let uid = 0;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAnchor: HTMLElement | null = null;
const OPEN_DELAY = 110, SWEEP_DELAY = 240;

const panelContaining = (node: Node): Panel | null => panels.find((p) => p.el.contains(node)) ?? null;
const childrenOf = (p: Panel): Panel[] => panels.filter((x) => x.parent === p);
function descendants(p: Panel): Panel[] {
  const res: Panel[] = [], st = [p];
  while (st.length) { const x = st.pop()!; for (const c of childrenOf(x)) { res.push(c); st.push(c); } }
  return res;
}
function removePanel(p: Panel): void { const i = panels.indexOf(p); if (i < 0) return; panels.splice(i, 1); hovered.delete(p.el); p.el.remove(); }
function closeChain(p: Panel): void { [p, ...descendants(p)].forEach(removePanel); }
/** Close every glossary panel (pinned included) — e.g. on resize. */
export function closeAllGloss(): void { panels.slice().forEach(removePanel); }
/** Close only the un-pinned panels — called on each app re-render so stale transient panels don't linger. */
export function closeTransientGloss(): void { panels.slice().filter((p) => !p.pinned).forEach(removePanel); }
const cancelSweep = () => { if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; } };
const scheduleSweep = () => { cancelSweep(); sweepTimer = setTimeout(reconcile, SWEEP_DELAY); };

/** Drop any panel that is no longer hovered/pinned and has no live descendant (deepest-first). */
function reconcile(): void {
  cancelSweep();
  const byDeep = panels.slice().sort((a, b) => b.level - a.level);
  const alive: Record<number, boolean> = {};
  for (const p of byDeep) {
    let a = p.pinned || hovered.has(p.el) || hovered.has(p.anchor);
    if (!a) for (const c of childrenOf(p)) if (alive[c.id]) a = true;
    alive[p.id] = a;
  }
  panels.slice().forEach((p) => { if (!alive[p.id]) removePanel(p); });
}

function positionPanel(node: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect(), pw = node.offsetWidth || 300, ph = node.offsetHeight || 160;
  const vw = window.innerWidth, vh = window.innerHeight, m = 8;
  let left = r.left; if (left + pw > vw - m) left = vw - m - pw; if (left < m) left = m;
  let top = r.bottom + 6; if (top + ph > vh - m) { const above = r.top - 6 - ph; top = above > m ? above : Math.max(m, vh - m - ph); }
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function buildPanel(t: Term): { el: HTMLElement; pinBtn: HTMLElement } {
  const node = document.createElement("div");
  node.className = "gloss-panel";
  const head = document.createElement("div"); head.className = "gp-head";
  const kind = document.createElement("span"); kind.className = "gp-kind"; kind.textContent = "keyword";
  const title = document.createElement("span"); title.className = "gp-title"; title.textContent = t.term; title.style.color = t.color;
  const spring = document.createElement("span"); spring.className = "gp-spring";
  const pinBtn = document.createElement("button"); pinBtn.className = "gp-btn gp-pin"; pinBtn.textContent = "📌"; pinBtn.title = "Pin (keep open)";
  const closeBtn = document.createElement("button"); closeBtn.className = "gp-btn gp-close"; closeBtn.textContent = "✕"; closeBtn.title = "Close";
  head.append(kind, title, spring, pinBtn, closeBtn);
  const body = document.createElement("div"); body.className = "gp-body";
  const def = document.createElement("div"); def.className = "gp-def"; def.innerHTML = glossHtml(t.definition);
  body.append(def);
  node.append(head, body);
  return { el: node, pinBtn };
}

function togglePin(p: Panel): void {
  p.pinned = !p.pinned;
  if (p.pinned) { p.parent = null; p.el.classList.add("pinned"); p.pinBtn.textContent = "📍"; p.pinBtn.title = "Unpin"; }
  else { p.el.classList.remove("pinned"); p.pinBtn.textContent = "📌"; p.pinBtn.title = "Pin (keep open)"; scheduleSweep(); }
}

function openPanel(anchor: HTMLElement, t: Term): Panel | null {
  const parent = panelContaining(anchor);
  // Under the same parent, a hover elsewhere closes other transient chains (so only one hover-branch is open).
  panels.slice().forEach((p) => { if (p.parent === parent && !p.pinned && p.anchor !== anchor) closeChain(p); });
  const existing = panels.find((p) => p.anchor === anchor);
  if (existing) return existing;
  const built = buildPanel(t);
  const node = built.el;
  node.style.visibility = "hidden";
  document.body.appendChild(node);
  positionPanel(node, anchor);
  node.style.visibility = "";
  const p: Panel = { id: ++uid, el: node, anchor, parent, level: parent ? parent.level + 1 : 0, pinned: false, pinBtn: built.pinBtn };
  node.addEventListener("mouseenter", () => { hovered.add(node); cancelSweep(); });
  node.addEventListener("mouseleave", () => { hovered.delete(node); scheduleSweep(); });
  built.pinBtn.addEventListener("click", (ev) => { ev.stopPropagation(); togglePin(p); });
  node.querySelector<HTMLElement>(".gp-close")?.addEventListener("click", (ev) => { ev.stopPropagation(); closeChain(p); });
  panels.push(p);
  return p;
}

function linkEnter(link: HTMLElement, t: Term): void {
  hovered.add(link); cancelSweep();
  if (openTimer) clearTimeout(openTimer);
  pendingAnchor = link;
  openTimer = setTimeout(() => { openTimer = null; if (document.body.contains(link)) openPanel(link, t); }, OPEN_DELAY);
}
function linkLeave(link: HTMLElement): void {
  hovered.delete(link);
  if (openTimer && pendingAnchor === link) { clearTimeout(openTimer); openTimer = null; }
  scheduleSweep();
}
function linkClick(link: HTMLElement, t: Term): void {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  const p = openPanel(link, t);
  if (p && !p.pinned) togglePin(p); // a tap/click pins the panel so it stays put
}

let inited = false;
/** Wire the delegated document listeners that drive keyword hover/tap + panel chaining. Call once at startup. */
export function initGloss(): void {
  if (inited) return;
  inited = true;
  document.addEventListener("mouseover", (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLElement>(".gloss");
    if (link) { const t = TERM_BY_KEY.get(link.dataset.gk ?? ""); if (t) linkEnter(link, t); }
  });
  document.addEventListener("mouseout", (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLElement>(".gloss");
    if (link) linkLeave(link);
  });
  document.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLElement>(".gloss");
    if (link) { const t = TERM_BY_KEY.get(link.dataset.gk ?? ""); if (t) { e.stopPropagation(); linkClick(link, t); } }
  });
  // A scroll outside the panels dismisses transient ones; resizing recomputes nothing, so just clear.
  window.addEventListener("scroll", (e) => {
    const tgt = e.target as Node | null;
    if (tgt && tgt.nodeType === 1 && panelContaining(tgt)) return;
    closeTransientGloss();
  }, true);
  window.addEventListener("resize", () => closeAllGloss());
}
