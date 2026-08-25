/**
 * Tests for the guest-identity SQLite account store: create-on-first-use, secret verification (impostor
 * rejection), name update + scrubbing, result tallying, and a concurrent-create race. Uses an in-memory db.
 * `authenticate` is async (scrypt is offloaded off the event loop), so every call is awaited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountStore, cleanName, elo, START_RATING } from "./accounts.ts";

function store() {
  return new AccountStore(":memory:");
}

test("first authenticate creates a fresh profile at the starting rating", async () => {
  const s = store();
  const p = await s.authenticate("player-1", "secret-abc", "Ada");
  assert.ok(p, "a new identity is accepted");
  assert.equal(p!.playerId, "player-1");
  assert.equal(p!.name, "Ada");
  assert.deepEqual([p!.wins, p!.losses, p!.draws], [0, 0, 0]);
  assert.equal(p!.rating, START_RATING);
  s.close();
});

test("re-authenticating with the correct secret returns the same profile", async () => {
  const s = store();
  await s.authenticate("p", "right-secret", "Grace");
  const again = await s.authenticate("p", "right-secret", "Grace");
  assert.ok(again, "the matching secret verifies");
  assert.equal(again!.name, "Grace");
  s.close();
});

test("a wrong secret for an existing id is rejected (impostor)", async () => {
  const s = store();
  await s.authenticate("p", "the-real-secret", "Real");
  const impostor = await s.authenticate("p", "guessed-secret", "Fake");
  assert.equal(impostor, null, "the mismatched secret is refused");
  assert.equal((await s.authenticate("p", "the-real-secret", "Real"))!.name, "Real", "the real owner still gets in, name unchanged");
  s.close();
});

test("a changed name updates on the next matching auth", async () => {
  const s = store();
  await s.authenticate("p", "sec", "OldName");
  const p = await s.authenticate("p", "sec", "NewName");
  assert.equal(p!.name, "NewName");
  assert.equal(s.getProfile("p")!.name, "NewName", "persisted");
  s.close();
});

test("concurrent first-auths for the same id both succeed (create race handled)", async () => {
  const s = store();
  const [a, b] = await Promise.all([
    s.authenticate("race", "same-secret", "One"),
    s.authenticate("race", "same-secret", "Two"),
  ]);
  assert.ok(a && b, "neither concurrent create fails");
  assert.equal(a!.playerId, "race");
  assert.equal(b!.playerId, "race");
  s.close();
});

test("recordResult tallies wins / losses / draws and persists", async () => {
  const s = store();
  await s.authenticate("p", "sec", "Rec");
  s.recordResult("p", "win");
  s.recordResult("p", "win");
  s.recordResult("p", "loss");
  s.recordResult("p", "draw");
  const p = s.getProfile("p")!;
  assert.deepEqual([p.wins, p.losses, p.draws], [2, 1, 1]);
  s.close();
});

test("malformed identities are refused, not crashed", async () => {
  const s = store();
  assert.equal(await s.authenticate("", "sec", "X"), null, "empty id");
  assert.equal(await s.authenticate("p", "", "X"), null, "empty secret");
  assert.equal(await s.authenticate("x".repeat(65), "sec", "X"), null, "over-long id");
  assert.equal(await s.authenticate("p", "x".repeat(513), "X"), null, "over-long secret");
  s.close();
});

test("elo: equal ratings move by ±K/2 on a decisive result, and not at all on a draw", () => {
  assert.deepEqual(elo(1000, 1000, 1), [1016, 984], "winner +16, loser -16 (K=32, E=0.5)");
  assert.deepEqual(elo(1000, 1000, 0), [984, 1016], "symmetric when B wins");
  assert.deepEqual(elo(1000, 1000, 0.5), [1000, 1000], "a draw between equals is a no-op");
});

test("elo: beating a much higher-rated opponent gains more than an even win; it is zero-sum", () => {
  const [low, high] = elo(1000, 1400, 1); // the underdog wins
  assert.ok(low - 1000 > 16, "the upset gains more than an even win");
  assert.equal(low - 1000, 1400 - high, "points won by one equal points lost by the other");
});

test("cleanName scrubs HTML-dangerous chars, clamps length, keeps spaces, defaults empty to Guest", () => {
  assert.equal(cleanName("<script>bad</script>"), "scriptbad/script"); // angle brackets gone; the slash is harmless
  assert.equal(cleanName("Ada Lovelace"), "Ada Lovelace", "internal spaces are kept");
  assert.equal(cleanName("   "), "Guest", "blank becomes Guest");
  assert.equal(cleanName(42 as unknown), "Guest", "non-strings become Guest");
  assert.equal(cleanName("x".repeat(50)).length, 20, "clamped to MAX_NAME_LEN");
});

// ── registered accounts (username + password) ──────────────────────────────────────────────────────── //

test("register creates an account and returns a working {playerId, secret} identity", async () => {
  const s = store();
  const r = await s.register("Ada_Lovelace", "hunter2pw", "Ada");
  assert.ok(r.ok, "registration succeeds");
  if (!r.ok) return;
  assert.equal(r.profile.username, "ada_lovelace", "username is folded to lowercase");
  assert.equal(r.profile.name, "Ada", "display name is separate from the login handle");
  assert.deepEqual(r.profile.progress, {}, "starts with an empty progress blob");
  // the returned identity authenticates exactly like a guest's
  const p = await s.authenticate(r.playerId, r.secret, "Ada");
  assert.ok(p, "the minted secret verifies");
});

test("register rejects a taken username, a short password, and a bad handle", async () => {
  const s = store();
  assert.ok((await s.register("dupe", "password1", "A")).ok);
  assert.equal((await s.register("DUPE", "password2", "B")).ok, false, "case-folded duplicate is refused");
  assert.equal((await s.register("ok_name", "short", "C")).ok, false, "too-short password refused");
  assert.equal((await s.register("no spaces!", "password1", "D")).ok, false, "invalid handle refused");
});

test("login verifies the password and mints a fresh secret (old secret is superseded)", async () => {
  const s = store();
  const reg = await s.register("grace", "correcthorse", "Grace");
  assert.ok(reg.ok); if (!reg.ok) return;
  assert.equal((await s.login("grace", "wrongpass")).ok, false, "wrong password rejected");
  const li = await s.login("GRACE", "correcthorse"); // case-insensitive handle
  assert.ok(li.ok, "correct password logs in"); if (!li.ok) return;
  assert.equal(li.playerId, reg.playerId, "same account");
  assert.notEqual(li.secret, reg.secret, "a fresh session secret is issued");
  assert.equal((await s.authenticate(reg.playerId, reg.secret, "Grace")), null, "the OLD secret no longer verifies");
  assert.ok(await s.authenticate(li.playerId, li.secret, "Grace"), "the NEW secret verifies");
});

test("save persists avatar + progress for the authenticated player, and rejects a bad secret", async () => {
  const s = store();
  const reg = await s.register(" author", "passphrase", "Author");
  assert.ok(reg.ok); if (!reg.ok) return;
  assert.equal(await s.save(reg.playerId, "not-the-secret", { avatar: "bolt.svg" }), null, "bad secret → no write");
  const p = await s.save(reg.playerId, reg.secret, { avatar: "bolt.svg", progress: { coins: 5 } });
  assert.ok(p);
  assert.equal(p!.avatar, "bolt.svg");
  assert.deepEqual(p!.progress, { coins: 5 });
  // persisted across a fresh read
  assert.deepEqual(s.getProfile(reg.playerId)!.progress, { coins: 5 });
});

test("claim attaches a login to an existing guest, keeping its playerId + record", async () => {
  const s = store();
  const guest = await s.authenticate("guest-xyz", "guest-secret", "Nomad");
  assert.ok(guest); // a guest with a record
  s.recordResult("guest-xyz", "win");
  const c = await s.claim("guest-xyz", "guest-secret", "Nomad_99", "keepmypw");
  assert.ok(c.ok, "claim succeeds"); if (!c.ok) return;
  assert.equal(c.playerId, "guest-xyz", "same identity — record carries over");
  assert.equal(c.profile.username, "nomad_99");
  assert.equal(c.profile.wins, 1, "the guest's win is preserved");
  // can now log in from elsewhere with the chosen credentials
  const li = await s.login("nomad_99", "keepmypw");
  assert.ok(li.ok); if (!li.ok) return;
  assert.equal(li.playerId, "guest-xyz");
});

test("claim rejects a bad secret, an already-claimed row, and a taken username", async () => {
  const s = store();
  await s.authenticate("g1", "s1", "One");
  assert.equal((await s.claim("g1", "wrong", "handle_a", "password1")).ok, false, "bad secret refused");
  assert.ok((await s.claim("g1", "s1", "handle_a", "password1")).ok, "first claim works");
  assert.equal((await s.claim("g1", "s1", "handle_b", "password1")).ok, false, "already-claimed row refused");
  await s.authenticate("g2", "s2", "Two");
  assert.equal((await s.claim("g2", "s2", "HANDLE_A", "password1")).ok, false, "taken username refused");
});
