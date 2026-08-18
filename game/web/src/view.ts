/**
 * DOM rendering for the web client (art layout). Pure functions of (MatchState, UiState) / setup state;
 * interaction is event-delegated on data-* (see main.ts). Uses the committed portrait + skill art.
 */
import type { MatchState, TeamId, Unit, Status } from "../../engine/src/types.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { totalShield } from "../../engine/src/damage.ts";
import { canUse, effectiveCost } from "../../engine/src/scheduler.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { heroPortrait, iconOf, minionPortrait, energyIcon, elColor } from "./assets.ts";
import { SKILL_TEXT } from "./skilltext.generated.ts";
import { STATUS_SOURCE } from "./statussource.generated.ts";
import { EFFECT_DESC, EFFECT_HIDE } from "./effectdesc.generated.ts";
import type { UiState } from "./main.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortName = (name: string) => name.split(",")[0]!.trim();
const nameOf = (id: string) => shortName(ROSTER.find((h) => h.id === id)?.name ?? id);
const IMG_FALLBACK = `onerror="this.style.visibility='hidden'"`;

// Kinds NOT worth a portrait chip — pure engine plumbing with no clear player-facing meaning.
const HIDDEN_KINDS = new Set<Status["kind"]>(["conditional_bypass", "stack_read_mod", "instant_cast"]);
// Kinds that read as a debuff (red) vs a buff (green); anything else is a neutral "state" chip.
const BAD_KINDS = new Set<Status["kind"]>(["dot", "stun", "blind", "silence", "paralysis", "taunt", "heal_lock", "heal_becomes_damage", "dies_at_max", "veiled"]);
const GOOD_KINDS = new Set<Status["kind"]>(["regen", "stack", "damage_reduction", "invulnerable", "immortal", "damage_ignore", "non_damage_ignore", "revive_ward", "uncounterable", "damage_becomes_heal", "elemental_essence"]);
// A round-permanent effect (duration null) reads as "Permanent"; a timed one shows turns remaining.
const durStr = (s: Status) => s.duration === null ? "Permanent" : typeof s.duration === "number" && s.duration > 0 ? `${s.duration} turn${s.duration > 1 ? "s" : ""} remaining` : "";
const skillName = (id?: string) => (id && SKILL_TEXT[id] ? SKILL_TEXT[id]!.n : undefined);
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

/** A precise, concise account of what THIS individual status is doing right now — keyed on the status's own
 *  fields (kind / magnitude / dtype / name / scope / unitRef), so two effects from one skill read distinctly.
 *  `src` is the id of the skill/passive that applied it (only used to attribute the source name). */
function effectDesc(state: MatchState, s: Status, src?: string): { title: string; body: string; dur: string } {
  const srcName = skillName(src);
  const mag = s.magnitude ?? 0, dt = s.dtype ?? "affliction";
  const unitName = s.unitRef ? shortName(state.units[s.unitRef]?.name ?? "a unit") : undefined;
  // Marks/stacks/channels are self-naming; otherwise fall back to the source skill's name, then the kind.
  const title = s.name ? (s.kind === "channeling" ? (skillName(s.name) ?? s.name) : s.name) : (srcName ?? s.kind.replace(/_/g, " "));
  let body: string;
  switch (s.kind) {
    case "dot": body = `Deals ${mag} ${dt} damage each turn.`; break;
    case "regen": body = `Restores ${mag} HP each turn.`; break;
    // Marks/stacks are opaque named effects; their meaning is authored (what HOLDING it does), not the
    // applying skill's action. The stack's live count shows on the chip badge, so the text describes the resource.
    case "stack": body = (s.name && EFFECT_DESC[s.name]) || `${mag} stack${mag === 1 ? "" : "s"} of ${s.name ?? "a resource"}.`; break;
    case "mark": body = (s.name && EFFECT_DESC[s.name]) || "A marker other skills read."; break;
    case "stun": body = s.scope ? `Can't use ${s.scope.mode === "only" ? "" : "non-"}${s.scope.tag} skills.` : "Stunned — can't use skills."; break;
    case "blind": body = "Single-target skills strike a random target."; break;
    case "invulnerable": body = "Can't be targeted by new harmful skills."; break;
    case "isolated": body = "Can't be targeted by new helpful skills."; break;
    case "untargetable": body = "Can't be targeted by other units."; break;
    case "taunt": body = `Forced to target ${unitName ?? "the taunter"}.`; break;
    case "silence": body = "No Elemental Essence income."; break;
    case "paralysis": body = "Cooldowns don't advance."; break;
    case "immortal": body = "HP can't drop below 1."; break;
    case "revive_ward": body = `Survives one lethal hit, reviving to ${mag} HP.`; break;
    case "shatter": body = "Its hits ignore DR, Invulnerable, and Shields."; break;
    case "damage_ignore": body = "Ignores all incoming damage."; break;
    case "non_damage_ignore": body = "Immune to harmful non-damage effects."; break;
    case "damage_reduction": body = `Reduces incoming damage by ${mag}.`; break;
    case "incoming_damage_mod": body = `Takes ${Math.abs(mag)} ${mag < 0 ? "less" : "more"} damage.`; break;
    case "outgoing_damage_mod": body = `Deals ${Math.abs(mag)} ${mag < 0 ? "less" : "more"} damage.`; break;
    case "incoming_damage_mult": body = `Takes ${mag}× damage${s.newDamageOnly ? " from skills" : ""}.`; break;
    case "outgoing_damage_mult": body = `Deals ${mag}× damage.`; break;
    case "outgoing_dtype_override": body = `Its damage is dealt as ${dt}.`; break;
    case "damage_becomes_heal": body = "Incoming damage heals it instead."; break;
    case "heal_becomes_damage": body = "Incoming healing damages it instead."; break;
    case "dies_at_max": body = "Dies at full HP; survives at 0."; break;
    case "heal_lock": body = unitName ? `Can only be healed by ${unitName}.` : "Can't be healed."; break;
    case "uncounterable": body = "Its skills can't be countered or reflected."; break;
    case "stealth": body = "Doesn't set off enemies' triggers."; break;
    case "veiled": body = "Its details stay hidden until it uses a harmful skill."; break;
    case "cost_mod": { const sk = skillName(s.skillId); body = `${sk ?? "Skills"} cost${sk ? "s" : ""} ${signed(mag)} energy.`; break; }
    case "cooldown_mod": body = `Skills' cooldowns ${signed(mag)} turns.`; break;
    case "elemental_essence": body = "Next energy income is 1 of its element (not generic)."; break;
    case "channeling": body = `Channeling ${skillName(s.name) ?? "a skill"} each turn.`; break;
    default: body = "";
  }
  // Attribute the source, unless the title already IS the source name (avoids "Frost-Covered (from Frost-Covered)").
  if (srcName && title !== srcName && s.kind !== "mark" && s.kind !== "stack") body = `${body} (from ${srcName})`;
  return { title, body: body.trim(), dur: durStr(s) };
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
  const shown = (s: Status) => !HIDDEN_KINDS.has(s.kind) && !(s.name && EFFECT_HIDE.has(s.name));
  // A stack/mark is a carrier; when the same NAME also manifests as a concrete effect (a dot, a damage
  // mod, …), that concrete chip already tells the story, so the carrier chip is redundant — drop it.
  // (Burning Blood Serum = a stack + its +damage mod + its dot → show just the mod and the dot.)
  const concreteNames = new Set<string>();
  for (const s of u.statuses) if (shown(s) && s.name && s.kind !== "stack" && s.kind !== "mark") concreteNames.add(s.name);
  const seen = new Set<string>(); const out: string[] = [];
  for (const s of u.statuses) {
    if (!shown(s)) continue;
    if ((s.kind === "stack" || s.kind === "mark") && s.name && concreteNames.has(s.name)) continue; // redundant carrier
    const key = `${s.kind}:${s.name ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    const src = statusSource(state, s);
    const icon = src ? iconOf(src) : null;
    const { title, body, dur } = effectDesc(state, s, src);
    const tone = BAD_KINDS.has(s.kind) ? "bad" : GOOD_KINDS.has(s.kind) ? "good" : "state";
    out.push(`<span class="fx ${tone}" data-fxtitle="${esc(title)}" data-fxbody="${esc(body)}" data-fxdur="${esc(dur)}">${icon ? `<img src="${icon}" ${IMG_FALLBACK} />` : `<span class="fx-abbr">${esc((s.name ?? s.kind)[0]!.toUpperCase())}</span>`}${s.kind === "stack" && (s.magnitude ?? 0) > 1 ? `<span class="fx-n">${s.magnitude}</span>` : ""}</span>`);
  }
  return out.length ? `<div class="fxrow">${out.slice(0, 6).join("")}</div>` : "";
}

function hpBar(u: Unit): string {
  const pct = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
  const shield = totalShield(u);
  return `<div class="hp"><div class="hp-fill" style="width:${pct}%"></div>
    <span class="hp-num">${Math.max(0, u.hp)}${shield > 0 ? `<i>+${shield}</i>` : ""}</span></div>`;
}

/** A skill's cost as a row of energy icons — one per unit, specific (element) then generic, no numbers/words. */
function costIcons(cost: { generic: number; specific: number }, element: string): string {
  const pip = (el: string) => `<img class="cost-ic" src="${energyIcon(el)}" alt="${esc(el)}" title="${esc(el)}" ${IMG_FALLBACK} />`;
  const icons = element && cost.specific > 0 ? pip(element).repeat(cost.specific) : "";
  const gen = cost.generic > 0 ? pip("generic").repeat(cost.generic) : "";
  const all = icons + gen;
  return all ? `<span class="cost-ics">${all}</span>` : `<span class="cost-free">Free</span>`;
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
    // Always clickable — an unusable skill opens its detail (examine) instead of entering targeting.
    return `<button class="${cls}" data-owner="${u.id}" data-skill="${s.id}" title="${esc(tip)}">
      ${ic ? `<img src="${ic}" alt="${esc(s.name)}" ${IMG_FALLBACK} />` : `<span class="tile-abbr">${esc(s.name.slice(0, 3))}</span>`}
      ${s.currentCd > 0 ? `<span class="cdbadge">${s.currentCd}</span>` : ""}</button>`;
  }).join("");
  return `<div class="tiles">${tiles}</div>`;
}

/** A readable label for where a queued skill lands when it has no explicit single target (AoE/self). */
function aoeLabel(skill: SkillInstance | undefined): string {
  switch (skill?.targeting) {
    case "all-enemies": return "all enemies";
    case "all-allies": return "all allies";
    case "all": return "everyone";
    default: return "self";
  }
}

/** The banner on a queued hero's card: which skill it will use, and on whom. */
function queuedBanner(state: MatchState, u: Unit, ui: UiState): string {
  const a = ui.planned.get(u.id);
  if (!a) return "";
  const skill = (u.skills ?? []).find((s) => s.id === a.skillId);
  const name = SKILL_TEXT[a.skillId]?.n ?? skill?.name ?? a.skillId;
  const ic = iconOf(a.skillId, u.heroId ?? undefined);
  const targets = a.targets && a.targets.length
    ? a.targets.map((id) => shortName(state.units[id]?.name ?? "?")).join(", ")
    : aoeLabel(skill);
  return `<div class="queued">${ic ? `<img src="${ic}" ${IMG_FALLBACK} />` : ""}<span class="q-txt"><b>${esc(name)}</b> → ${esc(targets)}</span></div>`;
}

/** The ids of every unit some queued skill will hit (explicit single targets), for an "incoming" marker. */
function queuedTargetIds(ui: UiState): Set<string> {
  const ids = new Set<string>();
  for (const a of ui.planned.values()) for (const t of a.targets ?? []) ids.add(t);
  return ids;
}

function heroCard(state: MatchState, u: Unit, ui: UiState, isYou: boolean, targetedBy: Set<string>): string {
  const targetable = ui.phase === "plan" && !!ui.targeting && ui.legalTargets.has(u.id);
  const incoming = targetedBy.has(u.id);
  const cls = ["hero", u.alive ? "" : "dead", targetable ? "targetable" : "", incoming ? "incoming" : "", ui.plannedSkill.has(u.id) ? "acted" : ""].filter(Boolean).join(" ");
  const mart = u.kind === "minion" ? minionPortrait(u.name) : null;
  const portrait = u.heroId
    ? `<img class="portrait" src="${heroPortrait(u.heroId, u.fused)}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : mart
    ? `<img class="portrait" src="${mart}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : `<div class="portrait minion-art">${esc(shortName(u.name))}</div>`;
  const pcol = `<div class="pcol">
    <div class="frame" style="--el:${elColor(u.currentElement)}" ${targetable ? `data-target="${u.id}"` : ""}>${portrait}${effectIcons(state, u)}${incoming ? `<div class="incoming-tag">◎ targeted</div>` : ""}<div class="name">${esc(shortName(u.name))}</div></div>
    ${hpBar(u)}
    ${isYou ? queuedBanner(state, u, ui) : ""}
  </div>`;
  return `<div class="${cls}">${pcol}${isYou && u.alive ? skillTiles(state, u, ui) : ""}</div>`;
}

function sideRow(state: MatchState, side: TeamId, ui: UiState, isYou: boolean, targetedBy: Set<string>): string {
  const units = state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u);
  const heroes = units.filter((u) => u.kind === "hero");
  const minions = units.filter((u) => u.kind === "minion");
  return `<div class="lane ${isYou ? "you" : "foe"}">
    <div class="heroes">${heroes.map((u) => heroCard(state, u, ui, isYou, targetedBy)).join("")}</div>
    ${minions.length ? `<div class="minions">${minions.map((u) => heroCard(state, u, ui, isYou, targetedBy)).join("")}</div>` : ""}
  </div>`;
}

function energyPool(state: MatchState, ui: UiState): string {
  const pool = state.teams[ui.you].energy;
  const els = new Set<string>(["generic"]);
  for (const id of state.teams[ui.you].units) { const u = state.units[id]; if (u?.kind === "hero") els.add(u.currentElement); }
  for (const k of Object.keys(pool)) if ((pool[k] ?? 0) > 0) els.add(k);
  const rows = [...els].sort((a, b) => (a === "generic" ? -1 : b === "generic" ? 1 : a.localeCompare(b)))
    .map((el) => `<div class="ep-row"><img class="ep-ic" src="${energyIcon(el)}" alt="${esc(el)}" title="${esc(el)}" ${IMG_FALLBACK} />
      <span class="ep-el">${esc(el)}</span><span class="ep-n">${pool[el] ?? 0}</span></div>`).join("");
  return `<div class="epool"><div class="ep-title">Energy Pool</div>${rows}</div>`;
}

function midbar(state: MatchState, ui: UiState): string {
  const yourTurn = ui.phase === "plan";
  // While targeting, the skill detail lives HERE (between the lanes) — never over a portrait, so every
  // highlighted target stays clickable. Otherwise: your-turn controls, or the AI's "acting…" bar.
  const center = ui.targeting || ui.examine
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

/** The skill detail in the midbar — shown either while targeting a usable skill, or while merely
 *  examining an unusable one (on cooldown / too costly), which shows the reason and does not target. */
function skillPanel(state: MatchState, ui: UiState): string {
  const sel = ui.targeting ?? ui.examine!;
  const examining = !ui.targeting;
  const u = state.units[sel.unitId];
  const skill = (u?.skills ?? []).find((s) => s.id === sel.skillId);
  const text = SKILL_TEXT[sel.skillId];
  const ic = iconOf(sel.skillId, u?.heroId ?? undefined);
  const cost = u && skill ? effectiveCost(u, skill) : null;
  const costEl = cost ? costIcons(cost, skill!.element) : "";
  const name = text?.n ?? ui.targeting?.skillName ?? skill?.name ?? sel.skillId;
  const foot = examining
    ? `<span class="sp-warn">⚠ ${esc(ui.examine!.reason)}</span> <button class="mini" data-cancel="1">close</button>`
    : `▸ Click a highlighted target to use <button class="mini" data-cancel="1">cancel</button>`;
  return `<div class="skillpanel${examining ? " examine" : ""}">
    ${ic ? `<img class="sp-icon" src="${ic}" ${IMG_FALLBACK} />` : ""}
    <div class="sp-body">
      <div class="sp-name">${esc(name)} <span class="sp-cost">${costEl}</span></div>
      <div class="sp-desc">${esc(text?.d ?? "")}</div>
      <div class="sp-foot">${foot}</div>
    </div>
  </div>`;
}

/** The end-of-turn panel: choose which energy colors cover the generic costs spent this turn. */
function energyPanel(ui: UiState): string {
  const p = ui.energyPanel!;
  const sum = Object.values(p.alloc).reduce((a, b) => a + b, 0);
  const covered = sum === p.generic;
  const colors = Object.keys(p.avail).sort((a, b) => (a === "generic" ? -1 : b === "generic" ? 1 : a.localeCompare(b)));
  const rows = colors.map((c) => {
    const have = p.avail[c] ?? 0, put = p.alloc[c] ?? 0;
    return `<div class="alloc-row">
      <img class="ep-ic" src="${energyIcon(c)}" alt="${esc(c)}" title="${esc(c)}" ${IMG_FALLBACK} />
      <span class="ac-el">${esc(c)}</span><span class="ac-avail">${have} available</span>
      <span class="ac-step"><button class="step" data-minus="${c}" ${put <= 0 ? "disabled" : ""}>−</button>
        <span class="ac-n">${put}</span>
        <button class="step" data-plus="${c}" ${put >= have || covered ? "disabled" : ""}>+</button></span>
    </div>`;
  }).join("");
  return `<div class="overlay"><div class="modal energy-modal">
    <h2>Cover generic costs</h2>
    <p>You spent <b>${p.generic}</b> generic energy this turn — any color can pay it. Choose which to spend.</p>
    <div class="alloc-rows">${rows}</div>
    <div class="alloc-total ${covered ? "ok" : "short"}">Allocated ${sum} / ${p.generic}</div>
    <div class="modal-foot">
      <button class="mini" data-energy-cancel="1">◀ Back</button>
      <button class="resolve" data-energy-confirm="1" ${covered ? "" : "disabled"}>Confirm &amp; resolve ▶</button>
    </div>
  </div></div>`;
}

export function renderApp(state: MatchState, ui: UiState): string {
  const foe = ui.you === "A" ? "B" : "A";
  const targetedBy = queuedTargetIds(ui);
  return `<div class="arena">
    ${sideRow(state, foe, ui, false, targetedBy)}
    ${midbar(state, ui)}
    ${sideRow(state, ui.you, ui, true, targetedBy)}
  </div>${ui.energyPanel ? energyPanel(ui) : ""}${ui.overlay ?? ""}`;
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
      <div><div class="sv-name">${esc(t?.n ?? s.name)} <span class="sv-cost">${costIcons(s.cost, s.element)}</span></div><div class="sv-desc">${esc(t?.d ?? "")}</div></div></div>`;
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
