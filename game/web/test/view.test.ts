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

test("a FUSED hero surfaces BOTH passives (native + fusion form) as hover-describable chips", () => {
  // Fusion ADDS its passive; the native passive is not disabled. Gaia fused to grave (Rotten Vitality) must
  // show her native "Yggdrasil's Bounty" chip AND the "Rotten Vitality" fusion-passive chip.
  const u = makeUnit({ id: "g", team: "A", kind: "hero", heroId: "gaia", fused: "grave", statuses: [] });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  const html = effectIcons(state, u);
  assert.match(html, /class="fx passive"[^>]*data-fxtitle="Yggdrasil/, "the native passive chip persists after fusing");
  assert.match(html, /class="fx passive"[^>]*data-fxtitle="Rotten Vitality"/, "the fusion-form passive chip is also shown");
});

test("an UNFUSED hero shows only its native passive chip (control)", () => {
  const u = makeUnit({ id: "g", team: "A", kind: "hero", heroId: "gaia", statuses: [] });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  const html = effectIcons(state, u);
  assert.match(html, /data-fxtitle="Yggdrasil/, "native passive shown");
  assert.doesNotMatch(html, /data-fxtitle="Rotten Vitality"/, "no fusion passive chip when unfused");
});

test("a chosen augment shows an effect chip on the hero, icon-sourced from the skill it modifies (Balm -> Soothe)", () => {
  // River Daughter's "Balm" (riverdaughter2): "When Soothe expires, it jumps…" — a trigger-only augment whose
  // patches name no skill, so the icon is sourced from the skill NAMED in its description (Soothe = riverdaughter4),
  // not the hero's passive. The tooltip carries the augment's own name + description so both players can read it.
  const u = makeUnit({ id: "rd", team: "A", kind: "hero", heroId: "riverdaughter", augments: ["riverdaughter2"], statuses: [] });
  const state = makeState([u], [makeUnit({ id: "e", team: "B" })]);
  const html = effectIcons(state, u);
  assert.match(html, /class="fx augment"[^>]*data-fxtitle="Balm"/, "an augment chip titled Balm is shown");
  assert.match(html, /data-fxbody="When Soothe expires/, "its tooltip body is the augment's own description");
  assert.match(html, /riverdaughter4\.png/, "the icon is sourced from Soothe (riverdaughter4), matched from the description — not the passive");
});
