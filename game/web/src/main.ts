/**
 * Element Arena — browser client entry. Builds a match and drives the engine's async loop, resolving the
 * human team's turn from board clicks (a Promise that settles when "Resolve turn" is pressed) and the AI
 * team from `defaultPolicy`. Between rounds each team auto-drafts an upgrade for now — an interactive draft
 * UI is the next increment. All rendering goes through view.ts; interaction is event-delegated on data-*.
 */
import type { MatchState, TeamId, Unit, Status, TurnResolutionItem } from "../../engine/src/types.ts";
import type { Action } from "../../engine/src/scheduler.ts";
import type { SkillInstance } from "../../engine/src/skill.ts";
import { canPay, effectiveCost, canUsePlanned, canPayAfter, reserveEnergy, pendingTicks } from "../../engine/src/scheduler.ts";
import { redactState } from "../../engine/src/visibility.ts";
import { buildMatch, defaultPolicy, type Draft } from "../../engine/content/match.ts";
import { ROSTER } from "../../engine/content/roster.generated.ts";
import { runMatch, type AsyncProvider } from "../../client/loop.ts";
import { autoDraft, applyDraftChoices, hasDraftOptions, draftableHeroes, type DraftChoice } from "../../client/draft.ts";
import { poolFor } from "../../client/targeting.ts";
import { renderApp, renderSetup, renderLogin, renderClaim } from "./view.ts";
import { energyIcon, elementRank, avatarUrl } from "./assets.ts";
import { ELEMENT_BY_ID } from "./elementid.generated.ts";
import { cbEnabled, cbEnergyEl, toggleColorblind } from "./colorblind.ts";
import { MatchSocket, serverUrl, fetchProfile, fetchAvatars, register, login, claimAccount, saveProfile, type AvatarInfo } from "./net.ts";
import { PROTOCOL_VERSION, MAX_NAME_LEN, type ServerMsg, type Profile, type WireTurnOrder } from "../../net/protocol.ts";

export interface UiState {
  you: TeamId;
  phase: "plan" | "busy" | "over";
  phaseLabel: string;
  targeting?: { unitId: string; skillId: string; skillName: string; single: boolean };
  examine?: { unitId: string; skillId: string; reason: string }; // read-only inspect of an unusable skill
  inspectUnit?: string; // a unit whose full kit is shown in the upper area (click any portrait outside targeting)
  legalTargets: Set<string>;
  planned: Map<string, Action>;
  plannedSkill: Map<string, string>; // unitId -> chosen skill id (to highlight its tile)
  // The end-of-turn generic-payment allocation panel: how much of each color pays the turn's generic.
  energyPanel?: { actions: Action[]; generic: number; avail: Record<string, number>; alloc: Record<string, number> };
  // The end-of-turn resolution-order panel (bot matches): the queued skills + this turn's pending dot/regen
  // ticks, arranged top-to-bottom; the player drags to change the order they resolve in.
  orderPanel?: { items: OrderItem[] };
  // The between-round fusion/augment draft: which of your heroes' options are shown, and the resolver to
  // settle once you commit a choice (or hold).
  draft?: { side: TeamId; inspect: string | null; picks: Map<string, DraftChoice>; resolve: () => void };
  overlay?: string;
  /** A thin fixed banner over the board (e.g. "opponent disconnected — waiting…"). */
  notice?: string;
  /** The opponent's display name in a networked match (shown in the midbar). */
  opponentName?: string;
  resolveTurn?: (actions: Action[]) => void;
}

/** One row of the resolution-order panel: a queued skill, or one of this turn's pending dot/regen ticks. */
export type OrderItem =
  | { kind: "action"; action: Action }
  | { kind: "tick"; unitId: string; status: Status };

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
// The interleaved resolution order built from the order panel, applied to state.turnOrder at finalize (bot
// matches only). Undefined = the default order (skills in submission order, then ticks at turn-end).
let pendingTurnOrder: TurnResolutionItem[] | undefined;
let dragOrderIndex: number | null = null; // the row being dragged in the resolution-order panel
let setup: { picked: string[]; oppo: string[]; inspect: string | null; augfuse?: boolean } | null = null;
// A live Quick Match (PvP) session. Non-null only in networked play; in bot mode it stays null and the
// local runMatch loop drives everything. When set, the turn/draft/concede commit points send to the server
// instead of resolving locally, and the server's state broadcasts drive the board.
/** What a match socket should do once its guest identity is authenticated. */
type Intent = { kind: "queue"; team: string[]; ranked: boolean } | { kind: "rejoin"; matchId: string; token: string };
let pvp:
  | { sock: MatchSocket; you: TeamId; over: boolean; started: boolean; token?: string; matchId?: string; reconnecting: boolean; attempts: number; intent: Intent; opponentName?: string }
  | null = null;
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_DELAY_MS = 2500;
const STORED_MATCH_KEY = "arenaMatch"; // sessionStorage: lets a page reload rejoin an in-progress match

// ── guest identity (persistent, client-held) ────────────────────────────────────────────────────────── //
let profile: Profile | null = null; // the authoritative profile from the server (name + record), when reachable
interface Identity { playerId: string; secret: string; name: string; }
let cachedCreds: { playerId: string; secret: string } | null = null; // memoized so a session keeps ONE identity even if storage is blocked

/** A random token that works even outside a secure context (crypto.randomUUID is undefined over LAN http). */
function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return "g-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Local-testing override: `?player=<key>` gives this window its OWN deterministic guest identity, so two
 *  tabs in the SAME browser become DISTINCT players the server will pair against each other (it never
 *  self-pairs one identity). Stable per key, so a reload keeps the same seat; it does not touch the normal
 *  persisted `arenaIdentity`. Use for manual PvP testing (see game/scripts/local-pvp-web.*). */
function identityOverride(): Identity | null {
  const key = (() => { try { return new URLSearchParams(location.search).get("player"); } catch { return null; } })();
  if (!key) return null;
  const k = key.slice(0, 40);
  const name = (() => { try { return localStorage.getItem(`arenaName:${k}`) || `Player ${k}`; } catch { return `Player ${k}`; } })();
  return { playerId: `local-${k}`, secret: `local-secret-${k}`, name };
}

function identity(): Identity {
  const override = identityOverride();
  if (override) return override;
  if (!cachedCreds) {
    try { const c = JSON.parse(localStorage.getItem("arenaIdentity") ?? "null"); if (c?.playerId && c?.secret) cachedCreds = c; } catch { /* blocked */ }
    if (!cachedCreds) {
      cachedCreds = { playerId: uuid(), secret: uuid() };
      try { localStorage.setItem("arenaIdentity", JSON.stringify(cachedCreds)); } catch { /* private mode — the memo keeps it stable this session */ }
    }
  }
  const name = (() => { try { return localStorage.getItem("arenaName") || "Guest"; } catch { return "Guest"; } })();
  return { ...cachedCreds, name };
}
function setStoredName(name: string): void {
  const key = (() => { try { return new URLSearchParams(location.search).get("player"); } catch { return null; } })();
  const storeKey = key ? `arenaName:${key.slice(0, 40)}` : "arenaName"; // keep `?player=` windows' names distinct
  try { localStorage.setItem(storeKey, name.slice(0, MAX_NAME_LEN)); } catch { /* ignore */ }
  syncProfile({ name: name.slice(0, MAX_NAME_LEN) }); // persist the display name to the account too
}

// The pickable avatar set (from assets/avatars/manifest.json) and the player's chosen one.
let avatars: AvatarInfo[] = [];
let avatarPickerOpen = false;
function playerAvatarFile(): string {
  const stored = (() => { try { return localStorage.getItem("arenaAvatar"); } catch { return null; } })();
  if (stored && (!avatars.length || avatars.some((a) => a.file === stored))) return stored;
  return "default.png"; // new players (no chosen avatar) get the "Default" avatar
}
function setAvatarFile(file: string): void { try { localStorage.setItem("arenaAvatar", file); } catch { /* ignore */ } syncProfile({ avatar: file }); }

// ── login / account session ─────────────────────────────────────────────────────────────────────────── //
let screen: "login" | "setup" = "setup"; // which pre-match screen is live (boot decides)
let loginState: { mode: "login" | "register"; error?: string; busy?: boolean } = { mode: "login" };
let claimForm: { error?: string; busy?: boolean } | null = null; // the "save your account" modal (guest → registered)

/** Store a server-issued (register/login) or guest identity so all later auth reuses it across reloads. */
function setStoredIdentity(playerId: string, secret: string): void {
  cachedCreds = { playerId, secret };
  try { localStorage.setItem("arenaIdentity", JSON.stringify(cachedCreds)); } catch { /* ignore */ }
}
/** Has this browser a stored identity already (a returning guest or logged-in account)? The ?player= test
 *  path also counts, so local 2-tab PvP skips the login gate. */
function hasStoredIdentity(): boolean {
  if (identityOverride()) return true;
  try { const c = JSON.parse(localStorage.getItem("arenaIdentity") ?? "null"); return !!(c?.playerId && c?.secret); } catch { return false; }
}
/** Persist a changed profile field (name/avatar) to the account and fold the server's echo back into `profile`. */
function syncProfile(patch: { name?: string; avatar?: string; progress?: unknown }): void {
  const id = identity();
  void saveProfile(id.playerId, id.secret, patch).then((p) => { if (p) profile = p; });
}
/** Sign out: drop the stored identity + local prefs and return to the login screen. */
function logout(): void {
  try { for (const k of ["arenaIdentity", "arenaName", "arenaAvatar"]) localStorage.removeItem(k); } catch { /* ignore */ }
  cachedCreds = null; profile = null; setup = null; avatarPickerOpen = false;
  loginState = { mode: "login" }; screen = "login"; renderLoginScreen();
}
function renderLoginScreen(): void { app.innerHTML = renderLogin(loginState); }

/** The player-profile panel's data: display name, an avatar image, a rating + record subtitle, and (for a
 *  registered account) the login handle — its presence marks the player as claimed vs. an anonymous guest. */
function playerPanel(): { name: string; sub: string; avatar: string; username?: string } {
  const name = profile?.name ?? identity().name;
  const sub = profile
    ? `★ ${profile.rating} · ${profile.wins}W · ${profile.losses}L${profile.draws ? ` · ${profile.draws}D` : ""}`
    : "offline";
  const file = playerAvatarFile();
  return { name, sub, avatar: file ? avatarUrl(file) : "", username: profile?.username };
}
/** The `auth` message every match socket sends first, from the stored identity. */
function authMsg() { const id = identity(); return { t: "auth" as const, playerId: id.playerId, secret: id.secret, name: id.name, protocolVersion: PROTOCOL_VERSION }; }
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const ui: UiState = {
  you: "A", phase: "busy", phaseLabel: "starting…",
  legalTargets: new Set(), planned: new Map(), plannedSkill: new Map(),
};

// A floating popup describing an effect icon, shown on hover/tap.
const fxpop = document.createElement("div");
fxpop.className = "fxpop"; fxpop.hidden = true;
document.body.appendChild(fxpop);
// Render authored text into `el`, turning {generic}/{fire}/… name tokens AND [<id>] element-id energy
// refs (e.g. [65] = generic) into inline energy icons; unknown ids stay as literal text.
function renderTokens(el: HTMLElement, text: string): void {
  for (const part of text.split(/(\{[a-z]+\}|\[\d+\])/i)) {
    const curly = /^\{([a-z]+)\}$/i.exec(part), brack = /^\[(\d+)\]$/.exec(part);
    const name = curly ? curly[1]!.toLowerCase() : brack ? ELEMENT_BY_ID[+brack[1]!] : undefined;
    if (name) {
      if (cbEnabled()) el.append(cbEnergyEl(name));
      else { const img = document.createElement("img"); img.className = "tt-en"; img.src = energyIcon(name); img.alt = name; el.append(img); }
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
  const pip = (elm: string) => {
    if (cbEnabled()) { meta.append(cbEnergyEl(elm, "cb-cost")); return; }
    const im = document.createElement("img"); im.className = "skpop-cost"; im.src = energyIcon(elm); meta.append(im);
  };
  for (let i = 0; i < spec; i++) pip(cel);
  for (let i = 0; i < gen; i++) pip("generic");
  const desc = document.createElement("div"); desc.className = "skpop-desc"; renderTokens(desc, d.skdesc || "No description.");
  skpop.append(name, meta, desc);
  skpop.hidden = false;
  const r = el.getBoundingClientRect(), pw = skpop.offsetWidth, ph = skpop.offsetHeight;
  const top = r.top - ph - 8 >= 6 ? r.top - ph - 8 : r.bottom + 8; // above the icon, flipping below if no room
  skpop.style.left = `${Math.max(6, Math.min(window.innerWidth - pw - 6, r.left + r.width / 2 - pw / 2))}px`;
  skpop.style.top = `${top}px`;
}
function hideSkpop(): void { skpop.hidden = true; }

// Render the board from the LOCAL seat's perspective: an opponent's Invisible effects are stripped here.
// In PvP the server already redacted `state`, so this is idempotent; in local vs-bot play (where `state` is
// the full authoritative board the engine loop runs on) this is what actually hides the bot's Invisible
// effects from the human. We redact only the render copy — the live `state` the loop mutates stays whole.
function render(): void { hideFx(); app.innerHTML = renderApp(redactState(state, ui.you), ui, playerPanel()); }
/** The team-select screen (its player panel reads the profile) plus the avatar picker when open. */
function renderSetupScreen(): void { app.innerHTML = renderSetup(setup!, playerPanel()) + avatarPickerHtml() + (claimForm ? renderClaim(claimForm) : ""); fitCharSelect(); }
/** Open team select, optionally pre-seeded with an already-chosen team (e.g. after cancelling matchmaking). */
function showSetup(picked: string[] = []): void {
  const keep = picked.slice(0, 3);
  setup = { picked: keep, oppo: randomTeam(keep), inspect: null }; // nothing selected on load — the player clicks a hero to inspect it
  renderSetupScreen();
}
/** Scale + recentre the (fixed-width) character-select scene to fit narrow windows, so it never runs off the
 *  edges. The scene isn't centred within its own box (right-heavy roster), so we measure its true extent and
 *  apply a translate+scale that both shrinks it to fit and centres it in the viewport. */
function fitCharSelect(): void {
  const cs = document.querySelector<HTMLElement>(".cs");
  const stage = document.querySelector<HTMLElement>(".cs-stage");
  if (!cs || !stage) return;
  stage.style.transform = "none"; // measure the natural (unscaled) horizontal extent in viewport coords
  let min = Infinity, max = -Infinity;
  for (const el of cs.querySelectorAll<HTMLElement>(".cs-hero, .cs-mid, .cs-show > *")) {
    const r = el.getBoundingClientRect();
    if (r.width) { min = Math.min(min, r.left); max = Math.max(max, r.right); }
  }
  const W = cs.clientWidth, natural = max - min;
  if (!(natural > 0) || natural <= W - 16) { stage.style.transform = ""; return; } // already fits
  const s = Math.max(0.4, (W - 16) / natural);
  const stageLeft = stage.getBoundingClientRect().left; // transform-origin is the stage's top-left
  const dx = W / 2 - stageLeft - ((min + max) / 2 - stageLeft) * s; // recentre the scaled content
  stage.style.transform = `translateX(${dx}px) scale(${s})`;
}
window.addEventListener("resize", () => { if (setup) fitCharSelect(); });
// <img>s are natively draggable — a few px of mouse movement while clicking a button starts a native image
// drag and swallows the click, making the icon/character buttons hard to press. Suppress it app-wide.
window.addEventListener("dragstart", (e) => { if ((e.target as Element | null)?.tagName === "IMG") e.preventDefault(); });

/** The avatar chooser: a grid of every avatar in the manifest; clicking one sets it. Empty string when closed. */
function avatarPickerHtml(): string {
  if (!avatarPickerOpen) return "";
  const current = playerAvatarFile();
  const cells = avatars.length
    ? avatars.map((a) => `<button class="av-cell ${a.file === current ? "on" : ""}" data-avatar-set="${escHtml(a.file)}">
        <img src="${avatarUrl(a.file)}" alt="" onerror="this.style.visibility='hidden'" /></button>`).join("")
    : `<div class="do-note">No avatars found. Add images to <code>assets/avatars/</code> and run <code>build_avatars.py</code>.</div>`;
  return `<div class="overlay" data-avatar-close="1"><div class="modal av-modal">
    <h2>Choose your avatar</h2>
    <div class="av-grid">${cells}</div>
    <div class="modal-foot"><button class="mini" data-avatar-close="1">Close</button></div>
  </div></div>`;
}

/** Fetch the guest profile from the server (create-or-verify); re-render the team-select if it's up. */
async function refreshProfile(): Promise<void> {
  const id = identity();
  profile = await fetchProfile(id.playerId, id.secret, id.name);
  if (setup) renderSetupScreen();
}

/** App entry: resume an in-progress match if one is stored, else load the profile + avatars and show team-select. */
async function boot(): Promise<void> {
  if (tryResumeStoredMatch()) return; // an accidental reload rejoins the live match first
  avatars = await fetchAvatars();
  if (hasStoredIdentity()) await enterSetup(); // returning guest or logged-in account → straight to team select
  else { screen = "login"; renderLoginScreen(); } // first visit → log in / register / continue as guest
}

/** Authenticate with the current stored identity and open team select (shared by boot + the login handlers). */
async function enterSetup(): Promise<void> {
  screen = "setup";
  const id = identity(); // mints a fresh guest identity here if none is stored (the "Continue as guest" path)
  profile = await fetchProfile(id.playerId, id.secret, id.name);
  if (profile?.avatar) setAvatarFileLocal(profile.avatar); // adopt the account's synced avatar
  showSetup();
}
/** Write the avatar locally WITHOUT re-syncing to the server (used when adopting the account's own value). */
function setAvatarFileLocal(file: string): void { try { localStorage.setItem("arenaAvatar", file); } catch { /* ignore */ } }

/** The single-target set the UI highlights for a skill — the offering logic (faction rules + fusion
 *  widenings like Merciless/Swoop, then the engine's legalTargets) lives in the shared client/targeting.ts. */
function targetsFor(u: Unit, skillId: string): Set<string> {
  const skill = (u.skills ?? []).find((s) => s.id === skillId)!;
  return new Set(poolFor(state, u, skill).map((x) => x.id));
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
  const pool = state.teams[u.team].energy;
  const cost = effectiveCost(u, skill, state);
  if (!canPay(pool, u.currentElement, cost)) return "Not enough energy in the pool.";
  // Affordable against the full pool, but its energy is already spoken for by other skills queued this turn.
  const others = [...ui.planned.values()].filter((a) => a.unit !== u.id);
  if (!canPayAfter(pool, u, cost, reserveEnergy(state, others))) return "Its energy is already committed to your other queued skills this turn.";
  return "Can't be used right now (stunned, silenced, or no valid target).";
}

// Between-round draft: show your heroes' fusion/augment options and await a batch (one upgrade per hero).
function humanDraft(st: MatchState, side: TeamId): Promise<void> {
  return new Promise((resolve) => {
    ui.phase = "busy";
    ui.phaseLabel = "choose your upgrades";
    ui.draft = { side, inspect: draftableHeroes(st, side)[0]?.id ?? null, picks: new Map(), resolve };
    render();
  });
}
function finishDraft(): void {
  const resolve = ui.draft?.resolve;
  ui.draft = undefined;
  resolve?.();
}
function logDraft(res: { ok: boolean; desc: string }): void { state.log.push(`draft — ${res.desc}`); }

// In-app surrender menu (native confirm() is unreliable in embedded/sandboxed browser contexts). Two ways
// out: concede just this ROUND (the opponent takes it, then you draft an upgrade), or forfeit the whole MATCH.
const SURRENDER_MENU = `<div class="overlay"><div class="modal surrender-menu">
  <h2>Surrender</h2>
  <p>Concede just this <b>round</b> — the opponent takes it and you go to the upgrade draft — or forfeit the whole <b>match</b>?</p>
  <div class="modal-foot">
    <button data-concede-round="1">Concede round</button>
    <button class="forfeit" data-forfeit="1">Forfeit match</button>
    <button class="mini" data-keep="1">Keep playing</button>
  </div></div></div>`;

/** Bot-mode: concede the current round locally. Set the engine flag (roundWinner awards the AI), clear the
 *  plan, and unblock the local match loop so it resolves the turn and advances into the between-round draft. */
function concedeRoundLocal(): void {
  state.concededRound = ui.you;
  ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set();
  ui.planned.clear(); ui.plannedSkill.clear();
  const resolve = ui.resolveTurn; ui.resolveTurn = undefined;
  ui.phase = "busy"; ui.phaseLabel = "conceding round…";
  render();
  resolve?.([]); // if it's your turn, the loop resolves an empty turn; roundWinner then ends the round
}

// ── interaction (event delegation) ───────────────────────────────────────────────────────────────── //
app.addEventListener("click", (e) => {
  const tgtEl = (e.target as HTMLElement).closest<HTMLElement>(".tgt");
  if (tgtEl) { const c = tgtEl.dataset.dequeue; if (c) { ui.planned.delete(c); ui.plannedSkill.delete(c); render(); } return; } // click a targeting icon → dequeue that skill
  const fxEl = (e.target as HTMLElement).closest<HTMLElement>(".fx");
  if (fxEl) { if (fxpop.hidden) showFx(fxEl); else hideFx(); return; } // tap an effect icon to toggle its description
  const skEl = (e.target as HTMLElement).closest<HTMLElement>(".cs-sicon");
  if (skEl) { showSkpop(skEl); return; } // tap a skill icon → pop off its info
  hideSkpop(); // any other click dismisses the skill popup

  // In-match: close the unit inspector, or click any portrait (outside targeting / no modal) to inspect its
  // kit in the upper area — works for the ENEMY team too, so you can check their current skills.
  if ((e.target as HTMLElement).closest("[data-inspect-close]")) { ui.inspectUnit = undefined; render(); return; }
  if ((e.target as HTMLElement).classList.contains("ui-backdrop")) { ui.inspectUnit = undefined; render(); return; } // click the dimmed backdrop to close
  const frameEl = (e.target as HTMLElement).closest<HTMLElement>(".frame[data-inspect-unit]");
  if (frameEl && !ui.targeting && !ui.draft && !ui.energyPanel && !ui.orderPanel && !ui.overlay) {
    const id = frameEl.dataset.inspectUnit!;
    ui.inspectUnit = ui.inspectUnit === id ? undefined : id; // clicking the same portrait again closes it
    render(); return;
  }

  if (setup?.augfuse) { // the Fusions & Augments preview is open — only Close / the backdrop respond
    const t = e.target as HTMLElement;
    if (t.closest("[data-augfuse-close]") || t.classList.contains("overlay")) { setup.augfuse = false; renderSetupScreen(); }
    return;
  }

  if (claimForm) { // the "save your account" modal is up — only its controls respond
    const t = e.target as HTMLElement;
    if (t.closest("[data-claim-cancel]") || t.classList.contains("overlay")) { claimForm = null; renderSetupScreen(); return; }
    if (t.closest("[data-claim-submit]") && !claimForm.busy) {
      const val = (sel: string) => (app.querySelector<HTMLInputElement>(sel)?.value ?? "").trim();
      const uname = val("[data-claim-username]"), pass = val("[data-claim-password]");
      claimForm = { busy: true }; renderSetupScreen();
      const id = identity();
      void (async () => {
        const r = await claimAccount(id.playerId, id.secret, uname, pass); // keeps the same identity; adds a login
        if (r.ok) { profile = r.creds.profile; claimForm = null; renderSetupScreen(); }
        else { claimForm = { error: r.error }; renderSetupScreen(); }
      })();
    }
    return; // swallow other clicks (the inputs still focus normally)
  }
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-login],[data-register],[data-guest],[data-login-mode],[data-logout],[data-claim-open],[data-owner],[data-skill],[data-target],[data-cancel],[data-resolve],[data-surrender],[data-pick],[data-inspect],[data-reroll],[data-start],[data-quick],[data-ranked],[data-quick-cancel],[data-plus],[data-minus],[data-energy-confirm],[data-energy-cancel],[data-draft-inspect],[data-fuse-unit],[data-aug-unit],[data-draft-confirm],[data-draft-clear],[data-concede-round],[data-forfeit],[data-keep],[data-augfuse],[data-avatar-pick],[data-avatar-set],[data-avatar-close],[data-cb-toggle],[data-order-cancel],[data-order-confirm],[data-order-up],[data-order-down]");
  if (!el) return;
  const d = el.dataset;

  if (d.logout) { logout(); return; } // sign out → back to the login screen
  if (d.claimOpen) { claimForm = {}; renderSetupScreen(); return; } // a guest opens the "save your account" modal
  if (d.cbToggle) { toggleColorblind(); if (setup) renderSetupScreen(); else render(); return; } // accessibility: energy icons ⇄ coloured [Element] labels

  if (screen === "login") { // the pre-character-select login screen — only its controls respond
    if (d.loginMode) { loginState = { mode: d.loginMode === "register" ? "register" : "login" }; renderLoginScreen(); return; }
    if (d.guest) { void enterSetup(); return; } // continue as guest (identity() mints/keeps a guest id)
    if ((d.login || d.register) && !loginState.busy) {
      const val = (sel: string) => (app.querySelector<HTMLInputElement>(sel)?.value ?? "").trim();
      const uname = val("[data-username-input]"), pass = val("[data-password-input]"), nm = val("[data-name-input]");
      const wantRegister = !!d.register;
      loginState = { ...loginState, busy: true, error: undefined }; renderLoginScreen();
      void (async () => {
        const r = wantRegister ? await register(uname, pass, nm || uname) : await login(uname, pass);
        if (r.ok) {
          setStoredIdentity(r.creds.playerId, r.creds.secret);
          setStoredName(r.creds.profile.name);
          if (r.creds.profile.avatar) setAvatarFileLocal(r.creds.profile.avatar);
          profile = r.creds.profile;
          await enterSetup();
        } else { loginState = { mode: loginState.mode, error: r.error }; renderLoginScreen(); }
      })();
    }
    return; // swallow any other click while the login screen is up
  }

  if (d.quickCancel) { cancelQuickMatch(); return; } // leave the Quick Match queue (searching screen)

  // Avatar picker (team-select): open on the profile avatar, choose a cell, or close.
  if (d.avatarSet) { setAvatarFile(d.avatarSet); avatarPickerOpen = false; renderSetupScreen(); return; }
  if (d.avatarClose) { avatarPickerOpen = false; renderSetupScreen(); return; }
  if (d.avatarPick !== undefined) { avatarPickerOpen = true; renderSetupScreen(); return; }

  if (ui.draft) { // the between-round draft modal is up — pick an upgrade PER hero, then confirm the batch
    const picks = ui.draft.picks;
    if (d.draftInspect) { ui.draft.inspect = d.draftInspect; render(); return; }
    if (d.fuseUnit && d.fuseForm) { // toggle: click the chosen fusion again to un-choose it
      const cur = picks.get(d.fuseUnit);
      if (cur?.kind === "fuse" && cur.formKey === d.fuseForm) picks.delete(d.fuseUnit);
      else picks.set(d.fuseUnit, { kind: "fuse", unitId: d.fuseUnit, formKey: d.fuseForm });
      render(); return;
    }
    if (d.augUnit && d.augId) {
      const cur = picks.get(d.augUnit);
      if (cur?.kind === "augment" && cur.augmentId === d.augId) picks.delete(d.augUnit);
      else picks.set(d.augUnit, { kind: "augment", unitId: d.augUnit, augmentId: d.augId });
      render(); return;
    }
    if (d.draftClear) { picks.delete(d.draftClear); render(); return; } // un-choose one hero
    if (d.draftConfirm) { // commit every hero's pick at once (an empty batch = hold all)
      const choices = [...picks.values()];
      if (pvp) { pvp.sock.send({ t: "draftChoice", choices }); pvpBusy("Applying your upgrades…"); }
      else { for (const res of applyDraftChoices(state, ui.draft.side, choices)) logDraft(res); finishDraft(); }
    }
    return;
  }

  if (ui.orderPanel) { // the resolution-order panel is up — reorder the rows, then confirm or go back
    if (d.orderCancel) { ui.orderPanel = undefined; pendingTurnOrder = undefined; render(); return; }
    if (d.orderConfirm) { confirmResolveOrder(); return; }
    if (d.orderUp) { const i = +d.orderUp; moveOrderItem(i, i - 1); return; }
    if (d.orderDown) { const i = +d.orderDown; moveOrderItem(i, i + 1); return; }
    return; // swallow other clicks while the panel is up
  }

  if (ui.energyPanel) { // the generic-payment modal is up — only its controls respond
    const p = ui.energyPanel;
    const sum = () => Object.values(p.alloc).reduce((a, b) => a + b, 0);
    if (d.plus && sum() < p.generic) { p.alloc[d.plus] = Math.min((p.alloc[d.plus] ?? 0) + 1, p.avail[d.plus] ?? 0); render(); }
    else if (d.minus) { p.alloc[d.minus] = Math.max((p.alloc[d.minus] ?? 0) - 1, 0); render(); }
    else if (d.energyConfirm && sum() === p.generic) finalizeTurn(p.actions, p.alloc);
    else if (d.energyCancel) { ui.energyPanel = undefined; pendingTurnOrder = undefined; render(); } // back to planning
    return;
  }

  if (setup) { // team-select screen
    if (d.augfuse) { setup.augfuse = true; renderSetupScreen(); }
    else if (d.inspect) { // first click inspects; clicking the ALREADY-inspected hero toggles it on/off the team
      if (setup.inspect === d.inspect) {
        const i = setup.picked.indexOf(d.inspect);
        if (i >= 0) setup.picked.splice(i, 1);
        else if (setup.picked.length < 3) setup.picked.push(d.inspect);
      } else setup.inspect = d.inspect;
      renderSetupScreen();
    }
    else if (d.pick) { // add / remove (detail button or a tray slot)
      const i = setup.picked.indexOf(d.pick);
      if (i >= 0) setup.picked.splice(i, 1);
      else if (setup.picked.length < 3) setup.picked.push(d.pick);
      renderSetupScreen();
    } else if (d.reroll) {
      setup.oppo = randomTeam(setup.picked);
      renderSetupScreen();
    } else if (d.quick && setup.picked.length === 3) {
      startQuickMatch([...setup.picked]); // networked PvP — matchmaking + an authoritative server
    } else if (d.ranked && setup.picked.length === 3) {
      startQuickMatch([...setup.picked], true); // ranked: Elo + rating-window matchmaking
    } else if (d.start && setup.picked.length === 3) {
      const draft: Draft = { A: [...setup.picked], B: [...setup.oppo], seed: Math.floor(Math.random() * 1e6) };
      setup = null;
      startMatch(draft).catch((err) => { app.innerHTML = `<pre style="color:#f88;padding:1rem">${(err as Error).stack ?? err}</pre>`; });
    }
    return;
  }

  if (d.surrender) { ui.overlay = SURRENDER_MENU; render(); return; }
  if (d.keep) { ui.overlay = undefined; render(); return; }
  if (d.forfeit) { // forfeit the whole MATCH → back to team select
    if (pvp) { pvp.sock.send({ t: "surrender" }); pvpBusy("Forfeiting…"); }
    else location.reload();
    return;
  }
  if (d.concedeRound) { // concede only the CURRENT round → the between-round draft
    ui.overlay = undefined;
    if (pvp) { pvp.sock.send({ t: "concedeRound" }); pvpBusy("Conceding round…"); }
    else concedeRoundLocal();
    return;
  }
  if (ui.phase !== "plan") return;
  if (d.cancel) { ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set(); render(); return; }
  if (d.resolve) { openResolveOrder(); return; }
  if (d.owner && d.skill) { // pick a skill → target it (if usable) or just examine it (if not)
    ui.inspectUnit = undefined; // picking a skill takes over the upper area from any open inspector
    const u = state.units[d.owner]!;
    const skill = (u.skills ?? []).find((s) => s.id === d.skill)!;
    if (canUsePlanned(state, u, skill, [...ui.planned.values()])) {
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

// Drag-to-reorder for the resolution-order panel (rows are plain divs, so the app-wide IMG drag guard doesn't
// interfere). ▲▼ buttons do the same via clicks, for touch / keyboard.
app.addEventListener("dragstart", (e) => {
  const it = (e.target as HTMLElement).closest<HTMLElement>(".ro-item");
  if (!ui.orderPanel || !it) return;
  dragOrderIndex = +it.dataset.roIndex!;
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.dataset.roIndex!); }
  it.classList.add("ro-dragging");
});
app.addEventListener("dragover", (e) => {
  if (ui.orderPanel && dragOrderIndex !== null && (e.target as HTMLElement).closest(".ro-item, .ro-list")) e.preventDefault();
});
app.addEventListener("drop", (e) => {
  if (!ui.orderPanel || dragOrderIndex === null) return;
  e.preventDefault();
  const it = (e.target as HTMLElement).closest<HTMLElement>(".ro-item");
  const to = it ? +it.dataset.roIndex! : ui.orderPanel.items.length - 1;
  const from = dragOrderIndex; dragOrderIndex = null;
  moveOrderItem(from, to);
});
app.addEventListener("dragend", () => { dragOrderIndex = null; app.querySelector(".ro-dragging")?.classList.remove("ro-dragging"); });

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
    const c = effectiveCost(u, sk, state);
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

// ── end-of-turn resolution order (bot matches) ──────────────────────────────────────────────────────── //
/** Open the resolution-order panel: the queued skills plus this turn's pending dot/regen ticks, arranged in
 *  their default resolution order (all skills, then ticks). Works in bot AND networked play — in PvP the
 *  chosen order rides along on the committed turn and the authoritative server re-resolves it. With nothing
 *  to resolve, commit straight through. */
function openResolveOrder(): void {
  const actions = [...ui.planned.values()];
  const ticks = pendingTicks(state, ui.you);
  const items: OrderItem[] = [
    ...actions.map((action): OrderItem => ({ kind: "action", action })),
    ...ticks.map((t): OrderItem => ({ kind: "tick", unitId: t.unitId, status: t.status })),
  ];
  if (!items.length) { commitTurn(); return; }
  ui.orderPanel = { items };
  render();
}

/** Move a resolution-order row from index `from` to index `to` (drag drop / ▲▼). */
function moveOrderItem(from: number, to: number): void {
  const items = ui.orderPanel?.items;
  if (!items || from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
  const [it] = items.splice(from, 1);
  items.splice(to, 0, it!);
  render();
}

/** True when the arranged order is the engine's DEFAULT: every tick after every skill, ticks still in their
 *  natural (pendingTicks) order. Then the normal turn path reproduces it (skills in array order, then tickDots)
 *  and no explicit interleave is needed — so the battle-tested path runs unless the player truly interleaves. */
function isCanonicalOrder(items: OrderItem[]): boolean {
  let seenTick = false;
  for (const it of items) { if (it.kind === "tick") seenTick = true; else if (seenTick) return false; } // skill after a tick
  const natural = pendingTicks(state, ui.you).map((t) => t.status);
  const arranged = items.filter((it): it is Extract<OrderItem, { kind: "tick" }> => it.kind === "tick").map((it) => it.status);
  if (arranged.length !== natural.length) return false;
  return arranged.every((s, i) => s === natural[i]);
}

/** Convert the local interleave order (Status refs) to the wire form the server re-resolves: each action item
 *  becomes a "next action" marker; each tick carries its bearer + status identity, which the server matches
 *  against its OWN recomputed pending ticks (it never trusts a client-named tick). */
function toWireOrder(order: TurnResolutionItem[]): WireTurnOrder {
  return order.map((it) =>
    it.kind === "action"
      ? { kind: "action" as const }
      : { kind: "tick" as const, unit: it.unitId, name: it.status.name, by: it.status.appliedBy, regen: it.status.kind === "regen" });
}

/** Confirm the resolution order → build the ordered actions (+ an explicit interleave order only when the
 *  player actually reordered ticks among skills), then continue into the normal energy/commit flow. */
function confirmResolveOrder(): void {
  const items = ui.orderPanel!.items;
  ui.orderPanel = undefined;
  const orderedActions: Action[] = [];
  const turnOrder: TurnResolutionItem[] = items.map((it) =>
    it.kind === "action"
      ? { kind: "action", index: (orderedActions.push(it.action), orderedActions.length - 1) }
      : { kind: "tick", unitId: it.unitId, status: it.status });
  pendingTurnOrder = isCanonicalOrder(items) ? undefined : turnOrder; // default path unless a real interleave
  commitTurn(orderedActions);
}

function commitTurn(actions: Action[] = [...ui.planned.values()]): void {
  const { generic, avail } = planGeneric(actions);
  // ALWAYS surface the allocation panel whenever the turn has any generic cost — even when the choice is
  // forced (a single payable color) — so the player always sees and confirms which energy pays it. (Queuing
  // is already gated to a jointly-payable set, so `avail` is guaranteed to cover `generic` here.) With no
  // generic cost there is nothing to allocate, so resolve straight through.
  if (generic > 0) {
    ui.energyPanel = { actions, generic, avail, alloc: defaultAlloc(generic, avail) };
    render();
    return;
  }
  finalizeTurn(actions, undefined);
}

function finalizeTurn(actions: Action[], alloc: Record<string, number> | undefined): void {
  if (pvp) { // networked: hand the committed turn (+ any explicit interleave) to the authoritative server
    const order = pendingTurnOrder ? toWireOrder(pendingTurnOrder) : undefined;
    pendingTurnOrder = undefined;
    pvp.sock.send({ t: "turn", actions, genericPay: alloc, order });
    pvpBusy("Waiting for opponent…");
    return;
  }
  if (alloc) state.genericPay = { ...alloc }; // the engine drains generic from these colors first
  if (pendingTurnOrder) state.turnOrder = pendingTurnOrder; // an explicit skill/tick interleave for this turn
  pendingTurnOrder = undefined;
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
  ui.planned.clear(); ui.plannedSkill.clear();
  ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set(); ui.inspectUnit = undefined;
  ui.orderPanel = undefined; pendingTurnOrder = undefined;
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
          await humanDraft(st, side); // interactive — awaits your per-hero upgrade batch
        } else {
          for (const res of applyDraftChoices(st, side, autoDraft(st, side))) st.log.push(`draft — Team ${side}: ${res.desc}`);
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

function storeMatch(matchId: string, token: string): void {
  try { sessionStorage.setItem(STORED_MATCH_KEY, JSON.stringify({ matchId, token })); } catch { /* private mode */ }
}
function clearStoredMatch(): void {
  try { sessionStorage.removeItem(STORED_MATCH_KEY); } catch { /* ignore */ }
}

/** A dropped socket. A reconnect/resume attempt retries; a first in-match drop starts reconnecting; only a
 *  fresh (never-started, no token) connect failure is a flat "can't reach the server". */
function onDrop(): void {
  if (!pvp || pvp.over) return;
  if (pvp.reconnecting) { setTimeout(attemptReconnect, RECONNECT_DELAY_MS); return; } // a reconnect/resume attempt itself dropped → retry
  if (!pvp.started) { pvp.over = true; pvp = null; showModal(`<h2>Can't reach the server</h2><p>No match server at <code>${escHtml(serverUrl())}</code>. Start it with <code>node game/server/index.ts</code>.</p><button onclick="location.reload()">Back</button>`); return; }
  pvp.reconnecting = true; pvp.attempts = 0;
  attemptReconnect();
}

/** Wire a match socket: authenticate first; the `authed` handler then acts on pvp.intent (queue/rejoin). */
function wireSocket(sock: MatchSocket): void {
  sock.onOpen = () => sock.send(authMsg());
  sock.onMessage = handleServerMsg;
  sock.onError = () => { /* wait for close */ };
  sock.onClose = onDrop;
}

/** Open a fresh socket and present the rejoin token to resume the in-progress match. */
function attemptReconnect(): void {
  if (!pvp || pvp.over || !pvp.reconnecting) return;
  if (++pvp.attempts > MAX_RECONNECT_ATTEMPTS || !pvp.token || !pvp.matchId) {
    pvp.over = true; pvp = null; clearStoredMatch();
    showModal(`<h2>Connection lost</h2><p>Couldn't reconnect to the match.</p><button onclick="location.reload()">Back to team select</button>`);
    return;
  }
  showModal(`<h2>Reconnecting…</h2><p>Attempt ${pvp.attempts} of ${MAX_RECONNECT_ATTEMPTS}…</p>`);
  const sock = new MatchSocket(serverUrl());
  pvp.sock = sock;
  pvp.intent = { kind: "rejoin", matchId: pvp.matchId, token: pvp.token };
  wireSocket(sock);
}

/** Connect, join the (ranked or casual) queue with `team`, and let server messages drive the match. */
function startQuickMatch(team: string[], ranked = false): void {
  const sock = new MatchSocket(serverUrl());
  pvp = { sock, you: "A", over: false, started: false, reconnecting: false, attempts: 0, intent: { kind: "queue", team, ranked } };
  setup = null;
  wireSocket(sock);
  showSearching(ranked ? "Connecting to Ranked…" : "Connecting…");
}

/** On page load, silently try to rejoin an in-progress match (survives an accidental reload). */
function tryResumeStoredMatch(): boolean {
  let stored: { matchId?: unknown; token?: unknown };
  try { stored = JSON.parse(sessionStorage.getItem(STORED_MATCH_KEY) ?? "null") ?? {}; } catch { clearStoredMatch(); return false; }
  if (typeof stored.matchId !== "string" || typeof stored.token !== "string") return false;
  const matchId = stored.matchId, token = stored.token;
  const sock = new MatchSocket(serverUrl());
  pvp = { sock, you: "A", over: false, started: false, token, matchId, reconnecting: true, attempts: 0, intent: { kind: "rejoin", matchId, token } };
  wireSocket(sock);
  showModal(`<h2>Reconnecting…</h2><p>Rejoining your match…</p>`);
  return true;
}

function cancelQuickMatch(): void {
  const keep = pvp?.intent.kind === "queue" ? pvp.intent.team : []; // keep the team the player had queued with
  pvp?.sock.send({ t: "cancelQueue" });
  pvp?.sock.close();
  pvp = null;
  showSetup(keep);
}

/** Open the between-round draft modal for a side (shared by yourDraft and a reconnect resumed at draft). */
function openPvpDraft(side: TeamId): void {
  ui.phase = "busy"; ui.phaseLabel = "choose your upgrade"; ui.overlay = undefined; ui.energyPanel = undefined;
  ui.draft = { side, inspect: draftableHeroes(state, side)[0]?.id ?? null, picks: new Map(), resolve: () => {} };
  render();
}

/** Enter local planning for a networked turn — mirrors the bot-mode human provider, minus the local promise. */
function enterPvpPlanning(): void {
  ui.phase = "plan";
  ui.phaseLabel = "your move";
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

/** Resume the board at the given control state — shared by yourTurn/opponentTurn/… and a reconnect. */
function applyControl(control: "turn" | "wait" | "draft" | "waitDraft"): void {
  const foe = ui.opponentName ?? "Opponent";
  if (control === "turn") enterPvpPlanning();
  else if (control === "draft") openPvpDraft(pvp!.you);
  else if (control === "waitDraft") pvpBusy(`${foe} is choosing an upgrade…`);
  else pvpBusy(`${foe} is acting…`);
}

function handleServerMsg(msg: ServerMsg): void {
  if (!pvp) return;
  switch (msg.t) {
    case "authed":
      profile = msg.profile; // freshest name + record
      if (pvp.intent.kind === "queue") pvp.sock.send({ t: "queue", team: pvp.intent.team, ranked: pvp.intent.ranked, protocolVersion: PROTOCOL_VERSION });
      else pvp.sock.send({ t: "rejoin", matchId: pvp.intent.matchId, token: pvp.intent.token, protocolVersion: PROTOCOL_VERSION });
      break;
    case "authError":
      pvp.over = true; pvp.sock.close(); pvp = null; clearStoredMatch();
      showModal(`<h2>Sign-in problem</h2><p>${escHtml(msg.message)}</p><button onclick="location.reload()">Back</button>`);
      break;
    case "queued": showSearching(pvp.intent.kind === "queue" && pvp.intent.ranked ? "Searching for a ranked opponent…" : "Searching for an opponent…"); break;
    case "start":
      pvp.started = true; pvp.you = msg.you; ui.you = msg.you; state = msg.state; pvp.opponentName = msg.opponentName; ui.opponentName = msg.opponentName;
      pvp.token = msg.token; pvp.matchId = msg.matchId; storeMatch(msg.matchId, msg.token);
      pvpBusy(`Matched vs ${msg.opponentName} — get ready…`);
      break;
    case "resumed":
      pvp.started = true; pvp.reconnecting = false; pvp.attempts = 0;
      pvp.you = msg.you; ui.you = msg.you; state = msg.state; pvp.opponentName = msg.opponentName; ui.opponentName = msg.opponentName;
      ui.notice = msg.opponentDisconnected ? `${msg.opponentName} disconnected — waiting for them to reconnect…` : undefined;
      applyControl(msg.control);
      break;
    case "opponentTurn": state = msg.state; pvpBusy(`${ui.opponentName ?? "Opponent"} is acting…`); break;
    case "yourTurn": state = msg.state; enterPvpPlanning(); break;
    case "opponentDraft": state = msg.state; pvpBusy(`${ui.opponentName ?? "Opponent"} is choosing an upgrade…`); break;
    case "yourDraft": state = msg.state; openPvpDraft(pvp.you); break; // a player always drafts for its own team
    case "opponentDisconnected": ui.notice = `${ui.opponentName ?? "Opponent"} disconnected — waiting for them to reconnect…`; render(); break;
    case "opponentReconnected": ui.notice = undefined; render(); break;
    case "matchEnd": {
      pvp.over = true; clearStoredMatch(); ui.notice = undefined;
      const won = msg.outcome.winner === msg.you;
      const title = msg.outcome.winner === null ? "Stalemate" : won ? "Victory 🏆" : "Defeat";
      const why = msg.reason === "opponent-left" ? " Your opponent left the match." : msg.reason === "forfeit" ? " (by surrender)" : "";
      const rating = msg.rating
        ? `<p style="font-size:15px">Rating <b>${msg.rating.rating}</b> <span style="color:${msg.rating.delta >= 0 ? "#6c6" : "#e66"}">(${msg.rating.delta >= 0 ? "+" : ""}${msg.rating.delta})</span></p>`
        : "";
      showModal(`<h2>${title}</h2>
        <p>Team ${msg.outcome.winner ?? "—"} wins ${msg.outcome.roundsWon.A}–${msg.outcome.roundsWon.B} over ${msg.outcome.rounds} round${msg.outcome.rounds === 1 ? "" : "s"}.${why}</p>
        ${rating}
        <button onclick="location.reload()">Back to team select</button>`);
      pvp.sock.close();
      break;
    }
    case "rejoinFailed": {
      const wasStarted = pvp.started;
      pvp.over = true; pvp.sock.close(); pvp = null; clearStoredMatch();
      if (wasStarted) showModal(`<h2>Match ended</h2><p>${escHtml(msg.message)}</p><button onclick="location.reload()">Back to team select</button>`);
      else showSetup(); // a stale stored match on page load — just return to team select
      break;
    }
    case "error":
      pvp.over = true; pvp.sock.close(); clearStoredMatch();
      showModal(`<h2>Quick Match</h2><p>${escHtml(msg.message)}</p><button onclick="location.reload()">Back</button>`);
      break;
  }
}

// Start at team select — unless a match from this tab is still in progress (an accidental reload), which we rejoin.
// Rename: committing the profile-bar name input stores it and re-verifies with the server.
app.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  // Only the team-select rename field commits a name; on the login screen the name input is part of the
  // register form and must NOT prematurely create/auth a guest profile.
  if (screen === "setup" && t instanceof HTMLInputElement && t.hasAttribute("data-name-input")) {
    setStoredName(t.value.trim() || "Guest");
    void refreshProfile();
  }
});

void boot(); // start at team-select — or rejoin an in-progress match after a reload
