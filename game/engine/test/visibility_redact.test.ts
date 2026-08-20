import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { redactState } from "../src/visibility.ts";
import "../content/hero.ts"; // side-effect: registers custom handlers (harmless; keeps parity with other suites)
import { makeState, makeUnit, skill, status } from "./helpers.ts";
import type { MatchState } from "../src/types.ts";

// Visibility redaction — PR 1a core. An isHidden skill's execution context stamps `invisible` on every
// status it applies; a status-spec `invisible:true` hides just that one effect (Zephyrex Wind Step's DR).
// redactState then omits a team's Invisible effects from the OPPONENT's view while the owner still sees them.

const has = (st: MatchState, id: string, name: string): boolean => (st.units[id]?.statuses ?? []).some((s) => s.name === name);
const hasKind = (st: MatchState, id: string, kind: string): boolean => (st.units[id]?.statuses ?? []).some((s) => s.kind === kind);
const nStatuses = (st: MatchState, id: string): number => st.units[id]?.statuses.length ?? -1;

test("an isHidden skill stamps `invisible` on every status it applies, and leaves no log telegraph", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [skill("hid", [
    { op: "applyStatus", to: "self", status: { kind: "mark", name: "Ward", duration: null } },
    { op: "applyStatus", to: "target", status: { kind: "mark", name: "Hex", duration: 2 } },
  ], { isHidden: true, targeting: "single", tags: ["Harmful"] })] });
  const foe = makeUnit({ id: "b1", team: "B" });
  const st = makeState([caster], [foe]);

  performAction(st, { unit: "a1", skillId: "hid", targets: ["b1"] });

  assert.equal(caster.statuses.find((s) => s.name === "Ward")?.invisible, true, "self ward is invisible");
  assert.equal(foe.statuses.find((s) => s.name === "Hex")?.invisible, true, "the mark placed on the foe is invisible");
  assert.ok(!st.log.some((l) => l.includes("used")), "an Invisible skill writes no `used` telegraph to the shared log");
});

test("an isHidden skill that lays stacks (addStack) stamps them invisible — Saya's Spider Mines shape", () => {
  const saya = makeUnit({ id: "a1", team: "A", skills: [skill("mines", [
    { op: "forEach", each: { faction: "enemies", kind: "hero" }, do: [
      { op: "addStack", name: "Spider Mine", amount: 1, to: "it" },
    ] },
  ], { isHidden: true, targeting: "self" })] });
  const foe1 = makeUnit({ id: "b1", team: "B" });
  const foe2 = makeUnit({ id: "b2", team: "B" });
  const st = makeState([saya], [foe1, foe2]);

  performAction(st, { unit: "a1", skillId: "mines", targets: [] });

  assert.equal(foe1.statuses.find((s) => s.name === "Spider Mine")?.invisible, true, "the mine laid on foe1 is invisible");
  assert.equal(foe2.statuses.find((s) => s.name === "Spider Mine")?.invisible, true, "the mine laid on foe2 is invisible");
  assert.ok(!has(redactState(st, "B"), "b1", "Spider Mine"), "the opponent cannot see the Invisible mines");
  assert.ok(has(redactState(st, "A"), "b1", "Spider Mine"), "Saya's own side still sees the mines it laid");
});

test("a visible skill leaves statuses visible; a status-spec `invisible:true` hides only that effect", () => {
  const caster = makeUnit({ id: "a1", team: "A", skills: [skill("vis", [
    { op: "applyStatus", to: "self", status: { kind: "mark", name: "Open", duration: null } },
    { op: "applyStatus", to: "self", status: { kind: "damage_reduction", magnitude: 15, duration: 1, invisible: true } },
  ], { targeting: "self" })] });
  const st = makeState([caster], [makeUnit({ id: "b1", team: "B" })]);

  performAction(st, { unit: "a1", skillId: "vis", targets: [] });

  assert.ok(!caster.statuses.find((s) => s.name === "Open")?.invisible, "an ordinary status stays visible");
  assert.equal(caster.statuses.find((s) => s.kind === "damage_reduction")?.invisible, true, "spec invisible:true hides just the DR (the Zephyrex Wind Step shape)");
  assert.ok(st.log.some((l) => l.includes("used")), "a visible skill telegraphs normally");
});

test("redactState hides a team's Invisible statuses from the opponent, keeps them for the owner", () => {
  const a = makeUnit({ id: "a1", team: "A", statuses: [
    status("damage_reduction", { magnitude: 15, duration: 1, appliedBy: "a1", invisible: true }), // Zephyrex self-hide
    status("mark", { name: "Public", appliedBy: "a1" }),
  ] });
  const b = makeUnit({ id: "b1", team: "B", statuses: [
    status("mark", { name: "Hex", appliedBy: "a1", invisible: true }), // A's Invisible debuff, sitting ON b
    status("mark", { name: "Bee", appliedBy: "b1" }),                   // b's own visible buff
  ] });
  const st = makeState([a], [b]);

  const forB = redactState(st, "B"); // B is A's opponent
  assert.ok(!hasKind(forB, "a1", "damage_reduction"), "B cannot see A's Invisible DR");
  assert.ok(has(forB, "a1", "Public"), "B still sees A's visible buff");
  assert.ok(!has(forB, "b1", "Hex"), "B cannot see the Invisible debuff A placed on B");
  assert.ok(has(forB, "b1", "Bee"), "B still sees its own buff");

  const forA = redactState(st, "A"); // the owner sees everything it created
  assert.ok(hasKind(forA, "a1", "damage_reduction"), "A sees its own Invisible DR");
  assert.ok(has(forA, "b1", "Hex"), "A sees the Invisible debuff it applied to B");

  assert.equal(nStatuses(st, "a1"), 2, "authoritative state is not mutated (A)");
  assert.equal(nStatuses(st, "b1"), 2, "authoritative state is not mutated (B)");
});

test("redactState keeps arrays and returns the same object when nothing is hidden", () => {
  const a = makeUnit({ id: "a1", team: "A", statuses: [status("mark", { name: "X", appliedBy: "a1" })] });
  const st = makeState([a], [makeUnit({ id: "b1", team: "B" })]);

  const forB = redactState(st, "B");
  assert.equal(forB, st, "no invisibility present → the identical object (no needless copy)");
  assert.ok(Array.isArray(forB.units["b1"]?.statuses), "statuses is still an array");
});

test("an orphaned Invisible status (applier gone) falls back to the bearer's team as owner", () => {
  const b = makeUnit({ id: "b1", team: "B", statuses: [status("mark", { name: "Lost", appliedBy: "ghost", invisible: true })] });
  const st = makeState([makeUnit({ id: "a1", team: "A" })], [b]);
  // Owner falls back to bearer team B, so B (the bearer) still sees it; A does not.
  assert.ok(has(redactState(st, "B"), "b1", "Lost"), "bearer sees its own orphaned Invisible status");
  assert.ok(!has(redactState(st, "A"), "b1", "Lost"), "the other team does not");
});
