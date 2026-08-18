import type { MatchState, Status, StatusKind, Unit } from "../src/types.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { Effect } from "../src/effects/ast.ts";

export function skill(id: string, effects: Effect[], over: Partial<SkillInstance> = {}): SkillInstance {
  return {
    id,
    name: id,
    element: "fire",
    targeting: "single",
    effects,
    cost: { generic: 0, specific: 0 },
    cooldown: 0,
    currentCd: 0,
    klass: "basic",
    tags: [],
    ...over,
  };
}

export function makeUnit(over: Partial<Unit> & { shield?: number } = {}): Unit {
  const { shield, ...rest } = over;
  return {
    id: "u1",
    kind: "hero",
    name: "Test Hero",
    team: "A",
    hp: 100,
    maxHp: 100,
    shields: shield ? [{ amount: shield, duration: null, appliedBy: "x", appliedTurn: 0 }] : [],
    baseElement: "fire",
    currentElement: "fire",
    statuses: [],
    alive: true,
    ...rest,
  };
}

export function status(kind: StatusKind, over: Partial<Status> = {}): Status {
  return { kind, duration: null, appliedBy: "src", appliedTurn: 0, ...over };
}

export function makeState(aUnits: Unit[], bUnits: Unit[], seed = 1): MatchState {
  const units: Record<string, Unit> = {};
  // Assign formation slots (0..) to heroes in listed order, unless already set.
  for (const side of [aUnits, bUnits]) {
    let slot = 0;
    for (const u of side) if (u.kind === "hero" && u.slot === undefined) u.slot = slot++;
  }
  for (const u of [...aUnits, ...bUnits]) units[u.id] = u;
  return {
    round: 1,
    turn: 1,
    activeTeam: "A",
    units,
    teams: {
      A: { id: "A", units: aUnits.map((u) => u.id), energy: {}, roundsWon: 0 },
      B: { id: "B", units: bUnits.map((u) => u.id), energy: {}, roundsWon: 0 },
    },
    rngState: seed,
    seed,
    minionSeq: 0,
    scheduled: [],
    actedThisTurn: [],
    log: [],
  };
}
