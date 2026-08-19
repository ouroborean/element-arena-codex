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
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { MAX_NAME_LEN, type Profile } from "../net/protocol.ts";

export const START_RATING = 1000;
export const ELO_K = 32; // rating movement per game — brisk, suited to a small player pool

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
  }

  private row(playerId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM profiles WHERE playerId = ?").get(playerId) as Row | undefined;
  }

  private count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }).n;
  }

  private toProfile(r: Row): Profile {
    return { playerId: r.playerId, name: r.name, wins: r.wins, losses: r.losses, draws: r.draws, rating: r.rating };
  }

  /** Verify a secret against an existing row (async hash), updating the display name if it changed. */
  private async verify(existing: Row, secret: string, name: string): Promise<Profile | null> {
    const actual = await scryptAsync(secret, Buffer.from(existing.salt), 32);
    const expected = Buffer.from(existing.secretHash);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null; // wrong secret
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
