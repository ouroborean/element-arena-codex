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
import { buildMatch, defaultPolicy } from "../../engine/content/match.ts";
import { runMatch, type AsyncProvider } from "../../client/loop.ts";
import { autoDraft, applyDraftChoice } from "../../client/draft.ts";
import { renderApp } from "./view.ts";

export interface UiState {
  you: TeamId;
  phase: "plan" | "busy" | "over";
  phaseLabel: string;
  hint: string;
  selectedUnit?: string;
  targeting?: { skillId: string; skillName: string };
  legalTargets: Set<string>;
  planned: Map<string, Action>;
  plannedLabel: Map<string, string>;
  overlay?: string;
  resolveTurn?: (actions: Action[]) => void;
}

const PRESET = { A: ["pyrrha", "jarrik", "gommar"], B: ["keeper", "riverdaughter", "saya"] };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const living = (s: MatchState, side: TeamId): Unit[] =>
  s.teams[side].units.map((id) => s.units[id]).filter((u): u is Unit => !!u && u.alive);

const app = document.getElementById("app")!;
let state: MatchState;
const ui: UiState = {
  you: "A", phase: "busy", phaseLabel: "starting…", hint: "",
  legalTargets: new Set(), planned: new Map(), plannedLabel: new Map(),
};

function render(): void { app.innerHTML = renderApp(state, ui); }

function targetsFor(u: Unit, skillId: string): Set<string> {
  const skill = (u.skills ?? []).find((s) => s.id === skillId)!;
  const enemy: TeamId = u.team === "A" ? "B" : "A";
  const pool = skill.tags.includes("Harmful") ? living(state, enemy)
    : skill.tags.includes("Helpful") ? living(state, u.team)
    : [...living(state, u.team), ...living(state, enemy)];
  return new Set(legalTargets(state, u, skill, pool, Rng.fromState(state.rngState)).map((x) => x.id));
}

function queue(unitId: string, skillId: string, targets: string[] | undefined, label: string): void {
  ui.planned.set(unitId, { unit: unitId, skillId, targets });
  ui.plannedLabel.set(unitId, label);
  ui.selectedUnit = undefined;
  ui.targeting = undefined;
  ui.legalTargets = new Set();
  render();
}

// ── interaction (event delegation) ───────────────────────────────────────────────────────────────── //
app.addEventListener("click", (e) => {
  if (ui.phase !== "plan") return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-unit],[data-skill],[data-target],[data-cancel],[data-resolve]");
  if (!el) return;
  const d = el.dataset;
  if (d.unit) { ui.selectedUnit = d.unit; ui.targeting = undefined; render(); }
  else if (d.cancel) { ui.targeting = undefined; ui.legalTargets = new Set(); render(); }
  else if (d.resolve) commitTurn();
  else if (d.skill && ui.selectedUnit) {
    const u = state.units[ui.selectedUnit]!;
    const skill = (u.skills ?? []).find((s) => s.id === d.skill)!;
    if (skill.targeting === "single") {
      ui.targeting = { skillId: skill.id, skillName: skill.name };
      ui.legalTargets = targetsFor(u, skill.id);
      if (ui.legalTargets.size === 0) { queue(u.id, skill.id, [], skill.name); return; } // taunt/blind-forced or no target
      render();
    } else queue(u.id, skill.id, undefined, skill.name);
  } else if (d.target && ui.selectedUnit && ui.targeting) {
    const tgt = state.units[d.target]!;
    queue(ui.selectedUnit, ui.targeting.skillId, [d.target], `${ui.targeting.skillName} → ${tgt.name}`);
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
  ui.hint = "Click a hero, pick a skill, then a target. Leave a hero unpicked to hold it.";
  ui.planned.clear(); ui.plannedLabel.clear();
  ui.selectedUnit = undefined; ui.targeting = undefined; ui.legalTargets = new Set();
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

async function main(): Promise<void> {
  state = buildMatch({ A: PRESET.A, B: PRESET.B, seed: Math.floor(Math.random() * 1e6) });
  render();
  const outcome = await runMatch(state, (st, side) => (side === ui.you ? human(st, side) : ai(st, side)), {
    roundsToWin: 2,
    hooks: {
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
    <button onclick="location.reload()">Play again</button>
  </div></div>`;
  ui.phaseLabel = "match over";
  render();
}

main().catch((e) => { app.innerHTML = `<pre style="color:#f88;padding:1rem">${(e as Error).stack ?? e}</pre>`; });
