/**
 * The damage / heal / health-loss pipeline.
 *
 * This is the load-bearing subsystem (ruling DAMAGE_CHANNELS, confidence HIGH). The
 * glossary proves there are TWO distinct defender-side subtraction channels that the
 * damage types treat differently:
 *
 *   - incoming damage-mods  (e.g. gommarwinter0 "+5 received")  — bypassed only by TRUE
 *   - Damage Reduction      (a flat shield-like subtraction)    — bypassed by PIERCING,
 *                                                                  AFFLICTION and TRUE,
 *                                                                  and suppressed by Shatter
 *
 * Merging them would mis-price every Piercing skill. The per-type capability mask
 * below is the single source of that behaviour — never re-encode it as if-chains.
 *
 * Defender-side order (ruling MITIGATION_ORDER):
 *   Damage Ignore -> incoming mods -> [Shatter voids DR+Shield] -> DR -> Shield
 *   -> apply to HP (Immortal floors at 1).
 */
import type { DamageType, MatchState, ShieldInstance, Status, StatusKind, TeamId, Unit } from "./types.ts";
import { applyRounding, RULINGS } from "./rulings.ts";

/** Total shield currently on a unit. */
export function totalShield(u: Unit): number {
  let t = 0;
  for (const s of u.shields) t += s.amount;
  return t;
}

/** Grant a shield instance (grantShield effect). */
export function addShield(
  u: Unit,
  amount: number,
  duration: number | null,
  appliedBy: string,
  appliedTurn: number,
  id?: string,
): void {
  if (amount <= 0) return;
  u.shields.push({ amount, duration, appliedBy, appliedTurn, id });
}

/**
 * Spend up to `amount` of a unit's shield outright (a cost, not damage — used by skills that
 * consume their own Shield). Drains instances in order and drops emptied ones. Returns the
 * amount actually spent (capped at what was available).
 */
export function spendShield(u: Unit, amount: number): number {
  let remaining = Math.max(0, amount);
  let spent = 0;
  for (const sh of u.shields) {
    if (remaining <= 0) break;
    const take = Math.min(sh.amount, remaining);
    sh.amount -= take;
    remaining -= take;
    spent += take;
  }
  u.shields = u.shields.filter((sh) => sh.amount > 0);
  return spent;
}

/** Expire timed shields at the applier's turn-end (same anchor as status durations). */
export function tickShieldsForTeam(state: MatchState, team: TeamId): void {
  for (const u of Object.values(state.units)) {
    const kept: ShieldInstance[] = [];
    for (const sh of u.shields) {
      const owner = state.units[sh.appliedBy];
      const byTeam = owner ? owner.team === team : false;
      if (byTeam && sh.duration !== null && sh.appliedTurn < state.turn) {
        const next = sh.duration - 1;
        if (next <= 0) continue; // expired
        sh.duration = next;
      }
      kept.push(sh);
    }
    u.shields = kept;
  }
}

/** true in a slot = this damage type IGNORES that mitigation stage. */
const IGNORES: Record<DamageType, { mods: boolean; dr: boolean; shield: boolean }> = {
  normal: { mods: false, dr: false, shield: false },
  piercing: { mods: false, dr: true, shield: false },
  affliction: { mods: false, dr: true, shield: true },
  true: { mods: true, dr: true, shield: true },
};

export function has(u: Unit, kind: StatusKind): boolean {
  return u.statuses.some((s) => s.kind === kind);
}

/** Does the target ignore this specific damage (all, or filtered by type/source)? */
function ignoresDamage(target: Unit, dmg: DamageInstance): boolean {
  return target.statuses.some(
    (s) =>
      s.kind === "damage_ignore" &&
      (s.dtype === undefined || s.dtype === dmg.type) &&
      (s.name === undefined || s.name === dmg.sourceId),
  );
}

function sumMagnitude(u: Unit, kind: StatusKind): number {
  let total = 0;
  for (const s of u.statuses) if (s.kind === kind) total += s.magnitude ?? 0;
  return total;
}

export function damageReduction(u: Unit): number {
  return sumMagnitude(u, "damage_reduction");
}

/** Net defender-side incoming modifier; +N means the unit takes N MORE damage. */
export function incomingDamageMod(u: Unit): number {
  return sumMagnitude(u, "incoming_damage_mod");
}

/** Per-hit cap on how much Shield the unit may spend absorbing one hit (Infinity = uncapped; most restrictive wins). */
export function shieldAbsorbCap(u: Unit): number {
  let m = Infinity;
  for (const s of u.statuses) if (s.kind === "shield_absorb_cap") m = Math.min(m, s.magnitude ?? Infinity);
  return m;
}

/**
 * Net attacker-side outgoing modifier; +N means the DEALER deals N more. Applies only
 * to normal/piercing (Affliction is "commonly not affected by damage-boosting effects";
 * True is never modified — DAMAGE_CHANNELS ruling).
 */
export function outgoingDamageMod(u: Unit, dtype: DamageType): number {
  return dtype === "normal" || dtype === "piercing" ? sumMagnitude(u, "outgoing_damage_mod") : 0;
}

/** Product of the defender's incoming multipliers (0.5 = half, 2 = double). `newDamageOnly` mults skip DoTs. */
function incomingDamageMult(u: Unit, isNew: boolean | undefined): number {
  let f = 1;
  for (const s of u.statuses) {
    if (s.kind !== "incoming_damage_mult") continue;
    if (s.newDamageOnly && !isNew) continue;
    f *= s.magnitude ?? 1;
  }
  return f;
}

/** Product of the attacker's outgoing multipliers (e.g. triple damage). Applies to every damage type. */
export function outgoingDamageMult(u: Unit): number {
  let f = 1;
  for (const s of u.statuses) if (s.kind === "outgoing_damage_mult") f *= s.magnitude ?? 1;
  return f;
}

/** The type the attacker's outgoing damage is forced to (e.g. Piercing), if any. */
export function outgoingDtypeOverride(u: Unit): DamageType | undefined {
  const s = u.statuses.find((x) => x.kind === "outgoing_dtype_override");
  if (!s) return undefined;
  // A gated override (e.g. Stinking Marsh) only forces its type while the holder has 0 RAW stacks of the named resource.
  if (s.overrideIfStackZero !== undefined) {
    const raw = u.statuses.find((x) => x.kind === "stack" && x.name === s.overrideIfStackZero)?.magnitude ?? 0;
    if (raw > 0) return undefined;
  }
  return s.dtype;
}

/** Does the attacker's damage Bypass (ignore DR + Shield) against this target (conditional_bypass)? */
export function bypassesAgainst(attacker: Unit, target: Unit): boolean {
  return attacker.statuses.some(
    (s) => s.kind === "conditional_bypass" && s.bypassCond !== undefined &&
      target.statuses.some((t) => t.kind === s.bypassCond!.kind && (s.bypassCond!.name === undefined || t.name === s.bypassCond!.name)),
  );
}

export interface DamageInstance {
  /** Attacker-side value already constructed (base + scaling + flats + multipliers). */
  amount: number;
  type: DamageType;
  /** A "new" skill instance (vs an ongoing DoT/affliction tick) — see ruling IS_NEW. */
  isNew?: boolean;
  sourceId?: string;
  /** This hit Bypasses — ignores Damage Reduction AND Shield (conditional_bypass resolved at cast). */
  bypass?: boolean;
}

export interface DamageResult {
  requested: number;
  /** HP actually removed. This is the post-mitigation figure accumulators read. */
  hpLost: number;
  shieldAbsorbed: number;
  /** The unit had shield and it was fully broken by this hit. */
  shieldBroke: boolean;
  finalHp: number;
  lethal: boolean;
}

export function applyDamage(target: Unit, dmg: DamageInstance): DamageResult {
  const requested = Math.max(0, applyRounding(dmg.amount));

  // 1. Damage Ignore — voids matching damage. A bare damage_ignore voids everything;
  //    one with a dtype and/or name (source) voids only that type/source.
  if (ignoresDamage(target, dmg)) {
    return { requested, hpLost: 0, shieldAbsorbed: 0, shieldBroke: false, finalHp: target.hp, lethal: false };
  }

  // Inverted HP ("damage now heals him"): the hit heals instead of harming, and can trip dies_at_max.
  if (has(target, "damage_becomes_heal")) {
    target.hp = Math.min(target.maxHp, target.hp + requested);
    const lethal = has(target, "dies_at_max") && target.hp >= target.maxHp;
    if (lethal) target.alive = false;
    return { requested, hpLost: 0, shieldAbsorbed: 0, shieldBroke: false, finalHp: target.hp, lethal };
  }

  const cap = IGNORES[dmg.type];
  let amount = requested;

  // 2. Incoming damage-mods (a channel distinct from Damage Reduction): additive, then multiplicative.
  if (!cap.mods) {
    amount = Math.max(0, amount + incomingDamageMod(target));
    amount = Math.max(0, applyRounding(amount * incomingDamageMult(target, dmg.isNew)));
  }

  const shattered = has(target, "shatter");

  // 3. Damage Reduction (suppressed by Shatter/Bypass; bypassed by Piercing/Affliction/True).
  if (!cap.dr && !shattered && !dmg.bypass) amount = Math.max(0, amount - damageReduction(target));

  // 4. Shields (suppressed by Shatter/Bypass; bypassed by Affliction/True). Absorb in order,
  //    up to the per-hit shield-absorb cap (shield_absorb_cap) — overflow above the cap falls through to HP.
  const shieldBefore = totalShield(target);
  let shieldAbsorbed = 0;
  if (!cap.shield && !shattered && !dmg.bypass && shieldBefore > 0) {
    let absorbable = Math.min(amount, shieldAbsorbCap(target));
    for (const sh of target.shields) {
      if (absorbable <= 0) break;
      const take = Math.min(sh.amount, absorbable);
      sh.amount -= take;
      amount -= take;
      absorbable -= take;
      shieldAbsorbed += take;
    }
    target.shields = target.shields.filter((sh) => sh.amount > 0);
  }
  const shieldBroke = shieldBefore > 0 && totalShield(target) === 0 && shieldAbsorbed > 0;

  // 5. Apply to HP; Immortal floors at 1; a revive_ward intercepts an otherwise-lethal hit.
  const floor = has(target, "immortal") ? 1 : 0;
  let finalHp = Math.max(floor, target.hp - amount);
  if (finalHp <= 0) {
    const wardIdx = target.statuses.findIndex((s) => s.kind === "revive_ward");
    if (wardIdx >= 0) {
      finalHp = Math.max(1, target.statuses[wardIdx]!.magnitude ?? 1);
      target.statuses.splice(wardIdx, 1); // consume the ward
    }
  }
  const hpLost = target.hp - finalHp;
  target.hp = finalHp;
  const lethal = finalHp <= 0 && !has(target, "dies_at_max"); // inverted-HP units do not die at 0
  if (lethal) target.alive = false;

  return { requested, hpLost, shieldAbsorbed, shieldBroke, finalHp, lethal };
}

export interface HealResult {
  requested: number;
  healed: number;
  finalHp: number;
}

export function applyHeal(
  target: Unit,
  amount: number,
  opts: { allowOverheal?: boolean } = {},
): HealResult {
  const requested = Math.max(0, applyRounding(amount));
  // "Healing damages him": a typed conversion (e.g. Affliction) routes through the full damage pipeline
  // (mods/mults/type-immunity apply); an untyped one (the inverted-HP curse) is a raw HP loss with
  // death-at-0 suppressed for dies_at_max units.
  if (requested > 0 && has(target, "heal_becomes_damage")) {
    const hbd = target.statuses.find((s) => s.kind === "heal_becomes_damage");
    if (hbd?.dtype) {
      const r = applyDamage(target, { amount: requested, type: hbd.dtype, isNew: true });
      return { requested, healed: 0, finalHp: r.finalHp };
    }
    const dropped = Math.max(0, target.hp - requested);
    target.hp = dropped;
    if (dropped <= 0 && !has(target, "dies_at_max")) target.alive = false;
    return { requested, healed: 0, finalHp: dropped };
  }
  const ceiling = opts.allowOverheal ? Number.POSITIVE_INFINITY : target.maxHp;
  const finalHp = Math.min(ceiling, target.hp + requested);
  const healed = finalHp - target.hp;
  target.hp = finalHp;
  if (has(target, "dies_at_max") && target.hp >= target.maxHp) target.alive = false; // dies at MAX hp
  return { requested, healed, finalHp };
}

/**
 * Non-damage health loss (e.g. gaiagrave1: "not considered damage of any kind").
 * Ignores Shield and Damage Reduction entirely — it is not damage — but Immortal
 * still floors HP at 1 (ruling IMMORTAL_SCOPE).
 */
export function applyHealthLoss(target: Unit, amount: number): number {
  const loss = Math.max(0, applyRounding(amount));
  const floored = RULINGS.IMMORTAL_FLOORS_NON_DAMAGE && has(target, "immortal");
  const finalHp = Math.max(floored ? 1 : 0, target.hp - loss);
  const hpLost = target.hp - finalHp;
  target.hp = finalHp;
  if (finalHp <= 0 && !has(target, "dies_at_max")) target.alive = false;
  return hpLost;
}
