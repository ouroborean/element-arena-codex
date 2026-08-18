/**
 * Element Arena — terminal client. Play a 3v3 match against the built-in AI.
 *
 *   node game/client/cli.ts                       # default preset, you = Team A
 *   node game/client/cli.ts a,b,c x,y,z [seed]    # custom draft (hero ids)
 *   node game/client/cli.ts --you=B               # control Team B instead
 *   node game/client/cli.ts --demo                # AI vs AI (non-interactive)
 *
 * Runs the engine natively (Node type-strips the TS) — no build step. The between-round
 * augment/fusion draft is not wired yet (each round starts fresh); that's the next increment.
 */
import * as readline from "node:readline/promises";
import { stdin, stdout, argv, env, exit } from "node:process";
import type { MatchState, TeamId, Unit } from "../engine/src/types.ts";
import type { Action } from "../engine/src/scheduler.ts";
import type { SkillInstance } from "../engine/src/skill.ts";
import { legalTargets } from "../engine/src/scheduler.ts";
import { Rng } from "../engine/src/rng.ts";
import { buildMatch, defaultPolicy, heroById } from "../engine/content/match.ts";
import { runMatch, type AsyncProvider } from "./loop.ts";
import * as R from "./render.ts";

const PRESET = { A: ["pyrrha", "jarrik", "gommar"], B: ["keeper", "riverdaughter", "saya"] };

export function parseArgs(args: string[]): { A: string[]; B: string[]; seed: number; you: TeamId; demo: boolean } {
  const flags = args.filter((a) => a.startsWith("--"));
  const pos = args.filter((a) => !a.startsWith("--"));
  const demo = flags.includes("--demo");
  const you = (flags.find((f) => f.startsWith("--you="))?.split("=")[1]?.toUpperCase() as TeamId) || "A";
  const A = pos[0] ? pos[0].split(",") : PRESET.A;
  const B = pos[1] ? pos[1].split(",") : PRESET.B;
  const seed = pos[2] ? Number(pos[2]) : Math.floor(Math.random() * 1e6);
  return { A, B, seed, you: you === "B" ? "B" : "A", demo };
}

export const livingUnits = (state: MatchState, side: TeamId): Unit[] =>
  state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u && u.alive);

/** The legal single-target pool for a skill (Harmful→enemies, Helpful→allies, else either), run through
 *  the engine's targeting rules (taunt/blind/invulnerable/isolated). A throwaway rng keeps state pure. */
export function targetPool(state: MatchState, u: Unit, skill: SkillInstance): Unit[] {
  const enemyTeam: TeamId = u.team === "A" ? "B" : "A";
  const harmful = skill.tags.includes("Harmful");
  const helpful = skill.tags.includes("Helpful");
  const pool = harmful ? livingUnits(state, enemyTeam)
    : helpful ? livingUnits(state, u.team)
    : [...livingUnits(state, u.team), ...livingUnits(state, enemyTeam)];
  return legalTargets(state, u, skill, pool, Rng.fromState(state.rngState));
}

async function main(): Promise<void> {
  const { A, B, seed, you, demo } = parseArgs(argv.slice(2));
  R.setColor(!!stdout.isTTY && !env.NO_COLOR);

  // Validate the draft up front (a typo is a hard, friendly error).
  try { [...A, ...B].forEach((id) => heroById(id)); }
  catch (e) { stdout.write(`\n${(e as Error).message}\n`); exit(1); }

  const state = buildMatch({ A, B, seed });
  stdout.write(R.heading(`Element Arena — ${A.join("/")}  vs  ${B.join("/")}   ${R.dim(`(seed ${seed})`)}`));
  stdout.write(`\n ${R.dim(demo ? "AI vs AI demo." : `You control Team ${you}. Pick a skill number per unit; 0 to skip.`)}\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q: string) => rl.question(q);

  const human: AsyncProvider = async (st, side) => {
    stdout.write(R.heading(`Round ${st.round} · Team ${side} — your move`));
    stdout.write("\n" + R.renderBoard(st, you) + "\n\n" + R.renderLog(st) + "\n");
    const actions: Action[] = [];
    for (const u of livingUnits(st, side)) {
      const menu = R.renderSkillMenu(st, u);
      if (!menu.usable.length) { stdout.write(R.dim(`\n  ${u.name}: no usable skill — skipping.\n`)); continue; }
      stdout.write(`\n ${R.bold(u.name)} ${R.dim(`[${u.id.toUpperCase()}]`)} — choose:\n${menu.text}\n`);
      const skill = (u.skills ?? [])[Number(await ask("  skill > ")) - 1];
      if (!skill || !menu.usable.includes(skill.id)) { stdout.write(R.dim("  (skipped)\n")); continue; }
      let targets: string[] | undefined;
      if (skill.targeting === "single") {
        const pool = targetPool(st, u, skill);
        if (!pool.length) { stdout.write(R.dim("  (no legal target — skipped)\n")); continue; }
        if (pool.length === 1) { targets = [pool[0]!.id]; stdout.write(R.dim(`  → ${pool[0]!.name}\n`)); }
        else {
          stdout.write(pool.map((t, i) => `   ${i + 1}) ${t.name} [${t.id.toUpperCase()}] ${t.hp}/${t.maxHp}`).join("\n") + "\n");
          const t = pool[Number(await ask("  target > ")) - 1] ?? pool[0]!;
          targets = [t.id];
        }
      }
      actions.push({ unit: u.id, skillId: skill.id, targets });
    }
    return actions;
  };

  const provide: AsyncProvider = demo
    ? (st, side) => defaultPolicy(st, side)
    : (st, side) => (side === you ? human(st, side) : defaultPolicy(st, side));

  const outcome = await runMatch(state, provide, {
    roundsToWin: 2,
    hooks: {
      onTurnStart: (st, side) => { if (side !== you || demo) stdout.write(R.dim(`\n— Team ${side} (AI) acts —\n`)); },
      onResults: (st, side, _res, newLog) => {
        if ((side !== you || demo) && newLog.length) stdout.write(newLog.map((l) => R.dim("  · " + l)).join("\n") + "\n");
      },
      onRoundEnd: (st, w) => stdout.write(R.heading(`Round ${st.round} won by Team ${w}   ${R.dim(`(${st.teams.A.roundsWon}–${st.teams.B.roundsWon})`)}`) + "\n"),
    },
    onBetweenRounds: () => { stdout.write(R.dim("\n  (augment/fusion draft not yet implemented — next round is a fresh battle)\n")); },
  });

  rl.close();
  const verdict = outcome.winner === null ? "a stalemate (turn cap)" : outcome.winner === you && !demo ? R.bold("you win! 🏆") : `Team ${outcome.winner} wins`;
  stdout.write(R.heading(`Match over — ${verdict}`) + `\n ${R.dim(`best-of, final ${outcome.roundsWon.A}–${outcome.roundsWon.B} over ${outcome.rounds} rounds`)}\n\n`);
}

if (import.meta.main) main().catch((e) => { stdout.write(`\nerror: ${(e as Error).stack ?? e}\n`); exit(1); });
