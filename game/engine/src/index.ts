/** @arena/engine — public surface (P1 kernel). */
export * from "./types.ts";
export { RULINGS, applyRounding } from "./rulings.ts";
export { Rng } from "./rng.ts";
export {
  applyDamage,
  applyHeal,
  applyHealthLoss,
  damageReduction,
  incomingDamageMod,
  has,
  totalShield,
  addShield,
  spendShield,
  tickShieldsForTeam,
  outgoingDamageMod,
} from "./damage.ts";
export type { DamageInstance, DamageResult, HealResult } from "./damage.ts";
export {
  applyStatus,
  removeStatus,
  stackCount,
  tickDurationsForTeam,
  clearRoundStatuses,
} from "./status.ts";
export type {
  Effect,
  Value,
  Selector,
  Condition,
  StatusSpec,
  SkillDef,
  NodeId,
} from "./effects/ast.ts";
export { findNode, replaceNode, mapNode, wrapNode } from "./effects/patch.ts";
export { runEffects, exec, evalValue, evalCondition, evalSkillCondition, resolveSelector, registerCustom, createBus, emit, resolveDeclaration } from "./effects/interpret.ts";
export type { Ctx, CustomFn, Bus, DeclarationResult } from "./effects/interpret.ts";
export type { GameEvent, TriggeredEffect, TriggerKind } from "./events.ts";
export { MAX_TRIGGER_DEPTH } from "./events.ts";
export type { MinionTemplate } from "./minions.ts";
export { registerMinion, getMinionTemplate, clearMinionRegistry } from "./minions.ts";
export { removeDeadMinions } from "./scheduler.ts";
export type { SkillInstance, EnergyCost } from "./skill.ts";
export {
  startRound,
  roundWinner,
  endRound,
  grantIncome,
  advanceCooldowns,
  startTurn,
  endTurn,
  tickDots,
  runChannels,
  performAction,
  resolveTurn,
  canPay,
  canUse,
  effectiveCost,
  effectiveCooldown,
  legalTargets,
} from "./scheduler.ts";
export type { Action, ActionResult, ActionRejection } from "./scheduler.ts";
