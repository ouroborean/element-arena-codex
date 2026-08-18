/**
 * Addressable-node surgery on an effect tree — the mechanism the augment/fusion metagame
 * rests on. Every Effect node carries an optional `id`; an augment names a node and rewrites
 * it in place. These walkers recurse into the four composite ops (`if`, `forEach`, `seq`,
 * `schedule`) and treat everything else as a leaf.
 *
 * Callers MUST operate on a deep clone of the tree: `loadHero` shares a hero's effect arrays
 * with its `HeroDef`, so mutating them in place would corrupt the shared authored content and
 * every other unit built from it (see content/augment.ts, which clones before patching).
 */
import type { Effect, NodeId } from "./ast.ts";

/** The child effect-arrays of a node (the real references, so mutating them mutates the tree). */
function childArrays(e: Effect): Effect[][] {
  switch (e.op) {
    case "if":
      return e.else ? [e.then, e.else] : [e.then];
    case "forEach":
      return [e.do];
    case "seq":
      return [e.steps];
    case "schedule":
      return [e.effect];
    case "applyStatus":
      // A status can carry an on-expire hook whose nodes are addressable too.
      return e.status.onExpire ? [e.status.onExpire] : [];
    default:
      return [];
  }
}

/** Depth-first: the node with `id`, or null. */
export function findNode(effects: Effect[], id: NodeId): Effect | null {
  for (const e of effects) {
    if (e.id === id) return e;
    for (const arr of childArrays(e)) {
      const hit = findNode(arr, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Replace the node with `id` in place. Returns true if it was found. */
export function replaceNode(effects: Effect[], id: NodeId, replacement: Effect): boolean {
  return mapNode(effects, id, () => replacement);
}

/** Rewrite the node with `id` via `fn` (read the old node, return the new). Returns true if found. */
export function mapNode(effects: Effect[], id: NodeId, fn: (e: Effect) => Effect): boolean {
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i]!;
    if (e.id === id) {
      effects[i] = fn(e);
      return true;
    }
    for (const arr of childArrays(e)) {
      if (mapNode(arr, id, fn)) return true;
    }
  }
  return false;
}

/** Wrap the node with `id`: replace it with `wrap(oldNode)` (e.g. put it inside a new `if`). */
export function wrapNode(effects: Effect[], id: NodeId, wrap: (e: Effect) => Effect): boolean {
  return mapNode(effects, id, wrap);
}
