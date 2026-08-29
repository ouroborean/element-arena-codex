/**
 * Turn playback — the step-by-step "what just happened" animation. The loop taps every GameEvent of a turn
 * (state.eventSink) and hands them here AFTER the board has resolved; we replay them over the final board:
 * each skill in turn gets a slide-in "[Hero] used [Skill] on [targets]" panel with floating damage/heal text
 * and small flashes on the affected units, then the end-of-turn dot ticks resolve quickly with no panel.
 * Purely cosmetic: it reads the resolved state + the event list, never mutates game state. Click anywhere to
 * skip to the end.
 */
import type { MatchState, TeamId } from "../../engine/src/types.ts";
import type { GameEvent } from "../../engine/src/events.ts";
import { SKILL_TEXT } from "./skilltext.generated.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortName = (name: string) => name.split(",")[0]!.trim();

// ---- skip plumbing: one click fast-forwards the rest of the turn ----------------------------------------- //
let skip = false;
let resolveSkip: (() => void) | null = null;
let skipPromise: Promise<void> = Promise.resolve();
function armSkip(): void {
  skip = false;
  skipPromise = new Promise((r) => (resolveSkip = r));
}
function fireSkip(): void { skip = true; resolveSkip?.(); }
function wait(ms: number): Promise<void> {
  if (skip) return Promise.resolve();
  return Promise.race([new Promise<void>((r) => setTimeout(r, ms)), skipPromise]);
}

// ---- the overlay layer where floating text + the skill panel live ---------------------------------------- //
function layer(): HTMLElement {
  let el = document.getElementById("anim-layer");
  if (!el) {
    el = document.createElement("div");
    el.id = "anim-layer";
    document.body.appendChild(el);
  }
  return el;
}
function unitRect(id: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`.frame[data-inspect-unit="${CSS.escape(id)}"]`);
  return el ? el.getBoundingClientRect() : null;
}

/** A rising, fading number/word over a unit. `tone`: "dmg" | "heal" | "info". */
function floatText(id: string, text: string, tone: string): void {
  const r = unitRect(id);
  if (!r) return;
  const el = document.createElement("div");
  el.className = `af-float ${tone}`;
  el.textContent = text;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top + r.height * 0.32}px`;
  layer().appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

/** A brief flash on a unit's frame (a hit, a status landing/ticking). */
function flashUnit(id: string, tone: string): void {
  const el = document.querySelector<HTMLElement>(`.frame[data-inspect-unit="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove("af-hit", "af-heal", "af-buff");
  void el.offsetWidth; // restart the animation
  el.classList.add(tone);
  setTimeout(() => el.classList.remove(tone), 420);
}

/** The slide-in "[Hero] used [Skill]" panel. Returns a remover. */
function showPanel(html: string): () => void {
  const el = document.createElement("div");
  el.className = "anim-pop";
  el.innerHTML = html;
  layer().appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  return () => { el.classList.remove("in"); el.addEventListener("transitionend", () => el.remove(), { once: true }); setTimeout(() => el.remove(), 300); };
}

type Fx = Extract<GameEvent, { type: "damageDealt" | "healReceived" | "statusApplied" | "unitDied" }>;
interface Segment { skill: Extract<GameEvent, { type: "skillUsed" }>; fx: Fx[]; showPop: boolean }

/** Play a resolved turn's events over the final board. Cosmetic only. `skillUsed` fires AFTER a skill's effects,
 *  so we buffer effect events and flush them into a segment when its `skillUsed` closes it. Dot ticks (isTick)
 *  and any effects not closed by a skill resolve in a quick, panel-less tail. */
export async function playTurn(state: MatchState, side: TeamId, events: GameEvent[], you: TeamId): Promise<void> {
  const segments: Segment[] = [];
  const ticks: Fx[] = [];
  let buf: Fx[] = [];
  for (const ev of events) {
    if (ev.type === "skillUsed") {
      // A hidden (invisible) skill from the opponent isn't named — its visible results still float, panel-less.
      segments.push({ skill: ev, fx: buf, showPop: !(ev.hidden && side !== you) });
      buf = [];
    } else if (ev.type === "damageDealt" || ev.type === "healReceived" || ev.type === "statusApplied" || ev.type === "unitDied") {
      if (ev.type === "damageDealt" && ev.isTick) ticks.push(ev);
      else buf.push(ev);
    }
  }
  ticks.push(...buf); // effects not closed by a skill (passive procs, etc.) resolve in the panel-less tail
  if (!segments.length && !ticks.length) return; // nothing worth animating (e.g. a pure Strategic no-op)

  armSkip();
  const onClick = (e: MouseEvent) => { e.stopPropagation(); fireSkip(); }; // a click fast-forwards, nothing else
  document.addEventListener("click", onClick, true);
  try {
    for (const seg of segments) {
      let remove: (() => void) | null = null;
      if (seg.showPop) {
        const caster = state.units[seg.skill.caster];
        const casterName = caster ? shortName(caster.name) : "Someone";
        const t = SKILL_TEXT[seg.skill.skillId];
        const tgtIds = seg.skill.targets.length ? seg.skill.targets : (seg.skill.affected ?? []).filter((id) => id !== seg.skill.caster);
        const tgtNames = [...new Set(tgtIds.map((id) => state.units[id]?.name).filter(Boolean).map((n) => shortName(n!)))];
        const foe = caster && caster.team !== you;
        remove = showPanel(
          `<div class="ap-head ${foe ? "foe" : "you"}"><b>${esc(casterName)}</b> used <b class="ap-skill">${esc(t?.n ?? seg.skill.skillId)}</b></div>`
          + (tgtNames.length ? `<div class="ap-tgt">on ${esc(tgtNames.join(", "))}</div>` : "")
          + (t?.d ? `<div class="ap-desc">${esc(t.d)}</div>` : ""),
        );
      }
      flashUnit(seg.skill.caster, "af-buff");
      await wait(seg.showPop ? 260 : 100);
      applyFx(seg.fx);
      await wait(seg.showPop ? 680 : 380);
      remove?.();
      await wait(120);
    }
    // End-of-turn ticks: quick, no panel.
    if (ticks.length) {
      await wait(120);
      applyFx(ticks);
      await wait(560);
    }
  } finally {
    document.removeEventListener("click", onClick, true);
    if (skip) layer().querySelectorAll(".af-float, .anim-pop").forEach((n) => n.remove());
  }
}

function applyFx(fx: Fx[]): void {
  for (const ev of fx) {
    if (ev.type === "damageDealt" && ev.amount > 0) {
      floatText(ev.target, `-${ev.amount}`, ev.isTick ? "dmg tick" : "dmg");
      flashUnit(ev.target, "af-hit");
    } else if (ev.type === "healReceived" && ev.amount > 0) {
      floatText(ev.unit, `+${ev.amount}`, "heal");
      flashUnit(ev.unit, "af-heal");
    } else if (ev.type === "statusApplied" && !STATUS_QUIET.has(ev.kind)) {
      flashUnit(ev.unit, "af-buff");
    } else if (ev.type === "unitDied") {
      flashUnit(ev.unit, "af-hit");
    }
  }
}

// Housekeeping kinds that fire constantly and would spam flashes; the visible damage/heal already tells the story.
const STATUS_QUIET = new Set(["stack", "elemental_essence", "channeling"]);
