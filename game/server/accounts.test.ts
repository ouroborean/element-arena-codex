/**
 * Tests for the guest-identity SQLite account store: create-on-first-use, secret verification (impostor
 * rejection), name update + scrubbing, and result tallying. Uses an in-memory database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountStore, cleanName, START_RATING } from "./accounts.ts";

function store() {
  return new AccountStore(":memory:");
}

test("first authenticate creates a fresh profile at the starting rating", () => {
  const s = store();
  const p = s.authenticate("player-1", "secret-abc", "Ada");
  assert.ok(p, "a new identity is accepted");
  assert.equal(p!.playerId, "player-1");
  assert.equal(p!.name, "Ada");
  assert.deepEqual([p!.wins, p!.losses, p!.draws], [0, 0, 0]);
  assert.equal(p!.rating, START_RATING);
  s.close();
});

test("re-authenticating with the correct secret returns the same profile", () => {
  const s = store();
  s.authenticate("p", "right-secret", "Grace");
  const again = s.authenticate("p", "right-secret", "Grace");
  assert.ok(again, "the matching secret verifies");
  assert.equal(again!.name, "Grace");
  s.close();
});

test("a wrong secret for an existing id is rejected (impostor)", () => {
  const s = store();
  s.authenticate("p", "the-real-secret", "Real");
  const impostor = s.authenticate("p", "guessed-secret", "Fake");
  assert.equal(impostor, null, "the mismatched secret is refused");
  // The real owner still gets in, and the impostor's name change did NOT take.
  assert.equal(s.authenticate("p", "the-real-secret", "Real")!.name, "Real");
  s.close();
});

test("a changed name updates on the next matching auth", () => {
  const s = store();
  s.authenticate("p", "sec", "OldName");
  const p = s.authenticate("p", "sec", "NewName");
  assert.equal(p!.name, "NewName");
  assert.equal(s.getProfile("p")!.name, "NewName", "persisted");
  s.close();
});

test("recordResult tallies wins / losses / draws and persists", () => {
  const s = store();
  s.authenticate("p", "sec", "Rec");
  s.recordResult("p", "win");
  s.recordResult("p", "win");
  s.recordResult("p", "loss");
  s.recordResult("p", "draw");
  const p = s.getProfile("p")!;
  assert.deepEqual([p.wins, p.losses, p.draws], [2, 1, 1]);
  s.close();
});

test("malformed identities are refused, not crashed", () => {
  const s = store();
  assert.equal(s.authenticate("", "sec", "X"), null, "empty id");
  assert.equal(s.authenticate("p", "", "X"), null, "empty secret");
  assert.equal(s.authenticate("x".repeat(65), "sec", "X"), null, "over-long id");
  s.close();
});

test("cleanName scrubs HTML-dangerous chars, clamps length, keeps spaces, defaults empty to Guest", () => {
  assert.equal(cleanName('<script>bad</script>'), "scriptbad/script"); // angle brackets gone; the slash is harmless
  assert.equal(cleanName("Ada Lovelace"), "Ada Lovelace", "internal spaces are kept");
  assert.equal(cleanName("   "), "Guest", "blank becomes Guest");
  assert.equal(cleanName(42 as unknown), "Guest", "non-strings become Guest");
  assert.equal(cleanName("x".repeat(50)).length, 20, "clamped to MAX_NAME_LEN");
});
