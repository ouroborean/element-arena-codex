import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction } from "../src/scheduler.ts";
import { runEffects } from "../src/effects/interpret.ts";
import { loadHero } from "../content/hero.ts"; // side-effect: registers handlers + minion templates
import { heroById } from "../content/match.ts";
import { applyAugment } from "../content/augment.ts";
import { augmentById } from "../content/augments.generated.ts";
import { makeState, makeUnit } from "./helpers.ts";
import type { MatchState, Unit } from "../src/types.ts";

// Fidelity Campaign 3 — coverage: zev'kir "Atlantean Waters" augment (zevkir1 / #47-#48).
// Frozen (augments.json zevkir1): "While Zev'kir is Channeling Call Tides, he heals 5 HP per turn
// and ignores stuns." SHIPPING: each Call Tides channel tick appends a refreshed
// {kind:"mark",name:"Stun Immunity",duration:1}; scheduler.isStunnedFor treats a unit carrying a
// "Stun Immunity" mark as NOT stunned (see scheduler.ts ~L315), so the appended mark IS the
// "ignores stuns" clause. isStunnedFor is module-private, so we drive the gate through
// performAction (reason "stunned") — the same gate every real cast passes.

// A fresh zev'kir on team A facing one enemy on team B, with energy to pay his Instant water skill.
function setup(): { z: Unit; state: MatchState } {
  const z = loadHero(heroById("zevkir"), "A", "z");
  const foe = makeUnit({ id: "e", team: "B", hp: 100, kind: "hero" });
  const state = makeState([z], [foe]);
  state.teams.A.energy = { generic: 10, water: 10 }; // zevkir2 costs 1 Water
  return { z, state };
}

const STUN = { kind: "stun" as const, duration: 1, appliedBy: "z", appliedTurn: 0 }; // unscoped -> stops every skill
const IMMUNITY = { kind: "mark" as const, name: "Stun Immunity", duration: 1, appliedBy: "z", appliedTurn: 0 };

test("scheduler: a 'Stun Immunity' mark lets a stunned unit act; without it the stun blocks the cast", () => {
  // Control: stunned, no immunity mark -> the stun gate rejects the cast.
  {
    const { z, state } = setup();
    z.statuses.push({ ...STUN });
    const r = performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e"] });
    assert.equal(r.ok, false, "a stunned unit cannot act");
    assert.equal(r.reason, "stunned", "rejected specifically for the stun");
  }
  // Positive: same stun PLUS a "Stun Immunity" mark -> isStunnedFor returns not-stunned, cast goes through.
  {
    const { z, state } = setup();
    z.statuses.push({ ...STUN }, { ...IMMUNITY });
    const r = performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e"] });
    assert.equal(r.ok, true, "a 'Stun Immunity' mark makes the same stunned unit able to act");
  }
});

test("Atlantean Waters (zevkir1): a Call Tides channel tick heals 5 and grants the immunity, so a stun no longer stops Zev'kir", () => {
  const { z, state } = setup();
  applyAugment(z, augmentById("zevkir1")!);
  z.hp = 90; // room to observe the +5 heal

  // One Call Tides channel tick = re-running the (now augment-appended) skill effects on self.
  const callTides = z.skills!.find((s) => s.id === "zevkir1")!;
  runEffects(state, callTides.effects, { caster: z, self: z, targets: [z], skillId: "zevkir1" });

  assert.equal(z.hp, 95, "the channel tick heals 5 HP");
  assert.ok(
    z.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity"),
    "the channel tick grants a 'Stun Immunity' mark",
  );

  // A stun landing mid-channel no longer stops him.
  z.statuses.push({ ...STUN });
  const immune = performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e"] });
  assert.equal(immune.ok, true, "while Channeling Call Tides, Zev'kir ignores the stun and can act");
});

test("control: WITHOUT the Atlantean Waters augment, a Call Tides tick grants no immunity and the stun blocks him", () => {
  const { z, state } = setup();
  // No applyAugment: running the base Call Tides effects appends no "Stun Immunity" mark.
  const callTides = z.skills!.find((s) => s.id === "zevkir1")!;
  runEffects(state, callTides.effects, { caster: z, self: z, targets: [z], skillId: "zevkir1" });

  assert.ok(
    !z.statuses.some((s) => s.kind === "mark" && s.name === "Stun Immunity"),
    "base Call Tides confers no Stun Immunity",
  );

  z.statuses.push({ ...STUN });
  const r = performAction(state, { unit: "z", skillId: "zevkir2", targets: ["e"] });
  assert.equal(r.ok, false, "without the augment the stun still stops Zev'kir");
  assert.equal(r.reason, "stunned", "rejected for the stun");
});
