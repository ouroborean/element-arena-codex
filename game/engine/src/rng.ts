/**
 * Deterministic, serializable PRNG (mulberry32).
 *
 * Every source of chance in the engine (Blind's random retarget, random-target
 * skills, tie-breaks) draws from here so a match is fully reproducible from its
 * seed — required for replays, netcode reconciliation, and golden tests. The whole
 * state is a single uint32, so it serializes into MatchState trivially.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Rng.pick: empty array");
    return arr[this.int(arr.length)] as T;
  }

  /** In-place Fisher–Yates shuffle (returns the same array). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const a = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = a;
    }
    return arr;
  }

  /** Serializable state. */
  get state(): number {
    return this.s >>> 0;
  }

  static fromState(state: number): Rng {
    return new Rng(state);
  }
}
