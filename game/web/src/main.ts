/**
 * Element Arena — browser client entry. Builds a match and drives the engine's async loop, resolving the
 * human team's turn from board clicks (a Promise that settles when "Resolve turn" is pressed) and the AI
 * team from `defaultPolicy`. Between rounds each team auto-drafts an upgrade for now — an interactive draft
 * UI is the next increment. All rendering goes through view.ts; interaction is event-delegated on data-*.
 */
import type { MatchState, TeamId, Unit } from "../../engine/src/types.ts";
import type { Action } from "../../engine/src/scheduler.ts";
import { legalTargets } from "../../engine/src/scheduler.ts";
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
  targeting?: { unitId: string; skillId: string; skillName: string };
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

function render(): void { app.innerHTML = renderApp(state, ui); }
function showSetup(): void { setup = { picked: [], oppo: randomTeam([]), inspect: null }; app.innerHTML = renderSetup(setup); }

function targetsFor(u: Unit, skillId: string): Set<string> {
  const skill = (u.skills ?? []).find((s) => s.id === skillId)!;
  const enemy: TeamId = u.team === "A" ? "B" : "A";
  const pool = skill.tags.includes("Harmful") ? living(state, enemy)
    : skill.tags.includes("Helpful") ? living(state, u.team)
    : [...living(state, u.team), ...living(state, enemy)];
  return new Set(legalTargets(state, u, skill, pool, Rng.fromState(state.rngState)).map((x) => x.id));
}

function queue(unitId: string, skillId: string, targets: string[] | undefined): void {
  ui.planned.set(unitId, { unit: unitId, skillId, targets });
  ui.plannedSkill.set(unitId, skillId);
  ui.targeting = undefined;
  ui.legalTargets = new Set();
  render();
}

// ── interaction (event delegation) ───────────────────────────────────────────────────────────────── //
app.addEventListener("click", (e) => {
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
  if (d.cancel) { ui.targeting = undefined; ui.legalTargets = new Set(); render(); return; }
  if (d.resolve) { commitTurn(); return; }
  if (d.owner && d.skill) { // choose a skill on one of your heroes
    const u = state.units[d.owner]!;
    const skill = (u.skills ?? []).find((s) => s.id === d.skill)!;
    if (skill.targeting === "single") {
      ui.targeting = { unitId: u.id, skillId: skill.id, skillName: skill.name };
      ui.legalTargets = targetsFor(u, skill.id);
      if (ui.legalTargets.size === 0) { queue(u.id, skill.id, []); return; } // taunt/blind-forced or no legal target
      render();
    } else queue(u.id, skill.id, undefined);
  } else if (d.target && ui.targeting) {
    queue(ui.targeting.unitId, ui.targeting.skillId, [d.target]);
  }
});

function commitTurn(): void {
  const actions = [...ui.planned.values()];
  const resolve = ui.resolveTurn;
  ui.resolveTurn = undefined;
  ui.phase = "busy";
  ui.phaseLabel = "resolving…";
  render();
  resolve?.(actions);
}

// ── the match loop ───────────────────────────────────────────────────────────────────────────────── //
const human: AsyncProvider = (st, side) => new Promise<Action[]>((resolve) => {
  ui.phase = "plan";
  ui.phaseLabel = "your move";
  ui.hint = "Pick a skill on each hero, then a target. Skip a hero to hold it.";
  ui.planned.clear(); ui.plannedSkill.clear();
  ui.targeting = undefined; ui.legalTargets = new Set();
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
