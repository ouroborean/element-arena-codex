/**
 * DOM rendering for the web client (art layout). Pure functions of (MatchState, UiState) / setup state;
 * interaction is event-delegated on data-* (see main.ts). Uses the committed portrait + skill art.
 */
import type { MatchState, TeamId, Unit, Status } from "../../engine/src/types.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { totalShield } from "../../engine/src/damage.ts";
import { canUse, effectiveCost } from "../../engine/src/scheduler.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { heroPortrait, skillIcon, elColor } from "./assets.ts";
import { SKILL_TEXT } from "./skilltext.generated.ts";
import type { UiState } from "./main.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortName = (name: string) => name.split(",")[0]!.trim();
const nameOf = (id: string) => shortName(ROSTER.find((h) => h.id === id)?.name ?? id);
const IMG_FALLBACK = `onerror="this.style.visibility='hidden'"`;

const STATE_KINDS = new Set<Status["kind"]>(["stun", "blind", "invulnerable", "isolated", "untargetable", "taunt", "silence", "paralysis", "immortal", "shatter", "channeling"]);
function statusPips(u: Unit): string {
  const seen = new Set<string>(); const pips: string[] = [];
  for (const s of u.statuses) {
    let label: string | null = null, cls = "pip";
    if (s.kind === "stack") { label = `${s.name} ${s.magnitude ?? 0}`; cls = "pip stack"; }
    else if (s.kind === "dot") { label = s.name ?? "dot"; cls = "pip bad"; }
    else if (s.kind === "regen") { label = s.name ?? "regen"; cls = "pip good"; }
    else if (s.kind === "mark") { label = s.name ?? "mark"; }
    else if (STATE_KINDS.has(s.kind)) { label = s.kind; cls = "pip state"; }
    if (!label || seen.has(label)) continue; seen.add(label);
    pips.push(`<span class="${cls}" title="${esc(label)}">${esc(label.length > 10 ? label.slice(0, 9) + "…" : label)}</span>`);
  }
  return pips.length ? `<div class="pips">${pips.slice(0, 5).join("")}</div>` : "";
}

function hpBar(u: Unit): string {
  const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
  const shield = totalShield(u);
  return `<div class="hp"><div class="hp-fill" style="width:${pct}%"></div>
    <span class="hp-num">${Math.max(0, u.hp)}${shield > 0 ? `<i>+${shield}</i>` : ""}</span></div>`;
}

function skillTiles(state: MatchState, u: Unit, ui: UiState): string {
  const chosen = ui.plannedSkill.get(u.id);
  const tiles = (u.skills ?? []).map((s) => {
    const ok = canUse(state, u, s);
    const cost = effectiveCost(u, s);
    const costStr = [cost.generic ? `${cost.generic} generic` : "", cost.specific ? `${cost.specific} ${s.element}` : ""].filter(Boolean).join(" + ") || "free";
    const text = SKILL_TEXT[s.id];
    const tip = `${text?.n ?? s.name} — ${costStr}${s.currentCd > 0 ? ` — on cooldown (${s.currentCd})` : ""}${text?.d ? `\n${text.d}` : ""}`;
    const cls = ["tile", ok ? "" : "off", chosen === s.id ? "chosen" : ""].filter(Boolean).join(" ");
    return `<button class="${cls}" ${ok ? `data-owner="${u.id}" data-skill="${s.id}"` : "disabled"} title="${esc(tip)}">
      <img src="${skillIcon(u.heroId ?? "", s.id)}" alt="${esc(s.name)}" ${IMG_FALLBACK} />
      ${s.currentCd > 0 ? `<span class="cdbadge">${s.currentCd}</span>` : ""}</button>`;
  }).join("");
  return `<div class="tiles">${tiles}</div>`;
}

function heroCard(state: MatchState, u: Unit, ui: UiState, isYou: boolean): string {
  const targetable = ui.phase === "plan" && !!ui.targeting && ui.legalTargets.has(u.id);
  const cls = ["hero", u.alive ? "" : "dead", targetable ? "targetable" : "", ui.plannedSkill.has(u.id) ? "acted" : ""].filter(Boolean).join(" ");
  const portrait = u.heroId
    ? `<img class="portrait" src="${heroPortrait(u.heroId, u.fused)}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : `<div class="portrait minion-art">${esc(shortName(u.name))}</div>`;
  const pcol = `<div class="pcol">
    <div class="frame" style="--el:${elColor(u.currentElement)}" ${targetable ? `data-target="${u.id}"` : ""}>${portrait}${statusPips(u)}<div class="name">${esc(shortName(u.name))}</div></div>
    ${hpBar(u)}
  </div>`;
  return `<div class="${cls}">${pcol}${isYou && u.alive ? skillTiles(state, u, ui) : ""}</div>`;
}

function sideRow(state: MatchState, side: TeamId, ui: UiState, isYou: boolean): string {
  const units = state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u);
  const heroes = units.filter((u) => u.kind === "hero");
  const minions = units.filter((u) => u.kind === "minion");
  return `<div class="lane ${isYou ? "you" : "foe"}">
    <div class="heroes">${heroes.map((u) => heroCard(state, u, ui, isYou)).join("")}</div>
    ${minions.length ? `<div class="minions">${minions.map((u) => heroCard(state, u, ui, isYou)).join("")}</div>` : ""}
  </div>`;
}

function energyPool(state: MatchState, ui: UiState): string {
  const pool = state.teams[ui.you].energy;
  const els = new Set<string>(["generic"]);
  for (const id of state.teams[ui.you].units) { const u = state.units[id]; if (u?.kind === "hero") els.add(u.currentElement); }
  for (const k of Object.keys(pool)) if ((pool[k] ?? 0) > 0) els.add(k);
  const rows = [...els].sort((a, b) => (a === "generic" ? -1 : b === "generic" ? 1 : a.localeCompare(b)))
    .map((el) => `<div class="ep-row"><span class="ep-pip" style="background:${el === "generic" ? "#8a8fa8" : elColor(el)}">${el === "generic" ? "◆" : ""}</span>
      <span class="ep-el">${esc(el)}</span><span class="ep-n">${pool[el] ?? 0}</span></div>`).join("");
  return `<div class="epool"><div class="ep-title">Energy Pool</div>${rows}</div>`;
}

function midbar(state: MatchState, ui: UiState): string {
  const yourTurn = ui.phase === "plan";
  const center = yourTurn
    ? `<div class="turn you">Your turn</div><div class="hint">${esc(ui.hint)}</div>
       ${ui.targeting ? `<button class="mini" data-cancel="1">cancel targeting</button>` : `<button class="resolve" data-resolve="1">Resolve turn ▶</button>`}`
    : `<div class="turn foe">${esc(ui.phaseLabel)}</div><div class="bar"><div class="bar-fill"></div></div>`;
  return `<div class="midbar">
    <div class="mid-left">${energyPool(state, ui)}</div>
    <div class="mid-center">${center}</div>
    <div class="mid-right"><div class="score">${state.teams.A.roundsWon}–${state.teams.B.roundsWon} · R${state.round}</div>
      <button class="surrender" data-surrender="1">Surrender</button></div>
  </div>`;
}

export function renderApp(state: MatchState, ui: UiState): string {
  const foe = ui.you === "A" ? "B" : "A";
  return `<div class="arena">
    ${sideRow(state, foe, ui, false)}
    ${midbar(state, ui)}
    ${sideRow(state, ui.you, ui, true)}
  </div>${ui.overlay ?? ""}`;
}

// ── team select (with a skill viewer) ─────────────────────────────────────────────────────────────── //
function heroDetail(heroId: string, picked: string[]): string {
  const def = ROSTER.find((h) => h.id === heroId);
  if (!def) return "";
  const on = picked.includes(heroId);
  const passive = SKILL_TEXT[`${heroId}0`];
  const skillRows = (def.skills ?? []).map((s) => {
    const t = SKILL_TEXT[s.id];
    return `<div class="sv-row"><img src="${skillIcon(heroId, s.id)}" ${IMG_FALLBACK} />
      <div><div class="sv-name">${esc(t?.n ?? s.name)}</div><div class="sv-desc">${esc(t?.d ?? "")}</div></div></div>`;
  }).join("");
  return `<div class="detail-head">
      <img class="dp" src="${heroPortrait(heroId)}" ${IMG_FALLBACK} />
      <div><h3>${esc(def.name)}</h3><span class="dp-el">${esc(def.element)}</span></div>
      <button class="addbtn ${on ? "rem" : ""}" data-pick="${heroId}" ${!on && picked.length >= 3 ? "disabled" : ""}>${on ? "− Remove" : "+ Add to team"}</button>
    </div>
    ${passive ? `<div class="sv-row passive"><img src="${skillIcon(heroId, `${heroId}0`)}" ${IMG_FALLBACK} /><div><div class="sv-name">${esc(passive.n)} <i>passive</i></div><div class="sv-desc">${esc(passive.d)}</div></div></div>` : ""}
    <div class="skillview">${skillRows}</div>`;
}

export function renderSetup(setup: { picked: string[]; oppo: string[]; inspect: string | null }): string {
  const grid = ROSTER.map((h) => ({ id: h.id, name: shortName(h.name), element: h.element }))
    .sort((a, b) => a.element.localeCompare(b.element) || a.name.localeCompare(b.name))
    .map((h) => {
      const on = setup.picked.includes(h.id);
      return `<button class="port ${on ? "on" : ""} ${setup.inspect === h.id ? "sel" : ""}" data-inspect="${h.id}" style="--el:${elColor(h.element)}">
        <img src="${heroPortrait(h.id)}" alt="${esc(h.name)}" ${IMG_FALLBACK} />
        <span class="port-name">${esc(h.name)}</span>${on ? '<span class="port-check">✓</span>' : ""}</button>`;
    }).join("");
  const slots = [0, 1, 2].map((i) => {
    const id = setup.picked[i];
    return id ? `<button class="slot on" data-pick="${id}" title="remove">${esc(nameOf(id))} ✕</button>` : `<span class="slot empty">—</span>`;
  }).join("");
  return `<header><div class="brand">◆ Element Arena</div><div class="status">team select</div></header>
    <div class="select">
      <div class="roster-grid">${grid}</div>
      <aside class="detail">${setup.inspect ? heroDetail(setup.inspect, setup.picked) : `<div class="hint">Click a hero to view its skills, then add it to your team.</div>`}</aside>
      <div class="teambar">
        <div class="tray"><b>Your team <span class="count">${setup.picked.length}/3</span></b><div class="slots">${slots}</div></div>
        <div class="tray"><b>Opponent (AI)</b><div class="oppo">${setup.oppo.map((id) => `<span>${esc(nameOf(id))}</span>`).join("")}</div><button class="mini" data-reroll="1">🎲 re-roll</button></div>
        <button class="start" data-start="1" ${setup.picked.length === 3 ? "" : "disabled"}>Start battle ▶</button>
      </div>
    </div>`;
}
