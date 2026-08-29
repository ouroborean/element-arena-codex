import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatch, defaultPolicy, heroById, playMatch } from "../content/match.ts";
import { startRound } from "../src/scheduler.ts";
import type { TeamId } from "../src/types.ts";

// The match-setup layer end to end: a draft assembles into a live MatchState, and the driver
// plays it to a best-of-N decision — deterministically (the whole match is one seed).

test("buildMatch assembles a 3v3 into a pre-round state with slots and empty pools", () => {
  const state = buildMatch({ A: ["pyrrha", "gaia", "saya"], B: ["gommar", "keeper", "blackknight"], seed: 7 });
  assert.equal(Object.keys(state.units).length, 6, "six heroes");
  assert.deepEqual(state.teams.A.units, ["a1", "a2", "a3"]);
  assert.deepEqual(state.teams.B.units, ["b1", "b2", "b3"]);
  assert.deepEqual([state.units.a1!.slot, state.units.a2!.slot, state.units.a3!.slot], [0, 1, 2], "slots assigned in order");
  assert.equal(state.units.a1!.name, heroById("pyrrha").name, "loaded from the roster");
  assert.equal(state.round, 0, "no round started yet");
  assert.deepEqual(state.teams.A.energy, {}, "pools start empty (income comes at turn start)");
  assert.equal(state.rngState, 7);
});

test("startRound fires a hero's round-start summon passive (Syl's Eagle)", () => {
  const state = buildMatch({ A: ["syl", "pyrrha", "gaia"], B: ["gommar", "keeper", "blackknight"] });
  startRound(state);
  const minions = Object.values(state.units).filter((u) => u.kind === "minion");
  assert.ok(minions.some((m) => m.summoner === "a1"), "Syl summoned her Eagle at round start");
});

test("heroById rejects an unknown draft pick", () => {
  assert.throws(() => heroById("not-a-hero"), /no such hero/);
});

// The bot must not inject Hector's Serums (Strategic, neither Harmful nor Helpful) into an enemy — a
// non-Harmful single-target skill only wastes the turn or helps the foe. defaultPolicy routes every
// non-Harmful single-target pick to a friendly unit.
test("defaultPolicy: the Hector bot injects its Serum into an ally, never an enemy", () => {
  const state = buildMatch({ A: ["hector", "pyrrha", "gaia"], B: ["gommar", "keeper", "blackknight"], seed: 3 });
  startRound(state); // Hector's round-start passive summons Dennis
  state.teams.A.energy = { generic: 40, poison: 40 }; // fund so a Serum is usable
  const actions = defaultPolicy(state, "A");
  const hectorAction = actions.find((a) => a.unit === "a1"); // Hector is the first A pick
  assert.ok(hectorAction, "Hector takes an action");
  const target = hectorAction!.targets?.[0];
  assert.ok(target, "Hector's chosen Serum is single-target");
  assert.equal(state.units[target!]!.team, "A", "the Serum is injected into a friendly unit, not an enemy");
});

test("playMatch drives a drafted 3v3 to a best-of-N winner, fully deterministically", () => {
  const run = () => {
    const state = buildMatch({ A: ["blackknight", "gommar", "saya"], B: ["pyrrha", "gaia", "keeper"], seed: 42 });
    const outcome = playMatch(state, defaultPolicy, { roundsToWin: 2, maxTurns: 400 });
    return { outcome, log: state.log.length, rngState: state.rngState };
  };
  const a = run();
  const b = run();

  assert.deepEqual(a, b, "same seed → identical match");
  if (a.outcome.winner !== null) {
    const w = a.outcome.winner as TeamId;
    assert.equal(a.outcome.roundsWon[w], 2, "the winner reached the round target");
    assert.ok(a.outcome.roundsWon[w === "A" ? "B" : "A"] < 2, "the loser did not");
  } else {
    // A stalemate is a legitimate (if rare) outcome — assert it is at least reported cleanly.
    assert.ok(a.outcome.rounds >= 1, "a stalemate still advanced through rounds");
  }
});

test("a match is decisive under the default policy (no stalemate) for a standard aggressive draft", () => {
  const state = buildMatch({ A: ["blackknight", "gommar", "roland"], B: ["pyrrha", "jarrik", "sera"], seed: 3 });
  const outcome = playMatch(state, defaultPolicy, { roundsToWin: 2, maxTurns: 600 });
  assert.notEqual(outcome.winner, null, "the match produced a winner");
  assert.equal(outcome.roundsWon[outcome.winner as TeamId], 2);
});

test("cross-roster drafts (summoners, counterers, positional) run deterministically without crashing", () => {
  // Deliberately mixes the mechanically-heavy heroes: summoners (syl/hector/trinity), a
  // counter/reflect + clone kit (xyris), positional (aramao), shielders (keeper), essence
  // (saya/blackknight). Each plays twice on one seed and must match exactly.
  const drafts: { A: string[]; B: string[]; seed: number }[] = [
    { A: ["trinity", "syl", "hector"], B: ["xyris", "aramao", "keeper"], seed: 11 },
    { A: ["saya", "blackknight", "zephyrex"], B: ["fate", "maggie", "galazax"], seed: 22 },
    { A: ["gaia", "taryn", "ando"], B: ["laria", "titania", "scratch"], seed: 33 },
    { A: ["dennis", "riverdaughter", "ayana"], B: ["zevkir", "sera", "roland"], seed: 44 },
  ];
  const key = (o: ReturnType<typeof playMatch>, logLen: number, rng: number) =>
    JSON.stringify({ w: o.winner, r: o.rounds, rw: o.roundsWon, logLen, rng });

  for (const d of drafts) {
    const s1 = buildMatch(d); const o1 = playMatch(s1, defaultPolicy, { roundsToWin: 2, maxTurns: 500 });
    const s2 = buildMatch(d); const o2 = playMatch(s2, defaultPolicy, { roundsToWin: 2, maxTurns: 500 });
    assert.equal(key(o1, s1.log.length, s1.rngState), key(o2, s2.log.length, s2.rngState), `deterministic: ${d.A} vs ${d.B}`);
  }
});
