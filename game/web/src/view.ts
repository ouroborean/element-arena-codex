/**
 * DOM rendering for the web client — builds the board/panel/log as an HTML string that the app swaps
 * into #app on every state change. Interaction is via event delegation on data-* attributes (see main.ts),
 * so rendering stays a pure function of (MatchState, UiState).
 */
import type { MatchState, TeamId, Unit, Status } from "../../engine/src/types.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { totalShield } from "../../engine/src/damage.ts";
import { canUse, effectiveCost } from "../../engine/src/scheduler.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import type { UiState } from "./main.ts";

const shortName = (name: string) => name.split(",")[0]!.trim();
const nameOf = (id: string) => shortName(ROSTER.find((h) => h.id === id)?.name ?? id);
const rosterList = ROSTER.map((h) => ({ id: h.id, name: shortName(h.name), element: h.element }))
  .sort((a, b) => a.element.localeCompare(b.element) || a.name.localeCompare(b.name));

/** The pre-match team-select screen: pick 3 heroes; the AI's team is shown (re-rollable). */
export function renderSetup(setup: { picked: string[]; oppo: string[] }): string {
  const full = setup.picked.length >= 3;
  const grid = rosterList.map((h) => {
    const on = setup.picked.includes(h.id);
    const dis = full && !on;
    return `<button class="pick ${on ? "on" : ""}" data-pick="${h.id}" ${dis ? "disabled" : ""}>
      <span class="pk-name">${esc(h.name)}</span><span class="pk-el">${esc(h.element)}</span></button>`;
  }).join("");
  const slots = [0, 1, 2].map((i) => {
    const id = setup.picked[i];
    return id ? `<button class="slot on" data-pick="${id}" title="remove">${esc(nameOf(id))} ✕</button>` : `<span class="slot empty">—</span>`;
  }).join("");
  return `<header>
      <div class="brand">◆ Element Arena</div>
      <div class="status">team select</div>
    </header>
    <div class="setup">
      <h2>Choose your team <span class="count">${setup.picked.length}/3</span></h2>
      <div class="roster">${grid}</div>
      <div class="trays">
        <div class="tray"><b>Your team</b><div class="slots">${slots}</div></div>
        <div class="tray"><b>Opponent (AI)</b><div class="oppo">${setup.oppo.map((id) => `<span>${esc(nameOf(id))}</span>`).join("")}</div>
          <button class="mini" data-reroll="1">🎲 re-roll</button></div>
      </div>
      <button class="start" data-start="1" ${setup.picked.length === 3 ? "" : "disabled"}>Start battle ▶</button>
    </div>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const STATE_KINDS = new Set<Status["kind"]>([
  "stun", "blind", "invulnerable", "isolated", "untargetable", "taunt", "silence",
  "paralysis", "stealth", "immortal", "damage_ignore", "shatter", "channeling",
]);

function statusChips(u: Unit): string {
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const s of u.statuses) {
    let label: string | null = null;
    let cls = "st";
    if (s.kind === "stack") { label = `${s.name} ${s.magnitude ?? 0}`; cls = "st stack"; }
    else if (s.kind === "dot") { label = s.name ?? "dot"; cls = "st bad"; }
    else if (s.kind === "regen") { label = s.name ?? "regen"; cls = "st good"; }
    else if (s.kind === "mark") { label = s.name ?? "mark"; }
    else if (STATE_KINDS.has(s.kind)) { label = s.kind; cls = "st state"; }
    if (!label || seen.has(label)) continue;
    seen.add(label);
    chips.push(`<span class="${cls}">${esc(label)}</span>`);
  }
  return chips.length ? `<div class="chips">${chips.join("")}</div>` : "";
}

/** One unit card. `role` marks it selectable/targetable for the current interaction. */
function unitCard(u: Unit, opts: { selected: boolean; planned?: string; targetable: boolean; clickable: boolean }): string {
  const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
  const hpClass = pct > 50 ? "hp-hi" : pct > 25 ? "hp-mid" : "hp-lo";
  const shield = totalShield(u);
  const cls = ["unit", u.alive ? "" : "dead", opts.selected ? "selected" : "", opts.targetable ? "targetable" : "", opts.clickable ? "clickable" : ""].filter(Boolean).join(" ");
  const data = opts.targetable ? `data-target="${u.id}"` : opts.clickable ? `data-unit="${u.id}"` : "";
  const kind = u.kind === "minion" ? `<span class="minion">summon</span>` : "";
  return `<div class="${cls}" ${data} title="${esc(u.name)}">
    <div class="u-top"><span class="u-name">${esc(u.name)}</span> ${kind}<span class="u-el">${esc(u.currentElement)}</span></div>
    <div class="hpbar"><div class="hpfill ${hpClass}" style="width:${pct}%"></div><span class="hptext">${Math.max(0, u.hp)}/${u.maxHp}${shield > 0 ? ` +${shield}` : ""}</span></div>
    ${opts.planned ? `<div class="planned">▸ ${esc(opts.planned)}</div>` : ""}
    ${statusChips(u)}
  </div>`;
}

function energyLine(state: MatchState, side: TeamId): string {
  const pool = state.teams[side].energy;
  const parts = Object.keys(pool).filter((k) => (pool[k] ?? 0) > 0).sort((a, b) => (a === "generic" ? -1 : 1)).map((k) => `${pool[k]}&nbsp;${k}`);
  return `<span class="energy">⚡ ${parts.length ? parts.join(" · ") : "—"}</span>`;
}

function team(state: MatchState, side: TeamId, ui: UiState): string {
  const you = side === ui.you;
  const units = state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u);
  const ordered = [...units.filter((u) => u.kind !== "minion"), ...units.filter((u) => u.kind === "minion")];
  const cards = ordered.map((u) => {
    const isTarget = ui.phase === "plan" && !!ui.targeting && ui.legalTargets.has(u.id);
    const clickable = ui.phase === "plan" && you && u.alive && u.kind === "hero" && !ui.planned.has(u.id) && !ui.targeting;
    return unitCard(u, { selected: ui.selectedUnit === u.id, planned: ui.plannedLabel.get(u.id), targetable: isTarget, clickable });
  }).join("");
  return `<div class="team ${you ? "you" : "foe"}">
    <div class="team-head"><b>Team ${side}</b> ${you ? '<span class="tag you">you</span>' : '<span class="tag foe">AI</span>'} ${energyLine(state, side)}</div>
    <div class="units">${cards}</div>
  </div>`;
}

function skillRow(state: MatchState, u: Unit, s: SkillInstance): string {
  const ok = canUse(state, u, s);
  const cost = effectiveCost(u, s);
  const costStr = [cost.generic ? `${cost.generic}⚡` : "", cost.specific ? `${cost.specific} ${s.element}` : ""].filter(Boolean).join(" ") || "free";
  const cd = s.currentCd > 0 ? `<span class="cd">cd${s.currentCd}</span>` : "";
  const kind = s.tags.find((t) => ["Harmful", "Helpful", "Strategic"].includes(t)) ?? s.klass;
  return `<button class="skill ${ok ? "" : "disabled"}" ${ok ? `data-skill="${s.id}"` : "disabled"}>
    <span class="sk-name">${esc(s.name)}</span>
    <span class="sk-meta">${costStr} ${cd} <i>${esc(kind)}</i></span>
  </button>`;
}

function panel(state: MatchState, ui: UiState): string {
  if (ui.phase !== "plan") return `<div class="panel"><div class="hint">${esc(ui.hint)}</div></div>`;
  const u = ui.selectedUnit ? state.units[ui.selectedUnit] : undefined;
  const skills = u && u.kind === "hero" ? (u.skills ?? []).map((s) => skillRow(state, u, s)).join("") : "";
  const body = ui.targeting
    ? `<div class="hint">Choose a target for <b>${esc(ui.targeting.skillName)}</b> — or <button data-cancel="1" class="mini">cancel</button></div>`
    : u ? `<div class="skills">${skills}</div>`
    : `<div class="hint">${esc(ui.hint)}</div>`;
  return `<div class="panel">
    ${body}
    <div class="controls"><button id="resolve" data-resolve="1">Resolve turn ▶</button></div>
  </div>`;
}

export function renderApp(state: MatchState, ui: UiState): string {
  const header = `<header>
    <div class="brand">◆ Element Arena</div>
    <div class="status">Round ${state.round} · ${ui.phaseLabel} · <span class="score">${state.teams.A.roundsWon}–${state.teams.B.roundsWon}</span></div>
  </header>`;
  const log = `<div class="log">${state.log.slice(-8).map((l) => `<div>${esc(l)}</div>`).join("")}</div>`;
  return `${header}
    <div class="boards">${team(state, ui.you === "A" ? "B" : "A", ui)}${team(state, ui.you, ui)}</div>
    ${panel(state, ui)}
    ${log}
    ${ui.overlay ?? ""}`;
}
