/**
 * DOM rendering for the web client (art layout). Pure functions of (MatchState, UiState) / setup state;
 * interaction is event-delegated on data-* (see main.ts). Uses the committed portrait + skill art.
 */
import type { MatchState, TeamId, Unit, Status } from "../../engine/src/types.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { totalShield } from "../../engine/src/damage.ts";
import { canUse, effectiveCost, hasEssenceIncome } from "../../engine/src/scheduler.ts";
import { availableFusions, availableAugments } from "../../engine/content/metagame.ts";
import { fusionsFor } from "../../engine/content/fusions.generated.ts";
import { fusionResult } from "../../engine/content/recipes.generated.ts";
import { augmentsFor } from "../../engine/content/augments.generated.ts";
import type { FusionForm } from "../../engine/content/fusion.ts";
import { draftableHeroes } from "../../client/draft.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { heroPortrait, iconOf, minionPortrait, energyIcon, characterButton, elColor, ELEMENT_ORDER, elementRank } from "./assets.ts";
import { SKILL_TEXT } from "./skilltext.generated.ts";
import { STATUS_SOURCE } from "./statussource.generated.ts";
import { EFFECT_DESC, EFFECT_VARIANT, EFFECT_HIDE } from "./effectdesc.generated.ts";
import type { UiState } from "./main.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortName = (name: string) => name.split(",")[0]!.trim();
const nameOf = (id: string) => shortName(ROSTER.find((h) => h.id === id)?.name ?? id);
const IMG_FALLBACK = `onerror="this.style.visibility='hidden'"`;

// Kinds NOT worth a portrait chip — pure engine plumbing, or (elemental_essence) shown as a glow instead.
const HIDDEN_KINDS = new Set<Status["kind"]>(["conditional_bypass", "stack_read_mod", "instant_cast", "elemental_essence"]);
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
/** The authored text for a named mark/stack: its state-gated variant while the bearer `u` holds the
 *  gating status (e.g. Saya's "Enhanced"), else the base. Undefined if the effect has no authored entry. */
function authoredText(s: Status, u: Unit): string | undefined {
  if (!s.name) return undefined;
  const v = EFFECT_VARIANT[s.name];
  if (v && u.statuses.some((x) => x.name === v.when || x.kind === (v.when.toLowerCase() as Status["kind"]))) return v.text;
  return EFFECT_DESC[s.name];
}

function effectDesc(state: MatchState, u: Unit, s: Status, src?: string): { title: string; body: string; dur: string } {
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
    case "stack": body = authoredText(s, u) || `${mag} stack${mag === 1 ? "" : "s"} of ${s.name ?? "a resource"}.`; break;
    case "mark": body = authoredText(s, u) || "A marker other skills read."; break;
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
 *  1. the engine-stamped runtime `sourceId` — the skill that ACTUALLY applied it, so it's form-correct
 *     (base skill in base form, fusion skill when fused). Preferred over the static map, which is keyed by
 *     name and can point at a fusion variant of a same-named status (e.g. base Fan the Flames vs Festering Burns).
 *  2. a named status → the content-scanned name→skill map (fallback for statuses lacking runtime provenance);
 *  3. a skill-scoped cost/cooldown mod → the skill it discounts (its `skillId` field);
 *  4. last resort — the applying unit's CURRENT passive (base or fusion form), so it's always hero-correct.
 */
function statusSource(state: MatchState, s: Status): string | undefined {
  if (s.sourceId && SKILL_TEXT[s.sourceId]) return s.sourceId;
  if (s.name && STATUS_SOURCE[s.name]) return STATUS_SOURCE[s.name];
  if (s.skillId && SKILL_TEXT[s.skillId]) return s.skillId;
  const by = state.units[s.appliedBy];
  return by?.heroId ? `${by.heroId}${by.fused ?? ""}0` : undefined;
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
    const { title, body, dur } = effectDesc(state, u, s, src);
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

const livingOn = (state: MatchState, side: TeamId): Unit[] =>
  state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.alive);

/** The units a queued action will actually hit: its explicit single target(s), else the whole set its
 *  targeting implies — self/none → the caster, all-enemies/all-allies/all → that living group. */
function actionTargets(state: MatchState, a: { unit: string; skillId: string; targets?: string[] }): string[] {
  if (a.targets && a.targets.length) return a.targets;
  const u = state.units[a.unit];
  const skill = (u?.skills ?? []).find((s) => s.id === a.skillId);
  if (!u || !skill) return [];
  const enemy: TeamId = u.team === "A" ? "B" : "A";
  switch (skill.targeting) {
    case "all-enemies": return livingOn(state, enemy).map((x) => x.id);
    case "all-allies": return livingOn(state, u.team).map((x) => x.id);
    case "all": return [...livingOn(state, u.team), ...livingOn(state, enemy)].map((x) => x.id);
    default: return [u.id]; // self / none → the caster
  }
}

interface Incoming { caster: string; skillId: string; order: number; }
/** For each targeted unit id, the queued skills aimed at it — with the caster and 1-based resolve order. */
function incomingBy(state: MatchState, ui: UiState): Map<string, Incoming[]> {
  const map = new Map<string, Incoming[]>();
  let order = 0;
  for (const a of ui.planned.values()) {
    order++;
    for (const t of actionTargets(state, a)) {
      const list = map.get(t) ?? (map.set(t, []).get(t)!);
      list.push({ caster: a.unit, skillId: a.skillId, order });
    }
  }
  return map;
}

/** Skill icons hanging over the top edge of a targeted portrait — one per queued skill aimed here, in
 *  resolve order. Each shows its skill on hover and dequeues that caster's action on click. */
function targetingRow(state: MatchState, incoming: Incoming[]): string {
  if (!incoming.length) return "";
  const icons = incoming.map(({ caster, skillId, order }) => {
    const cu = state.units[caster];
    const ic = iconOf(skillId, cu?.heroId ?? undefined);
    const t = SKILL_TEXT[skillId];
    const body = `From ${esc(shortName(cu?.name ?? "?"))}, resolves #${order}. Click to remove.${t?.d ? ` — ${esc(t.d)}` : ""}`;
    return `<button class="tgt" data-dequeue="${caster}" data-fxtitle="${esc(t?.n ?? skillId)}" data-fxbody="${body}">
      ${ic ? `<img src="${ic}" ${IMG_FALLBACK} />` : `<span class="tgt-abbr">?</span>`}<span class="tgt-n">${order}</span></button>`;
  }).join("");
  return `<div class="tgtrow">${icons}</div>`;
}

function heroCard(state: MatchState, u: Unit, ui: UiState, isYou: boolean, incoming: Map<string, Incoming[]>): string {
  const targetable = ui.phase === "plan" && !!ui.targeting && ui.legalTargets.has(u.id);
  const essence = u.kind === "hero" && u.alive && hasEssenceIncome(u); // element glow — has an Essence charge, or is the middle hero
  const cls = ["hero", u.alive ? "" : "dead", targetable ? "targetable" : "", essence ? "essence" : "", ui.plannedSkill.has(u.id) ? "acted" : ""].filter(Boolean).join(" ");
  const mart = u.kind === "minion" ? minionPortrait(u.name) : null;
  const portrait = u.heroId
    ? `<img class="portrait" src="${heroPortrait(u.heroId, u.fused)}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : mart
    ? `<img class="portrait" src="${mart}" alt="${esc(u.name)}" ${IMG_FALLBACK} />`
    : `<div class="portrait minion-art">${esc(shortName(u.name))}</div>`;
  const pcol = `<div class="pcol">
    ${targetingRow(state, incoming.get(u.id) ?? [])}
    <div class="frame" style="--el:${elColor(u.currentElement)}" ${targetable ? `data-target="${u.id}"` : ""}>${portrait}${effectIcons(state, u)}<div class="name">${esc(shortName(u.name))}</div></div>
    ${hpBar(u)}
  </div>`;
  return `<div class="${cls}">${pcol}${isYou && u.alive ? skillTiles(state, u, ui) : ""}</div>`;
}

function sideRow(state: MatchState, side: TeamId, ui: UiState, isYou: boolean, incoming: Map<string, Incoming[]>): string {
  const units = state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u);
  const heroes = units.filter((u) => u.kind === "hero");
  const minions = units.filter((u) => u.kind === "minion");
  return `<div class="lane ${isYou ? "you" : "foe"}">
    <div class="heroes">${heroes.map((u) => heroCard(state, u, ui, isYou, incoming)).join("")}</div>
    ${minions.length ? `<div class="minions">${minions.map((u) => heroCard(state, u, ui, isYou, incoming)).join("")}</div>` : ""}
  </div>`;
}

function energyPool(state: MatchState, ui: UiState): string {
  const pool = state.teams[ui.you].energy;
  const els = new Set<string>(["generic"]);
  for (const id of state.teams[ui.you].units) { const u = state.units[id]; if (u?.kind === "hero") els.add(u.currentElement); }
  for (const k of Object.keys(pool)) if ((pool[k] ?? 0) > 0) els.add(k);
  const rows = [...els].sort((a, b) => elementRank(a) - elementRank(b) || a.localeCompare(b))
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
  const colors = Object.keys(p.avail).sort((a, b) => elementRank(a) - elementRank(b) || a.localeCompare(b));
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

/** The base element `base` fuses WITH to reach the form keyed `result` — for "Fire/Water → Alchemy" labels. */
function fusionPartner(base: string, result: string): string | undefined {
  return ELEMENT_ORDER.find((p) => fusionResult(base, p) === result);
}
/** Fusion forms ordered by the partner element's fixed rank (never alphabetical). */
function orderFusions(base: string, forms: FusionForm[]): FusionForm[] {
  return forms.slice().sort((a, b) => elementRank(fusionPartner(base, a.key) ?? "") - elementRank(fusionPartner(base, b.key) ?? ""));
}
/** The "components → result" heading for a fusion card, e.g. "Fire/Water → Alchemy". */
function fusionHead(base: string, f: FusionForm): string {
  const p = fusionPartner(base, f.key);
  return `${esc(cap(base))}${p ? `/${esc(cap(p))}` : ""} → <b style="color:${elColor(f.element)}">${esc(cap(f.element))}</b>`;
}

/** The fusion/augment options for one hero — fused portraits + new element + passive for each fusion form,
 *  and name + prose for each untaken augment. One click commits the whole team's single upgrade this round. */
function draftOptions(state: MatchState, u: Unit): string {
  const hid = u.heroId ?? "";
  const forms = orderFusions(u.baseElement, availableFusions(state, u));
  const augs = availableAugments(u);
  const fusion = u.fused
    ? `<div class="do-note">Already fused into <b>${esc(cap(u.fused))}</b> — a hero fuses once per match.</div>`
    : forms.length
    ? forms.map((f) => {
        const passIc = iconOf(`${hid}${f.key}0`, hid);
        const sk = f.skill, skText = SKILL_TEXT[sk.id], skIc = iconOf(sk.id, hid);
        const block = (label: string, ic: string | null, name: string, desc: string) =>
          `<span class="fc-block"><span class="fc-label">${label}</span>
            <span class="fc-line">${ic ? `<img src="${ic}" ${IMG_FALLBACK} />` : ""}<b>${esc(name)}</b></span>
            <span class="fc-desc">${esc(desc)}</span></span>`;
        return `<button class="do-card fusion-card" data-fuse-unit="${u.id}" data-fuse-form="${esc(f.key)}">
          <img class="fc-port" src="${heroPortrait(hid, f.key)}" ${IMG_FALLBACK} />
          <span class="fc-body">
            <span class="fc-head">${fusionHead(u.baseElement, f)}</span>
            ${block("New passive", passIc, f.passive.name, f.passive.description)}
            ${block("New skill", skIc, skText?.n ?? sk.name, skText?.d ?? "")}
          </span></button>`;
      }).join("")
    : `<div class="do-note">No fusion available — needs a teammate whose element forms a recipe.</div>`;
  const augment = augs.length
    ? augs.map((a) => `<button class="do-card" data-aug-unit="${u.id}" data-aug-id="${esc(a.id)}">
        <span class="do-txt"><span class="do-name">★ ${esc(a.name)}</span><span class="do-desc">${esc(a.description)}</span></span></button>`).join("")
    : `<div class="do-note">All of this hero's augments are taken.</div>`;
  return `<div class="do-sec fusion"><h4>Fusion <span>(re-elements the hero, new passive + skill)</span></h4>${fusion}</div>
    <div class="do-sec augment"><h4>Augments <span>(a permanent tweak; cumulative)</span></h4>${augment}</div>`;
}

/** The between-round draft modal: pick one hero and one upgrade (fuse / augment), or hold. */
function draftPanel(state: MatchState, ui: UiState): string {
  const d = ui.draft!;
  const heroes = draftableHeroes(state, d.side);
  const sel = heroes.find((h) => h.id === d.inspect) ?? heroes[0];
  const heroList = heroes.map((h) => {
    const nf = h.fused ? 0 : availableFusions(state, h).length;
    const na = availableAugments(h).length;
    return `<button class="dh ${sel?.id === h.id ? "on" : ""}" data-draft-inspect="${h.id}">
      <img src="${heroPortrait(h.heroId ?? "", h.fused)}" ${IMG_FALLBACK} />
      <span class="dh-name">${esc(shortName(h.name))}</span>
      <span class="dh-opts">${h.fused ? `fused: ${esc(cap(h.fused))}` : `${nf} ⚛`} · ${na} ★</span></button>`;
  }).join("");
  return `<div class="overlay"><div class="modal draft-modal">
    <h2>Round ${state.round} — choose an upgrade</h2>
    <p class="draft-sub">Fuse or augment <b>one</b> hero, or hold. This is your team's single upgrade for the round.</p>
    <div class="draft-body">
      <div class="draft-heroes">${heroList}</div>
      <div class="draft-options">${sel ? draftOptions(state, sel) : ""}</div>
    </div>
    <div class="modal-foot"><button class="mini" data-draft-hold="1">Hold — no upgrade ▶</button></div>
  </div></div>`;
}

export function renderApp(state: MatchState, ui: UiState): string {
  const foe = ui.you === "A" ? "B" : "A";
  const incoming = incomingBy(state, ui);
  return `<div class="arena">
    ${sideRow(state, foe, ui, false, incoming)}
    ${midbar(state, ui)}
    ${sideRow(state, ui.you, ui, true, incoming)}
  </div>${ui.energyPanel ? energyPanel(ui) : ""}${ui.draft ? draftPanel(state, ui) : ""}${ui.overlay ?? ""}`;
}

// ── team select (redesigned scene) ────────────────────────────────────────────────────────────────── //
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleOf = (fullName: string) => fullName.split(",").slice(1).join(",").trim();

// Hand-authored roster layout, split into the left & right panels around the centre controls. Each single-
// element pair sits together (both heroes of that element); the fusion-element heroes stand alone by name.
const LEFT_ROWS = [
  ["sera", "gommar", "keeper", "jarrik", "pyrrha"], //  SERA · [ice] · [fire]
  ["hector", "titania", "syl", "zephyrex"], //           [poison] · [wind]
  ["fate", "dennis", "maggie", "blackknight"], //        Fate · Dennis · [unholy]
];
const RIGHT_ROWS = [
  ["riverdaughter", "zevkir", "ando", "saya", "scratch"], // [water] · [lightning] · Scratch
  ["gaia", "roland", "ayana", "taryn", "trinity"], //        [earth] · [holy] · Trinity
  ["laria", "xyris", "galazax", "aramao"], //               [shadow] · Galazax · Aramao
];
const ROSTER_ORDER = [...LEFT_ROWS.flat(), ...RIGHT_ROWS.flat()];

export function renderSetup(setup: { picked: string[]; oppo: string[]; inspect: string | null; augfuse?: boolean }): string {
  const inspectId = setup.inspect ?? ROSTER_ORDER[0]!;
  const def = ROSTER.find((h) => h.id === inspectId)!;
  const on = setup.picked.includes(inspectId);
  const full = setup.picked.length >= 3;

  // Each skill icon carries its info as data-* for a floating hover/tap popup (skpop in main.ts) — no
  // inline detail panel, so switching skills never shoves the layout around.
  const skTile = (id: string) => {
    const t = SKILL_TEXT[id], isPassive = id === `${def.id}0`;
    const sk = (def.skills ?? []).find((s) => s.id === id);
    const meta = [isPassive ? "Passive" : cap(sk?.klass ?? ""), isPassive || !sk ? "" : sk.cooldown > 0 ? `${sk.cooldown}-turn cooldown` : "no cooldown"].filter(Boolean).join(" · ");
    return `<button class="cs-sicon" data-skname="${esc(t?.n ?? id)}" data-skmeta="${esc(meta)}" data-skdesc="${esc(t?.d ?? "")}" data-skgen="${sk?.cost.generic ?? 0}" data-skspec="${sk?.cost.specific ?? 0}" data-skel="${esc(sk?.element ?? "")}" title="${esc(t?.n ?? id)}"><img src="${iconOf(id, def.id) ?? ""}" ${IMG_FALLBACK} /></button>`;
  };
  const byClass = (k: string) => (def.skills ?? []).filter((s) => s.klass === k).map((s) => skTile(s.id)).join("");
  // Render a section only when the hero actually has that class of skill (Trinity has no defensive/ultimate;
  // only the fusion-element heroes carry a built-in "fusion" skill, since they can't fuse).
  const section = (label: string, cls: string, icons: string) => icons ? `<div class="cs-sk ${cls}"><h4>${label}</h4><div class="cs-icons">${icons}</div></div>` : "";

  const heroCard = (id: string) => {
    const h = ROSTER.find((x) => x.id === id)!;
    return `<button class="cs-hero ${setup.picked.includes(id) ? "on" : ""} ${inspectId === id ? "sel" : ""}" data-inspect="${id}" style="--el:${elColor(h.element)}" title="${esc(shortName(h.name))}">
      <img src="${characterButton(id)}" alt="${esc(shortName(h.name))}" ${IMG_FALLBACK} />${setup.picked.includes(id) ? '<span class="cs-check">✓</span>' : ""}</button>`;
  };
  const panelRows = (rows: string[][]) => rows.map((row) => `<div class="cs-rrow">${row.map(heroCard).join("")}</div>`).join("");

  const slots = [0, 1, 2].map((i) => {
    const id = setup.picked[i];
    return id
      ? `<button class="cs-slot on" data-pick="${id}" title="remove ${esc(nameOf(id))}"><img src="${characterButton(id)}" ${IMG_FALLBACK} /></button>`
      : `<span class="cs-slot empty"></span>`;
  }).join("");

  return `<div class="cs">
    <div class="cs-mini">
      <img src="${characterButton(inspectId)}" ${IMG_FALLBACK} />
      <div class="cs-mini-txt"><b>${esc(shortName(def.name))}</b><span>${esc(titleOf(def.name) || `${cap(def.element)} Element`)}</span></div>
    </div>

    <div class="cs-show">
      <div class="cs-info">
        <div class="cs-hname">${esc(shortName(def.name))}</div>
        <div class="cs-hel">${esc(cap(def.element))} Element</div>
        <button class="cs-abtn ${on ? "rem" : ""}" data-pick="${inspectId}" ${!on && full ? "disabled" : ""}>${on ? "Remove Hero" : "Add to Team"}</button>
        <button class="cs-abtn" disabled title="Not available yet">Mastery</button>
        <button class="cs-abtn" data-augfuse="1" title="Preview this hero's fusion forms and augments">Fusions &amp; Augments</button>
      </div>
      <div class="cs-art"><img src="${heroPortrait(inspectId)}" alt="${esc(shortName(def.name))}" ${IMG_FALLBACK} /></div>
      <div class="cs-skills">
        <div class="cs-sk-title">Kit</div>
        ${section("Passive", "passive", skTile(`${def.id}0`))}
        ${section("Basic", "basic", byClass("basic"))}
        ${section("Fusion", "fusion", byClass("fusion"))}
        ${section("Defensive", "defensive", byClass("defensive"))}
        ${section("Ultimate", "ultimate", byClass("ultimate"))}
      </div>
    </div>

    <div class="cs-bottom">
      <div class="cs-roster left">${panelRows(LEFT_ROWS)}</div>
      <div class="cs-mid">
        <div class="cs-modes">
          <button class="cs-mode" disabled>Quick Match</button>
          <button class="cs-mode" disabled>Ranked Match</button>
          <button class="cs-mode wide" disabled>Hero Challenge Trials</button>
          <button class="cs-mode start" data-start="1" ${full ? "" : "disabled"}>Bot Match</button>
          <button class="cs-mode" disabled>Private Match</button>
        </div>
        <div class="cs-team-title">Your Team</div>
        <div class="cs-team">${slots}</div>
        <div class="cs-prompt">${full ? "Ready — press Bot Match ▶" : `Select ${3 - setup.picked.length} more — 3 Heroes to begin!`}</div>
      </div>
      <div class="cs-roster right">${panelRows(RIGHT_ROWS)}</div>
    </div>
  </div>${setup.augfuse ? augFuseModal(inspectId) : ""}`;
}

/** A read-only modal previewing every fusion form (by partner element) and every augment a base hero
 *  can take — the character-select "Fusions & Augments" view. Reuses the between-round draft card styles. */
function augFuseModal(heroId: string): string {
  const def = ROSTER.find((h) => h.id === heroId)!;
  const forms = orderFusions(def.element, fusionsFor(heroId));
  const augs = augmentsFor(heroId);
  const block = (label: string, ic: string | null, name: string, meta: string, desc: string) =>
    `<span class="fc-block"><span class="fc-label">${label}</span>
      <span class="fc-line">${ic ? `<img src="${ic}" ${IMG_FALLBACK} />` : ""}<b>${esc(name)}</b></span>
      ${meta}<span class="fc-desc">${esc(desc)}</span></span>`;
  const fusion = forms.map((f) => {
    const sk = f.skill, skText = SKILL_TEXT[sk.id];
    const cd = sk.cooldown > 0 ? `${sk.cooldown}-turn cooldown` : "no cooldown";
    const skMeta = `<span class="fc-meta">${costIcons(sk.cost, sk.element)}<span class="fc-cd">${esc(cd)}</span></span>`;
    return `<div class="do-card fusion-card">
      <img class="fc-port" src="${heroPortrait(heroId, f.key)}" ${IMG_FALLBACK} />
      <span class="fc-body">
        <span class="fc-head">${fusionHead(def.element, f)}</span>
        ${block("New passive", iconOf(`${heroId}${f.key}0`, heroId), f.passive.name, "", f.passive.description)}
        ${block("New skill", iconOf(sk.id, heroId), skText?.n ?? sk.name, skMeta, skText?.d ?? "")}
      </span></div>`;
  }).join("");
  const augment = augs.map((a) => `<div class="do-card"><span class="do-txt"><span class="do-name">★ ${esc(a.name)}</span><span class="do-desc">${esc(a.description)}</span></span></div>`).join("");
  return `<div class="overlay"><div class="modal draft-modal augfuse-modal">
    <h2>${esc(shortName(def.name))} — Fusions &amp; Augments</h2>
    <p class="draft-sub">Every fusion form (one per partner element) and every augment this hero can take.</p>
    <div class="draft-options">
      <div class="do-sec fusion"><h4>Fusion forms <span>(${forms.length})</span></h4>${fusion || `<div class="do-note">None.</div>`}</div>
      <div class="do-sec augment"><h4>Augments <span>(${augs.length})</span></h4>${augment || `<div class="do-note">None.</div>`}</div>
    </div>
    <div class="modal-foot"><button class="mini" data-augfuse-close="1">Close</button></div>
  </div></div>`;
}
