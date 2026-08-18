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
import { autoDraft, applyDraftChoice } from "../../client/draft.ts";
import { renderApp, renderSetup } from "./view.ts";

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
let setup: { picked: string[]; oppo: string[]; inspect: string | null } | null = null;
const ui: UiState = {
  you: "A", phase: "busy", phaseLabel: "starting…", hint: "",
  legalTargets: new Set(), planned: new Map(), plannedSkill: new Map(),
};

// A floating popup describing an effect icon, shown on hover/tap.
const fxpop = document.createElement("div");
fxpop.className = "fxpop"; fxpop.hidden = true;
document.body.appendChild(fxpop);
function showFx(el: HTMLElement): void {
  fxpop.textContent = "";
  const b = document.createElement("b"); b.textContent = el.dataset.fxtitle ?? "";
  const body = document.createElement("div"); body.textContent = el.dataset.fxbody ?? "";
  fxpop.append(b, body);
  fxpop.hidden = false;
  const r = el.getBoundingClientRect(), pw = fxpop.offsetWidth;
  fxpop.style.left = `${Math.max(6, Math.min(window.innerWidth - pw - 6, r.left + r.width / 2 - pw / 2))}px`;
  fxpop.style.top = `${r.bottom + 6}px`;
}
function hideFx(): void { fxpop.hidden = true; }

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

// ── interaction (event delegation) ───────────────────────────────────────────────────────────────── //
app.addEventListener("click", (e) => {
  const fxEl = (e.target as HTMLElement).closest<HTMLElement>(".fx");
  if (fxEl) { if (fxpop.hidden) showFx(fxEl); else hideFx(); return; } // tap an effect icon to toggle its description
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-owner],[data-skill],[data-target],[data-cancel],[data-resolve],[data-surrender],[data-pick],[data-inspect],[data-reroll],[data-start]");
  if (!el) return;
  const d = el.dataset;

  if (setup) { // team-select screen
    if (d.inspect) { setup.inspect = d.inspect; app.innerHTML = renderSetup(setup); }
    else if (d.pick) { // add / remove (detail button or a tray slot)
      const i = setup.picked.indexOf(d.pick);
      if (i >= 0) setup.picked.splice(i, 1);
      else if (setup.picked.length < 3) setup.picked.push(d.pick);
      app.innerHTML = renderSetup(setup);
    } else if (d.reroll) {
      setup.oppo = randomTeam(setup.picked);
      app.innerHTML = renderSetup(setup);
    } else if (d.start && setup.picked.length === 3) {
      const draft: Draft = { A: [...setup.picked], B: [...setup.oppo], seed: Math.floor(Math.random() * 1e6) };
      setup = null;
      startMatch(draft).catch((err) => { app.innerHTML = `<pre style="color:#f88;padding:1rem">${(err as Error).stack ?? err}</pre>`; });
    }
    return;
  }

  if (d.surrender) { if (confirm("Surrender this match?")) location.reload(); return; }
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

// desktop hover: show an effect's description popup
app.addEventListener("mouseover", (e) => { const fx = (e.target as HTMLElement).closest<HTMLElement>(".fx"); if (fx) showFx(fx); });
app.addEventListener("mouseout", (e) => { if ((e.target as HTMLElement).closest(".fx")) hideFx(); });

function commitTurn(): void {
  const actions = [...ui.planned.values()];
  const resolve = ui.resolveTurn;
  ui.resolveTurn = undefined;
  ui.phase = "busy";
  ui.phaseLabel = "resolving…";
  ui.targeting = undefined; ui.examine = undefined; ui.legalTargets = new Set();
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
        const choice = autoDraft(st, side);
        const res = applyDraftChoice(st, choice);
        if (choice.kind !== "skip") st.log.push(`draft — Team ${side}: ${res.desc}`);
      }
      render();
      await delay(1400);
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

showSetup(); // start at the team-select screen; "New team" reloads back here
