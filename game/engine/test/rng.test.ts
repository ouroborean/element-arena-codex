import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/rng.ts";

test("same seed produces the same sequence", () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test("different seeds diverge", () => {
  assert.notEqual(new Rng(1).next(), new Rng(2).next());
});

test("state round-trips (reproducible mid-stream)", () => {
  const a = new Rng(99);
  a.next();
  a.next();
  const resumed = Rng.fromState(a.state);
  assert.equal(resumed.next(), a.next());
});

test("int is bounded and pick stays in range", () => {
  const r = new Rng(7);
  for (let i = 0; i < 1000; i++) {
    const n = r.int(6);
    assert.ok(n >= 0 && n < 6);
  }
  assert.ok(["x", "y", "z"].includes(r.pick(["x", "y", "z"])));
});
