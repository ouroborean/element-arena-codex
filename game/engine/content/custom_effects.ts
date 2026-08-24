/**
 * Native handlers for the `custom` escape-hatch nodes the roster authors reached for
 * (the ~3% of skills the declarative DSL can't express). Each is transcribed from its
 * skill's prose; where a faithful implementation needs a primitive the engine doesn't
 * have yet, the handler does the closest correct thing and the shortfall is logged as
 * fidelity debt in ../../design/ENGINE_GAPS.md (never a silent no-op).
 *
 * Importing this module registers all handlers; content/hero.ts does that side-effect
 * import so any consumer of the roster gets them.
 */
import { registerCustom, resolveSelector, runInContext } from "../src/effects/interpret.ts";
import { applyStatus, removeStatus, stackCount } from "../src/status.ts";
import { applyHeal, spendShield } from "../src/damage.ts";
import type { Unit } from "../src/types.ts";
import type { Selector } from "../src/effects/ast.ts";
import type { SkillInstance } from "../src/skill.ts";

// saya5 "Stroke of Genius" — sets the caster's OTHER skills to a flat 1-energy cost.
// Faithful: per ENERGY_INCOME/cost model, a skill's SPECIFIC cost is paid in the caster's
// CURRENT element, so {generic:0, specific:1} on Saya (element = lightning) IS "1 lightning".
registerCustom("setSkillCosts", (ctx, args) => {
  const units = resolveSelector((args.of as Selector) ?? "caster", ctx);
  const except = args.exceptSkillId as string | undefined;
  const generic = (args.generic as number) ?? 0;
  const specific = (args.specific as number) ?? 0;
  for (const u of units) {
    for (const s of u.skills ?? []) {
      if (s.id === except) continue;
      s.cost = { generic, specific };
    }
  }
});

// zephyrex4 "Wind Step" — grant Essence IF Zephyrex is given a new skill during the DR window.
// This opens the window (a timed mark); Zephyrex's standing `skillGranted` trigger reads it and
// grants the essence. Skill-granting is a fusion/augment mechanic, so no base-kit event emits
// `skillGranted` yet — the wiring is correct and dormant until that emitter exists.
registerCustom("grantEssenceIfSkillReceivedWithin", (ctx, args) => {
  const turns = (args.turns as number) ?? 1;
  for (const u of resolveSelector((args.to as Selector) ?? "self", ctx)) {
    applyStatus(u, {
      kind: "mark", name: "Wind Step Window", duration: turns,
      appliedBy: ctx.self.id, appliedTurn: ctx.state.turn,
    });
  }
});

// syl4 "Unbreakable Bond" — set Syl and her Eagle to the average of their current HP.
// Fully faithful.
registerCustom("equalizeHp", (ctx, args) => {
  const sels = (args.units as Selector[]) ?? [];
  const units: Unit[] = [];
  for (const sel of sels) {
    for (const u of resolveSelector(sel, ctx)) if (!units.includes(u)) units.push(u);
  }
  if (units.length === 0) return;
  const avg = Math.floor(units.reduce((a, u) => a + u.hp, 0) / units.length);
  for (const u of units) u.hp = Math.min(u.maxHp, avg);
});

// syl passive — Leyline Nest's specific cost decays by `amount` each turn (floor `min`) and
// resets to base on use. Modelled with a skillId-scoped cost_mod discount (base cost is never
// mutated, so the reset is just dropping the discount). This turnStart half grows the discount.
registerCustom("decaySkillCost", (ctx, args) => {
  const e = ctx.event;
  if (e && e.type === "turnStart" && e.team !== ctx.self.team) return; // only my team's turns
  // syl:ghost "Forlorn Feathers" suppresses this decay while its mark is up.
  if (ctx.self.statuses.some((s) => s.kind === "mark" && s.name === "Leyline Decay Suppressed")) return;
  const skillId = args.skillId as string;
  const amount = (args.amount as number) ?? 1;
  const min = (args.min as number) ?? 0;
  const skill = ctx.self.skills?.find((s) => s.id === skillId);
  if (!skill) return;
  const floorDelta = -(skill.cost.specific - min); // discount can zero the specific cost, no further
  const cur = ctx.self.statuses.find((s) => s.kind === "cost_mod" && s.skillId === skillId)?.magnitude ?? 0;
  applyStatus(ctx.self, {
    kind: "cost_mod", skillId, magnitude: Math.max(floorDelta, cur - amount),
    duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn,
  });
});

// The reset half of a skillId-scoped cost decay: when the named skill is actually used, drop
// its scoped cost_mod so the cost returns to base. Fires on a skillUsed trigger; no-ops unless
// the event's skill matches (there is no skillId Condition to gate the trigger itself).
registerCustom("resetScopedCostMod", (ctx, args) => {
  const skillId = args.skillId as string;
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== skillId) return;
  ctx.self.statuses = ctx.self.statuses.filter((s) => !(s.kind === "cost_mod" && s.skillId === skillId));
});

// hector3 "Mindfog Serum" — a lasting +N to the target's cooldowns (a removable
// drawback). Faithful via the cooldown_mod status (read by scheduler.effectiveCooldown).
registerCustom("cooldownMod", (ctx, args) => {
  const delta = (args.delta as number) ?? 1;
  const duration = (args.duration as number | null) ?? null;
  const name = args.name as string | undefined;
  for (const u of resolveSelector((args.to as Selector) ?? "target", ctx)) {
    applyStatus(u, {
      kind: "cooldown_mod", magnitude: delta, name, duration,
      appliedBy: ctx.self.id, appliedTurn: ctx.state.turn,
    });
  }
});

// hector5 "Serum Overload" — clears the Mindfog cooldown penalty. Faithful.
registerCustom("clearCooldownMod", (ctx, args) => {
  const units = args.from ? resolveSelector(args.from as Selector, ctx) : ctx.targets;
  for (const u of units) u.statuses = u.statuses.filter((s) => s.kind !== "cooldown_mod");
});

// blackknight passive — if the Black Knight is the SOLE acting ally this turn (he acted and no
// other allied hero did), self-mark Exile + gain Essence; else drop Exile. Read from the
// acted-this-turn ledger at his team's turn-end (the earliest point his aloneness is known);
// the duration-1 Exile mark then colours his NEXT turn's skills. Fires on turnEnd.
registerCustom("exileActingAlone", (ctx, args) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd" || e.team !== ctx.self.team) return; // only my own team's turn-end
  const mark = (args.mark as string) ?? "Exile";
  const markDuration = (args.markDuration as number) ?? 1;
  // The Onyx Legion (blackknight:curse): allies bearing this mark "never count as acting" when deciding
  // if the Black Knight is alone. Absent (base kit) -> no allies are excluded (identical behavior).
  const excludeMark = args.excludeMark as string | undefined;
  const acted = ctx.state.actedThisTurn;
  const iActed = acted.includes(ctx.self.id);
  const otherAllyActed = ctx.state.teams[ctx.self.team].units.some((id) => {
    const u = ctx.state.units[id];
    if (!u || u.kind !== "hero" || u.id === ctx.self.id || !acted.includes(u.id)) return false;
    if (excludeMark && u.statuses.some((s) => s.kind === "mark" && s.name === excludeMark)) return false;
    return true;
  });
  if (iActed && !otherAllyActed) {
    applyStatus(ctx.self, {
      kind: "mark", name: mark, duration: markDuration,
      appliedBy: ctx.self.id, appliedTurn: ctx.state.turn,
    });
    applyStatus(ctx.self, {
      kind: "elemental_essence", duration: null,
      appliedBy: ctx.self.id, appliedTurn: ctx.state.turn,
    });
  } else {
    removeStatus(ctx.self, "mark", mark);
  }
});

// xyris3 "Twisted Nightmares" — marks the target; while it holds the mark, its all-* skills
// resolve against a single target (enforced in scheduler.resolveTargets, which narrows an
// all-* targeting set to one whenever the caster carries this mark).
registerCustom("aoeBecomesSingleTarget", (ctx, args) => {
  const markName = (args.markName as string) ?? "Twisted Nightmares";
  const duration = (args.duration as number | null) ?? null;
  for (const u of resolveSelector((args.of as Selector) ?? "target", ctx)) {
    applyStatus(u, {
      kind: "mark", name: markName, duration,
      appliedBy: ctx.self.id, appliedTurn: ctx.state.turn,
    });
  }
});

// keeper1/2/4/5 — spend N Shield from the caster's real Shield pool as a skill cost. Faithful.
registerCustom("consumeShield", (ctx, args) => {
  const amount = (args.amount as number) ?? 0;
  for (const u of resolveSelector((args.of as Selector) ?? "caster", ctx)) {
    const spent = spendShield(u, amount);
    const shortfall = amount - spent;
    if (shortfall > 0) {
      // keeper:crystal — Chronicle Fragments count as 10 Shield each; cover the shortfall with WHOLE stacks
      // (a Fragment can't be split). Non-Keeper callers hold 0 Fragments, so this is a no-op for them.
      const need = Math.min(stackCount(u, "Chronicle Fragments"), Math.ceil(shortfall / 10));
      if (need > 0) applyStatus(u, { kind: "stack", name: "Chronicle Fragments", magnitude: -need, duration: null, appliedBy: u.id, appliedTurn: ctx.state.turn });
    }
  }
});

// xyris4 "Somnic Apparition" — clone the just-countered skill onto the freshly-summoned Dream
// Reflection (replacing its placeholder), re-elementing its Specific cost to Xyris' element (the
// minion pays specific in its own current element). Reads the skillDeclared event being countered.
registerCustom("cloneCounteredSkillOntoMinion", (ctx, args) => {
  const e = ctx.event;
  if (!e || e.type !== "skillDeclared") return;
  const template = args.minionTemplate as string;
  const placeholder = args.placeholderSkillId as string | undefined;
  const src = ctx.state.units[e.caster];
  const srcSkill = (src?.skills ?? []).find((s) => s.id === e.skillId);
  if (!srcSkill) return;
  // Only ever clone onto a FRESH Dream Reflection — one still holding its placeholder skill. If the
  // 6-minion cap blocked the summon (a no-op), no such minion exists and we do nothing, rather than
  // silently overwrite an older reflection's loadout (per prose: this "creates a ... minion").
  const fresh = Object.values(ctx.state.units)
    .filter((u) => u.kind === "minion" && u.name === template && u.summoner === ctx.self.id &&
      (u.skills ?? []).some((s) => s.id === placeholder))
    .sort((a, b) => Number(a.id.split(":").pop()) - Number(b.id.split(":").pop()));
  const minion = fresh[fresh.length - 1];
  if (!minion) return;
  const clone: SkillInstance = { ...JSON.parse(JSON.stringify(srcSkill)), currentCd: 0 };
  const skills = minion.skills ?? [];
  skills[skills.findIndex((s) => s.id === placeholder)] = clone;
  minion.skills = skills;
  minion.currentElement = ctx.self.currentElement; // Specific cost re-elemented to Xyris' element
});

// xyris5 "Echoes of Desire" — re-run the skill that was just used, against the same targets.
// (useSkill needs a static id; this reads the dynamic skillId off the skillUsed event.) The
// trigger clears its mark before calling, so the echo does not re-arm this trigger.
registerCustom("repeatEventSkill", (ctx) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed") return;
  const by = ctx.state.units[e.caster];
  const sk = (by?.skills ?? []).find((s) => s.id === e.skillId);
  if (!by || !sk) return;
  const targets = e.targets.map((id) => ctx.state.units[id]).filter((u): u is Unit => !!u);
  runInContext(sk.effects, { ...ctx, caster: by, self: by, targets, it: null });
});

// aramao1 — swap the caster with his living hero teammate standing in the target's slot
// ("directly across from the target"). No selector expresses "my ally in the target's slot".
registerCustom("swapWithAllyAcrossFromTarget", (ctx) => {
  const target = ctx.targets[0];
  if (!target || target.slot === undefined || ctx.self.slot === undefined) return;
  const ally = ctx.state.teams[ctx.self.team].units
    .map((id) => ctx.state.units[id])
    .find((u) => !!u && u.alive && u.kind === "hero" && u.id !== ctx.self.id && u.slot === target.slot);
  if (!ally) return;
  const tmp = ctx.self.slot;
  ctx.self.slot = ally.slot;
  ally.slot = tmp;
});

// scratch "Deal: Save Your Friends" — if the skill just used carries the Helpful tag, heal each
// of its targets and make them Invulnerable. Reads the tags off the used skill (skillUsed events
// don't carry class tags, so this looks the skill up on its caster).
registerCustom("augmentIfHelpful_healAndInvuln", (ctx, args) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed") return;
  const src = ctx.state.units[e.caster];
  const sk = (src?.skills ?? []).find((s) => s.id === e.skillId);
  if (!sk || !sk.tags.includes("Helpful")) return;
  const heal = (args.heal as number) ?? 0;
  const dur = (args.invulnerableDuration as number) ?? 1;
  for (const id of e.targets) {
    const u = ctx.state.units[id];
    if (!u) continue;
    if (heal > 0) applyHeal(u, heal);
    applyStatus(u, { kind: "invulnerable", duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});
