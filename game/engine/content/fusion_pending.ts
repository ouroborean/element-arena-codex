/**
 * Fusion mechanics awaiting native handlers.
 *
 * The 200 fusion forms are authored as data — each mechanic the DSL can't express is a `custom`
 * node with a precise intent `note`. Faithfully implementing all ~120 distinct bespoke fusion
 * mechanics is a large, ongoing effort; until each has a real handler, this registers a TRACKED,
 * LOGGED stub for the unimplemented ones so the framework runs and the gap is visible (a stub
 * pushes an "unimplemented fusion mechanic" line to `state.log` — it is never a silent no-op).
 *
 * As real handlers land (in a content/fusion_effects.ts), those fns drop off the pending list
 * automatically: this only stubs fns that are NOT already registered.
 */
import { FUSIONS } from "./fusions.generated.ts";
import { registerCustom, hasCustom } from "../src/effects/interpret.ts";
import type { Effect } from "../src/effects/ast.ts";

/** Every custom fn name referenced anywhere in the authored fusion forms. */
export function fusionCustomFns(): string[] {
  const fns = new Set<string>();
  const walk = (nodes: Effect[] | undefined): void => {
    for (const e of nodes ?? []) {
      if (e.op === "custom") fns.add(e.fn);
      if (e.op === "if") { walk(e.then); walk(e.else); }
      else if (e.op === "forEach") walk(e.do);
      else if (e.op === "seq") walk(e.steps);
      else if (e.op === "schedule") walk(e.effect);
      else if (e.op === "applyStatus" && e.status.onExpire) walk(e.status.onExpire);
    }
  };
  for (const f of FUSIONS) {
    walk(f.skill.effects);
    for (const t of f.passiveTriggers ?? []) walk(t.effect);
  }
  return [...fns].sort();
}

/**
 * Register a logging stub for every fusion custom fn that has no native handler yet. Returns the
 * list of fns that were stubbed (the pending set) — call before running fusion content.
 */
export function registerPendingFusionCustoms(): string[] {
  const pending: string[] = [];
  for (const fn of fusionCustomFns()) {
    if (!hasCustom(fn)) {
      registerCustom(fn, (ctx) => { ctx.state.log.push(`unimplemented fusion mechanic: ${fn}`); });
      pending.push(fn);
    }
  }
  return pending;
}
