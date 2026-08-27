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
import { SKILL_REFS, SKILL_CARDS, MINION_REFS, type MinionRef } from "./glossref.generated.ts";
import { SKILL_TEXT } from "./skilltext.generated.ts";
import { elColor } from "./assets.ts";

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

type Kind = "def" | "skill" | "minion";
interface Cand { key: string; lckey: string; len: number; ci: boolean; kind: Kind; color: string; ref: string; }
interface Term { term: string; definition: string; color: string; }
type Target =
  | { kind: "def"; term: string; definition: string; color: string }
  | { kind: "skill"; id: string }
  | { kind: "minion"; id: string };

// Match index: first-char (lowercase) -> candidates sorted longest-first. Definitions match case-insensitively
// (ci=true); skill/minion NAMES match case-sensitively (ci=false). Lookups: def keyword -> term, minion id -> ref.
const BUCKET = new Map<string, Cand[]>();
const TERM_BY_KEY = new Map<string, Term>();
const MINION_BY_ID = new Map<string, MinionRef>();
function addCand(c: Cand): void {
  const f = c.lckey.charAt(0);
  let arr = BUCKET.get(f);
  if (!arr) { arr = []; BUCKET.set(f, arr); }
  arr.push(c);
}
{
  const seenDef = new Set<string>();
  for (const d of GLOSSARY_DEFS) {
    const color = glossColor(d.color);
    for (const kw of d.keywords) {
      const lc = kw.toLowerCase();
      if (!lc || seenDef.has(lc)) continue;
      seenDef.add(lc);
      TERM_BY_KEY.set(lc, { term: d.term, definition: d.definition, color });
      addCand({ key: kw, lckey: lc, len: kw.length, ci: true, kind: "def", color, ref: lc });
    }
  }
  // Skill + minion NAMES (already deduped name-first-wins by the generator) match case-sensitively.
  for (const s of SKILL_REFS) {
    if (!s.name) continue;
    addCand({ key: s.name, lckey: s.name.toLowerCase(), len: s.name.length, ci: false, kind: "skill", color: elColor(SKILL_CARDS[s.id]?.elem ?? "generic"), ref: s.id });
  }
  for (const m of MINION_REFS) {
    if (!m.name) continue;
    MINION_BY_ID.set(m.id, m);
    addCand({ key: m.name, lckey: m.name.toLowerCase(), len: m.name.length, ci: false, kind: "minion", color: elColor(m.elem || "generic"), ref: m.id });
  }
  // Longest first; on a tie prefer a case-sensitive name (ci=false) over a definition, matching the codex.
  for (const arr of BUCKET.values()) arr.sort((a, b) => (b.len - a.len) || (a.ci === b.ci ? 0 : a.ci ? 1 : -1));
}

function resolveTarget(gt: string | undefined): Target | null {
  if (!gt) return null;
  const i = gt.indexOf(":");
  if (i < 0) return null;
  const kind = gt.slice(0, i), key = gt.slice(i + 1);
  if (kind === "def") { const t = TERM_BY_KEY.get(key); return t ? { kind: "def", term: t.term, definition: t.definition, color: t.color } : null; }
  if (kind === "skill") return SKILL_CARDS[key] ? { kind: "skill", id: key } : null;
  if (kind === "minion") return MINION_BY_ID.has(key) ? { kind: "minion", id: key } : null;
  return null;
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
    let matched: string | null = null, mc: Cand | null = null;
    if (bucket) {
      for (const c of bucket) {
        if (i + c.len > n) continue;
        const slice = text.substr(i, c.len);
        if (c.ci ? slice.toLowerCase() !== c.lckey : slice !== c.key) continue;
        const beforeOK = !isWordChar(slice.charAt(0)) || !isWordChar(text.charAt(i - 1) ?? "");
        const afterOK = !isWordChar(slice.charAt(c.len - 1)) || !isWordChar(text.charAt(i + c.len) ?? "");
        if (beforeOK && afterOK) { matched = slice; mc = c; break; }
      }
    }
    if (matched && mc) {
      flush();
      out += `<span class="gloss gloss-${mc.kind}" data-gt="${esc(mc.kind + ":" + mc.ref)}" style="--gc:${mc.color}">${esc(matched)}</span>`;
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

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
function statSpan(k: string, v: string): HTMLElement {
  const s = document.createElement("span"); s.className = "gp-stat";
  const i = document.createElement("i"); i.textContent = `${k} `;
  s.append(i, document.createTextNode(v));
  return s;
}
function costText(gen: number, spec: number, elem: string): string {
  if (!gen && !spec) return "Free";
  const parts: string[] = [];
  if (gen) parts.push(`${gen} generic`);
  if (spec) parts.push(`${spec} ${cap(elem || "element")}`);
  return parts.join(" + ");
}
function defBlock(html: string): HTMLElement { const d = document.createElement("div"); d.className = "gp-def"; d.innerHTML = html; return d; }
function footBlock(text: string): HTMLElement { const f = document.createElement("div"); f.className = "gp-foot"; f.textContent = text; return f; }

function buildPanel(t: Target): { el: HTMLElement; pinBtn: HTMLElement } {
  const node = document.createElement("div");
  node.className = `gloss-panel gloss-panel-${t.kind}`;
  const head = document.createElement("div"); head.className = "gp-head";
  const kind = document.createElement("span"); kind.className = "gp-kind"; kind.textContent = t.kind === "def" ? "keyword" : t.kind;
  const title = document.createElement("span"); title.className = "gp-title";
  const spring = document.createElement("span"); spring.className = "gp-spring";
  const pinBtn = document.createElement("button"); pinBtn.className = "gp-btn gp-pin"; pinBtn.textContent = "📌"; pinBtn.title = "Pin (keep open)";
  const closeBtn = document.createElement("button"); closeBtn.className = "gp-btn gp-close"; closeBtn.textContent = "✕"; closeBtn.title = "Close";
  head.append(kind, title, spring, pinBtn, closeBtn);
  const body = document.createElement("div"); body.className = "gp-body";

  if (t.kind === "def") {
    title.textContent = t.term; title.style.color = t.color;
    body.append(defBlock(glossHtml(t.definition)));
  } else if (t.kind === "skill") {
    const c = SKILL_CARDS[t.id]!;
    title.textContent = c.name; title.style.color = elColor(c.elem || "generic");
    const stats = document.createElement("div"); stats.className = "gp-stats";
    stats.append(statSpan("Cost", costText(c.gen, c.spec, c.elem)), statSpan("CD", String(c.cd)), statSpan("Type", c.passive ? "Passive" : "Active"));
    if (c.target) stats.append(statSpan("Target", cap(c.target)));
    body.append(stats, defBlock(glossHtml(SKILL_TEXT[t.id]?.d ?? "No description.")));
    if (c.owner) body.append(footBlock(c.owner));
  } else {
    const m = MINION_BY_ID.get(t.id)!;
    title.textContent = m.name; title.style.color = elColor(m.elem || "generic");
    const stats = document.createElement("div"); stats.className = "gp-stats";
    stats.append(statSpan("HP", m.hpDynamic ? "Dynamic" : (m.hp != null ? String(m.hp) : "—")));
    if (m.elem) stats.append(statSpan("Element", cap(m.elem)));
    body.append(stats);
    if (m.owner) body.append(footBlock(`Summoned by ${m.owner}`));
  }
  node.append(head, body);
  return { el: node, pinBtn };
}

function togglePin(p: Panel): void {
  p.pinned = !p.pinned;
  if (p.pinned) { p.parent = null; p.el.classList.add("pinned"); p.pinBtn.textContent = "📍"; p.pinBtn.title = "Unpin"; }
  else { p.el.classList.remove("pinned"); p.pinBtn.textContent = "📌"; p.pinBtn.title = "Pin (keep open)"; scheduleSweep(); }
}

function openPanel(anchor: HTMLElement, t: Target): Panel | null {
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

function linkEnter(link: HTMLElement, t: Target): void {
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
function linkClick(link: HTMLElement, t: Target): void {
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
    if (link) { const t = resolveTarget(link.dataset.gt); if (t) linkEnter(link, t); }
  });
  document.addEventListener("mouseout", (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLElement>(".gloss");
    if (link) linkLeave(link);
  });
  document.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLElement>(".gloss");
    if (link) { const t = resolveTarget(link.dataset.gt); if (t) { e.stopPropagation(); linkClick(link, t); } }
  });
  // A scroll outside the panels dismisses transient ones; resizing recomputes nothing, so just clear.
  window.addEventListener("scroll", (e) => {
    const tgt = e.target as Node | null;
    if (tgt && tgt.nodeType === 1 && panelContaining(tgt)) return;
    closeTransientGloss();
  }, true);
  window.addEventListener("resize", () => closeAllGloss());
}
