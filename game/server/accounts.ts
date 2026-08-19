/**
 * Guest-identity account store, backed by the built-in `node:sqlite` (no dependency). Each player holds a
 * client-generated {playerId, secret} — trust-on-first-use: the first `authenticate` for an id CREATES the
 * profile bound to a scrypt hash of its secret; later calls VERIFY the secret before returning the profile.
 * The secret is a high-entropy random token, never a human password, and only its hash is stored.
 *
 * Persists a display name, a win/loss/draw record, and a `rating` (seeded at 1000) that anchors future Ranked.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { MAX_NAME_LEN, type Profile } from "../net/protocol.ts";

export const START_RATING = 1000;
export type ResultKind = "win" | "loss" | "draw";

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

function hashSecret(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
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

  private toProfile(r: Row): Profile {
    return { playerId: r.playerId, name: r.name, wins: r.wins, losses: r.losses, draws: r.draws, rating: r.rating };
  }

  /**
   * Create-or-verify a guest identity. Returns the profile on success, or null if the id already exists with
   * a DIFFERENT secret (an impostor). A matching call also updates the display name if it changed.
   */
  authenticate(playerId: string, secret: string, name: string): Profile | null {
    if (typeof playerId !== "string" || playerId.length === 0 || playerId.length > 64 || typeof secret !== "string" || secret.length === 0) return null;
    const now = Date.now();
    const nm = cleanName(name);
    const existing = this.row(playerId);
    if (!existing) {
      const salt = randomBytes(16);
      const hash = hashSecret(secret, salt);
      this.db.prepare("INSERT INTO profiles (playerId, name, salt, secretHash, created, updated) VALUES (?, ?, ?, ?, ?, ?)")
        .run(playerId, nm, salt, hash, now, now);
      return { playerId, name: nm, wins: 0, losses: 0, draws: 0, rating: START_RATING };
    }
    const expected = Buffer.from(existing.secretHash);
    const actual = hashSecret(secret, Buffer.from(existing.salt));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null; // wrong secret
    if (nm !== existing.name) {
      this.db.prepare("UPDATE profiles SET name = ?, updated = ? WHERE playerId = ?").run(nm, now, playerId);
      existing.name = nm;
    }
    return this.toProfile(existing);
  }

  /** Tally a match result for a player (identity must already exist). No-op for an unknown id. */
  recordResult(playerId: string, result: ResultKind): void {
    const col = result === "win" ? "wins" : result === "loss" ? "losses" : "draws";
    this.db.prepare(`UPDATE profiles SET ${col} = ${col} + 1, updated = ? WHERE playerId = ?`).run(Date.now(), playerId);
  }

  getProfile(playerId: string): Profile | null {
    const r = this.row(playerId);
    return r ? this.toProfile(r) : null;
  }

  close(): void {
    this.db.close();
  }
}
