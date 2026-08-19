/**
 * Byte-level tests for the dependency-free WebSocket codec (ws.ts): the accept-key hash, frame encoding
 * at every length boundary, masked client frames, fragmentation, split TCP chunks, and control frames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptKey, encodeFrame, FrameDecoder } from "./ws.ts";

/** Build a masked client→server frame (browsers always mask), the input the decoder must handle. */
function maskFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= key[i & 3]!;
  const len = masked.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, key, masked]);
}

function collect(maxBytes?: number) {
  const texts: string[] = [];
  const events: string[] = [];
  const dec = new FrameDecoder(
    {
      onText: (s) => texts.push(s),
      onPing: () => events.push("ping"),
      onPong: () => events.push("pong"),
      onClose: () => events.push("close"),
      onError: (r) => events.push(`error:${r}`),
    },
    maxBytes,
  );
  return { dec, texts, events };
}

test("acceptKey matches the RFC 6455 example", () => {
  // The canonical example from RFC 6455 §1.3.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("encodeFrame — 7-bit length header (text, unmasked, FIN)", () => {
  const f = encodeFrame(0x1, Buffer.from("hi"));
  assert.equal(f[0], 0x81, "FIN + text opcode");
  assert.equal(f[1], 2, "length 2, mask bit clear");
  assert.equal(f.subarray(2).toString(), "hi");
});

test("encodeFrame — 16-bit and 64-bit length headers at the boundaries", () => {
  const f16 = encodeFrame(0x1, Buffer.alloc(126));
  assert.equal(f16[1], 126); assert.equal(f16.readUInt16BE(2), 126);
  const fBig = encodeFrame(0x1, Buffer.alloc(65536));
  assert.equal(fBig[1], 127); assert.equal(Number(fBig.readBigUInt64BE(2)), 65536);
});

test("decoder round-trips a masked text frame", () => {
  const { dec, texts } = collect();
  dec.push(maskFrame(0x1, Buffer.from("hello world", "utf8")));
  assert.deepEqual(texts, ["hello world"]);
});

test("decoder handles every length boundary (0, 125, 126, 65535, 65536)", () => {
  for (const n of [0, 125, 126, 65535, 65536]) {
    const { dec, texts } = collect();
    const payload = "x".repeat(n);
    dec.push(maskFrame(0x1, Buffer.from(payload, "utf8")));
    assert.equal(texts.length, 1, `one message at len ${n}`);
    assert.equal(texts[0]!.length, n, `payload length ${n} preserved`);
  }
});

test("decoder reassembles a fragmented message (text + continuation)", () => {
  const { dec, texts } = collect();
  dec.push(maskFrame(0x1, Buffer.from("Ele", "utf8"), false)); // fin=false starts a fragmented message
  dec.push(maskFrame(0x0, Buffer.from("ment", "utf8"), true)); // continuation, fin=true completes it
  assert.deepEqual(texts, ["Element"]);
});

test("decoder tolerates frames split across TCP chunks (byte-by-byte)", () => {
  const { dec, texts } = collect();
  const frame = maskFrame(0x1, Buffer.from("chunked-delivery", "utf8"));
  for (const byte of frame) dec.push(Buffer.from([byte])); // one byte at a time
  assert.deepEqual(texts, ["chunked-delivery"]);
});

test("decoder parses multiple frames arriving in one chunk", () => {
  const { dec, texts } = collect();
  dec.push(Buffer.concat([maskFrame(0x1, Buffer.from("a")), maskFrame(0x1, Buffer.from("b")), maskFrame(0x1, Buffer.from("c"))]));
  assert.deepEqual(texts, ["a", "b", "c"]);
});

test("decoder dispatches ping / pong / close control frames", () => {
  const { dec, events } = collect();
  dec.push(maskFrame(0x9, Buffer.alloc(0))); // ping
  dec.push(maskFrame(0xa, Buffer.alloc(0))); // pong
  dec.push(maskFrame(0x8, Buffer.alloc(0))); // close
  assert.deepEqual(events, ["ping", "pong", "close"]);
});

test("decoder fails a frame larger than maxBytes instead of buffering it", () => {
  const { dec, texts, events } = collect(64);
  dec.push(maskFrame(0x1, Buffer.from("x".repeat(200), "utf8")));
  assert.equal(texts.length, 0, "oversize message is not delivered");
  assert.ok(events.some((e) => e.startsWith("error:")), "an error is raised");
});

test("decoder fails a stray continuation frame", () => {
  const { dec, events } = collect();
  dec.push(maskFrame(0x0, Buffer.from("orphan", "utf8"), true));
  assert.ok(events.some((e) => e.startsWith("error:")), "continuation with no message in progress errors");
});
