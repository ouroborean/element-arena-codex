import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatch, defaultPolicy, playMatch } from "../engine/content/match.ts";
import { applyStatus } from "../engine/src/status.ts";
import { runMatch } from "./loop.ts";
import { parseArgs, targetPool } from "./cli.ts";
import * as R from "./render.ts";

R.setColor(false); // stable, ANSI-free assertions

const DRAFT = { A: ["pyrrha", "jarrik", "gommar"], B: ["keeper", "riverdaughter", "saya"], seed: 7 };

test("parseArgs: defaults, custom draft, and flags", () => {
  const d = parseArgs([]);
  assert.deepEqual(d.A, ["pyrrha", "jarrik", "gommar"]);
  assert.equal(d.you, "A");
  assert.equal(d.demo, false);
  const c = parseArgs(["a,b,c", "x,y,z", "42", "--you=B", "--demo"]);
  assert.deepEqual(c.A, ["a", "b", "c"]);
  assert.deepEqual(c.B, ["x", "y", "z"]);
  assert.equal(c.seed, 42);
  assert.equal(c.you, "B");
  assert.equal(c.demo, true);
});

test("hpBar / renderEnergy / renderStatuses format as expected", () => {
  assert.match(R.hpBar(60, 100), /60\/100$/);
  assert.equal(R.renderEnergy({ generic: 2, fire: 1, water: 0 }), "2 generic, 1 fire");
  assert.equal(R.renderEnergy({}), "(none)");
});

test("renderBoard shows both teams, HP, the slot tags, and the human marker", () => {
  const board = R.renderBoard(buildMatch({ ...DRAFT }), "A");
  assert.match(board, /Team A \(you\)/);
  assert.match(board, /Team B \(AI\)/);
  assert.match(board, /100\/100/);
  assert.match(board, /\[A1\]/);
});

test("renderStatuses summarises marks/stacks/states, skips internal-only kinds", () => {
  const st = buildMatch({ A: ["gommar"], B: ["keeper"], seed: 1 });
  const u = st.units["a1"]!;
  applyStatus(u, { kind: "mark", name: "Frost-Covered", duration: null, appliedBy: "a1", appliedTurn: 0 });
  applyStatus(u, { kind: "stack", name: "Charge", magnitude: 3, duration: null, appliedBy: "a1", appliedTurn: 0 });
  applyStatus(u, { kind: "stun", duration: 1, appliedBy: "a1", appliedTurn: 0 });
  applyStatus(u, { kind: "cost_mod", magnitude: -1, duration: null, appliedBy: "a1", appliedTurn: 0 }); // internal — skipped
  const s = R.renderStatuses(u);
  assert.match(s, /Frost-Covered/);
  assert.match(s, /Charge×3/);
  assert.match(s, /stun/);
  assert.doesNotMatch(s, /cost_mod/);
});

test("targetPool: a Harmful single-target skill can only target living enemies", () => {
  const st = buildMatch({ A: ["pyrrha"], B: ["keeper", "saya"], seed: 1 });
  const pyrrha = st.units["a1"]!;
  const harmful = (pyrrha.skills ?? []).find((s) => s.targeting === "single" && s.tags.includes("Harmful"))!;
  const pool = targetPool(st, pyrrha, harmful);
  assert.ok(pool.length >= 1, "at least one enemy is targetable");
  assert.ok(pool.every((u) => u.team === "B"), "only enemies are in the pool");
});

test("runMatch (the interactive loop) mirrors playMatch for the same draft + seed", async () => {
  const p = playMatch(buildMatch({ ...DRAFT }), defaultPolicy, { roundsToWin: 2, maxTurns: 200 });
  const r = await runMatch(buildMatch({ ...DRAFT }), (s, side) => defaultPolicy(s, side), { roundsToWin: 2, maxTurns: 200 });
  assert.equal(r.winner, p.winner, "same winner");
  assert.deepEqual(r.roundsWon, p.roundsWon, "same round tally");
  assert.ok(r.winner === "A" || r.winner === "B");
});

test("runMatch fires its hooks (round start/end + per-turn results)", async () => {
  const seen = { rounds: 0, turns: 0, ended: 0 };
  await runMatch(buildMatch({ ...DRAFT }), (s, side) => defaultPolicy(s, side), {
    roundsToWin: 2, maxTurns: 200,
    hooks: {
      onRoundStart: () => { seen.rounds++; },
      onResults: () => { seen.turns++; },
      onRoundEnd: () => { seen.ended++; },
    },
  });
  assert.ok(seen.rounds >= 2, "at least two rounds started");
  assert.ok(seen.turns > 0, "turns resolved");
  assert.ok(seen.ended >= 2, "at least two rounds ended");
});
