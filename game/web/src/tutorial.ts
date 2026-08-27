/**
 * Coach-mark overlay for the guided tutorial: a floating message that points at a piece of the real UI. The
 * tutorial STATE MACHINE lives in main.ts (it needs the live match/ui state); this module is the dumb
 * renderer it drives — show a step, reposition it after each re-render, hide it.
 *
 * Two modes:
 *   • blocking ("explain")  — a dim scrim over the whole app that advances on click (read, then Continue).
 *   • non-blocking ("act")  — no scrim (the board stays live); a pulsing ring highlights the control the
 *                             player must use, and the state machine advances when they actually use it.
 * The anchor is a CSS selector re-resolved on every reposition, because the app re-renders (innerHTML swap)
 * and destroys the previous element.
 */
export interface CoachStep {
  /** CSS selector for the element to point at + highlight; omitted → a centred message (no anchor). */
  anchor?: string;
  title: string;
  /** HTML (already escaped / glossary-annotated by the caller). */
  body: string;
  /** true = dim scrim + click-to-continue; false = highlight only, the game stays interactive. */
  blocking: boolean;
  /** Continue-button label for a blocking step (default "Continue ▶"). */
  cta?: string;
  /** Step counter label, e.g. "3 / 16". */
  progress?: string;
}

let root: HTMLElement | null = null;
let scrim: HTMLElement | null = null;
let ring: HTMLElement | null = null;
let pop: HTMLElement | null = null;
let current: CoachStep | null = null;

function ensureRoot(): void {
  if (root) return;
  root = document.createElement("div");
  root.className = "tut-root";
  root.hidden = true;
  scrim = document.createElement("div"); scrim.className = "tut-scrim";
  ring = document.createElement("div"); ring.className = "tut-ring"; ring.hidden = true;
  pop = document.createElement("div"); pop.className = "tut-pop";
  root.append(scrim, ring, pop);
  document.body.appendChild(root);
}

/** Show a coach-mark for `step`; `onContinue` fires when a blocking step is clicked through. */
export function showCoach(step: CoachStep, onContinue: () => void): void {
  ensureRoot();
  current = step;
  root!.hidden = false;
  root!.classList.toggle("blocking", step.blocking);
  // The overlay is click-THROUGH (see .tut-root pointer-events:none in the CSS) so the board stays fully live —
  // only the popup's own buttons are interactive. Explain steps advance via the Continue button, not the scrim.

  pop!.innerHTML = "";
  if (step.progress) { const p = document.createElement("div"); p.className = "tut-step"; p.textContent = step.progress; pop!.append(p); }
  const h = document.createElement("div"); h.className = "tut-title"; h.textContent = step.title;
  const b = document.createElement("div"); b.className = "tut-body"; b.innerHTML = step.body;
  pop!.append(h, b);
  if (step.blocking) {
    const btn = document.createElement("button"); btn.className = "tut-cta"; btn.textContent = step.cta ?? "Continue ▶";
    btn.onclick = (e) => { e.stopPropagation(); onContinue(); };
    pop!.append(btn);
  } else {
    const hint = document.createElement("div"); hint.className = "tut-hint"; hint.textContent = "↳ do this to continue";
    pop!.append(hint);
  }
  positionCoach();
}

/** Re-resolve the anchor and reposition the ring + popup. Call after every app re-render (anchors are recreated). */
export function positionCoach(): void {
  if (!current || !root || root.hidden) return;
  const el = current.anchor ? document.querySelector<HTMLElement>(current.anchor) : null;
  const rect = el?.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, m = 10;

  if (rect && rect.width > 0 && rect.height > 0) {
    ring!.hidden = false;
    const pad = 6;
    ring!.style.left = `${Math.round(rect.left - pad)}px`;
    ring!.style.top = `${Math.round(rect.top - pad)}px`;
    ring!.style.width = `${Math.round(rect.width + pad * 2)}px`;
    ring!.style.height = `${Math.round(rect.height + pad * 2)}px`;
  } else {
    ring!.hidden = true;
  }
  root!.classList.toggle("no-anchor", ring!.hidden); // no element to spotlight → the scrim itself dims

  // Popup: below the anchor if there's room, else above; horizontally aligned to it and clamped to the viewport.
  // With no anchor, centre it.
  const pw = pop!.offsetWidth || 300, ph = pop!.offsetHeight || 140;
  let left: number, top: number;
  if (rect && rect.width > 0) {
    left = rect.left + rect.width / 2 - pw / 2;
    top = rect.bottom + 14;
    if (top + ph > vh - m) { const above = rect.top - 14 - ph; top = above > m ? above : Math.max(m, vh - m - ph); }
  } else {
    left = vw / 2 - pw / 2;
    top = vh / 2 - ph / 2;
  }
  pop!.style.left = `${Math.round(Math.max(m, Math.min(vw - m - pw, left)))}px`;
  pop!.style.top = `${Math.round(Math.max(m, Math.min(vh - m - ph, top)))}px`;
}

export function hideCoach(): void {
  current = null;
  if (root) root.hidden = true;
}

export function coachActive(): boolean { return !!current; }

// Anchors move when the window resizes; keep the coach-mark pinned to its target.
window.addEventListener("resize", positionCoach);
