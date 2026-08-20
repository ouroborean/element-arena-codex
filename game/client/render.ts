/**
 * Terminal rendering for the CLI client — pure string builders (no I/O), so they are unit-testable
 * and reusable by any front-end. Nothing here mutates the match; it only reads a MatchState.
 */
import type { MatchState, TeamId, Unit, Status, EnergyPool } from "../engine/src/types.ts";
import type { SkillInstance } from "../engine/src/skill.ts";
import { totalShield } from "../engine/src/damage.ts";
import { canUse, effectiveCost } from "../engine/src/scheduler.ts";

// ── ANSI colour (auto-off when not a TTY or NO_COLOR is set) ──────────────────────────────────── //
let COLOR = false;
export function setColor(on: boolean): void { COLOR = on; }
const c = (code: string, s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);
export const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const cyan = (s: string) => c("36", s);

const RULE = "─".repeat(62);
export function rule(): string { return dim(RULE); }

/** A compact HP meter, e.g. "██████░░░░ 60/100". */
export function hpBar(hp: number, max: number, width = 10): string {
  const filled = max > 0 ? Math.round((Math.max(0, hp) / max) * width) : 0;
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  const frac = hp / max;
  const tint = frac > 0.5 ? green : frac > 0.25 ? yellow : red;
  return `${tint(bar)} ${hp}/${max}`;
}

/** "2 generic, 1 fire" — a team's energy pool, zero entries omitted. */
export function renderEnergy(pool: EnergyPool): string {
  const parts = Object.keys(pool)
    .filter((k) => (pool[k] ?? 0) > 0)
    .sort((a, b) => (a === "generic" ? -1 : b === "generic" ? 1 : a.localeCompare(b)))
    .map((k) => `${pool[k]} ${k}`);
  return parts.length ? parts.join(", ") : dim("(none)");
}

const STATE_KINDS = new Set<Status["kind"]>([
  "stun", "blind", "invulnerable", "isolated", "untargetable", "taunt", "silence",
  "paralysis", "stealth", "channeling", "immortal", "damage_ignore", "shatter",
]);

/** Compact status summary for a unit: marks/stacks/dots by name, notable states by kind. */
export function renderStatuses(u: Unit): string {
  const bits: string[] = [];
  const seen = new Set<string>();
  for (const s of u.statuses) {
    let label: string | null = null;
    if (s.kind === "stack") label = `${s.name}×${s.magnitude ?? 0}`;
    else if (s.kind === "mark" || s.kind === "dot" || s.kind === "regen") label = s.name ?? s.kind;
    else if (STATE_KINDS.has(s.kind)) label = s.kind;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    bits.push(label);
  }
  return bits.length ? dim(`{${bits.join(", ")}}`) : "";
}

/** One board line for a unit: slot tag, name, HP bar, shield, element, statuses. */
export function renderUnit(u: Unit): string {
  const tag = u.kind === "minion" ? dim(`(${u.name})`) : bold(`[${u.id.toUpperCase()}]`);
  if (!u.alive) return `  ${tag} ${dim(`${u.name} — defeated`)}`;
  const name = (u.kind === "minion" ? u.name : u.name).padEnd(20).slice(0, 20);
  const shield = totalShield(u);
  const sh = shield > 0 ? " " + cyan(`⛨${shield}`) : "";
  const el = dim(`·${u.currentElement}`);
  const st = renderStatuses(u);
  return `  ${tag} ${name} ${hpBar(u.hp, u.maxHp)}${sh} ${el}${st ? " " + st : ""}`;
}

function teamUnits(state: MatchState, side: TeamId): Unit[] {
  return state.teams[side].units.map((id) => state.units[id]).filter((u): u is Unit => !!u);
}

/** The full board: both teams (heroes then any minions), energy pools, marking the human side. */
export function renderBoard(state: MatchState, youSide: TeamId): string {
  const lines: string[] = [];
  for (const side of ["A", "B"] as TeamId[]) {
    const who = side === youSide ? green("you") : yellow("AI");
    lines.push(`${bold(`Team ${side}`)} (${who})   ${dim("energy:")} ${renderEnergy(state.teams[side].energy)}`);
    const units = teamUnits(state, side);
    for (const u of units.filter((u) => u.kind !== "minion")) lines.push(renderUnit(u));
    for (const u of units.filter((u) => u.kind === "minion")) lines.push(renderUnit(u));
  }
  return lines.join("\n");
}

/** "Fan the Flames  1⚡ · cd0 · Harmful" — a one-line skill descriptor. */
export function describeSkill(state: MatchState, u: Unit, skill: SkillInstance): string {
  const cost = effectiveCost(u, skill, state);
  const costStr = [cost.generic ? `${cost.generic} gen` : "", cost.specific ? `${cost.specific} ${skill.element}` : ""].filter(Boolean).join("+") || "free";
  const cd = skill.currentCd > 0 ? red(`cd${skill.currentCd}`) : dim("ready");
  const kind = skill.tags.find((t) => ["Harmful", "Helpful", "Strategic"].includes(t)) ?? skill.klass;
  return `${skill.name.padEnd(22)} ${dim(costStr.padEnd(12))} ${cd} ${dim(kind)}`;
}

/** A numbered menu of a unit's skills; unusable ones are dimmed and marked. Returns [menu, usableIds]. */
export function renderSkillMenu(state: MatchState, u: Unit): { text: string; usable: string[] } {
  const lines: string[] = [];
  const usable: string[] = [];
  const skills = u.skills ?? [];
  skills.forEach((s, i) => {
    const ok = canUse(state, u, s);
    if (ok) usable.push(s.id);
    const n = ok ? bold(`${i + 1})`) : dim(`${i + 1})`);
    const body = describeSkill(state, u, s);
    lines.push(`   ${n} ${ok ? body : dim(body) + dim(" — unusable")}`);
  });
  lines.push(`   ${bold("0)")} ${dim("skip / hold")}`);
  return { text: lines.join("\n"), usable };
}

/** The tail of the match log. */
export function renderLog(state: MatchState, n = 6): string {
  const lines = state.log.slice(-n);
  if (!lines.length) return "";
  return dim("recent:\n") + lines.map((l) => dim("  · " + l)).join("\n");
}

export function heading(text: string): string {
  return "\n" + bold("═".repeat(62)) + "\n " + bold(text) + "\n" + rule();
}
