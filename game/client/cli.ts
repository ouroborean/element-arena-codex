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
import * as readline from "node:readline";
import { stdin, stdout, argv, env, exit } from "node:process";
import type { MatchState, TeamId, Unit } from "../engine/src/types.ts";
import type { Action } from "../engine/src/scheduler.ts";
import type { SkillInstance } from "../engine/src/skill.ts";
import { legalTargets } from "../engine/src/scheduler.ts";
import { Rng } from "../engine/src/rng.ts";
import { buildMatch, defaultPolicy, heroById } from "../engine/content/match.ts";
import { runMatch, type AsyncProvider } from "./loop.ts";
import { availableFusions, availableAugments } from "../engine/content/metagame.ts";
import { draftableHeroes, hasDraftOptions, applyDraftChoice, autoDraft, type DraftChoice } from "./draft.ts";
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
  // Fusion targeting expansions (the engine has no faction filter; these only widen the offered pool):
  //  - Merciless (black knight "evil"): Oathbreaker Strike may target allied Heroes.
  //  - Mountain Rescue Team (syl "winter"): the Eagle's Swoop may target a stunned ally (for invuln).
  const merciless = skill.id === "blackknight1" && u.fused === "evil";
  const swoopRescue = skill.id === "sylminion2" && state.units[u.summoner ?? ""]?.fused === "winter";
  const pool = merciless
    ? [...livingUnits(state, enemyTeam), ...livingUnits(state, u.team).filter((x) => x.kind === "hero" && x.id !== u.id)]
    : swoopRescue
    ? [...livingUnits(state, enemyTeam), ...livingUnits(state, u.team).filter((x) => x.id !== u.id && x.statuses.some((s) => s.kind === "stun"))]
    : harmful ? livingUnits(state, enemyTeam)
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

  // A robust line reader: readline/promises' rl.question hangs after the first question on piped
  // (non-TTY) input, so we queue "line" events ourselves. Works for a real TTY and for piped input/tests.
  const rl = readline.createInterface({ input: stdin });
  const lineQ: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  let stdinClosed = false;
  rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else lineQ.push(l); });
  rl.on("close", () => { stdinClosed = true; while (waiters.length) waiters.shift()!(""); });
  const ask = (q: string): Promise<string> => {
    stdout.write(q);
    if (lineQ.length) return Promise.resolve(lineQ.shift()!);
    return stdinClosed ? Promise.resolve("") : new Promise((res) => waiters.push(res));
  };

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

  // Interactive between-round draft: fuse a hero, augment a hero, or hold.
  const humanDraft = async (st: MatchState, side: TeamId): Promise<DraftChoice> => {
    stdout.write(R.heading(`Between rounds — Team ${side}, choose an upgrade`) + "\n");
    for (const u of draftableHeroes(st, side)) {
      const nf = availableFusions(st, u).length;
      const na = availableAugments(u).length;
      const fused = u.fused ? R.dim(` · fused:${u.fused}`) : "";
      stdout.write(`  ${R.bold(`[${u.id.toUpperCase()}]`)} ${u.name}${fused}  ${R.dim(`— ${nf} fusion(s), ${na} augment(s)`)}\n`);
    }
    const mode = (await ask("\n  (f)use, (a)ugment, or (s)kip? > ")).trim().toLowerCase();
    if (mode === "f" || mode === "fuse") {
      const pool = draftableHeroes(st, side).filter((u) => availableFusions(st, u).length);
      if (!pool.length) { stdout.write(R.dim("  no hero can fuse — held.\n")); return { kind: "skip" }; }
      stdout.write(pool.map((u, i) => `   ${i + 1}) ${u.name} [${u.id.toUpperCase()}]`).join("\n") + "\n");
      const u = pool[Number(await ask("  hero > ")) - 1] ?? pool[0]!;
      const forms = availableFusions(st, u);
      stdout.write(forms.map((f, i) => `   ${i + 1}) ${R.bold(f.key)} ${R.dim(`(${f.element})`)} — ${f.passive.name}: ${R.dim((f.passive.description ?? "").slice(0, 84))}`).join("\n") + "\n");
      const f = forms[Number(await ask("  form > ")) - 1] ?? forms[0]!;
      return { kind: "fuse", unitId: u.id, formKey: f.key };
    }
    if (mode === "a" || mode === "augment") {
      const pool = draftableHeroes(st, side).filter((u) => availableAugments(u).length);
      if (!pool.length) { stdout.write(R.dim("  no augments available — held.\n")); return { kind: "skip" }; }
      stdout.write(pool.map((u, i) => `   ${i + 1}) ${u.name} [${u.id.toUpperCase()}]`).join("\n") + "\n");
      const u = pool[Number(await ask("  hero > ")) - 1] ?? pool[0]!;
      const augs = availableAugments(u);
      stdout.write(augs.map((a, i) => `   ${i + 1}) ${R.bold(a.name)}: ${R.dim((a.description ?? "").slice(0, 92))}`).join("\n") + "\n");
      const a = augs[Number(await ask("  augment > ")) - 1] ?? augs[0]!;
      return { kind: "augment", unitId: u.id, augmentId: a.id };
    }
    return { kind: "skip" };
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
    onBetweenRounds: async (st, roundWinner) => {
      const loser: TeamId = roundWinner === "A" ? "B" : "A";
      stdout.write(R.heading(`Round ${st.round} decided — AUGMENT / FUSE draft`) + "\n");
      for (const side of [loser, roundWinner]) { // the round's loser drafts first
        if (!hasDraftOptions(st, side)) { stdout.write(R.dim(`  Team ${side}: no upgrades available.\n`)); continue; }
        const choice = side === you && !demo ? await humanDraft(st, side) : autoDraft(st, side);
        const res = applyDraftChoice(st, choice);
        const who = side === you && !demo ? R.green(`Team ${side}`) : R.dim(`Team ${side} (AI)`);
        stdout.write(`  ${who}: ${res.ok ? res.desc : R.dim("(" + res.desc + ")")}\n`);
      }
    },
  });

  rl.close();
  const verdict = outcome.winner === null ? "a stalemate (turn cap)" : outcome.winner === you && !demo ? R.bold("you win! 🏆") : `Team ${outcome.winner} wins`;
  stdout.write(R.heading(`Match over — ${verdict}`) + `\n ${R.dim(`best-of, final ${outcome.roundsWon.A}–${outcome.roundsWon.B} over ${outcome.rounds} rounds`)}\n\n`);
}

if (import.meta.main) main().catch((e) => { stdout.write(`\nerror: ${(e as Error).stack ?? e}\n`); exit(1); });
