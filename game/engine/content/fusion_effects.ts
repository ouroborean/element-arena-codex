/**
 * Native handlers for fusion `custom` mechanics, implemented in themed clusters. As each cluster
 * lands here, its fns drop off `fusion_pending`'s stub list automatically (that module only stubs
 * fns with no real handler).
 *
 * Cluster 1 — "combat-event reactions": mechanics that read the firing event's values (damage/heal
 * amount, sourceId) or the acted-this-turn ledger. The DSL exposes no `event.amount`/`event.sourceId`
 * to a Value/Condition, so these are the sanctioned native form — but they are FAITHFUL (no
 * approximation): they read the real event off the context and act on it.
 */
import { registerCustom, resolveSelector, runInContext } from "../src/effects/interpret.ts";
import type { Ctx } from "../src/effects/interpret.ts";
import { applyStatus, removeStatus, rawStackCount, stackCount } from "../src/status.ts";
import { applyDamage, applyHeal, addShield, totalShield } from "../src/damage.ts";
import { legalTargets } from "../src/scheduler.ts";
import type { Effect, Selector } from "../src/effects/ast.ts";
import type { TriggeredEffect } from "../src/events.ts";
import type { SkillInstance } from "../src/skill.ts";
import type { DamageType, Status, Unit } from "../src/types.ts";

const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const stackOf = (u: Unit, name: string) => u.statuses.find((s) => s.kind === "stack" && s.name === name);

/** Apply damage AND emit the same events the interpreter's `damage` op would (real, reactable damage). */
function dealAndEmit(ctx: Ctx, u: Unit, amount: number, dtype: DamageType = "normal", bypass = false): void {
  const wasAlive = u.alive;
  const r = applyDamage(u, { amount, type: dtype, isNew: true, bypass });
  if (r.shieldAbsorbed > 0) ctx.emit({ type: "shieldDamaged", unit: u.id, source: ctx.self.id, amount: r.shieldAbsorbed });
  if (r.shieldBroke) ctx.emit({ type: "shieldBroken", unit: u.id, source: ctx.self.id });
  ctx.emit({ type: "damageDealt", source: ctx.self.id, target: u.id, amount: r.hpLost, dtype, isNew: true });
  if (wasAlive && r.lethal) ctx.emit({ type: "unitDied", unit: u.id, killer: ctx.self.id });
}

// ── watch-window helpers (dynamic triggers) ──────────────────────────────────── //

/** Install a temporary reactive/counter/reflect trigger on `owner`, expiring after `turns` (ticked
 *  at the installer's turn-end). This is the primitive behind every "for N turns, when X happens…" clause. */
function installWatch(ctx: Ctx, spec: Omit<TriggeredEffect, "owner">, turns: number | null, owner: Unit = ctx.self): void {
  // sourceSkillId = the skill/passive that installed this watch (ctx.skillId), so a status the watch
  // later applies can show that skill's icon even though it fires in a fresh, deferred context.
  owner.triggers = [...(owner.triggers ?? []), { sourceSkillId: ctx.skillId, ...spec, owner: owner.id, duration: turns, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn }];
}
/** Tag units with a marker so a later-firing dynamic trigger can name "the target(s)" by mark. */
function markUnits(ctx: Ctx, sel: Selector, name: string, duration: number | null): void {
  for (const u of resolveSelector(sel, ctx)) applyStatus(u, { kind: "mark", name, duration, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
}
/** Deep-copy an effect tree, swapping one selector string for another (retarget authored onUse blocks). */
function remap(node: unknown, from: string, to: string): unknown {
  if (Array.isArray(node)) return node.map((n) => remap(n, from, to));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = v === from ? to : remap(v, from, to);
    return out;
  }
  return node;
}

// riverdaughter:blood — bank the damage just dealt into the "Blood in the Water" stack.
registerCustom("storeDamageDealt", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt") return;
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "stack", name: a.name as string, magnitude: e.amount, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// riverdaughter:mirror — bank the healing an enemy just received into the "Reflection of Kindness" tally.
registerCustom("storeHealing", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "healReceived") return;
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "stack", name: a.name as string, magnitude: e.amount, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// jarrik:ritual — accrue the hp lost in a damage instance into "Ritual Power", capped at `max`.
registerCustom("gainRitualPower", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.amount <= 0) return;
  const name = a.stack as string;
  applyStatus(ctx.self, { kind: "stack", name, magnitude: e.amount, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  const s = stackOf(ctx.self, name);
  if (s) s.magnitude = Math.min(num(a.max, Infinity), s.magnitude ?? 0);
});

// laria:assassin — while Vanished, repeat the damage just dealt onto the same target (doubling it).
// Applied WITHOUT emitting, so it cannot re-trigger this reaction (the note's requirement).
registerCustom("repeatDamageDealt", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.amount <= 0) return;
  for (const u of resolveSelector((a.to as Selector) ?? "eventTarget", ctx)) {
    applyDamage(u, { amount: e.amount, type: e.dtype });
  }
});

// maggie:blood — when Maggie's Curse of Thorns dot deals damage, heal each living ally.
registerCustom("healAlliesWhenCurseOfThornsDeals", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.sourceId !== "Curse of Thorns") return;
  for (const u of resolveSelector({ faction: "allies" }, ctx)) applyHeal(u, num(a.healAmount));
});

// maggie:curse — when Curse of Thorns deals damage, heal-lock the unit it hit.
registerCustom("healLockUnitsDamagedByCurseOfThorns", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.sourceId !== "Curse of Thorns") return;
  const tgt = ctx.state.units[e.target];
  if (tgt) applyStatus(tgt, { kind: "heal_lock", duration: num(a.durationTurns, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// maggie:zealot — at her team's turn-end, if Maggie took no action, spread another Curse stack to enemies.
registerCustom("addCurseStackIfMaggieDidNotAct", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd" || e.team !== ctx.self.team) return;
  if (ctx.state.actedThisTurn.includes(ctx.self.id)) return;
  for (const u of resolveSelector({ faction: "enemies" }, ctx)) {
    applyStatus(u, { kind: "stack", name: a.name as string, magnitude: num(a.amount, 1), duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// ── Cluster 2 — "watch windows": temporary reactive triggers installed by an active skill ──────── //
// A window's target(s) are tagged with a private mark so the later-firing trigger can name them;
// reflect destinations that can't be a selector use redirectToId. All expire after `turns`.

// ando:ion — for 2 turns, punish enemies who turn Invulnerable (Electroblade) or use a skill (Flash Step).
registerCustom("singularityWatch", (ctx, a) => {
  const turns = num(a.turns, 2);
  const inv = (a.onInvulnerableAttempt as { skillId: string }).skillId;
  const harm = (a.onHarmfulSkill as { skillId: string }).skillId;
  installWatch(ctx, { on: "statusApplied", source: "Singularity", when: { and: [{ isFaction: "eventUnit", faction: "enemy" }, { eventStatusKind: "invulnerable" }] }, effect: [{ op: "useSkill", skillId: inv, by: "self", on: "eventUnit" }] }, turns);
  installWatch(ctx, { on: "skillUsed", source: "Singularity", when: { and: [{ isFaction: "eventSource", faction: "enemy" }, { eventHasTag: "Harmful" }] }, effect: [{ op: "useSkill", skillId: harm, by: "self", on: "eventSource" }] }, turns);
});

// syl:winter — for 4 turns, heal + shield any ally who gets Stunned.
registerCustom("searchAndRescueWatch", (ctx, a) => {
  installWatch(ctx, {
    on: "statusApplied", source: "Search and Rescue",
    when: { and: [{ isFaction: "eventUnit", faction: "ally" }, { eventStatusKind: "stun" }] },
    effect: [{ op: "heal", amount: num(a.healAmount, 20), to: "eventUnit" }, { op: "applyStatus", to: "eventUnit", status: { kind: "invulnerable", duration: num(a.invulnDuration, 1) } }],
  }, num(a.turns, 4));
});

// syl:ninja — for 2 turns, a Shadow-Seekers-marked enemy that takes ally damage is stunned (non-Strategic).
registerCustom("shadowSeekersWatch", (ctx, a) => {
  const mark = a.mark as string;
  installWatch(ctx, {
    on: "damageDealt", source: "Shadow Seekers",
    when: { and: [{ has: "mark", name: mark, of: "eventTarget" }, { or: [{ sameUnit: ["eventSource", "self"] }, { and: [{ isFaction: "eventSource", faction: "ally" }, { isKind: "eventSource", kind: "minion" }] }] }] },
    effect: [{ op: "applyStatus", to: "eventTarget", status: { kind: "stun", scope: a.stunScope as { tag: string; mode: "only" | "except" }, duration: num(a.stunDuration, 1) } }, { op: "removeStatus", kind: "mark", name: mark, from: "eventTarget" }],
  }, num(a.turns, 2));
});

// pyrrha:apocalypse — for 1 turn, enemies that turn Invulnerable are Stunned.
registerCustom("stunEnemiesThatBecomeInvulnerable", (ctx, a) => {
  installWatch(ctx, {
    on: "statusApplied", source: "Apocalypse",
    when: { and: [{ isFaction: "eventUnit", faction: "enemy" }, { eventStatusKind: "invulnerable" }] },
    effect: [{ op: "applyStatus", to: "eventUnit", status: { kind: "stun", duration: num(a.stunDuration, 1) } }],
  }, num(a.window, 1));
});

// A retaliation/link damage that does NOT emit damageDealt — so it doesn't re-trigger the dealer's own
// on-damage passives (e.g. Consecration must not disable Taryn's Guardian at the Gates).
registerCustom("dealNoEmit", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? "eventSource", ctx)) applyDamage(u, { amount: num(a.amount), type: (a.dtype as DamageType) ?? "normal" });
});

// taryn:sanctuary — for 2 turns, an enemy that damages Taryn or an ally takes retaliation damage
// (non-emitting, per prose "will not disable Guardian at the Gates").
registerCustom("consecrationRetaliation", (ctx, a) => {
  installWatch(ctx, {
    on: "damageDealt", source: "Consecration",
    when: { and: [{ isFaction: "eventTarget", faction: "ally" }, { isFaction: "eventSource", faction: "enemy" }] },
    effect: [{ op: "custom", fn: "dealNoEmit", args: { to: "eventSource", amount: num(a.damage, 10) } }],
  }, num(a.turns, 2));
});

// titania:assassin — for 1 turn, the first time the target is healed it is heal-locked + afflicted.
registerCustom("moongloveTrap", (ctx, a) => {
  const turns = num(a.turns, 1);
  markUnits(ctx, (a.target as Selector) ?? "target", "Moonglove", turns);
  installWatch(ctx, {
    on: "healReceived", source: "Moonglove", once: true,
    when: { has: "mark", name: "Moonglove", of: "eventUnit" },
    effect: [{ op: "applyStatus", to: "eventUnit", status: { kind: "heal_lock", duration: null } }, { op: "applyStatus", to: "eventUnit", status: { kind: "dot", name: "Moonglove", magnitude: num(a.affliction, 15), dtype: "affliction", duration: null } }],
  }, turns);
});

// titania:stasis — for 1 turn, the first time the target takes damage it is Stunned + the dealer gains Essence.
registerCustom("icySmileWatch", (ctx, a) => {
  const turns = num(a.turns, 1);
  markUnits(ctx, (a.target as Selector) ?? "target", "Icy Smile", turns);
  installWatch(ctx, {
    on: "damageDealt", source: "Icy Smile", once: true,
    when: { has: "mark", name: "Icy Smile", of: "eventTarget" },
    effect: [{ op: "applyStatus", to: "eventTarget", status: { kind: "stun", duration: num(a.stunDuration, 1) } }, { op: "applyStatus", to: "eventSource", status: { kind: "elemental_essence", duration: null } }],
  }, turns);
});

// zephyrex:ghost — for 3 turns, the marked target is made Invulnerable at each turn-end.
registerCustom("soulstealWindow", (ctx, a) => {
  const turns = num(a.turns, 3);
  markUnits(ctx, (a.to as Selector) ?? "target", "Soulsteal", turns);
  installWatch(ctx, {
    on: "turnEnd", source: "Soulsteal",
    effect: [{ op: "forEach", each: { filter: { faction: "all" }, with: { kind: "mark", name: "Soulsteal" } }, do: [{ op: "applyStatus", to: "it", status: { kind: "invulnerable", duration: num(a.invulnerableDuration, 1) } }] }],
  }, turns);
});

// taryn:divine — for 2 turns, the target's stun ends the first time it takes damage.
registerCustom("breakStunOnDamage", (ctx, a) => {
  const turns = num(a.turns, 2);
  markUnits(ctx, (a.target as Selector) ?? "target", "Break Stun", turns);
  installWatch(ctx, {
    on: "damageDealt", source: "Break Stun", once: true,
    when: { has: "mark", name: "Break Stun", of: "eventTarget" },
    effect: [{ op: "removeStatus", kind: "stun", from: "eventTarget" }],
  }, turns);
});

// zephyrex:nomad — for 3 turns, if the Blinded target turns Invulnerable, clear its Blind.
registerCustom("clearBlindWhenTargetInvulnerable", (ctx, a) => {
  const turns = 3;
  markUnits(ctx, (a.of as Selector) ?? "target", "Clear Blind", turns);
  installWatch(ctx, {
    on: "statusApplied", source: "Clear Blind", once: true,
    when: { and: [{ has: "mark", name: "Clear Blind", of: "eventUnit" }, { eventStatusKind: "invulnerable" }] },
    effect: [{ op: "removeStatus", kind: "blind", name: a.name as string, from: "eventUnit" }],
  }, turns);
});

// hector:assassin — for 2 turns, if the target uses a skill it takes the onUse payload and its heal-mark is stripped.
registerCustom("armSkillUseTrap", (ctx, a) => {
  const turns = num(a.window, 2);
  markUnits(ctx, (a.on as Selector) ?? "target", "Skill Trap", turns);
  const onUse = remap(a.onUse ?? [], "target", "eventSource") as Effect[];
  const effect: Effect[] = [...onUse, { op: "removeStatus", kind: "mark", name: "Skill Trap", from: "eventSource" }];
  if (a.cancels) effect.push({ op: "removeStatus", kind: "mark", name: a.cancels as string, from: "eventSource" });
  installWatch(ctx, { on: "skillUsed", source: "Skill Trap", when: { has: "mark", name: "Skill Trap", of: "eventSource" }, effect }, turns);
});

// Cancel a pending mark (and its onExpire payload) if the marked unit uses a skill within the window —
// the "…unless they use a skill" half of a use-or-be-punished clause (hector:faerie enemy branch).
registerCustom("removeMarkOnSkillUse", (ctx, a) => {
  const markName = a.mark as string;
  installWatch(ctx, {
    on: "skillUsed", source: `Cancel ${markName}`,
    when: { has: "mark", name: markName, of: "eventSource" },
    effect: [{ op: "removeStatus", kind: "mark", name: markName, from: "eventSource" }],
  }, num(a.window, 1));
});

// hector:faerie — for 1 turn, if the watched ally uses a skill they gain Essence.
registerCustom("armSkillUseReward", (ctx, a) => {
  const turns = num(a.window, 1);
  markUnits(ctx, (a.on as Selector) ?? "target", "Skill Reward", turns);
  installWatch(ctx, {
    on: "skillUsed", source: "Skill Reward",
    when: { has: "mark", name: "Skill Reward", of: "eventSource" },
    effect: [{ op: "applyStatus", to: "eventSource", status: { kind: "elemental_essence", duration: null } }, { op: "removeStatus", kind: "mark", name: "Skill Reward", from: "eventSource" }],
  }, turns);
});

// ando:magnet — for 1 turn, reflect damage aimed at Ando onto the marked target, and helpful on the target back to Ando.
registerCustom("oppositesAttract", (ctx, a) => {
  const turns = num(a.turns, 1);
  const first = resolveSelector((a.target as Selector) ?? "target", ctx)[0];
  markUnits(ctx, (a.target as Selector) ?? "target", "Opposites Attract", turns);
  installWatch(ctx, { on: "skillDeclared", kind: "reflect", source: "Opposites Attract", when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] }, redirectTo: { filter: { faction: "enemies" }, with: { kind: "mark", name: "Opposites Attract" } }, effect: [] }, turns);
  if (first) installWatch(ctx, { on: "skillDeclared", kind: "reflect", source: "Opposites Attract", when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Helpful" }] }, redirectToId: ctx.self.id, effect: [] }, turns, first);
});

// taryn:vengeance — for 1 turn, harmful skills aimed at the target ally are reflected to Taryn.
registerCustom("notTodayReflect", (ctx, a) => {
  const turns = num(a.turns, 1);
  const ally = resolveSelector((a.target as Selector) ?? "target", ctx)[0];
  if (ally) installWatch(ctx, { on: "skillDeclared", kind: "reflect", source: "Not Today", when: { and: [{ declaredTargetsSelf: true }, { eventHasTag: "Harmful" }] }, redirectToId: ctx.self.id, effect: [] }, turns, ally);
});

// taryn:angel — for 1 turn, the first Harmful skill by the target is Countered and Hand of Michael adds damage.
registerCustom("handOfMichaelWatch", (ctx, a) => {
  const turns = num(a.turns, 1);
  markUnits(ctx, (a.target as Selector) ?? "target", "Hand of Michael", turns);
  installWatch(ctx, {
    on: "skillDeclared", kind: "counter", source: "Hand of Michael", once: true,
    when: { and: [{ has: "mark", name: "Hand of Michael", of: "eventSource" }, { eventHasTag: "Harmful" }] },
    effect: [{ op: "damage", amount: num(a.counterBonus, 15), to: "eventSource" }],
  }, turns);
});

// saya:magnet — for 1 turn, counter the first skill the target uses, stripping its Essence + charging it.
registerCustom("personalMagnetism", (ctx, a) => {
  const turns = num(a.turns, 1);
  markUnits(ctx, (a.target as Selector) ?? "target", "Personal Magnetism", turns);
  installWatch(ctx, {
    on: "skillDeclared", kind: "counter", source: "Personal Magnetism", once: true,
    when: { and: [{ has: "mark", name: "Personal Magnetism", of: "eventSource" }, { or: [{ eventHasTag: "Harmful" }, { eventHasTag: "Helpful" }] }] },
    effect: [
      { op: "removeStatus", kind: "elemental_essence", from: "eventSource" },
      { op: "if", cond: { eventHasTag: "Harmful" },
        then: [{ op: "applyStatus", to: "eventSource", status: { kind: "mark", name: a.negMark as string, duration: null } }],
        else: [{ op: "applyStatus", to: "eventSource", status: { kind: "mark", name: a.posMark as string, duration: null } }] },
    ],
  }, turns);
});

// ── Cluster 3 — "self-skill mutation": permanently/temporarily edit the hero's OWN skill instances ─ //
// Clone discipline: loadHero shares a hero's base skills (and their effect arrays) with the authored
// HeroDef, so mutableSkill detaches a deep clone on first edit — never corrupting the shared def or a
// teammate. Idempotency: roundStart rewrites fire every round but must apply once — `once` guards the
// compounding ones (a stable per-clone ledger), while set-to-fixed edits are naturally idempotent.

const DETACHED = new WeakSet<object>();
const PATCHED = new WeakMap<object, Set<string>>();

/**
 * Find the hero's skill by id and detach its shared internals (effects/tags/cost) on first mutation.
 * Clones IN PLACE — keeping the SkillInstance object identity — so a reference the caller holds mid-
 * resolution (e.g. performAction resolving a skill whose own effect mutates it) stays valid.
 */
function mutableSkill(ctx: Ctx, id: string): SkillInstance | undefined {
  for (const owner of [ctx.self, ctx.caster]) {
    const s = (owner.skills ?? []).find((x) => x.id === id);
    if (!s) continue;
    if (!DETACHED.has(s)) {
      s.effects = JSON.parse(JSON.stringify(s.effects)); // detach from the shared HeroDef tree
      s.tags = [...s.tags];
      s.cost = { ...s.cost };
      DETACHED.add(s);
    }
    return s;
  }
  return undefined;
}
/** True the first time `fn` patches this (detached) skill — makes a compounding rewrite apply once. */
function once(skill: SkillInstance, fn: string): boolean {
  let set = PATCHED.get(skill);
  if (!set) { set = new Set(); PATCHED.set(skill, set); }
  if (set.has(fn)) return false;
  set.add(fn);
  return true;
}
function walkNodes(effects: Effect[], fn: (e: Effect) => void): void {
  for (const e of effects) {
    fn(e);
    if (e.op === "if") { walkNodes(e.then, fn); if (e.else) walkNodes(e.else, fn); }
    else if (e.op === "forEach") walkNodes(e.do, fn);
    else if (e.op === "seq") walkNodes(e.steps, fn);
    else if (e.op === "schedule") walkNodes(e.effect, fn);
    else if (e.op === "applyStatus" && e.status.onExpire) walkNodes(e.status.onExpire, fn);
  }
}
const bumpDamage = (s: SkillInstance, d: number) => walkNodes(s.effects, (e) => { if (e.op === "damage" && typeof e.amount === "number") e.amount += d; });
const bumpHeal = (s: SkillInstance, d: number) => walkNodes(s.effects, (e) => { if (e.op === "heal" && typeof e.amount === "number") e.amount += d; });
const setDamageAll = (s: SkillInstance, v: number) => walkNodes(s.effects, (e) => { if (e.op === "damage") e.amount = v; });
const setDtype = (s: SkillInstance, t: DamageType) => walkNodes(s.effects, (e) => { if (e.op === "damage") e.dtype = t; });

// zephyrex:ninja — each Biting Wind trigger permanently raises Elegant Sweep's damage (compounds).
registerCustom("bumpSkillDamage", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s) bumpDamage(s, num(a.delta, 5));
});

// zephyrex:ninja — when Wind Step (the trigger skill) is used, raise Elegant Sweep's damage.
registerCustom("bumpSkillDamageOnSkill", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.triggerSkillId as string)) return;
  const s = mutableSkill(ctx, a.skillId as string);
  if (s) bumpDamage(s, num(a.delta, 5));
});

// zephyrex:mechanic — Elegant Sweep deals Affliction instead of Piercing (idempotent).
registerCustom("setSkillDamageType", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s) setDtype(s, a.dtype as DamageType);
});

// zephyrex:angel — Elegant Sweep deals a fixed lower amount and additionally heals the team.
registerCustom("patchElegantSweepAngel", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (!s) return;
  setDamageAll(s, num(a.setDamage, 15));
  if (once(s, "patchElegantSweepAngel")) s.effects.push({ op: "heal", amount: num(a.healTeam, 10), to: { faction: (a.team as "allies" | "enemies") ?? "allies" } });
});

// pyrrha:devil — the fusion skill costs 1 more generic each time it is used (compounds).
registerCustom("escalateSkillCost", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s) s.cost = { generic: s.cost.generic + num(a.generic, 1), specific: s.cost.specific };
});

// xyris:ion — Enter the Dreamscape now affects all living units.
registerCustom("enterDreamscapeAffectsAll", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s) s.targeting = "all";
});

// xyris:ninja — Enter the Dreamscape drops its damage and hits all enemies.
registerCustom("modifyEnterDreamscape", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (!s) return;
  s.targeting = (a.targeting as SkillInstance["targeting"]) ?? "all-enemies";
  if (a.noDamage) setDamageAll(s, 0);
});

// pyrrha:devil — Fan the Flames hits every unit on both teams.
registerCustom("flamesOfGreedRewrite", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s) s.targeting = "all";
});

// pyrrha:dragon — Feed the Fire: +5 damage and healing, and it hits all enemies (apply once).
registerCustom("dragonsHungerRewrite", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s && once(s, "dragonsHungerRewrite")) {
    bumpDamage(s, num(a.damageBonus, 5));
    bumpHeal(s, num(a.healBonus, 5));
    s.targeting = "all-enemies";
  }
});

// pyrrha:brimstone — Fan the Flames' dot becomes permanent (apply once).
registerCustom("festeringBurnsRewrite", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (s && once(s, "festeringBurnsRewrite")) {
    walkNodes(s.effects, (e) => { if (e.op === "applyStatus" && e.status.kind === "dot" && e.status.name === (a.dotName as string)) e.status.duration = null; });
  }
});

// pyrrha:sun — Flashbang re-elements, costs 1 specific, and hits all enemies.
registerCustom("solarFlareRewrite", (ctx, a) => {
  const s = mutableSkill(ctx, a.skillId as string);
  if (!s) return;
  s.targeting = "all-enemies";
  s.cost = { generic: 0, specific: 1 };
  s.element = a.element as string;
});

// taryn:zealot — "Until the end of his next turn, Banner of Harmony will affect all enemies." A duration-bounded
// skill_targeting_override the target resolver reads live (effectiveTargeting), so both Banner's damage and its
// mark hit all enemies for the window, then it auto-reverts at Taryn's turn-end (no skill mutation to undo).
registerCustom("bannerAffectsAllEnemies", (ctx, a) => {
  applyStatus(ctx.self, { kind: "skill_targeting_override", skillId: a.skillId as string, name: "all-enemies", duration: num(a.turns, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// titania:brimstone — "For 4 turns, Thorn Prick costs nothing and its INITIAL damage is +5 (its DoT is unchanged)."
// A scoped free-cost cost_mod plus a duration-bounded skill_damage_bonus the damage op reads live for that skill id
// (the DoT is applied via applyStatus, not a damage op, so it is untouched). Both auto-revert at Titania's turn-end.
registerCustom("empowerThornPrick", (ctx, a) => {
  const s = (ctx.self.skills ?? []).find((k) => k.id === (a.skillId as string));
  if (!s) return;
  const turns = num(a.turns, 4);
  if (a.freeCost) applyStatus(ctx.self, { kind: "cost_mod", skillId: s.id, magnitude: -(s.cost.generic + s.cost.specific), duration: turns, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  applyStatus(ctx.self, { kind: "skill_damage_bonus", skillId: s.id, magnitude: num(a.bonusInitialDamage, 5), duration: turns, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// ── Cluster 4 — HP manipulation (implemented to exact prose) ─────────────────── //

// xyris:curse "Dream Weaving" ("Xyris and a targeted Hero swap their current HP") and
// laria:mirror "Black Reflection" ("Laria will swap her current HP with theirs"): swap two units'
// CURRENT hp only (max HP untouched).
const swapCurrentHp: Parameters<typeof registerCustom>[1] = (ctx, a) => {
  const A = resolveSelector(a.a as Selector, ctx)[0];
  const B = resolveSelector(a.b as Selector, ctx)[0];
  if (A && B) { const t = A.hp; A.hp = B.hp; B.hp = t; }
};
registerCustom("swapHp", swapCurrentHp);
registerCustom("swapCurrentHp", swapCurrentHp);

// pyrrha:ritual "Tormentor's Brand" ("...and sets their max HP to their current HP"): runs after the
// skill's 15 damage, so max HP drops to the reduced current HP.
registerCustom("setMaxHpToCurrent", (ctx, a) => {
  for (const u of resolveSelector((a.of as Selector) ?? "target", ctx)) u.maxHp = u.hp;
});

// riverdaughter:slime "Congeal" ("Restores 15HP to all Slime Minions. Any healing past max is added
// as Max HP"): heal each target by `amount`; if that pushes current HP past max, raise max HP to match.
registerCustom("healWithOverhealToMaxHp", (ctx, a) => {
  const amount = num(a.amount, 15);
  for (const u of resolveSelector((a.to as Selector) ?? "target", ctx)) {
    u.hp += amount;
    if (u.hp > u.maxHp) u.maxHp = u.hp; // the overheal becomes Max HP
  }
});

// ── Cluster 5 — resource & charge systems (implemented to exact prose) ────────── //

// syl:storm (Stormchaser: "its cost is decreased by 1 [35] each time she gains Elemental Essence"):
// deepen the syl5-scoped cost discount by `amount` (floored so the specific cost stays >= min).
registerCustom("reduceLeylineCostOnEssence", (ctx, a) => {
  const skillId = a.skillId as string;
  const skill = (ctx.self.skills ?? []).find((s) => s.id === skillId);
  if (!skill) return;
  const floorDelta = -(skill.cost.specific - num(a.min, 0));
  const cur = ctx.self.statuses.find((s) => s.kind === "cost_mod" && s.skillId === skillId)?.magnitude ?? 0;
  applyStatus(ctx.self, { kind: "cost_mod", skillId, magnitude: Math.max(floorDelta, cur - num(a.amount, 1)), duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// syl:ghost (Forlorn Feathers: "During this time, Syl will not gain stacks of Leyline Nest's cost
// reduction"): mark Syl so the per-turn decay is suppressed for `turns` (decaySkillCost skips it).
registerCustom("suppressLeylineCostDecay", (ctx, a) => {
  applyStatus(ctx.self, { kind: "mark", name: "Leyline Decay Suppressed", duration: num(a.turns, 4), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// jarrik:brimstone (Scorched Flesh: "Enemies affected by Cinders have the cost of their Strategic skills
// increased by [65]"): each turn, +`amount` generic to every `tag`-tagged skill of each Cinders-marked enemy.
registerCustom("scorchedFleshCostAura", (ctx, a) => {
  const markName = a.mark as string;
  const tag = a.tag as string;
  for (const enemy of resolveSelector({ faction: "enemies" }, ctx)) {
    if (!enemy.statuses.some((s) => s.kind === "mark" && s.name === markName)) continue;
    for (const skill of enemy.skills ?? []) {
      if (skill.tags.includes(tag)) applyStatus(enemy, { kind: "cost_mod", skillId: skill.id, magnitude: num(a.amount, 1), duration: 1, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    }
  }
});

// saya:magnet (Magnetic Field): an enemy's Helpful/Harmful skill grants matching charge; using the same
// polarity again (Harmful while Negative, or Helpful while Positive) → 15 damage + stun; Strategic clears charge.
registerCustom("magneticFieldCharge", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed") return;
  const enemy = ctx.state.units[e.caster];
  if (!enemy) return;
  const tags = e.tags ?? [];
  const pos = a.posMark as string, neg = a.negMark as string;
  const has = (n: string) => enemy.statuses.some((s) => s.kind === "mark" && s.name === n);
  const punish = () => {
    dealAndEmit(ctx, enemy, num(a.damage, 15));
    applyStatus(enemy, { kind: "stun", duration: num(a.stunTurns, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  };
  // A unit holds a single polarity: gaining one clears the opposite.
  const charge = (n: string, opposite: string) => { removeStatus(enemy, "mark", opposite); applyStatus(enemy, { kind: "mark", name: n, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn }); };
  if (tags.includes("Strategic")) { removeStatus(enemy, "mark", pos); removeStatus(enemy, "mark", neg); return; }
  if (tags.includes("Harmful")) { if (has(neg)) punish(); charge(neg, pos); }
  else if (tags.includes("Helpful")) { if (has(pos)) punish(); charge(pos, neg); }
});

// zephyrex:winter (Cold and Alone): at each enemy turn-end, an Invulnerable/Isolated enemy gains a stack;
// on reaching `threshold` (3) it is stunned and the stacks reset.
registerCustom("coldAndAloneAccrue", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd" || e.team === ctx.self.team) return; // only the enemies' turn-end
  const stack = a.stack as string;
  for (const enemy of resolveSelector({ faction: "enemies" }, ctx)) {
    if (!enemy.statuses.some((s) => s.kind === "invulnerable" || s.kind === "isolated")) continue;
    applyStatus(enemy, { kind: "stack", name: stack, magnitude: 1, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    if ((stackOf(enemy, stack)?.magnitude ?? 0) >= num(a.threshold, 3)) {
      applyStatus(enemy, { kind: "stun", duration: num(a.stunDuration, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
      removeStatus(enemy, "stack", stack);
    }
  }
});

// ando:battery (Capacitor Upgrade): when Expel Energy (skillId) is used, deal `perStack` x stacks bonus
// damage to its targets, then consume the stacks ("removed when Expel Energy is used").
registerCustom("capacitorUpgradeOnExpel", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const stackName = a.stackName as string;
  const stacks = stackOf(ctx.self, stackName)?.magnitude ?? 0;
  if (stacks <= 0) return;
  const bonus = num(a.perStack, 5) * stacks;
  for (const id of e.targets) { const u = ctx.state.units[id]; if (u) dealAndEmit(ctx, u, bonus); }
  removeStatus(ctx.self, "stack", stackName);
});

// ── Cluster 6 — minion & summon variants (implemented to exact prose) ────────── //

// keeper:myth (Wise Old Man): on Keeper's death, split his Tales-to-Tell Shield evenly among living
// allied Heroes, each share rounded UP to the nearest increment of 5.
registerCustom("distributeShieldOnDeathRoundedTo5", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "unitDied" || e.unit !== ctx.self.id) return;
  const total = totalShield(ctx.self);
  if (total <= 0) return;
  const allies = resolveSelector((a.to as Selector) ?? { faction: "allies", kind: "hero", alive: true }, ctx).filter((u) => u.id !== ctx.self.id);
  if (!allies.length) return;
  const share = Math.ceil(total / allies.length / 5) * 5;
  for (const u of allies) addShield(u, share, null, ctx.self.id, ctx.state.turn);
});

// xyris:mirror (Darkness and Truth): the named minion templates ignore counters (uncounterable) and
// stuns (a "Stun Immunity" mark). Re-applied each round to freshly-summoned minions.
registerCustom("minionsIgnoreCountersAndStuns", (ctx, a) => {
  const templates = (a.templates as string[]) ?? [];
  for (const u of resolveSelector({ faction: "allies", kind: "minion" }, ctx)) {
    if (!templates.includes(u.name)) continue;
    applyStatus(u, { kind: "uncounterable", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    applyStatus(u, { kind: "mark", name: "Stun Immunity", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// syl:nomad (Scavenger's Path, 1st clause): any unit death creates a Scavenger's Pile — but a Pile
// does not spawn another Pile.
registerCustom("createScavengerPile", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "unitDied") return;
  const dead = ctx.state.units[e.unit];
  if (dead && ((a.skipTemplates as string[]) ?? []).includes(dead.name)) return;
  runInContext([{ op: "summon", template: a.template as string, count: 1 }], ctx);
});

// syl:nomad (Scavenger's Path, 2nd clause): if Syl's Eagle (her non-Pile minion) kills a Scavenger's
// Pile, the Eagle heals 25 and Leyline Nest (syl5) costs 1 less specific until used.
registerCustom("eagleKillScavenger", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "unitDied") return;
  const pile = a.pileTemplate as string;
  const dead = ctx.state.units[e.unit];
  const killer = e.killer ? ctx.state.units[e.killer] : undefined;
  if (!dead || dead.name !== pile) return;
  if (!killer || killer.kind !== "minion" || killer.summoner !== ctx.self.id || killer.name === pile) return;
  applyHeal(killer, num(a.healAmount, 25));
  const skillId = a.leylineSkillId as string;
  const skill = (ctx.self.skills ?? []).find((s) => s.id === skillId);
  if (skill) {
    const cur = ctx.self.statuses.find((s) => s.kind === "cost_mod" && s.skillId === skillId)?.magnitude ?? 0;
    applyStatus(ctx.self, { kind: "cost_mod", skillId, magnitude: Math.max(-skill.cost.specific, cur - num(a.costReduction, 1)), duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// syl:nomad (Pick the Bones): 15 damage, DOUBLED vs a Scavenger's Pile; if it kills the target, Syl's
// team gains Elemental Essence.
registerCustom("pickTheBonesDamage", (ctx, a) => {
  const target = resolveSelector((a.target as Selector) ?? "target", ctx)[0];
  if (!target) return;
  let dmg = num(a.base, 15);
  if (a.doubleVsPile && target.name === (a.pileTemplate as string)) dmg *= 2;
  const wasAlive = target.alive;
  dealAndEmit(ctx, target, dmg);
  if (wasAlive && !target.alive) {
    for (const ally of resolveSelector({ faction: "allies", kind: "hero" }, ctx)) applyStatus(ally, { kind: "elemental_essence", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// ── Cluster 7 — damage multipliers (implemented to exact prose) ──────────────── //

// gommar:crystal (Frosted Facets: "Gommar takes half damage from new Harmful skills"): a permanent
// x0.5 incoming multiplier scoped to new skill hits (isNew). Re-applied each round.
registerCustom("incomingDamageMultiplier", (ctx, a) => {
  for (const u of resolveSelector((a.of as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "incoming_damage_mult", magnitude: num(a.factor, 0.5), newDamageOnly: a.newOnly !== false, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// pyrrha:ritual (Ritual of Agony: "all units will permanently receive double damage"): a permanent x2
// incoming multiplier on EVERY unit, both teams (the authored `if` latches it at 75 Ritual Power).
registerCustom("ritualDoubleAllDamage", (ctx) => {
  for (const u of Object.values(ctx.state.units)) {
    applyStatus(u, { kind: "incoming_damage_mult", magnitude: 2, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// titania:faerie (Burning Order: "Target Summer Courtesan deals triple damage this turn"): a x3 OUTGOING
// multiplier on the target for `turns`.
registerCustom("tripleDamageThisTurn", (ctx, a) => {
  for (const u of resolveSelector((a.target as Selector) ?? "target", ctx)) {
    applyStatus(u, { kind: "outgoing_damage_mult", magnitude: 3, duration: num(a.turns, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// ── Cluster 8 — damage-type override & conditional bypass (implemented to exact prose) ───────── //

// taryn:vigilante (Glorious Justice, while outnumbered): "his damage changed to Piercing" — a 1-turn
// outgoing type override, re-applied each of his turns while the branch holds (auto-expires otherwise).
registerCustom("damageBecomesPiercing", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "outgoing_dtype_override", dtype: "piercing", duration: (a.duration as number | null) ?? null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// syl:ghost (Silent Wingbeats: "Syl and her Eagle now Bypass against Isolated targets"): the listed
// units' damage ignores DR + Shield against any Isolated target.
registerCustom("bypassVsIsolated", (ctx, a) => {
  const sels = (a.units as Selector[]) ?? ["self"];
  for (const sel of sels) for (const u of resolveSelector(sel, ctx)) {
    applyStatus(u, { kind: "conditional_bypass", bypassCond: { kind: "isolated" }, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// xyris:ninja (Dream Infiltration: "Xyris's skills Bypass against targets affected by Enter the
// Dreamscape"): Xyris's damage ignores DR + Shield against any target holding the named mark.
registerCustom("bypassVsDreamscapeAffected", (ctx, a) => {
  applyStatus(ctx.self, { kind: "conditional_bypass", bypassCond: { kind: "mark", name: a.markName as string }, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// ── Cluster 9 — heal-to-damage conversion & inverted HP (implemented to exact prose) ──────────── //

// titania:antidote (Gift from the Fae, harmful version): "any healing the target receives for the next
// 3 turns is dealt as Affliction damage instead" — a heal_becomes_damage status for `turns`.
registerCustom("healReceivedBecomesAffliction", (ctx, a) => {
  for (const u of resolveSelector((a.target as Selector) ?? "target", ctx)) {
    applyStatus(u, { kind: "heal_becomes_damage", dtype: "affliction", duration: num(a.turns, 3), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// xyris:curse (Hypnagogic Curse): "starts at 1HP. Damage now heals him, and healing damages him. Dies
// when he reaches 100 HP." Sets HP to 1 and installs the inverted-HP statuses (permanent, re-set each round).
registerCustom("curseStartAtOneHp", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    u.hp = num(a.hp, 1);
    applyStatus(u, { kind: "damage_becomes_heal", duration: null, appliedBy: u.id, appliedTurn: ctx.state.turn });
    applyStatus(u, { kind: "heal_becomes_damage", duration: null, appliedBy: u.id, appliedTurn: ctx.state.turn });
    applyStatus(u, { kind: "dies_at_max", duration: null, appliedBy: u.id, appliedTurn: ctx.state.turn });
  }
});

// ── Cluster 10 — skill-use triggers, cleanses & simple status ops (implemented to exact prose) ─── //

/** True when the firing event is `self` using the named skill. */
function usedOwnSkill(ctx: Ctx, skillId: string): boolean {
  const e = ctx.event;
  return !!e && e.type === "skillUsed" && e.skillId === skillId && e.caster === ctx.self.id;
}
/** Resolve a selector, falling back to the skillUsed event's targets (which use `targets`, not `target`). */
function resolveWithSkillTargets(ctx: Ctx, sel: Selector): Unit[] {
  const r = resolveSelector(sel, ctx);
  if (r.length) return r;
  const e = ctx.event;
  if (e && e.type === "skillUsed") return e.targets.map((id) => ctx.state.units[id]).filter((u): u is Unit => !!u);
  return [];
}
/** A debuff an enemy would apply (signed mods classified by magnitude). */
function isHarmfulStatus(s: Status): boolean {
  switch (s.kind) {
    case "stun": case "silence": case "paralysis": case "blind": case "taunt": case "isolated":
    case "heal_lock": case "dot": case "shatter": case "heal_becomes_damage": return true;
    case "incoming_damage_mod": case "cost_mod": case "cooldown_mod": return (s.magnitude ?? 0) > 0;
    case "outgoing_damage_mod": return (s.magnitude ?? 0) < 0;
    case "incoming_damage_mult": return (s.magnitude ?? 1) > 1;
    case "outgoing_damage_mult": return (s.magnitude ?? 1) < 1;
    default: return false;
  }
}
/** A buff a hero would want to keep. */
function isBeneficialStatus(s: Status): boolean {
  switch (s.kind) {
    case "damage_reduction": case "invulnerable": case "immortal": case "revive_ward":
    case "elemental_essence": case "uncounterable": case "regen": case "stealth":
    case "damage_ignore": case "non_damage_ignore": case "damage_becomes_heal": return true;
    case "outgoing_damage_mod": return (s.magnitude ?? 0) > 0;
    case "incoming_damage_mod": case "cost_mod": case "cooldown_mod": return (s.magnitude ?? 0) < 0;
    case "incoming_damage_mult": return (s.magnitude ?? 1) < 1;
    case "outgoing_damage_mult": return (s.magnitude ?? 1) > 1;
    default: return false;
  }
}

// syl:ninja (To the Skies! -> Syl Invulnerable 1 turn).
registerCustom("invulnOnSkill", (ctx, a) => {
  if (!usedOwnSkill(ctx, a.skillId as string)) return;
  applyStatus(ctx.self, { kind: "invulnerable", duration: num(a.invulnDuration, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// taryn:angel (Stalwart Shield -> Taryn + its targeted allies Invulnerable 1 turn, Taryn gains Essence).
registerCustom("onStalwartShield", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const dur = num(a.invulnDuration, 1);
  applyStatus(ctx.self, { kind: "invulnerable", duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  for (const id of e.targets) { const t = ctx.state.units[id]; if (t) applyStatus(t, { kind: "invulnerable", duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn }); }
  applyStatus(ctx.self, { kind: "elemental_essence", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// syl:angel (Skylance -> Taunt its target onto Syl, and give Syl 10 Shield for 1 turn).
registerCustom("skylanceTauntAndShield", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const dur = num(a.shieldDuration, 1);
  for (const id of e.targets) { const t = ctx.state.units[id]; if (t) applyStatus(t, { kind: "taunt", unitRef: ctx.self.id, duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn }); }
  addShield(ctx.self, num(a.shieldAmount, 10), dur, ctx.self.id, ctx.state.turn);
});

// zephyrex:storm (triggering Wind Step marks all enemies with Ominous Rumble).
registerCustom("ominousRumbleOnWindStep", (ctx, a) => {
  if (!usedOwnSkill(ctx, a.triggerSkillId as string)) return;
  for (const u of resolveSelector({ faction: "enemies" }, ctx)) applyStatus(u, { kind: "mark", name: a.mark as string, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// xyris:night (Paralyzes the targets' cooldowns for a duration).
registerCustom("paralyzeCooldowns", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? { faction: "enemies" }, ctx)) applyStatus(u, { kind: "paralysis", duration: num(a.duration, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// ando:current / taryn:anointment (when a named mark is applied, set its duration directly — no re-emit).
registerCustom("setStatusDuration", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusApplied" || e.kind !== (a.kind as string) || e.name !== (a.name as string)) return;
  for (const u of resolveSelector((a.to as Selector) ?? "eventUnit", ctx)) {
    const s = u.statuses.find((x) => x.kind === (a.kind as string) && x.name === (a.name as string));
    if (s) s.duration = (a.duration as number | null) ?? null;
  }
});

// keeper:aurora (20 Shield, 30 if another allied hero acted this turn, 45 if both did).
registerCustom("grantTieredShieldByAlliesActed", (ctx, a) => {
  const amounts = (a.amounts as number[]) ?? [20, 30, 45];
  const others = ctx.state.teams[ctx.self.team].units.filter(
    (id) => id !== ctx.self.id && ctx.state.actedThisTurn.includes(id) && ctx.state.units[id]?.kind === "hero",
  ).length;
  const amt = amounts[Math.min(others, amounts.length - 1)]!;
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) addShield(u, amt, null, ctx.self.id, ctx.state.turn);
});

// saya:plasma (gaining Elemental Essence heals 10; Saya cannot be healed any other way -> heal_lock).
registerCustom("essenceHeal", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusApplied" || e.kind !== (a.statusKind as string) || e.unit !== ctx.self.id) return;
  applyHeal(ctx.self, num(a.amount, 10)); // direct heal bypasses the heal_lock (which gates exec heals)
  applyStatus(ctx.self, { kind: "heal_lock", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// riverdaughter:glacier (Soothe heals 5 now, 10 next turn, 15 the turn after).
registerCustom("escalatingHeal", (ctx, a) => {
  const e = ctx.event;
  if (e && e.type === "skillUsed" && a.skillId && e.skillId !== (a.skillId as string)) return; // Soothe only
  const tgt = resolveWithSkillTargets(ctx, (a.to as Selector) ?? "eventTarget")[0];
  if (!tgt) return;
  for (const step of (a.schedule as { delayTurns: number; amount: number }[]) ?? []) {
    if (step.delayTurns <= 0) applyHeal(tgt, step.amount);
    else ctx.state.scheduled.push({ effect: [{ op: "heal", amount: step.amount }], caster: ctx.self.id, targets: [tgt.id], turns: step.delayTurns, appliedTurn: ctx.state.turn });
  }
});

// taryn:antidote (cleanse one BENEFICIAL effect from an enemy).
registerCustom("cleanseBeneficial", (ctx, a) => {
  const count = num(a.count, 1);
  for (const u of resolveSelector((a.from as Selector) ?? "target", ctx)) {
    let removed = 0;
    u.statuses = u.statuses.filter((s) => (removed < count && isBeneficialStatus(s)) ? (removed++, false) : true);
  }
});

// hector:antidote (remove ONE harmful effect from an ally, on serum application/expiration).
const HECTOR_SERUMS = ["Burning Blood Serum", "Stoneseal Serum", "Mindfog Serum"];
registerCustom("removeOneHarmful", (ctx, a) => {
  // Only fire when a Serum is applied to / expires from an ALLY — not on every status or for enemies.
  const e = ctx.event;
  if (e && (e.type === "statusApplied" || e.type === "statusExpired")) {
    if (!e.name || !HECTOR_SERUMS.includes(e.name)) return;
    const u = ctx.state.units[e.unit];
    if (u && u.team !== ctx.self.team) return;
  }
  for (const u of resolveSelector((a.from as Selector) ?? "eventUnit", ctx)) {
    const i = u.statuses.findIndex(isHarmfulStatus);
    if (i >= 0) u.statuses.splice(i, 1);
  }
});

// hector:antidote / riverdaughter:anointment (cleanse ALL enemy-applied effects from an ally).
registerCustom("cleanseEnemyEffects", (ctx, a) => {
  const e = ctx.event;
  if (e && e.type === "skillUsed" && a.skillId && e.skillId !== (a.skillId as string)) return; // Soothe only (river form)
  for (const u of resolveWithSkillTargets(ctx, (a.to as Selector) ?? (a.from as Selector) ?? "target")) {
    u.statuses = u.statuses.filter((s) => {
      const applier = ctx.state.units[s.appliedBy];
      return !(applier && applier.team !== u.team); // drop effects applied by an enemy of this unit
    });
  }
});

// ── Cluster 11 — ledger punishes, chance procs, execute, links & targeting (to exact prose) ────── //

// ando:current (Rising Geyser): marked units replicate all new damage they take to every OTHER marked
// unit. Install a round-permanent link once; the replicate deals directly (no emit) so it can't loop.
registerCustom("risingGeyserLink", (ctx, a) => {
  const mark = a.mark as string;
  if ((ctx.self.triggers ?? []).some((t) => t.source === "Rising Geyser Link")) return; // install once
  installWatch(ctx, {
    on: "damageDealt", source: "Rising Geyser Link",
    when: { has: "mark", name: mark, of: "eventTarget" },
    effect: [{ op: "custom", fn: "replicateDamageToMarked", args: { mark } }],
  }, null);
});
registerCustom("replicateDamageToMarked", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.amount <= 0 || !e.isNew) return; // "all NEW damage" — not DoT ticks
  const mark = a.mark as string;
  for (const u of Object.values(ctx.state.units)) {
    if (u.id === e.target || !u.alive) continue;
    if (u.statuses.some((s) => s.kind === "mark" && s.name === mark)) applyDamage(u, { amount: e.amount, type: "normal" }); // direct: no re-trigger
  }
});

// ando:thunder (God of Thunder): this skill takes DOUBLE benefit — deal an extra hit equal to Ando's
// accumulated outgoing_damage_mod to each enemy.
registerCustom("doubleGodOfThunder", (ctx, a) => {
  const bonus = ctx.self.statuses.filter((s) => s.kind === "outgoing_damage_mod").reduce((t, s) => t + (s.magnitude ?? 0), 0);
  if (bonus <= 0) return;
  for (const u of resolveSelector((a.to as Selector) ?? { faction: "enemies" }, ctx)) dealAndEmit(ctx, u, bonus, "piercing");
});

// jarrik:devil (Belphegor's Blade): at each turn-end, Jarrik and each Cinders-enemy who did NOT act this
// turn take 15 Affliction.
registerCustom("belphegorsBladeIdlePunish", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd") return;
  const mark = a.mark as string;
  for (const id of ctx.state.teams[e.team].units) {
    const u = ctx.state.units[id];
    if (!u || !u.alive) continue;
    const applies = u.id === ctx.self.id || (u.team !== ctx.self.team && u.statuses.some((s) => s.kind === "mark" && s.name === mark));
    if (applies && !ctx.state.actedThisTurn.includes(u.id)) dealAndEmit(ctx, u, num(a.amount, 15), (a.dtype as DamageType) ?? "affliction");
  }
});

// saya:current (Constant Flux): each coil ticks its base +/- a random multiple of `step` in
// [varianceMin, varianceMax], to a random enemy.
registerCustom("constantFluxCoilTick", (ctx, a) => {
  const opts: number[] = [];
  for (let v = num(a.varianceMin, -10); v <= num(a.varianceMax, 10); v += num(a.step, 5)) opts.push(v);
  const roll = () => opts[Math.floor(ctx.rng.next() * opts.length)] ?? 0;
  const coils = stackOf(ctx.self, a.coilStack as string)?.magnitude ?? 0;
  const enhanced = stackOf(ctx.self, a.enhancedStack as string)?.magnitude ?? 0;
  let total = 0;
  for (let i = 0; i < coils; i++) total += Math.max(0, num(a.base, 10) + roll());
  for (let i = 0; i < enhanced; i++) total += Math.max(0, num(a.enhancedBase, 20) + roll());
  const target = resolveSelector((a.to as Selector) ?? { pick: "random", from: { faction: "enemies" }, count: 1 }, ctx)[0];
  if (target && total > 0) dealAndEmit(ctx, target, total, "normal"); // base Saya Coil is normal damage
});

// titania:assassin (Thorn Prick): a Thorn-Prick hit that drops a minion below `threshold` HP executes it.
registerCustom("thornPrickExecute", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt") return;
  if (e.sourceId !== (a.skillId as string) && e.sourceId !== (a.dotName as string)) return;
  const u = ctx.state.units[e.target];
  if (u && u.alive && u.kind === "minion" && u.hp < num(a.threshold, 20)) {
    u.hp = 0; u.alive = false;
    ctx.emit({ type: "unitDied", unit: u.id, killer: ctx.self.id });
  }
});

// titania:blight (Five Plagues): on Titania's Affliction damage, 10% per stack to inflict a random effect.
registerCustom("fivePlaguesProc", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.dtype !== "affliction") return;
  const stacks = stackOf(ctx.self, a.stackName as string)?.magnitude ?? 0;
  if (stacks <= 0) return;
  if (ctx.rng.next() >= num(a.chancePerStack, 0.1) * stacks) return;
  const u = ctx.state.units[e.target];
  if (!u) return;
  const dur = num(a.duration, 1);
  const pool = (a.effects as string[]) ?? [];
  const pick = pool[Math.floor(ctx.rng.next() * pool.length)];
  const at = { appliedBy: ctx.self.id, appliedTurn: ctx.state.turn };
  if (pick === "shatter") applyStatus(u, { kind: "shatter", duration: dur, ...at });
  else if (pick === "isolated") applyStatus(u, { kind: "isolated", duration: dur, ...at });
  else if (pick === "costIncrease") applyStatus(u, { kind: "cost_mod", magnitude: 1, duration: dur, ...at });
  else if (pick === "stunNonStrategic") applyStatus(u, { kind: "stun", scope: { tag: "Strategic", mode: "except" }, duration: dur, ...at });
  else if (pick === "stunStrategic") applyStatus(u, { kind: "stun", scope: { tag: "Strategic", mode: "only" }, duration: dur, ...at });
});

// zephyrex:nomad (Sand in the Eyes): Zephyrex cannot be chosen as a target by a Blinded caster's skills.
registerCustom("untargetableByBlindedSkills", (ctx, a) => {
  for (const u of resolveSelector((a.to as Selector) ?? "self", ctx)) {
    applyStatus(u, { kind: "mark", name: "Blind-Untargetable", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// laria:night (Reveal): the "see invisible effects" clause is cosmetic — the isHidden/invisible flag is a
// deferred, unmodelled presentation concept, so there is nothing mechanical to reveal (faithful no-op).
registerCustom("revealEnemyInvisibleEffects", () => { /* cosmetic: no hidden-effect system to reveal */ });

// ── Cluster 12 — shields, watch-afflict, clone & stack mechanics (to exact prose) ─────────────── //

// saya:aurora (Plasma Shield -> all allied Heroes get the shield + 2-turn Affliction immunity).
registerCustom("prismaticShielding", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const dur = num(a.afflictionIgnoreTurns, 2);
  // Exclude Saya herself — the base Plasma Shield already shields the caster (avoid double-shielding).
  for (const u of resolveSelector((a.to as Selector) ?? { faction: "allies", kind: "hero", includeSelf: false }, ctx)) {
    if (u.id === ctx.self.id) continue;
    addShield(u, num(a.shield, 40), dur, ctx.self.id, ctx.state.turn);
    applyStatus(u, { kind: "damage_ignore", dtype: "affliction", duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// taryn:antidote (Stalwart Shield ends -> Taryn + marked allies heal 5 per enemy-applied effect on them).
registerCustom("purifyingShieldHeal", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "shieldBroken" || e.unit !== ctx.self.id) return;
  const per = num(a.perEnemyEffect, 5);
  const healByEffects = (u: Unit) => {
    const n = u.statuses.filter((s) => { const ap = ctx.state.units[s.appliedBy]; return ap && ap.team !== u.team; }).length;
    if (n > 0) applyHeal(u, per * n);
  };
  healByEffects(ctx.self);
  for (const u of resolveSelector({ faction: "allies", kind: "hero" }, ctx)) {
    if (u.id !== ctx.self.id && u.statuses.some((s) => s.kind === "mark" && s.name === (a.markName as string))) healByEffects(u);
  }
});

// titania:serum (target enemy permanently Isolated; if it uses a Helpful skill it takes 20 Affliction).
registerCustom("afflictOnHelpfulUse", (ctx, a) => {
  markUnits(ctx, (a.target as Selector) ?? "target", "Hysteria", null);
  for (const u of resolveSelector((a.target as Selector) ?? "target", ctx)) {
    applyStatus(u, { kind: "isolated", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
  if (!(ctx.self.triggers ?? []).some((t) => t.source === "Hysteria Watch")) {
    installWatch(ctx, {
      on: "skillUsed", source: "Hysteria Watch",
      when: { and: [{ has: "mark", name: "Hysteria", of: "eventSource" }, { eventHasTag: "Helpful" }] },
      effect: [{ op: "damage", amount: num(a.affliction, 20), dtype: "affliction", to: "eventSource" }],
    }, null);
  }
});

// xyris:mirror (create a Simulacrum with 30 HP possessing the target's Basic skills, re-elemented to Xyris).
registerCustom("cloneBasicSkillsOntoSimulacrum", (ctx, a) => {
  const template = a.minionTemplate as string;
  runInContext([{ op: "summon", template, count: 1, hp: 30 }], ctx);
  const mine = Object.values(ctx.state.units)
    // empty skills = the fresh Simulacrum just summoned; if the summon no-op'd at the minion cap this is
    // empty and the handler bails rather than re-copying onto an older, already-populated Simulacrum.
    .filter((u) => u.kind === "minion" && u.name === template && u.summoner === ctx.self.id && (u.skills ?? []).length === 0)
    .sort((x, y) => Number(x.id.split(":").pop()) - Number(y.id.split(":").pop()));
  const sim = mine[mine.length - 1];
  const src = resolveSelector((a.copyFrom as Selector) ?? "target", ctx)[0];
  if (!sim || !src) return;
  sim.skills = (src.skills ?? []).filter((s) => s.klass === "basic").map((s) => ({ ...JSON.parse(JSON.stringify(s)) as SkillInstance, currentCd: 0 }));
  sim.currentElement = ctx.self.currentElement; // Specific costs match Xyris's element
});

// zevkir:glacier (Riptide adds Freezing Brine per Call Tides; at 5 stacks the enemy is stunned + consumed).
registerCustom("freezingBrineOnRiptide", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const per = stackOf(ctx.self, "Call Tides")?.magnitude ?? 0;
  if (per <= 0) return;
  const brine = a.stackName as string;
  for (const id of e.targets) {
    const u = ctx.state.units[id];
    if (!u || u.team === ctx.self.team) continue;
    applyStatus(u, { kind: "stack", name: brine, magnitude: per, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    if ((stackOf(u, brine)?.magnitude ?? 0) >= num(a.threshold, 5)) {
      applyStatus(u, { kind: "stun", duration: num(a.stunTurns, 1), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
      removeStatus(u, "stack", brine);
    }
  }
});

// zevkir:slime (consume Call Tides -> grant the team 10 Shield per turn for that many turns). Reads the
// EFFECTIVE Call Tides via stackCount so Stinking Marsh's floorZero (raw 0 -> reads 2) empowers it, matching
// the skill's sibling cost_mod which already reads {ref:stackCount}.
registerCustom("shieldPerTurnForDuration", (ctx, a) => {
  const turns = stackCount(ctx.self, "Call Tides");
  if (turns <= 0) return;
  removeStatus(ctx.self, "stack", "Call Tides");
  const allyIds = resolveSelector((a.to as Selector) ?? { faction: "allies", includeSelf: true }, ctx).map((u) => u.id);
  const amt = num(a.amount, 10);
  for (let i = 0; i < turns; i++) {
    if (i === 0) for (const id of allyIds) { const u = ctx.state.units[id]; if (u) addShield(u, amt, null, ctx.self.id, ctx.state.turn); }
    else ctx.state.scheduled.push({ effect: [{ op: "grantShield", amount: amt }], caster: ctx.self.id, targets: allyIds, turns: i, appliedTurn: ctx.state.turn });
  }
});

// ── Cluster 13 — empower windows, retaliation & stack-spend (to exact prose) ──────────────────── //

// syl:storm (Lightning Crash): for 3 turns, each Skylance also hits 2 random enemies for 5 Piercing and
// grants Syl Essence. The window is a watch; its effect gates on the Skylance skill id.
registerCustom("lightningCrashSkylanceEmpower", (ctx, a) => {
  installWatch(ctx, {
    on: "skillUsed", source: "Lightning Crash", when: { sameUnit: ["eventSource", "self"] },
    effect: [{ op: "custom", fn: "skylanceEmpowerHit", args: { skillId: a.skillId, bonusDamage: a.bonusDamage, dtype: a.dtype, extraTargets: a.extraTargets, grantEssence: a.grantEssence } }],
  }, num(a.turns, 3));
});
registerCustom("skylanceEmpowerHit", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  for (const u of ctx.rng.shuffle(resolveSelector({ faction: "enemies" }, ctx)).slice(0, num(a.extraTargets, 2))) {
    dealAndEmit(ctx, u, num(a.bonusDamage, 5), (a.dtype as DamageType) ?? "piercing");
  }
  if (a.grantEssence) applyStatus(ctx.self, { kind: "elemental_essence", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// taryn:judgment (Forced Harmony): when Taryn uses Inspiring Thrust, its Forced-Harmony-marked targets take
// an extra (double) hit, consuming the mark.
registerCustom("forcedHarmonyBonus", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.skillId !== (a.skillId as string) || e.caster !== ctx.self.id) return;
  const mark = a.markName as string;
  for (const id of e.targets) {
    const u = ctx.state.units[id];
    if (u && u.statuses.some((s) => s.kind === "mark" && s.name === mark)) {
      dealAndEmit(ctx, u, num(a.bonusDamage, 20));
      removeStatus(u, "mark", mark);
    }
  }
});

// taryn:vigilante (Restrain): while Restrain holds, if Taryn takes new damage the damaging enemy's stun
// (Restrain) lasts 1 turn longer.
registerCustom("restrainRetaliate", (ctx, a) => {
  installWatch(ctx, {
    on: "damageDealt", source: "Restrain Retaliate", when: { sameUnit: ["eventTarget", "self"] },
    effect: [{ op: "custom", fn: "extendStunOnDamager", args: { extendBy: a.extendBy } }],
  }, num(a.turns, 1));
});
registerCustom("extendStunOnDamager", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || !e.source || !e.isNew) return; // NEW damage only, not DoT ticks
  const dmgr = ctx.state.units[e.source];
  // Only EXTEND an existing Restrain (stun) on the damager — do not stun an un-Restrained enemy.
  const stun = dmgr?.statuses.find((s) => s.kind === "stun");
  if (stun && stun.duration !== null) stun.duration += num(a.extendBy, 1);
});

// riverdaughter:mirror (Reflection of Kindness): each 50 banked healing → Essence + 15 Affliction to all
// enemies (consume in a loop so multiple thresholds fire).
registerCustom("spendStack", (ctx, a) => {
  const name = a.name as string;
  const amount = num(a.amount, 50);
  const s = stackOf(ctx.self, name);
  while (s && (s.magnitude ?? 0) >= amount) {
    s.magnitude = (s.magnitude ?? 0) - amount;
    applyStatus(ctx.self, { kind: "elemental_essence", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    for (const u of resolveSelector({ faction: "enemies" }, ctx)) dealAndEmit(ctx, u, 15, "affliction");
  }
});

// ── Cluster 14 — Hector's serum system, summon-swap & channeled skill-mods (to exact prose) ─────── //

// The three Serums are applied by Hector's basic skills; "apply a Serum" means run that skill's real
// effect on the target (the full stack + rider), so every serum keeps its authored behaviour.
const SERUM_NAME_BY_SKILL: Record<string, string> = { hector1: "Burning Blood Serum", hector2: "Stoneseal Serum", hector3: "Mindfog Serum" };
const SERUM_SKILL_IDS = ["hector1", "hector2", "hector3"];
function applySerum(ctx: Ctx, target: Unit, skillId: string): void {
  const skill = (ctx.self.skills ?? []).find((s) => s.id === skillId);
  if (!skill) return;
  runInContext(skill.effects, { ...ctx, caster: ctx.self, self: ctx.self, targets: [target], it: null });
}

// hector:battery ("Applies a random Serum to Dennis that he isn't already affected by whenever Hector
// gains energy from Elemental Essence") and hector:faerie ("Hector will use a random serum on the first
// character to use a skill on him each turn").
registerCustom("applyRandomSerum", (ctx, a) => {
  // faerie: once per turn — a duration-1 self mark holds the guard until Hector's next turn-end.
  if (a.oncePerTurn && ctx.self.statuses.some((s) => s.kind === "mark" && s.name === "Faerie Serum Used")) return;
  const target = resolveSelector((a.to as Selector) ?? "eventSource", ctx)[0];
  if (!target) return;
  let pool = SERUM_SKILL_IDS;
  if (a.excludeExisting) pool = pool.filter((sid) => !target.statuses.some((s) => s.name === SERUM_NAME_BY_SKILL[sid]));
  if (!pool.length) return;
  applySerum(ctx, target, ctx.rng.pick(pool));
  if (a.oncePerTurn) applyStatus(ctx.self, { kind: "mark", name: "Faerie Serum Used", duration: 1, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// hector:serum (Serum Avatar): "Deals 5 Affliction damage to all enemies for each serum on Hector each
// turn for 3 turns. During this time he ignores non-damage effects." A per-turn watch re-counts the
// serums on Hector so a serum gained/lost mid-window changes the pulse.
registerCustom("avatarSerum", (ctx, a) => {
  installWatch(ctx, {
    on: "turnStart", source: "Serum Avatar",
    effect: [{ op: "custom", fn: "avatarSerumTick", args: { damagePerSerum: a.damagePerSerum, dtype: a.dtype } }],
  }, num(a.turns, 3));
  applyStatus(ctx.self, { kind: "non_damage_ignore", duration: num(a.turns, 3), appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});
registerCustom("avatarSerumTick", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnStart" || e.team !== ctx.self.team) return;
  const count = SERUM_SKILL_IDS.filter((sid) => ctx.self.statuses.some((s) => s.name === SERUM_NAME_BY_SKILL[sid])).length;
  if (count <= 0) return;
  const dmg = num(a.damagePerSerum, 5) * count;
  for (const u of resolveSelector({ faction: "enemies" }, ctx)) dealAndEmit(ctx, u, dmg, (a.dtype as DamageType) ?? "affliction");
});

// hector:serum (2nd clause): "Applies any Serums Hector uses to himself as well."
registerCustom("mirrorUsedSerumToSelf", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster !== ctx.self.id) return;
  if (!SERUM_NAME_BY_SKILL[e.skillId]) return; // only the serum-applying skills
  const target = resolveSelector((a.to as Selector) ?? "self", ctx)[0];
  if (target) applySerum(ctx, target, e.skillId);
});

// titania:stasis (Winter Exile): "Titania can no longer create Summer Courtesan minions. When she uses
// Summer Clique, she instead creates Winter Loyalist minions." The base skill still creates them, so on
// Summer Clique we re-badge her Summer Courtesans as Winter Loyalists (no registered template to swap to).
registerCustom("winterExileSummon", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster !== ctx.self.id || e.skillId !== (a.skillId as string)) return;
  const from = a.fromTemplate as string, to = a.toTemplate as string;
  for (const u of Object.values(ctx.state.units)) {
    if (u.alive && u.kind === "minion" && u.summoner === ctx.self.id && u.name === from) u.name = to;
  }
});

// zevkir:mist (Misty Mire): "Bubble Prison will now target all enemies, dealing 15 Piercing damage to a
// random target per turn. This damage Bypasses [shields]." The base imprison (a 15/turn "Bubble Prison"
// dot lasting 1 + Call Tides stacks) reaches every enemy — only the ≥3-stack branch did natively — and a
// per-turn bypass strike hits a random enemy for the same window. (The base's single-target conditional
// stun is left as the base skill applies it.)
registerCustom("mistyMireBubblePrison", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster !== ctx.self.id || e.skillId !== (a.skillId as string)) return;
  const turns = 1 + (stackOf(ctx.self, "Call Tides")?.magnitude ?? 0);
  for (const u of resolveSelector((a.to as Selector) ?? { faction: "enemies" }, ctx)) {
    applyStatus(u, { kind: "dot", name: "Bubble Prison", magnitude: 15, dtype: "normal", duration: turns, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
  installWatch(ctx, {
    on: "turnStart", source: "Misty Mire",
    effect: [{ op: "custom", fn: "mistyMireTick", args: { perTurnDamage: a.perTurnDamage, dtype: a.dtype } }],
  }, turns);
});
registerCustom("mistyMireTick", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnStart" || e.team !== ctx.self.team) return;
  const enemies = resolveSelector({ faction: "enemies" }, ctx).filter((u) => u.alive);
  if (!enemies.length) return;
  dealAndEmit(ctx, ctx.rng.pick(enemies), num(a.perTurnDamage, 15), (a.dtype as DamageType) ?? "piercing", true);
});

// ── Cluster 15 — delayed strikes, per-turn strikes & heal→damage redirects (to exact prose) ─────── //

// zephyrex:mist (Cleave the Veil): "targets one enemy. At the end of his next turn, if he has not
// received a new harmful skill, he deals 45 piercing damage to the targeted enemy. Channeled." The hit
// is a scheduled effect; an interrupt watch cancels it if a harmful skill lands on Zephyrex first.
registerCustom("cleaveTheVeil", (ctx, a) => {
  const target = resolveSelector((a.target as Selector) ?? "target", ctx)[0];
  if (!target) return;
  applyStatus(target, { kind: "mark", name: "Cleave Target", duration: 2, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  applyStatus(ctx.self, { kind: "mark", name: "Cleave Charging", duration: 2, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  if (a.cancelOnHarmfulSkillReceived) {
    installWatch(ctx, { on: "skillUsed", source: "Cleave the Veil", effect: [{ op: "custom", fn: "cleaveInterrupt", args: {} }] }, 2);
  }
  ctx.state.scheduled.push({
    effect: [{ op: "custom", fn: "cleaveResolve", args: { amount: a.amount, dtype: a.dtype } }],
    caster: ctx.self.id, targets: [], turns: num(a.delayTurns, 1), appliedTurn: ctx.state.turn,
  });
});
registerCustom("cleaveInterrupt", (ctx) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster === ctx.self.id) return; // his own skills don't cancel it
  if (!e.targets.includes(ctx.self.id)) return;
  if (!(e.tags ?? []).includes("Harmful")) return; // "a new harmful skill" received
  removeStatus(ctx.self, "mark", "Cleave Charging");
});
registerCustom("cleaveResolve", (ctx, a) => {
  const charging = ctx.self.statuses.some((s) => s.kind === "mark" && s.name === "Cleave Charging");
  const target = Object.values(ctx.state.units).find((u) => u.alive && u.statuses.some((s) => s.kind === "mark" && s.name === "Cleave Target"));
  removeStatus(ctx.self, "mark", "Cleave Charging");
  if (target) removeStatus(target, "mark", "Cleave Target");
  if (charging && target) dealAndEmit(ctx, target, num(a.amount, 45), (a.dtype as DamageType) ?? "piercing");
});

// saya:storm (Lightning Rod): "Saya will deal 5 damage to a random enemy per stack of Lightning Rod on
// her. She will gain a stack of Lightning Rod whenever Saya gains energy from Elemental Essence." Two
// round-permanent watches: the per-turn strike and the essence stack-gain.
registerCustom("lightningRod", (ctx, a) => {
  const stackName = a.stackName as string;
  installWatch(ctx, {
    on: "turnStart", source: "Lightning Rod",
    effect: [{ op: "custom", fn: "lightningRodTick", args: { perStack: a.perStack, stackName } }],
  }, null);
  installWatch(ctx, {
    on: "energyFromEssence", source: "Lightning Rod", when: { sameUnit: ["eventUnit", "self"] },
    effect: [{ op: "addStack", name: stackName, amount: 1, to: "self" }],
  }, null);
});
registerCustom("lightningRodTick", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnStart" || e.team !== ctx.self.team) return;
  const stacks = stackOf(ctx.self, a.stackName as string)?.magnitude ?? 0;
  // "5 damage to a random enemy per stack" — one independently-chosen random enemy per stack.
  for (let i = 0; i < stacks; i++) {
    const enemies = resolveSelector({ faction: "enemies" }, ctx).filter((u) => u.alive);
    if (!enemies.length) break;
    dealAndEmit(ctx, ctx.rng.pick(enemies), num(a.perStack, 5), "normal");
  }
});

// titania:serum (Laughing Serum): "Laughing Powder's damage over time is doubled, and when it transfers
// to a new target, the current target receives 15 Affliction damage." The DOUBLE is implemented (double
// the dot's magnitude on its own application). The transfer rider is unreachable: the base Laughing
// Powder dot has no target-transfer mechanic in this engine, so there is no transfer moment to hook.
registerCustom("doubleLaughingPowder", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusApplied" || e.source !== ctx.self.id) return;
  const name = a.name as string;
  if (e.kind !== "dot" || e.name !== name) return; // only the Laughing Powder dot's own application doubles it
  for (const u of resolveSelector((a.to as Selector) ?? "eventUnit", ctx)) {
    const dot = u.statuses.find((s) => s.kind === "dot" && s.name === name);
    if (dot) dot.magnitude = (dot.magnitude ?? 0) * 2;
  }
});

// riverdaughter:serum (Font of Cruelty): "Any overhealing done by River Daughter is dealt to a random
// enemy as Affliction damage." Reads the overheal the heal op now reports on the healReceived event.
registerCustom("overhealAsAffliction", (ctx) => {
  const e = ctx.event;
  if (!e || e.type !== "healReceived" || e.source !== ctx.self.id) return;
  const over = e.overheal ?? 0;
  if (over <= 0) return;
  const enemies = resolveSelector({ faction: "enemies" }, ctx).filter((u) => u.alive);
  if (enemies.length) dealAndEmit(ctx, ctx.rng.pick(enemies), over, "affliction");
});

// ── Cluster 16 — positional & targeting restrictions (to exact prose) ──────────────────────────── //

// syl:mist (Flutter in the Fog): "At the end of her turn, Syl becomes invulnerable for 1 turn. If she
// became invulnerable this way on her last turn, her Eagle becomes invulnerable for 1 turn instead. The
// turn after making her Eagle invulnerable, this effect will not [fire]." A 3-state cycle at her turn-end.
registerCustom("flutterInTheFog", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd" || e.team !== ctx.self.team) return;
  const dur = num(a.invulnDuration, 1);
  const inactive = a.inactiveMark as string;
  const has = (n: string) => ctx.self.statuses.some((s) => s.kind === "mark" && s.name === n);
  if (has(inactive)) { removeStatus(ctx.self, "mark", inactive); return; } // the skipped turn
  if (has("Flutter Self")) {
    removeStatus(ctx.self, "mark", "Flutter Self");
    for (const eagle of resolveSelector((a.eagle as Selector) ?? { faction: "allies", kind: "minion" }, ctx)) {
      applyStatus(eagle, { kind: "invulnerable", duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    }
    applyStatus(ctx.self, { kind: "mark", name: inactive, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  } else {
    applyStatus(ctx.self, { kind: "invulnerable", duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    applyStatus(ctx.self, { kind: "mark", name: "Flutter Self", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// maggie:reanimation (Reanimate): "For the next 3 turns, target ally will become Immortal. During this
// time, they can only target Maggie or enemies affected by Bramblelash. At the end of this skill's
// duration, the target dies." Immortal(+onExpire defeat) + a "Reanimated" mark the target-legality reads.
registerCustom("restrictTargetingToMaggieOrBramblelash", (ctx, a) => {
  const turns = num(a.durationTurns, 3);
  for (const u of resolveSelector((a.to as Selector) ?? "target", ctx)) {
    applyStatus(u, { kind: "immortal", duration: turns, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn, onExpire: [{ op: "defeat" }] });
    applyStatus(u, { kind: "mark", name: "Reanimated", duration: turns, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// ── Cluster 17 — derived stack-reads (the stack_read_mod primitive; to exact prose) ─────────────── //

// laria:vigilante (Evencoin, 2nd clause): "Characters with Evencoins are treated as though they have triple
// their actual stacks of Deepening Shadows." A live-gated mult read-mod (applied to every hero, inert unless
// the holder actually carries an Evencoin). The first-killing-blow Evencoin grant is a co-authored DSL
// unitDied trigger, NOT this fn.
registerCustom("evencoinTripleShadows", (ctx) => {
  for (const u of resolveSelector({ faction: "all" }, ctx)) {
    if (u.kind !== "hero") continue;
    applyStatus(u, { kind: "stack_read_mod", name: "Deepening Shadows", mode: "mult", magnitude: 3, readModIf: "Evencoin", duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// zevkir:slime (Stinking Marsh): "When Zev'kir has no stacks of Call Tides, his skills are treated as though
// he had two, and deal Affliction damage instead." A floorZero read-mod (raw 0 -> reads `treatAsStacks`) +
// a gated outgoing_dtype_override (forces Affliction only while raw Call Tides is 0 — direct hits via the
// damage op AND DoT ticks). The "10 Affliction on 0-stack skill use" clause is the re-authored skillUsed
// trigger (afflictSelfIfRawStackZero), which fires on skillDeclared (PRE-resolution) so it reads the RAW
// Call Tides count as it was at cast time — before the skill's own effects can mutate it — and the floor
// (which makes the effective read report 2) does not mask a true 0.
registerCustom("stinkingMarshZeroStackMod", (ctx, a) => {
  const name = a.stackName as string;
  applyStatus(ctx.self, { kind: "stack_read_mod", name, mode: "floorZero", magnitude: num(a.treatAsStacks, 2), duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  applyStatus(ctx.self, { kind: "outgoing_dtype_override", dtype: (a.dtype as DamageType) ?? "affliction", overrideIfStackZero: name, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});
registerCustom("afflictSelfIfRawStackZero", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillDeclared" || e.caster !== ctx.self.id) return;
  if (rawStackCount(ctx.self, a.stackName as string) !== 0) return;
  dealAndEmit(ctx, ctx.self, num(a.amount, 10), (a.dtype as DamageType) ?? "affliction");
});

// zevkir:serum (Rapid Mutation): "For every 15 Health he is missing, Zev'kir has one additional stack of
// Call Tides." A missingHp read-mod. The "5 Affliction at end of each of his turns" clause is a co-authored
// turnEnd trigger, NOT this fn.
registerCustom("callTidesFromMissingHp", (ctx, a) => {
  applyStatus(ctx.self, { kind: "stack_read_mod", name: a.stackName as string, mode: "missingHp", magnitude: num(a.perMissingHp, 15), duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// ── Cluster 18 — eagle/minion skill mods, granted skills & channel-instant (to exact prose) ─────── //

// The Eagle's evolution stages (Leyline Nest evolves Hatchling -> Adult -> Ancient), read from its name.
const EAGLE_STAGE: Record<string, number> = { "Hatchling Eagle": 0, "Adult Eagle": 1, "Ancient Eagle": 2 };

// syl:cloud (Great Roc): "Syl's Eagle minion's skills ... last 1 additional turn." (The "cost 1 more"
// clause is the sibling authored global cost_mod.) Bump every numeric status/stack/shield duration the
// eagle's skills apply by `durationDelta`. Detach each shared minion-skill effect tree first (minions copy
// skills shallowly, sharing the template's effect arrays), and `once`-guard so the round-start re-fire
// doesn't compound. A duration-0 status is lifetime-identical to a duration-1 one (the birth-turn tick is
// skipped), so it is floored to 1 before the bump to actually gain a turn.
registerCustom("extendEagleSkillDurations", (ctx, a) => {
  const delta = num(a.durationDelta, 1);
  for (const eagle of resolveSelector((a.eagle as Selector) ?? { faction: "allies", kind: "minion" }, ctx)) {
    if (!(eagle.name in EAGLE_STAGE)) continue; // only Syl's Eagle, not other allied minions
    for (const s of eagle.skills ?? []) {
      if (!DETACHED.has(s)) { s.effects = JSON.parse(JSON.stringify(s.effects)); DETACHED.add(s); }
      if (!once(s, "extendEagleSkillDurations")) continue;
      walkNodes(s.effects, (e) => {
        if (e.op === "applyStatus" && typeof e.status.duration === "number") e.status.duration = Math.max(e.status.duration, 1) + delta;
        else if (e.op === "addStack" && typeof e.duration === "number") e.duration = Math.max(e.duration, 1) + delta;
        else if (e.op === "grantShield" && typeof e.duration === "number") e.duration = Math.max(e.duration, 1) + delta;
      });
    }
  }
});

// syl:cloud (Sky Drop): "This skill deals 10 more damage and stuns for 1 more turn per stage her Eagle has
// evolved this round." (The base 25 damage + 0-turn stun are authored ops that precede this custom.) Stage
// is the Eagle's current rank read from its template name.
registerCustom("skyDropEagleStageBonus", (ctx, a) => {
  const eagle = resolveSelector({ faction: "allies", kind: "minion" }, ctx).find((u) => u.name in EAGLE_STAGE);
  const stage = eagle ? (EAGLE_STAGE[eagle.name] ?? 0) : 0;
  if (stage <= 0) return;
  const target = resolveSelector((a.target as Selector) ?? "target", ctx)[0];
  if (!target) return;
  const bonusDmg = num(a.perStageDamage, 10) * stage;
  if (bonusDmg > 0) dealAndEmit(ctx, target, bonusDmg);
  const bonusStun = num(a.perStageStun, 1) * stage;
  if (bonusStun > 0) {
    const stun = target.statuses.find((s) => s.kind === "stun" && !s.scope);
    if (stun && typeof stun.duration === "number") stun.duration += bonusStun;
    else applyStatus(target, { kind: "stun", duration: bonusStun, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// roland:life (Living Boulder): "Boulder minions now have Living Lash." Living Lash (rolandlivingboulder1)
// has no engine-content definition, so its SkillInstance is transcribed here (frozen/skills.json: 10 normal
// to target, single-target Harmful+Instant, cost 0/0, cd 1). Hooks minion CREATION (minionSummoned): Roland
// summons Boulders only mid-round via Form Stone, so a round-start sweep would find none.
const LIVING_LASH: SkillInstance = {
  id: "rolandlivingboulder1", name: "Living Lash", element: "life", targeting: "single", klass: "basic",
  tags: ["Harmful", "Instant"], cost: { generic: 0, specific: 0 }, cooldown: 1, currentCd: 0,
  effects: [{ op: "damage", amount: 10, to: "target" }],
};
registerCustom("grantSkillToTemplate", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "minionSummoned") return;
  if (e.template !== (a.template as string) || e.summoner !== ctx.self.id) return;
  const minion = ctx.state.units[e.unit];
  if (!minion) return;
  if ((minion.skills ?? []).some((s) => s.id === (a.skillId as string))) return;
  minion.skills = [...(minion.skills ?? []), { ...LIVING_LASH, cost: { ...LIVING_LASH.cost }, tags: [...LIVING_LASH.tags], currentCd: 0 }];
  ctx.emit({ type: "skillGranted", unit: minion.id, skillId: LIVING_LASH.id, source: ctx.self.id });
});

// zephyrex:angel (Light of Raphael): "During this time, Elegant Sweep hits instantly." (The 20 Shield + the
// window mark are authored DSL ops.) An instant_cast status for the named skill makes its Channel resolve
// entirely on cast (no sustained re-runs) for the mark's remaining duration.
registerCustom("skillCastsInstantlyWhileMarked", (ctx, a) => {
  const mark = ctx.self.statuses.find((s) => s.kind === "mark" && s.name === (a.mark as string));
  const dur = mark && typeof mark.duration === "number" ? mark.duration : 3;
  applyStatus(ctx.self, { kind: "instant_cast", skillId: a.skillId as string, duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});

// xyris:assassin (Before I Wake): "When Enter the Dreamscape ends, affected enemies receive damage equal to
// the damage they received while it was active." Companion A stamps the namesake mark (xyris2 leaves none);
// companion B (storeDamageDealt) banks each hit taken while marked into "Dreamscape Damage"; this release
// pays the tally back as `true` damage (un-mitigated, so it EQUALS the damage received) when the mark expires.
registerCustom("applyDreamscapeMark", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster !== ctx.self.id || e.skillId !== (a.skillId as string)) return;
  const dur = (a.duration as number | null) ?? 2;
  for (const id of e.targets) {
    const u = ctx.state.units[id];
    if (u) applyStatus(u, { kind: "mark", name: a.markName as string, duration: dur, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});
registerCustom("dreamscapeEndDamage", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "statusExpired" || e.kind !== "mark" || e.name !== (a.markName as string)) return;
  const u = resolveSelector((a.to as Selector) ?? "eventUnit", ctx)[0];
  if (!u) return;
  const banked = stackOf(u, "Dreamscape Damage")?.magnitude ?? 0;
  removeStatus(u, "stack", "Dreamscape Damage");
  if (banked > 0) dealAndEmit(ctx, u, banked, "true");
});

// ── Cluster 19 — summon-execute & Fae-Prince per-turn accrual (to exact prose) ──────────────────── //

// titania:brimstone (Barren Realm): "Whenever she would create a Summer Courtesan, she instead deals 10
// Affliction damage to the enemy target with the lowest HP (random if tied). This effect Bypasses
// invulnerability." Hooks minion CREATION (minionSummoned): each Summer Courtesan Titania creates is deleted
// on the spot — which frees the minion-cap slot so the next one in the same summon op is created too, making
// the interception count equal the would-be count (Prance) rather than the cap-limited survivors. Deleting
// also converts every courtesan SOURCE (Summer Clique AND the titania4 augment), not just one cast.
// Affliction ignores DR/Shield; direct damage ignores the invulnerable targeting gate, so this "Bypasses
// invulnerability". (The "generate a Summer Clique stack when she takes damage" clause is a co-authored trigger.)
registerCustom("barrenRealmExecute", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "minionSummoned" || e.summoner !== ctx.self.id) return;
  const minion = ctx.state.units[e.unit];
  if (!minion || minion.name !== "Summer Courtesan") return;
  const team = ctx.state.teams[ctx.self.team];
  delete ctx.state.units[e.unit];
  team.units = team.units.filter((id) => id !== e.unit);
  const enemies = resolveSelector({ faction: "enemies" }, ctx).filter((u) => u.alive);
  if (!enemies.length) return;
  const minHp = Math.min(...enemies.map((u) => u.hp));
  const lowest = enemies.filter((u) => u.hp === minHp);
  dealAndEmit(ctx, lowest.length === 1 ? lowest[0]! : ctx.rng.pick(lowest), num(a.perStack, 10), "affliction");
});

// zephyrex:faerie (Fae Prince): "Every turn that an enemy Hero doesn't deal damage to Zephyrex, that enemy
// receives 10 additional damage from Zephyrex's next damaging ability." recordDamagedZephyrex writes the
// per-turn ledger (real hits only); faePrinceAccrue stocks the bonus at the enemy team's turn-end for those
// who didn't; faePrinceConsume pays it out (times the stock) on Zephyrex's next damaging hit and clears it.
registerCustom("recordDamagedZephyrex", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.target !== ctx.self.id || e.amount <= 0) return;
  const src = e.source ? ctx.state.units[e.source] : undefined;
  if (!src || src.team === ctx.self.team || src.kind !== "hero") return; // a real hit from an enemy hero
  applyStatus(src, { kind: "mark", name: a.mark as string, duration: 1, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
});
registerCustom("faePrinceAccrue", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "turnEnd" || e.team === ctx.self.team) return; // the enemy team's turn-end
  const mark = a.mark as string;
  for (const enemy of resolveSelector({ faction: "enemies", kind: "hero" }, ctx)) {
    const damaged = enemy.statuses.some((s) => s.kind === "mark" && s.name === "Damaged Zephyrex");
    if (!damaged) applyStatus(enemy, { kind: "stack", name: mark, magnitude: 1, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
    removeStatus(enemy, "mark", "Damaged Zephyrex");
  }
});
registerCustom("faePrinceConsume", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "damageDealt" || e.source !== ctx.self.id) return;
  const target = ctx.state.units[e.target];
  if (!target) return;
  const mark = a.mark as string;
  const count = stackOf(target, mark)?.magnitude ?? 0;
  if (count <= 0) return;
  removeStatus(target, "stack", mark); // consume BEFORE dealing (the re-emitted damage re-enters this trigger)
  dealAndEmit(ctx, target, num(a.amount, 10) * count, e.dtype);
});

// ── Final cluster — the 6 hard holdouts (to exact prose) ────────────────────────────────────────── //

// xyris:ninja (Steal Secrets): "creates a Dream Reflection minion with a copy of the skill that the
// targeted enemy used last ... will fail if the target has not yet used a skill." The handler OWNS the
// summon (so a failed clone leaves no minion) and clones the target's last-used SkillInstance onto the
// fresh minion's xyrisminion1 placeholder, re-elementing its specific cost to Xyris's element. The
// "affected by Enter the Dreamscape" gate is the authored inline `if`.
registerCustom("cloneLastUsedSkillOntoMinion", (ctx, a) => {
  const src = resolveSelector((a.copyFrom as Selector) ?? "target", ctx)[0];
  if (!src || !src.lastSkillId) return; // "will fail if the target has not yet used a skill"
  const srcSkill = (src.skills ?? []).find((s) => s.id === src.lastSkillId);
  if (!srcSkill) return;
  const template = a.minionTemplate as string;
  const placeholder = a.placeholderSkillId as string;
  runInContext([{ op: "summon", template, count: 1, hp: 35 }], ctx);
  const minion = Object.values(ctx.state.units)
    .filter((u) => u.kind === "minion" && u.name === template && u.summoner === ctx.caster.id && (u.skills ?? []).some((s) => s.id === placeholder))
    .sort((x, y) => Number(x.id.split(":").pop()) - Number(y.id.split(":").pop()))
    .pop();
  if (!minion) return; // the 6-minion cap blocked the summon
  const clone: SkillInstance = { ...JSON.parse(JSON.stringify(srcSkill)), currentCd: 0 };
  const skills = minion.skills ?? [];
  const idx = skills.findIndex((s) => s.id === placeholder);
  if (idx >= 0) skills[idx] = clone; else skills.push(clone);
  minion.skills = skills;
  if (a.reelementSpecificCostTo === "casterCurrentElement") minion.currentElement = ctx.caster.currentElement;
});

// titania:evolution (Hive Formation): "if Titania uses Barbed Wit, the Taunt effect redirects to a random
// ally with Hive Formation." A 4-turn watch that, when Titania uses Barbed Wit, rewrites the taunt slot on
// each freshly-taunted enemy to point at a random Hive-Formation ally. (The Compound Eyes / Hive Formation
// marks are applied declaratively by the skill.)
registerCustom("hiveFormationRedirect", (ctx, a) => {
  installWatch(ctx, {
    on: "skillUsed", source: "Hive Formation", when: { sameUnit: ["eventSource", "self"] },
    effect: [{ op: "custom", fn: "redirectBarbedWitTaunt", args: { skillId: a.skillId, markName: a.markName } }],
  }, num(a.turns, 4));
});
registerCustom("redirectBarbedWitTaunt", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster !== ctx.self.id || e.skillId !== (a.skillId as string)) return;
  const pool = resolveSelector({ filter: { faction: "allies" }, with: { kind: "mark", name: a.markName as string } }, ctx);
  if (!pool.length) return;
  for (const id of e.targets) {
    const taunt = ctx.state.units[id]?.statuses.find((s) => s.kind === "taunt");
    if (taunt) taunt.unitRef = ctx.rng.pick(pool).id;
  }
});

// ando:magnet (Magnetic Reprisal): "Whenever Ando's skills gain additional targets, he gains 10 Shield for
// each extra target affected." Reads the skill's `affected` ledger (every enemy it actually hit/statused);
// the "extra" ones are the affected enemies beyond the single declared target.
registerCustom("shieldPerExtraTarget", (ctx, a) => {
  const e = ctx.event;
  if (!e || e.type !== "skillUsed" || e.caster !== ctx.self.id) return;
  const declared = new Set(e.targets);
  let extra = 0;
  for (const id of new Set(e.affected ?? [])) {
    if (declared.has(id)) continue;
    const u = ctx.state.units[id];
    if (!u || u.team === ctx.self.team) continue; // only enemies of Ando count as extra targets
    extra++;
  }
  if (extra > 0) addShield(ctx.self, num(a.perTarget, 10) * extra, null, ctx.self.id, ctx.state.turn);
});

// syl:winter (Mountain Rescue Team): "Feed can now target any stunned ally. Swoop can now be used to make a
// stunned ally invulnerable for 1 turn." Feed (Syl's own skill, so observable) gains a stunned-ally branch
// that heals the chosen ally instead of only her Eagle; Swoop (the Eagle's skill) gains a stunned-ally
// invuln branch. Both mirror extendEagleSkillDurations' detach + once-guard. (The Swoop half is inert until
// Syl's Eagle actually summons — a separate base-wiring gap.)
function wrapStunnedAllyBranch(s: SkillInstance, fn: string, then: Effect[]): void {
  if (!DETACHED.has(s)) { s.effects = JSON.parse(JSON.stringify(s.effects)); DETACHED.add(s); }
  if (!once(s, fn)) return;
  s.effects = [{
    op: "if",
    cond: { and: [{ has: "stun", of: "target" }, { isFaction: "target", faction: "ally" }] },
    then, else: s.effects,
  }];
}
registerCustom("mountainRescueTeam", (ctx, a) => {
  const invuln = num(a.invulnDuration, 1);
  // Feed: heal the targeted stunned ally 20 (+ Essence to Syl if that ally ends at max HP, mirroring base).
  const feed = mutableSkill(ctx, a.feedSkillId as string);
  if (feed) wrapStunnedAllyBranch(feed, "mountainRescueTeam", [
    { op: "heal", amount: 20, to: "target" },
    { op: "if", cond: { cmp: "==", left: { ref: "missingHp", of: "target" }, right: 0 }, then: [{ op: "applyStatus", to: "self", status: { kind: "elemental_essence", duration: null } }] },
  ]);
  // Swoop: the Eagle's skill — make a targeted stunned ally invulnerable.
  for (const eagle of resolveSelector({ faction: "allies", kind: "minion" }, ctx)) {
    if (!(eagle.name in EAGLE_STAGE)) continue;
    const s = (eagle.skills ?? []).find((x) => x.id === (a.swoopSkillId as string));
    if (s) wrapStunnedAllyBranch(s, "mountainRescueTeam", [{ op: "applyStatus", to: "target", status: { kind: "invulnerable", duration: invuln } }]);
  }
});

// titania:battery (The Whimsy Engine): "For the next 1 turn, any time a unit uses a new skill, they will
// instead use a random one of their skills with randomly selected targets." A `replace`-kind skillDeclared
// trigger (checked before Uncounterable) cancels the declared skill and, in its place, runs a random skill
// of the declaring unit against random legal targets. The base skill marks every unit for the 1-turn window;
// the watch fires only for a marked caster. Running effects (not performAction) means no declaration
// recursion, so the replacement is never itself whimsied.
registerCustom("whimsyEngine", (ctx, a) => {
  const spec = {
    on: "skillDeclared" as const, kind: "replace" as const, source: "The Whimsy Engine",
    when: { has: "mark" as const, name: "The Whimsy Engine", of: "eventSource" as const },
    effect: [{ op: "custom" as const, fn: "whimsyReplace", args: {} }],
  };
  // Install on EVERY unit so the field effect survives Titania's death within its window (findReplace skips
  // dead owners; first match wins, so the redundant copies never double-fire).
  for (const u of resolveSelector({ faction: "all" }, ctx)) installWatch(ctx, spec, num(a.turns, 1), u);
});
function whimsyTargets(ctx: Ctx, skill: SkillInstance): Unit[] {
  if (skill.targeting !== "single") return []; // self/AOE skills resolve their own faction selectors
  const harmful = skill.tags.includes("Harmful");
  const helpful = skill.tags.includes("Helpful");
  const pool = harmful ? resolveSelector({ faction: "enemies" }, ctx)
    : helpful ? resolveSelector({ faction: "allies" }, ctx)
    : [ctx.self];
  // Honour target legality (invulnerable/isolated/untargetable + taunt-forcing + blind-random) exactly as a normal cast.
  const legal = legalTargets(ctx.state, ctx.self, skill, pool, ctx.rng);
  return legal.length ? [ctx.rng.pick(legal)] : [];
}
registerCustom("whimsyReplace", (ctx) => {
  const actor = resolveSelector("eventSource", ctx)[0];
  if (!actor || !(actor.skills ?? []).length) return; // still cancels the original (acceptable)
  const chosen = ctx.rng.pick(actor.skills!);
  const affected = new Set<string>();
  const actorCtx: Ctx = { ...ctx, caster: actor, self: actor, it: null, targets: [], affected };
  const targets = whimsyTargets(actorCtx, chosen);
  runInContext(chosen.effects, { ...actorCtx, targets });
  // The substitution IS a real skill use — surface it as skillUsed (NOT skillDeclared, to keep the
  // no-declaration-recursion guarantee) so other skillUsed reactions observe it.
  ctx.emit({ type: "skillUsed", caster: actor.id, skillId: chosen.id, targets: targets.map((t) => t.id), tags: chosen.tags, affected: [...affected] });
});

// saya:ion (Ion Coils): "Saya Coils can no longer be Enhanced and gain a maximum stack of 2, but are
// applied 2 at a time." Rewrites Saya Coil (saya2) to always add `perCast` plain coils (no Enhanced branch),
// and lowers the cap in its `requires` bound to `maxStack`. (panicIgnoresCoils is moot under the base fusion
// — replace-mode drops the Panic-arming trigger — so that clause has no live effect and is not built.)
registerCustom("ionCoilRules", (ctx, a) => {
  const s2 = mutableSkill(ctx, "saya2");
  if (!s2 || !once(s2, "ionCoilRules")) return;
  s2.effects = [{ op: "addStack", name: a.coilStack as string, amount: num(a.perCast, 2), to: "self" }];
  if (s2.requires) {
    const req = JSON.parse(JSON.stringify(s2.requires));
    if (req && typeof req === "object" && "cmp" in req) req.right = num(a.maxStack, 2);
    s2.requires = req;
  }
});

// ── Fusion-minion custom handlers ────────────────────────────────────────────────────────────────── //

// hector:battery (Synthesizer). Synthesize Serum: "stores a permanent copy of all Serums on the target that
// it does not currently have." For each Hector serum present on the source that the Synthesizer lacks, record
// a permanent "Stored Serum: <name>" mark on the Synthesizer (deduped by serum type).
registerCustom("synthesizeSerum", (ctx, a) => {
  const src = resolveSelector((a.from as Selector) ?? "target", ctx)[0];
  if (!src) return;
  for (const sid of SERUM_SKILL_IDS) {
    const name = SERUM_NAME_BY_SKILL[sid]!;
    const stored = `Stored Serum: ${name}`;
    const srcHas = src.statuses.some((s) => s.name === name);
    const alreadyStored = ctx.self.statuses.some((s) => s.kind === "mark" && s.name === stored);
    if (srcHas && !alreadyStored) applyStatus(ctx.self, { kind: "mark", name: stored, duration: null, appliedBy: ctx.self.id, appliedTurn: ctx.state.turn });
  }
});

// hector:battery (Synthesizer). Catalyze Serum: "applies all of its stored serums to target unit." Re-runs
// the summoner Hector's serum skill for each stored serum (stored serums are permanent, not consumed). The
// Synthesizer does not own hector1/2/3, so the serum effects are sourced from the summoner.
registerCustom("catalyzeSerum", (ctx, a) => {
  const target = resolveSelector((a.to as Selector) ?? "target", ctx)[0];
  const hector = resolveSelector("summoner", ctx)[0];
  if (!target || !hector) return;
  for (const sid of SERUM_SKILL_IDS) {
    const stored = `Stored Serum: ${SERUM_NAME_BY_SKILL[sid]}`;
    if (!ctx.self.statuses.some((s) => s.kind === "mark" && s.name === stored)) continue;
    const skill = (hector.skills ?? []).find((s) => s.id === sid);
    if (skill) runInContext(skill.effects, { ...ctx, caster: hector, self: hector, targets: [target], it: null });
  }
});

// maggie:lich (Lash of Servitude): the Revenant raised when Maggie kills an enemy Hero copies that hero's 3
// Basic skills. The unitDied trigger's summon op already created the Revenant (hp 25); this only fills the
// freshest one's kit with deep-clones of the dead hero's basics (no re-summon, no re-element per the prose).
registerCustom("cloneBasicSkillsOntoRevenant", (ctx, a) => {
  const src = resolveSelector((a.copyFrom as Selector) ?? "eventUnit", ctx)[0];
  const template = (a.minionTemplate as string) ?? "Revenant";
  const revenant = Object.values(ctx.state.units)
    // empty skills = a fresh, un-populated Revenant; if the summon no-op'd at the minion cap this yields
    // none (rather than overwriting an older, already-populated Revenant).
    .filter((u) => u.kind === "minion" && u.name === template && u.summoner === ctx.self.id && (u.skills ?? []).length === 0)
    .sort((x, y) => Number(x.id.split(":").pop()) - Number(y.id.split(":").pop()))
    .pop();
  if (!src || !revenant) return;
  revenant.skills = (src.skills ?? []).filter((s) => s.klass === "basic").map((s) => ({ ...JSON.parse(JSON.stringify(s)) as SkillInstance, currentCd: 0 }));
});
