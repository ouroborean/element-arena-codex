/**
 * Guest-identity account store, backed by the built-in `node:sqlite` (no dependency). Each player holds a
 * client-generated {playerId, secret} — trust-on-first-use: the first `authenticate` for an id CREATES the
 * profile bound to a scrypt hash of its secret; later calls VERIFY the secret before returning the profile.
 * The secret is a high-entropy random token, never a human password, and only its hash is stored.
 *
 * Hashing uses the ASYNC scrypt (threadpool-offloaded) so it never blocks the server's single event loop.
 * Persists a display name, a win/loss/draw record, and a `rating` (seeded at 1000) that anchors future Ranked.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { MAX_NAME_LEN, type Profile } from "../net/protocol.ts";

export const START_RATING = 1000;
export const ELO_K = 32; // rating movement per game — brisk, suited to a small player pool

export const MIN_USERNAME_LEN = 3, MAX_USERNAME_LEN = 20;
const MIN_PASS_LEN = 6, MAX_PASS_LEN = 200;
const MAX_PROGRESS_BYTES = 16 * 1024;

/** A register/login outcome: fresh {playerId, secret} identity + profile on success, else a UX error string. */
export type AuthResult = { ok: true; profile: Profile; playerId: string; secret: string } | { ok: false; error: string };

/** Fold a login handle to its canonical unique form (lowercase [a-z0-9_], bounded), or null if invalid. This
 *  is the login HANDLE — distinct from the free-form display name (cleanName). */
export function cleanUsername(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim().toLowerCase();
  return new RegExp(`^[a-z0-9_]{${MIN_USERNAME_LEN},${MAX_USERNAME_LEN}}$`).test(s) ? s : null;
}
/** Clamp an avatar-manifest filename to a safe, bounded string (or null to clear it). */
export function cleanAvatar(a: unknown): string | null {
  if (typeof a !== "string") return null;
  const s = a.replace(/[^\w.-]/g, "").slice(0, 64);
  return s.length ? s : null;
}
function safeParse(json: string | null | undefined): unknown {
  try { return json ? JSON.parse(json) : {}; } catch { return {}; }
}

/**
 * The two players' new Elo ratings after a game. `sa` is player A's score: 1 = win, 0.5 = draw, 0 = loss.
 * A single rounded transfer `d` is added to A and subtracted from B, so the exchange is exactly zero-sum;
 * both results are floored at 0.
 */
export function elo(ratingA: number, ratingB: number, sa: number, k = ELO_K): [number, number] {
  const ea = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const d = Math.round(k * (sa - ea));
  return [Math.max(0, ratingA + d), Math.max(0, ratingB - d)];
}

const MAX_SECRET_LEN = 512; // a legitimate secret is a ~36-char UUID; bound it so a huge input can't inflate hashing
const MAX_PROFILES = 200_000; // coarse cap so unauthenticated create-on-first-use can't fill the disk without bound
export type ResultKind = "win" | "loss" | "draw";

const scryptAsync = promisify(scrypt) as (secret: string, salt: Buffer, keylen: number) => Promise<Buffer>;

// Characters scrubbed from a display name: HTML-dangerous quotes/angles/ampersand, backtick (\x60), and
// ASCII control chars (\x00-\x1f). Spaces are kept (collapsed + trimmed below). Built from a string so the
// source carries no literal backtick.
const UNSAFE_NAME_CHARS = new RegExp("[\"'&<>\\x60\\x00-\\x1f]", "g");

/** Clamp/scrub a display name to a safe, bounded, non-empty string. */
export function cleanName(name: unknown): string {
  const s = (typeof name === "string" ? name : "")
    .replace(UNSAFE_NAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
  return s.length ? s : "Guest";
}

interface Row {
  playerId: string;
  name: string;
  salt: Uint8Array;
  secretHash: Uint8Array;
  wins: number;
  losses: number;
  draws: number;
  rating: number;
  // Registered-account columns (null for anonymous guests): a unique login handle + a password hash, plus a
  // synced avatar and an extensible JSON progress blob.
  username: string | null;
  passSalt: Uint8Array | null;
  passHash: Uint8Array | null;
  avatar: string | null;
  progress: string | null;
}

export class AccountStore {
  private db: DatabaseSync;

  constructor(path = process.env.ARENA_DB ?? "arena.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS profiles (" +
        "playerId TEXT PRIMARY KEY, name TEXT NOT NULL, salt BLOB NOT NULL, secretHash BLOB NOT NULL, " +
        "wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, " +
        `rating INTEGER NOT NULL DEFAULT ${START_RATING}, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
    );
    // Additive migration: ALTER-in the registered-account columns on an existing db (CREATE TABLE IF NOT
    // EXISTS never alters). Each is idempotent (skipped if the column is already present).
    for (const [col, def] of [["username", "TEXT"], ["passSalt", "BLOB"], ["passHash", "BLOB"], ["avatar", "TEXT"], ["progress", "TEXT NOT NULL DEFAULT '{}'"]] as const) {
      this.ensureColumn(col, def);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username) WHERE username IS NOT NULL");
  }

  private ensureColumn(name: string, def: string): void {
    const cols = this.db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE profiles ADD COLUMN ${name} ${def}`);
  }

  private row(playerId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM profiles WHERE playerId = ?").get(playerId) as Row | undefined;
  }

  private count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }).n;
  }

  private toProfile(r: Row): Profile {
    return {
      playerId: r.playerId, name: r.name, wins: r.wins, losses: r.losses, draws: r.draws, rating: r.rating,
      username: r.username ?? undefined,
      avatar: r.avatar ?? undefined,
      progress: safeParse(r.progress),
    };
  }

  /** Timing-safe check that `secret` matches the row's stored session-secret hash. */
  private async verifySecret(existing: Row, secret: string): Promise<boolean> {
    const actual = await scryptAsync(secret, Buffer.from(existing.salt), 32);
    const expected = Buffer.from(existing.secretHash);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Verify a secret against an existing row (async hash), updating the display name if it changed. */
  private async verify(existing: Row, secret: string, name: string): Promise<Profile | null> {
    if (!(await this.verifySecret(existing, secret))) return null; // wrong secret
    const nm = cleanName(name);
    if (nm !== existing.name) {
      this.db.prepare("UPDATE profiles SET name = ?, updated = ? WHERE playerId = ?").run(nm, Date.now(), existing.playerId);
      existing.name = nm;
    }
    return this.toProfile(existing);
  }

  /**
   * Create-or-verify a guest identity. Returns the profile on success, null if the id already exists with a
   * DIFFERENT secret, if inputs are malformed, or if the profile cap is reached for a brand-new id.
   */
  async authenticate(playerId: string, secret: string, name: string): Promise<Profile | null> {
    if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64) return null;
    if (typeof secret !== "string" || secret.length === 0 || secret.length > MAX_SECRET_LEN) return null;

    const existing = this.row(playerId);
    if (existing) return this.verify(existing, secret, name);

    if (this.count() >= MAX_PROFILES) return null; // refuse to grow the store without bound
    const salt = randomBytes(16);
    const hash = await scryptAsync(secret, salt, 32);
    const now = Date.now();
    try {
      this.db.prepare("INSERT INTO profiles (playerId, name, salt, secretHash, created, updated) VALUES (?, ?, ?, ?, ?, ?)")
        .run(playerId, cleanName(name), salt, hash, now, now);
      return { playerId, name: cleanName(name), wins: 0, losses: 0, draws: 0, rating: START_RATING };
    } catch {
      // A concurrent auth created this id during the await — fall back to verifying against that row.
      const r = this.row(playerId);
      return r ? this.verify(r, secret, name) : null;
    }
  }

  /** Register a real account: a unique username + hashed password + a fresh {playerId, secret} session identity.
   *  Returns that identity (which the client stores + uses for all later auth exactly like a guest), or an error. */
  async register(username: unknown, password: unknown, name: unknown): Promise<AuthResult> {
    const uname = cleanUsername(username);
    if (!uname) return { ok: false, error: `username must be ${MIN_USERNAME_LEN}–${MAX_USERNAME_LEN} characters: letters, numbers, underscore` };
    if (typeof password !== "string" || password.length < MIN_PASS_LEN || password.length > MAX_PASS_LEN) {
      return { ok: false, error: `password must be at least ${MIN_PASS_LEN} characters` };
    }
    if (this.count() >= MAX_PROFILES) return { ok: false, error: "the account limit has been reached" };
    const playerId = randomUUID();
    const secret = randomBytes(24).toString("hex");
    const salt = randomBytes(16), passSalt = randomBytes(16);
    const [secretHash, passHash] = await Promise.all([scryptAsync(secret, salt, 32), scryptAsync(password, passSalt, 32)]);
    const now = Date.now();
    try {
      this.db.prepare("INSERT INTO profiles (playerId, name, salt, secretHash, username, passSalt, passHash, progress, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(playerId, cleanName(name), salt, secretHash, uname, passSalt, passHash, "{}", now, now);
    } catch {
      return { ok: false, error: "that username is already taken" }; // unique-index violation
    }
    return { ok: true, profile: this.getProfile(playerId)!, playerId, secret };
  }

  /** Log into a registered account by username + password. Mints a FRESH session secret (the client can't
   *  recover the stored one), so logging in on a new device supersedes the old one. */
  async login(username: unknown, password: unknown): Promise<AuthResult> {
    const uname = cleanUsername(username);
    const generic: AuthResult = { ok: false, error: "wrong username or password" };
    if (!uname || typeof password !== "string" || !password) return generic;
    const r = this.db.prepare("SELECT * FROM profiles WHERE username = ?").get(uname) as Row | undefined;
    if (!r || !r.passHash || !r.passSalt) return generic;
    const actual = await scryptAsync(password, Buffer.from(r.passSalt), 32);
    const expected = Buffer.from(r.passHash);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return generic;
    const secret = randomBytes(24).toString("hex");
    const salt = randomBytes(16);
    const secretHash = await scryptAsync(secret, salt, 32);
    this.db.prepare("UPDATE profiles SET salt = ?, secretHash = ?, updated = ? WHERE playerId = ?").run(salt, secretHash, Date.now(), r.playerId);
    return { ok: true, profile: this.getProfile(r.playerId)!, playerId: r.playerId, secret };
  }

  /** Persist profile fields (display name, avatar, progress blob) for an authenticated player. Verifies the
   *  session secret; a bad secret or oversized progress leaves the row untouched. Returns the (updated) profile. */
  async save(playerId: string, secret: string, patch: { name?: unknown; avatar?: unknown; progress?: unknown }): Promise<Profile | null> {
    const r = this.row(playerId);
    if (!r || !(await this.verifySecret(r, secret))) return null;
    const sets: string[] = [], vals: (string | null)[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); vals.push(cleanName(patch.name)); }
    if (patch.avatar !== undefined) { sets.push("avatar = ?"); vals.push(cleanAvatar(patch.avatar)); }
    if (patch.progress !== undefined) {
      const json = JSON.stringify(patch.progress ?? {});
      if (json.length <= MAX_PROGRESS_BYTES) { sets.push("progress = ?"); vals.push(json); }
    }
    if (sets.length) {
      sets.push("updated = ?");
      this.db.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE playerId = ?`).run(...vals, Date.now(), playerId);
    }
    return this.getProfile(playerId);
  }

  /** Tally an (unranked) match result for a player. No-op for an unknown id. */
  recordResult(playerId: string, result: ResultKind): void {
    const col = result === "win" ? "wins" : result === "loss" ? "losses" : "draws";
    this.db.prepare(`UPDATE profiles SET ${col} = ${col} + 1, updated = ? WHERE playerId = ?`).run(Date.now(), playerId);
  }

  /** Tally a ranked result AND set the new Elo rating in one update. */
  recordRankedResult(playerId: string, result: ResultKind, newRating: number): void {
    const col = result === "win" ? "wins" : result === "loss" ? "losses" : "draws";
    this.db.prepare(`UPDATE profiles SET ${col} = ${col} + 1, rating = ?, updated = ? WHERE playerId = ?`).run(newRating, Date.now(), playerId);
  }

  /** Record BOTH players of a ranked match atomically, so a fault can't persist one Elo update but not the
   *  other (a zero-sum violation). Throws (rolling back) on any DB error — callers keep it non-fatal. */
  recordRankedMatch(a: { playerId: string; result: ResultKind; rating: number }, b: { playerId: string; result: ResultKind; rating: number }): void {
    this.db.exec("BEGIN");
    try {
      this.recordRankedResult(a.playerId, a.result, a.rating);
      this.recordRankedResult(b.playerId, b.result, b.rating);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getProfile(playerId: string): Profile | null {
    const r = this.row(playerId);
    return r ? this.toProfile(r) : null;
  }

  close(): void {
    this.db.close();
  }
}
