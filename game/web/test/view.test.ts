/**
 * Tests for the web client's chip rendering (view.ts effectIcons) — the layer the engine + client suites
 * never touched ("view.ts has zero tests"), which is how Curse of Thorns rendering with no visible stack
 * count slipped through. effectIcons is a pure function of (MatchState, Unit) → HTML, so it tests directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectIcons } from "../src/view.ts";
import { makeState, makeUnit, status } from "../../engine/test/helpers.ts";

test("BUG 3a: a stack-backed effect (Curse of Thorns) surfaces its stack COUNT on the surviving chip", () => {
  // Maggie's Curse is BOTH a counting stack (read by maggie3/4/5) and a same-named dot (the damage). The dot
  // is the concrete chip that survives dedup; the fix carries the deduped stack's count onto it so the escalating
  // ×N is visible again (it used to render a countless dot chip).
  const u = makeUnit({
    id: "maggie", team: "A", kind: "hero",
    statuses: [
      status("stack", { name: "Curse of Thorns", magnitude: 3, duration: null, appliedBy: "maggie" }),
      status("dot", { name: "Curse of Thorns", magnitude: 15, dtype: "affliction", duration: null, appliedBy: "maggie" }),
    ],
  });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  const html = effectIcons(state, u);
  assert.match(html, /class="fx-n">3</, "the '3' stack count is rendered on the Curse chip");
  assert.equal((html.match(/data-fxtitle="Curse of Thorns"/g) ?? []).length, 1, "still exactly ONE Curse of Thorns chip (no redundant carrier duplicate)");
});

test("BUG 3a control: a lone dot with no stack carrier shows NO phantom count badge", () => {
  const u = makeUnit({
    id: "x", team: "A", kind: "hero",
    statuses: [status("dot", { name: "Searing", magnitude: 5, dtype: "normal", duration: 3, appliedBy: "x" })],
  });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  assert.doesNotMatch(effectIcons(state, u), /class="fx-n"/, "a plain dot must not invent a stack-count badge");
});

test("BUG 3a guard: a name carrying TWO concrete effects is left un-badged (avoids an ambiguous count)", () => {
  // Burning Blood Serum-shape: a stack + a damage mod + a dot under one name. The count is ambiguous across the
  // two concretes, so we do NOT badge either — only the single-concrete case (Curse of Thorns) gets the ×N.
  const u = makeUnit({
    id: "y", team: "A", kind: "hero",
    statuses: [
      status("stack", { name: "Serum", magnitude: 4, duration: null, appliedBy: "y" }),
      status("dot", { name: "Serum", magnitude: 8, dtype: "affliction", duration: null, appliedBy: "y" }),
      status("outgoing_damage_mod", { name: "Serum", magnitude: 4, duration: null, appliedBy: "y" }),
    ],
  });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  assert.doesNotMatch(effectIcons(state, u), /class="fx-n"/, "multi-concrete name is not badged");
});
