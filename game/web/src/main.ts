/**
 * Element Arena — browser client entry. Builds a match and drives the engine's async loop, resolving the
 * human team's turn from board clicks (a Promise that settles when "Resolve turn" is pressed) and the AI
 * team from `defaultPolicy`. Between rounds each team auto-drafts an upgrade for now — an interactive draft
 * UI is the next increment. All rendering goes through view.ts; interaction is event-delegated on data-*.
 */
import type { MatchState, TeamId, Unit } from "../../engine/src/types.ts";
import type { Action } from "../../engine/src/scheduler.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { legalTargets, canUse, canPay, effectiveCost } from "../../engine/src/scheduler.ts";
import { Rng } from "../../engine/src/rng.ts";
import { buildMatch, defaultPolicy, type Draft } from "../../engine/content/match.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { runMatch, type AsyncProvider } from "../../client/loop.ts";
import { autoDraft, applyDraftChoice, hasDraftOptions, draftableHeroes, type DraftChoice } from "../../client/draft.ts";
import { renderApp, renderSetup } from "./view.ts";
import { energyIcon, elementRank } from "./assets.ts";
import { MatchSocket, serverUrl } from "./net.ts";
import { PROTOCOL_VERSION, type ServerMsg } from "../../net/protocol.ts";

export interface UiState {
  you: TeamId;
  phase: "plan" | "busy" | "over";
  phaseLabel: string;
  hint: string;
  targeting?: { unitId: string; skillId: string; skillName: string; single: boolean };
  examine?: { unitId: string; skillId: string; reason: string }; // read-only inspect of an unusable skill
  legalTargets: Set<string>;
  planned: Map<string, Action>;
  plannedSkill: Map<string, string>; // unitId -> chosen skill id (to highlight its tile)
  // The end-of-turn generic-payment allocation panel: how much of each color pays the turn's generic.
  energyPanel?: { actions: Action[]; generic: number; avail: Record<string, number>; alloc: Record<string, number> };
  // The between-round fusion/augment draft: which of your heroes' options are shown, and the resolver to
  // settle once you commit a choice (or hold).
  draft?: { side: TeamId; inspect: string | null; resolve: () => void };
  overlay?: string;
  resolveTurn?: (actions: Action[]) => void;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL_IDS = ROSTER.map((h) => h.id);
function randomTeam(exclude: string[]): string[] {
  const pool = ALL_IDS.filter((id) => !exclude.includes(id));
  const out: string[] = [];
  while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  return out;
}
const living = (s: MatchState, side: TeamId): Unit[] =>
  s.teams[side].units.map((id) => s.units[id]).filter((u): u is Unit => !!u && u.alive);

const app = document.getElementById("app")!;
let state: MatchState;
let setup: { picked: string[]; oppo: string[]; inspect: string | null; augfuse?: boolean } | null = null;
// A live Quick Match (PvP) session. Non-null only in networked play; in bot mode it stays null and the
// local runMatch loop drives everything. When set, the turn/draft/concede commit points send to the server
// instead of resolving locally, and the server's state broadcasts drive the board.
let pvp: { sock: MatchSocket; you: TeamId; over: boolean; started: boolean } | null = null;
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const ui: UiState = {
  you: "A", phase: "busy", phaseLabel: "starting…", hint: "",
  legalTargets: new Set(), planned: new Map(), plannedSkill: new Map(),
};

// A floating popup describing an effect icon, shown on hover/tap.
const fxpop = document.createElement("div");
fxpop.className = "fxpop"; fxpop.hidden = true;
document.body.appendChild(fxpop);
// Render authored text into `el`, turning {generic}/{fire}/… tokens into inline energy icons.
function renderTokens(el: HTMLElement, text: string): void {
  for (const part of text.split(/(\{[a-z]+\})/i)) {
    const m = /^\{([a-z]+)\}$/i.exec(part);
    if (m) {
      const img = document.createElement("img");
      img.className = "tt-en"; img.src = energyIcon(m[1]!.toLowerCase()); img.alt = m[1]!;
      el.append(img);
    } else if (part) el.append(document.createTextNode(part));
  }
}
function showFx(el: HTMLElement): void {
  fxpop.textContent = "";
  const b = document.createElement("b"); b.textContent = el.dataset.fxtitle ?? "";
  const body = document.createElement("div"); renderTokens(body, el.dataset.fxbody ?? "");
  fxpop.append(b, body);
  const dur = el.dataset.fxdur;
  if (dur) { const d = document.createElement("div"); d.className = "fxdur"; d.textContent = `⏳ ${dur}`; fxpop.append(d); }
  fxpop.hidden = false;
  const r = el.getBoundingClientRect(), pw = fxpop.offsetWidth;
  fxpop.style.left = `${Math.max(6, Math.min(window.innerWidth - pw - 6, r.left + r.width / 2 - pw / 2))}px`;
  fxpop.style.top = `${r.bottom + 6}px`;
}
function hideFx(): void { fxpop.hidden = true; }

// A floating skill-info popup for character select — pops off a skill icon on hover/tap (no layout shift).
const skpop = document.createElement("div");
skpop.className = "skpop"; skpop.hidden = true;
document.body.appendChild(skpop);
function showSkpop(el: HTMLElement): void {
  const d = el.dataset;
  skpop.textContent = "";
  const name = document.createElement("b"); name.textContent = d.skname ?? "";
  const meta = document.createElement("div"); meta.className = "skpop-meta"; meta.textContent = d.skmeta ?? "";
  const spec = +(d.skspec ?? 0), gen = +(d.skgen ?? 0), cel = d.skel || "generic";
  const pip = (elm: string) => { const im = document.createElement("img"); im.className = "skpop-cost"; im.src = energyIcon(elm); meta.append(im); };
  for (let i = 0; i < spec; i++) pip(cel);
  for (let i = 0; i < gen; i++) pip("generic");
  const desc = document.createElement("div"); desc.className = "skpop-desc"; desc.textContent = d.skdesc || "No description.";
  skpop.append(name, meta, desc);
  skpop.hidden = false;
  const r = el.getBoundingClientRect(), pw = skpop.offsetWidth, ph = skpop.offsetHeight;
  const top = r.top - ph - 8 >= 6 ? r.top - ph - 8 : r.bottom + 8; // above the icon, flipping below if no room
  skpop.style.left = `${Math.max(6, Math.min(window.innerWidth - pw - 6, r.left + r.width / 2 - pw / 2))}px`;
  skpop.style.top = `${top}px`;
}
function hideSkpop(): void { skpop.hidden = true; }

function render(): void { hideFx(); app.innerHTML = renderApp(state, ui); }
function showSetup(): void { setup = { picked: [], oppo: randomTeam([]), inspect: null }; app.innerHTML = renderSetup(setup); }

/** Legal single-target set (Harmful→enemies, Helpful→allies, else either), run through targeting rules. */
function targetsFor(u: Unit, skillId: string): Set<string> {
  const skill = (u.skills ?? []).find((s) => s.id === skillId)!;
  const enemy: TeamId = u.team === "A" ? "B" : "A";
  const pool = skill.tags.includes("Harmful") ? living(state, enemy)
    : skill.tags.includes("Helpful") ? living(state, u.team)
    : [...living(state, u.team), ...living(state, enemy)];
  return new Set(legalTargets(state, u, skill, pool, Rng.fromState(state.rngState)).map((x) => x.id));
}

/** The portraits to highlight for a skill — EVERY skill requires a target click, even self/auto ones. */
function highlightSet(u: Unit, skill: SkillInstance): Set<string> {
  const enemy: TeamId = u.team === "A" ? "B" : "A";
  switch (skill.targeting) {
    case "single": return targetsFor(u, skill.id);
    case "all-enemies": return new Set(living(state, enemy).map((x) => x.id));
    case "all-allies": return new Set(living(state, u.team).map((x) => x.id));
    case "all": return new Set([...living(state, u.team), ...living(state, enemy)].map((x) => x.id));
    default: return new Set([u.id]); // self / none — confirm on the caster
  }
}

function queue(unitId: string, skillId: string, targets: string[] | undefined): void {
  ui.planned.set(unitId, { unit: unitId, skillId, targets });
  ui.plannedSkill.set(unitId, skillId);
  ui.targeting = undefined;
  ui.legalTargets = new Set();
  render();
}

/** Why a skill can't be used right now — shown in the examine panel for an unusable tile. */
function unusableReason(u: Unit, skill: SkillInstance): string {
  if (skill.currentCd > 0) return `On cooldown — ${skill.currentCd} turn${skill.currentCd > 1 ? "s" : ""} remaining.`;
  if (!canPay(state.teams[u.team].energy, u.currentElement, effectiveCost(u, skill))) return "Not enough energy in the pool.";
  return "Can't be used right now (stunned, silenced, or no valid target).";
}

// Between-round draft: show your heroes' fusion/augment options and await one choice (or hold).
function humanDraft(st: MatchState, side: TeamId): Promise<void> {
  return new Promise((resolve) => {
    ui.phase = "busy";
    ui.phaseLabel = "choose your upgrade";
    ui.draft = { side, inspect: draftableHeroes(st, side)[0]?.id ?? null, resolve };
    render();
  });
}
function finishDraft(): void {
  const resolve = ui.draft?.resolve;
  ui.draft = undefined;
  resolve?.();
}
function logDraft(res: { ok: boolean; desc: string }): void { state.log.push(`draft — ${res.desc}`); }

// In-app surrender confirmation (native confirm() is unreliable in embedded/sandboxed browser contexts).
const SURRENDER_CONFIRM = `<div class="overlay"><div class="modal">
  <h2>Surrender?</h2>
  <p>You'll concede the match and return to team select.</p>
  <div class="modal-foot">
    <button class="mini" data-keep="1">Keep playing</button>
    <button data-concede="1">Concede</button>
  </div></div></div>`;

// ── interaction (event delegation) ───────────────────────────────────────────────────────────────── //
app.addEventListener("click", (e) => {
  const tgtEl = (e.target as HTMLElement).closest<HTMLElement>(".tgt");
  if (tgtEl) { const c = tgtEl.dataset.dequeue; if (c) { ui.planned.delete(c); ui.plannedSkill.delete(c); render(); } return; } // click a targeting icon → dequeue that skill
  const fxEl = (e.target as HTMLElement).closest<HTMLElement>(".fx");
  if (fxEl) { if (fxpop.hidden) showFx(fxEl); else hideFx(); return; } // tap an effect icon to toggle its description
  const skEl = (e.target as HTMLElement).closest<HTMLElement>(".cs-sicon");
  if (skEl) { showSkpop(skEl); return; } // tap a skill icon → pop off its info
  hideSkpop(); // any other click dismisses the skill popup

  if (setup?.augfuse) { // the Fusions & Augments preview is open — only Close / the backdrop respond
    const t = e.target as HTMLElement;
    if (t.closest("[data-augfuse-close]") || t.classList.contains("overlay")) { setup.augfuse = false; app.innerHTML = renderSetup(setup); }
    return;
  }
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-owner],[data-skill],[data-target],[data-cancel],[data-resolve],[data-surrender],[data-pick],[data-inspect],[data-reroll],[data-start],[data-quick],[data-quick-cancel],[data-plus],[data-minus],[data-energy-confirm],[data-energy-cancel],[data-draft-inspect],[data-fuse-unit],[data-aug-unit],[data-draft-hold],[data-concede],[data-keep],[data-augfuse]");
  if (!el) return;
  const d = el.dataset;

  if (d.quickCancel) { cancelQuickMatch(); return; } // leave the Quick Match queue (searching screen)

  if (ui.draft) { // the between-round draft modal is up — only its controls respond
    if (d.draftInspect) { ui.draft.inspect = d.draftInspect; render(); return; }
    let choice: DraftChoice | null = null;
    if (d.fuseUnit && d.fuseForm) choice = { kind: "fuse", unitId: d.fuseUnit, formKey: d.fuseForm };
    else if (d.augUnit && d.augId) choice = { kind: "augment", unitId: d.augUnit, augmentId: d.augId };
    else if (d.draftHold) choice = { kind: "skip" };
    if (!choice) return;
    if (pvp) { // networked: the server applies the choice authoritatively and broadcasts the new state
      pvp.sock.send({ t: "draftChoice", choice });
      pvpBusy("Applying your upgrade…");
    } else {
      if (choice.kind !== "skip") logDraft(applyDraftChoice(state, choice));
      finishDraft();
    }
    return;
  }

  if (ui.energyPanel) { // the generic-payment modal is up — only its controls respond
    const p = ui.energyPanel;
    const sum = () => Object.values(p.alloc).reduce((a, b) => a + b, 0);
    if (d.plus && sum() < p.generic) { p.alloc[d.plus] = Math.min((p.alloc[d.plus] ?? 0) + 1, p.avail[d.plus] ?? 0); render(); }
    else if (d.minus) { p.alloc[d.minus] = Math.max((p.alloc[d.minus] ?? 0) - 1, 0); render(); }
    else if (d.energyConfirm && sum() === p.generic) finalizeTurn(p.actions, p.alloc);
    else if (d.energyCancel) { ui.energyPanel = undefined; render(); } // back to planning
    return;
  }

  if (setup) { // team-select screen
    if (d.augfuse) { setup.augfuse = true; app.innerHTML = renderSetup(setup); }
    else if (d.inspect) { setup.inspect = d.inspect; app.innerHTML = renderSetup(setup); }
    else if (d.pick) { // add / remove (detail button or a tray slot)
      const i = setup.picked.indexOf(d.pick);
      if (i >= 0) setup.picked.splice(i, 1);
      else if (setup.picked.length < 3) setup.picked.push(d.pick);
      app.innerHTML = renderSetup(setup);
    } else if (d.reroll) {
      setup.oppo = randomTeam(setup.picked);
      app.innerHTML = renderSetup(setup);
    } else if (d.quick && setup.picked.length === 3) {
      startQuickMatch([...setup.picked]); // networked PvP — matchmaking + an authoritative server
    } else if (d.start && setup.picked.length === 3) {
      const draft: Draft = { A: [...setup.picked], B: [...setup.oppo], seed: Math.floor(Math.random() * 1e6) };
      setup = null;
      startMatch(draft).catch((err) => { app.innerHTML = `<pre style="color:#f88;padding:1rem">${(err as Error).stack ?? err}</pre>`; });
    }
    return;
  }

  if (d.surrender) { ui.overlay = SURRENDER_CONFIRM; render(); return; }
  if (d.concede) { // networked: tell the server (it decides the forfeit); bot mode just restarts
    if (pvp) { pvp.sock.send({ t: "surrender" }); pvpBusy("Conceding…"); }
    else location.reload();
    return;
  }
  if (d.keep) { ui.overlay = undefined; render(); return; }
  if (ui.phase !== "plan") return;
  if (d.cancel) { ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set(); render(); return; }
  if (d.resolve) { commitTurn(); return; }
  if (d.owner && d.skill) { // pick a skill → target it (if usable) or just examine it (if not)
    const u = state.units[d.owner]!;
    const skill = (u.skills ?? []).find((s) => s.id === d.skill)!;
    if (canUse(state, u, skill)) {
      ui.examine = undefined;
      ui.targeting = { unitId: u.id, skillId: skill.id, skillName: skill.name, single: skill.targeting === "single" };
      ui.legalTargets = highlightSet(u, skill);
    } else { // on cooldown / unaffordable / no target → show its detail, but do NOT enter targeting
      ui.targeting = undefined; ui.legalTargets = new Set();
      ui.examine = { unitId: u.id, skillId: skill.id, reason: unusableReason(u, skill) };
    }
    render();
  } else if (d.target && ui.targeting) { // click a highlighted portrait to commit the skill
    queue(ui.targeting.unitId, ui.targeting.skillId, ui.targeting.single ? [d.target] : undefined);
  }
});

// desktop hover: show the effect/targeting-skill description popup
app.addEventListener("mouseover", (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>(".fx, .tgt"); if (el) showFx(el);
  const sk = t.closest<HTMLElement>(".cs-sicon"); if (sk) showSkpop(sk);
});
app.addEventListener("mouseout", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".fx, .tgt")) hideFx();
  if (t.closest(".cs-sicon")) hideSkpop();
});

/** The turn's total generic cost, and how much of each color is free to pay it (pool minus the specific
 *  each element must reserve). Generic energy is fully available; it can only ever pay generic. */
function planGeneric(actions: Action[]): { generic: number; avail: Record<string, number> } {
  const pool = state.teams[ui.you].energy;
  let generic = 0;
  const reservedSpecific: Record<string, number> = {};
  for (const a of actions) {
    const u = state.units[a.unit];
    const sk = (u?.skills ?? []).find((s) => s.id === a.skillId);
    if (!u || !sk) continue;
    const c = effectiveCost(u, sk);
    generic += c.generic;
    if (c.specific > 0) reservedSpecific[u.currentElement] = (reservedSpecific[u.currentElement] ?? 0) + c.specific;
  }
  const avail: Record<string, number> = {};
  for (const color of Object.keys(pool)) {
    const free = (pool[color] ?? 0) - (color === "generic" ? 0 : reservedSpecific[color] ?? 0);
    if (free > 0) avail[color] = free;
  }
  return { generic, avail };
}

/** Pre-fill the allocation the way the engine would auto-pay: generic pool first, then colors. */
function defaultAlloc(generic: number, avail: Record<string, number>): Record<string, number> {
  const alloc: Record<string, number> = {};
  let rem = generic;
  for (const c of ["generic", ...Object.keys(avail).filter((k) => k !== "generic").sort((a, b) => elementRank(a) - elementRank(b) || a.localeCompare(b))]) {
    if (rem <= 0) break;
    const take = Math.min(rem, avail[c] ?? 0);
    if (take > 0) { alloc[c] = take; rem -= take; }
  }
  return alloc;
}

function commitTurn(): void {
  const actions = [...ui.planned.values()];
  const { generic, avail } = planGeneric(actions);
  const totalAvail = Object.values(avail).reduce((a, b) => a + b, 0);
  // Ask the player to allocate only when there's a real choice (>1 color) and it's affordable.
  if (generic > 0 && Object.keys(avail).length >= 2 && totalAvail >= generic) {
    ui.energyPanel = { actions, generic, avail, alloc: defaultAlloc(generic, avail) };
    render();
    return;
  }
  finalizeTurn(actions, undefined);
}

function finalizeTurn(actions: Action[], alloc: Record<string, number> | undefined): void {
  if (pvp) { // networked: hand the committed turn to the authoritative server, then wait for its next state
    pvp.sock.send({ t: "turn", actions, genericPay: alloc });
    pvpBusy("Waiting for opponent…");
    return;
  }
  if (alloc) state.genericPay = { ...alloc }; // the engine drains generic from these colors first
  const resolve = ui.resolveTurn;
  ui.resolveTurn = undefined;
  ui.phase = "busy";
  ui.phaseLabel = "resolving…";
  ui.targeting = undefined; ui.examine = undefined; ui.energyPanel = undefined; ui.legalTargets = new Set();
  ui.planned.clear(); ui.plannedSkill.clear(); // queued banners clear once the turn is committed
  render();
  resolve?.(actions);
}

// ── the match loop ───────────────────────────────────────────────────────────────────────────────── //
const human: AsyncProvider = (st, side) => new Promise<Action[]>((resolve) => {
  ui.phase = "plan";
  ui.phaseLabel = "your move";
  ui.hint = "Pick a skill on each hero, then a target. Skip a hero to hold it.";
  ui.planned.clear(); ui.plannedSkill.clear();
  ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set();
  ui.resolveTurn = resolve;
  render();
});

const ai: AsyncProvider = async (st, side) => {
  ui.phase = "busy";
  ui.phaseLabel = `Team ${side} (AI) is acting…`;
  render();
  await delay(650);
  return defaultPolicy(st, side);
};

async function startMatch(draft: Draft): Promise<void> {
  state = buildMatch(draft);
  // No pre-loop render: runMatch → startRound → the human provider renders "Round 1 · your move" first,
  // so we skip the momentary "Round 0" frame.
  const outcome = await runMatch(state, (st, side) => (side === ui.you ? human(st, side) : ai(st, side)), {
    roundsToWin: 2,
    hooks: {
      onRoundStart: () => render(), // renders the board synchronously at round 1 (no "Round 0" frame, no delay)
      onResults: () => render(),
      onRoundEnd: (st, w) => { ui.phaseLabel = `Round ${st.round} — Team ${w} wins`; render(); },
    },
    onBetweenRounds: async (st, w) => {
      ui.phase = "busy"; ui.phaseLabel = "between-round draft…";
      for (const side of [w === "A" ? "B" : "A", w] as TeamId[]) { // loser drafts first
        if (side === ui.you && hasDraftOptions(st, side)) {
          await humanDraft(st, side); // interactive — awaits your fuse/augment/hold choice
        } else {
          const choice = autoDraft(st, side);
          const res = applyDraftChoice(st, choice);
          if (choice.kind !== "skip") st.log.push(`draft — Team ${side}: ${res.desc}`);
        }
        render();
        await delay(side === ui.you ? 200 : 900); // brief beat after yours; let the AI's read
      }
    },
  });
  ui.phase = "over";
  const won = outcome.winner === ui.you;
  ui.overlay = `<div class="overlay"><div class="modal">
    <h2>${outcome.winner === null ? "Stalemate" : won ? "Victory 🏆" : "Defeat"}</h2>
    <p>Team ${outcome.winner ?? "—"} wins ${outcome.roundsWon.A}–${outcome.roundsWon.B} over ${outcome.rounds} rounds.</p>
    <button onclick="location.reload()">New team</button>
  </div></div>`;
  ui.phaseLabel = "match over";
  render();
}

// ── Quick Match (PvP, server-authoritative) ─────────────────────────────────────────────────────────── //
/** A standalone centred modal that works before any board exists (searching / errors / connection loss). */
function showModal(html: string): void { app.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`; }
function showSearching(text: string): void {
  showModal(`<h2>Quick Match</h2><p>${escHtml(text)}</p>
    <div class="modal-foot"><button data-quick-cancel="1">Cancel</button></div>`);
}

/** Connect, join the queue with `team`, and let server messages drive the match from here on. */
function startQuickMatch(team: string[]): void {
  const sock = new MatchSocket(serverUrl());
  pvp = { sock, you: "A", over: false, started: false };
  setup = null;
  sock.onOpen = () => sock.send({ t: "queue", team, protocolVersion: PROTOCOL_VERSION });
  sock.onMessage = handleServerMsg;
  // 'error' then 'close' both fire on an abnormal drop — run once, and tailor the message to whether the
  // match had actually started (a dropped in-match connection vs. never reaching the server at all).
  const onDrop = () => {
    if (!pvp || pvp.over) return;
    const started = pvp.started;
    pvp.over = true; pvp.sock.close(); pvp = null;
    showModal(started
      ? `<h2>Connection lost</h2><p>The match connection closed.</p><button onclick="location.reload()">Back to team select</button>`
      : `<h2>Can't reach the server</h2><p>No match server at <code>${escHtml(serverUrl())}</code>. Start it with <code>node game/server/index.ts</code>.</p><button onclick="location.reload()">Back</button>`);
  };
  sock.onError = onDrop;
  sock.onClose = onDrop;
  showSearching("Connecting…");
}

function cancelQuickMatch(): void {
  pvp?.sock.send({ t: "cancelQueue" });
  pvp?.sock.close();
  pvp = null;
  showSetup();
}

/** Enter local planning for a networked turn — mirrors the bot-mode human provider, minus the local promise. */
function enterPvpPlanning(): void {
  ui.phase = "plan";
  ui.phaseLabel = "your move";
  ui.hint = "Pick a skill on each hero, then a target. Skip a hero to hold it.";
  ui.planned.clear(); ui.plannedSkill.clear();
  ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set();
  ui.energyPanel = undefined; ui.overlay = undefined; ui.draft = undefined;
  render();
}

function pvpBusy(label: string): void {
  ui.phase = "busy"; ui.phaseLabel = label;
  ui.targeting = undefined; ui.examine = undefined; ui.energyPanel = undefined; ui.legalTargets = new Set();
  ui.planned.clear(); ui.plannedSkill.clear(); ui.draft = undefined; ui.overlay = undefined;
  render();
}

function handleServerMsg(msg: ServerMsg): void {
  if (!pvp) return;
  switch (msg.t) {
    case "queued": showSearching("Searching for an opponent…"); break;
    case "start":
      pvp.started = true; pvp.you = msg.you; ui.you = msg.you; state = msg.state;
      pvpBusy("Match found — get ready…");
      break;
    case "opponentTurn": state = msg.state; pvpBusy("Opponent is acting…"); break;
    case "yourTurn": state = msg.state; enterPvpPlanning(); break;
    case "opponentDraft": state = msg.state; pvpBusy("Opponent is choosing an upgrade…"); break;
    case "yourDraft": {
      state = msg.state;
      const side = pvp.you; // a player always drafts for its own team
      ui.phase = "busy"; ui.phaseLabel = "choose your upgrade"; ui.overlay = undefined; ui.energyPanel = undefined;
      ui.draft = { side, inspect: draftableHeroes(state, side)[0]?.id ?? null, resolve: () => {} };
      render();
      break;
    }
    case "matchEnd": {
      pvp.over = true;
      const won = msg.outcome.winner === msg.you;
      const title = msg.outcome.winner === null ? "Stalemate" : won ? "Victory 🏆" : "Defeat";
      const why = msg.reason === "opponent-left" ? " Your opponent left the match." : msg.reason === "forfeit" ? " (by surrender)" : "";
      showModal(`<h2>${title}</h2>
        <p>Team ${msg.outcome.winner ?? "—"} wins ${msg.outcome.roundsWon.A}–${msg.outcome.roundsWon.B} over ${msg.outcome.rounds} round${msg.outcome.rounds === 1 ? "" : "s"}.${why}</p>
        <button onclick="location.reload()">Back to team select</button>`);
      pvp.sock.close();
      break;
    }
    case "error":
      pvp.over = true; pvp.sock.close();
      showModal(`<h2>Quick Match</h2><p>${escHtml(msg.message)}</p><button onclick="location.reload()">Back</button>`);
      break;
  }
}

showSetup(); // start at the team-select screen; "New team" reloads back here
