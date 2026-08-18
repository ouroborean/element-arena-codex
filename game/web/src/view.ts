/**
 * DOM rendering for the web client (art layout). Pure functions of (MatchState, UiState) / setup state;
 * interaction is event-delegated on data-* (see main.ts). Uses the committed portrait + skill art.
 */
import type { MatchState, TeamId, Unit, Status } from "../../engine/src/types.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { totalShield } from "../../engine/src/damage.ts";
import { canUse, effectiveCost } from "../../engine/src/scheduler.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { heroPortrait, iconOf, minionPortrait, elColor } from "./assets.ts";
import { SKILL_TEXT } from "./skilltext.generated.ts";
import { STATUS_SOURCE } from "./statussource.generated.ts";
import type { UiState } from "./main.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortName = (name: string) => name.split(",")[0]!.trim();
const nameOf = (id: string) => shortName(ROSTER.find((h) => h.id === id)?.name ?? id);
const IMG_FALLBACK = `onerror="this.style.visibility='hidden'"`;

const STATE_KINDS = new Set<Status["kind"]>(["stun", "blind", "invulnerable", "isolated", "untargetable", "taunt", "silence", "paralysis", "immortal", "shatter", "channeling", "elemental_essence", "damage_reduction", "incoming_damage_mod", "outgoing_damage_mod", "cost_mod", "cooldown_mod"]);
const durStr = (s: Status) => s.duration === null ? "for the round" : typeof s.duration === "number" && s.duration > 0 ? `${s.duration} turn${s.duration > 1 ? "s" : ""} left` : "";

/** A plain-language account of what a status is doing right now (for the hover popup). `src` is the id of
 *  the skill/passive that applied it (for the source name + a mark's descriptive fallback). */
function effectDesc(s: Status, src?: string): { title: string; body: string } {
  const srcName = src && SKILL_TEXT[src] ? SKILL_TEXT[src]!.n : undefined;
  const title = s.name ?? srcName ?? s.kind.replace(/_/g, " ");
  const mag = s.magnitude ?? 0, dt = s.dtype ?? "affliction";
  let body: string;
  switch (s.kind) {
    case "dot": body = `Deals ${mag} ${dt} damage each turn.`; break;
    case "regen": body = `Restores ${mag} HP each turn.`; break;
    case "stack": body = `${mag} stack${mag === 1 ? "" : "s"}.`; break;
    case "stun": body = "Stunned — can't use skills."; break;
    case "blind": body = "Blinded — single-target skills strike a random target."; break;
    case "invulnerable": body = "Can't be targeted by new harmful skills."; break;
    case "isolated": body = "Can't be targeted by new helpful skills."; break;
    case "untargetable": body = "Can't be targeted by other units."; break;
    case "taunt": body = "Forced to target the taunter."; break;
    case "silence": body = "No Elemental Essence income."; break;
    case "paralysis": body = "Cooldowns don't advance."; break;
    case "immortal": body = "HP can't drop below 1."; break;
    case "shatter": body = "Ignores DR / Invulnerable / Shield."; break;
    case "damage_reduction": body = `Reduces incoming damage by ${mag}.`; break;
    case "incoming_damage_mod": body = `Takes ${Math.abs(mag)} ${mag < 0 ? "less" : "more"} damage.`; break;
    case "outgoing_damage_mod": body = `Deals ${Math.abs(mag)} ${mag < 0 ? "less" : "more"} damage.`; break;
    case "cost_mod": body = `Skills cost ${mag > 0 ? "+" : ""}${mag} energy.`; break;
    case "cooldown_mod": body = `Cooldowns ${mag > 0 ? "+" : ""}${mag} turns.`; break;
    case "elemental_essence": body = "Next income is 1 energy of its element."; break;
    case "channeling": body = "Channeling a skill each turn."; break;
    case "mark": body = src && SKILL_TEXT[src] ? SKILL_TEXT[src]!.d : ""; break;
    default: body = src && SKILL_TEXT[src] ? SKILL_TEXT[src]!.d : "";
  }
  // Attribute the source, unless the title already IS the source name (avoids "Frost-Covered (from Frost-Covered)").
  if (srcName && title !== srcName && s.kind !== "mark" && s.kind !== "stack") body += ` (from ${srcName})`;
  const d = durStr(s); if (d) body = `${body.trim()} ${d.charAt(0).toUpperCase()}${d.slice(1)}.`;
  return { title, body: body.trim() };
}

/**
 * The skill/passive id an effect should show the icon of, resolved most-precise first:
 *  1. a named status → the content-scanned map (status name → applying skill/passive), authoritative;
 *  2. an engine-stamped `sourceId` that is a real skill id (skill-cast provenance);
 *  3. a skill-scoped cost/cooldown mod → the skill it discounts (its `skillId` field);
 *  4. last resort — the applying unit's passive, so it's always at least hero-correct (never a bare letter).
 */
function statusSource(state: MatchState, s: Status): string | undefined {
  if (s.name && STATUS_SOURCE[s.name]) return STATUS_SOURCE[s.name];
  if (s.sourceId && SKILL_TEXT[s.sourceId]) return s.sourceId;
  if (s.skillId && SKILL_TEXT[s.skillId]) return s.skillId;
  const by = state.units[s.appliedBy];
  return by?.heroId ? `${by.heroId}0` : undefined;
}

/** Status icons on a portrait: the source skill's art, each hover-describable. */
function effectIcons(state: MatchState, u: Unit): string {
  const seen = new Set<string>(); const out: string[] = [];
  for (const s of u.statuses) {
    if (!(s.kind === "stack" || s.kind === "mark" || s.kind === "dot" || s.kind === "regen" || STATE_KINDS.has(s.kind))) continue;
    const key = `${s.kind}:${s.name ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    const src = statusSource(state, s);
    const icon = src ? iconOf(src) : null;
    const { title, body } = effectDesc(s, src);
    const cls = ["fx", s.kind === "dot" ? "bad" : s.kind === "regen" || s.kind === "stack" ? "good" : STATE_KINDS.has(s.kind) ? "state" : ""].filter(Boolean).join(" ");
    out.push(`<span class="${cls}" data-fxtitle="${esc(title)}" data-fxbody="${esc(body)}">${icon ? `<img src="${icon}" ${IMG_FALLBACK} />` : `<span class="fx-abbr">${esc((s.name ?? s.kind)[0]!.toUpperCase())}</span>`}${s.kind === "stack" && (s.magnitude ?? 0) > 1 ? `<span class="fx-n">${s.magnitude}</span>` : ""}</span>`);
  }
  return out.length ? `<div class="fxrow">${out.slice(0, 6).join("")}</div>` : "";
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
    const ic = iconOf(s.id, u.heroId ?? undefined);
    return `<button class="${cls}" ${ok ? `data-owner="${u.id}" data-skill="${s.id}"` : "disabled"} title="${esc(tip)}">
      ${ic ? `<img src="${ic}" alt="${esc(s.name)}" ${IMG_FALLBACK} />` : `<span class="tile-abbr">${esc(s.name.slice(0, 3))}</span>`}
      ${s.currentCd > 0 ? `<span class="cdbadge">${s.currentCd}</span>` : ""}</button>`;
  }).join("");
  return `<div class="tiles">${tiles}</div>`;
}

function heroCard(state: MatchState, u: Unit, ui: UiState, isYou: boolean): string {
  const targetable = ui.phase === "plan" && !!ui.targeting && ui.legalTargets.has(u.id);
  const cls = ["hero", u.alive ? "" : "dead", targetable ? "targetable" : "", ui.plannedSkill.has(u.id) ? "acted" : ""].filter(Boolean).join(" ");
  const mart = u.kind === "minion" ? minionPortrait(u.name) : null;
  const portrait = u.heroId
    ? `<img class="portrait" src="${heroPortrait(u.heroId, u.fused)}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : mart
    ? `<img class="portrait" src="${mart}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : `<div class="portrait minion-art">${esc(shortName(u.name))}</div>`;
  const pcol = `<div class="pcol">
    <div class="frame" style="--el:${elColor(u.currentElement)}" ${targetable ? `data-target="${u.id}"` : ""}>${portrait}${effectIcons(state, u)}<div class="name">${esc(shortName(u.name))}</div></div>
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
  // While targeting, the skill detail lives HERE (between the lanes) — never over a portrait, so every
  // highlighted target stays clickable. Otherwise: your-turn controls, or the AI's "acting…" bar.
  const center = ui.targeting
    ? skillPanel(state, ui)
    : yourTurn
    ? `<div class="turn you">Your turn</div><div class="hint">${esc(ui.hint)}</div>
       <button class="resolve" data-resolve="1">Resolve turn ▶</button>`
    : `<div class="turn foe">${esc(ui.phaseLabel)}</div><div class="bar"><div class="bar-fill"></div></div>`;
  return `<div class="midbar">
    <div class="mid-left">${energyPool(state, ui)}</div>
    <div class="mid-center">${center}</div>
    <div class="mid-right"><div class="score">${state.teams.A.roundsWon}–${state.teams.B.roundsWon} · R${state.round}</div>
      <button class="surrender" data-surrender="1">Surrender</button></div>
  </div>`;
}

/** The skill detail shown in the midbar while a skill is picked: what it does, while you choose a target. */
function skillPanel(state: MatchState, ui: UiState): string {
  const t = ui.targeting!;
  const u = state.units[t.unitId];
  const skill = (u?.skills ?? []).find((s) => s.id === t.skillId);
  const text = SKILL_TEXT[t.skillId];
  const ic = iconOf(t.skillId, u?.heroId ?? undefined);
  const cost = u && skill ? effectiveCost(u, skill) : null;
  const costStr = cost ? ([cost.generic ? `${cost.generic} generic` : "", cost.specific ? `${cost.specific} ${skill!.element}` : ""].filter(Boolean).join(" + ") || "free") : "";
  return `<div class="skillpanel">
    ${ic ? `<img class="sp-icon" src="${ic}" ${IMG_FALLBACK} />` : ""}
    <div class="sp-body">
      <div class="sp-name">${esc(text?.n ?? t.skillName)} <span class="sp-cost">${esc(costStr)}</span></div>
      <div class="sp-desc">${esc(text?.d ?? "")}</div>
      <div class="sp-foot">▸ Click a highlighted target to use <button class="mini" data-cancel="1">cancel</button></div>
    </div>
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
    return `<div class="sv-row"><img src="${iconOf(s.id, heroId) ?? ""}" ${IMG_FALLBACK} />
      <div><div class="sv-name">${esc(t?.n ?? s.name)}</div><div class="sv-desc">${esc(t?.d ?? "")}</div></div></div>`;
  }).join("");
  return `<div class="detail-head">
      <img class="dp" src="${heroPortrait(heroId)}" ${IMG_FALLBACK} />
      <div><h3>${esc(def.name)}</h3><span class="dp-el">${esc(def.element)}</span></div>
      <button class="addbtn ${on ? "rem" : ""}" data-pick="${heroId}" ${!on && picked.length >= 3 ? "disabled" : ""}>${on ? "− Remove" : "+ Add to team"}</button>
    </div>
    ${passive ? `<div class="sv-row passive"><img src="${iconOf(`${heroId}0`, heroId) ?? ""}" ${IMG_FALLBACK} /><div><div class="sv-name">${esc(passive.n)} <i>passive</i></div><div class="sv-desc">${esc(passive.d)}</div></div></div>` : ""}
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
