/**
 * A tiny, dependency-free WebSocket server (RFC 6455) over node:http — enough for the Quick Match
 * relay without pulling in `ws`, so the server runs with a bare `node` like the rest of the repo.
 *
 * Scope: text frames only (our protocol is JSON), server→client frames unmasked, client→server frames
 * unmasked-or-masked, ping/pong keepalive, and clean close. Fragmented messages are reassembled; frames
 * larger than `maxBytes` fail the connection (a memory-abuse guard). Binary frames are ignored.
 *
 * The frame codec (`encodeFrame` + `FrameDecoder`) is pure and unit-tested in ws.test.ts.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 magic for the accept-key hash
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key (SHA-1 of key+GUID, base64). */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Encode one unmasked frame (server→client). `payload` is the raw bytes; opcode is 0x1 for text. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

type DecoderHooks = {
  onText(s: string): void;
  onPing(p: Buffer): void;
  onPong(): void;
  onClose(): void;
  onError(reason: string): void;
};

/**
 * Incremental frame decoder. Feed it TCP chunks via `push`; it invokes the hooks per complete frame,
 * reassembling fragmented text messages. Kept a standalone class so the byte-level logic is testable.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOpcode = -1;
  private failed = false;
  private hooks: DecoderHooks;
  private maxBytes: number;

  constructor(hooks: DecoderHooks, maxBytes = 4 * 1024 * 1024) {
    this.hooks = hooks;
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.failed && this.step()) {
      /* consume every complete frame currently buffered */
    }
  }

  /** Parse one frame if fully buffered; return true if a frame was consumed, false if more bytes are needed. */
  private step(): boolean {
    const buf = this.buf;
    if (buf.length < 2) return false;
    const b0 = buf[0]!, b1 = buf[1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxBytes)) return this.fail("frame too large");
      len = Number(big);
      offset = 10;
    }
    if (len > this.maxBytes) return this.fail("frame too large");
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return false;

    const payload = Buffer.from(buf.subarray(offset, offset + len)); // copy out before we advance the buffer
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i & 3]!;
    this.buf = buf.subarray(offset + len);
    this.dispatch(fin, opcode, payload);
    return !this.failed;
  }

  private dispatch(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_CLOSE: this.hooks.onClose(); return;
      case OP_PING: this.hooks.onPing(payload); return;
      case OP_PONG: this.hooks.onPong(); return;
      case OP_TEXT:
      case OP_BIN:
        if (this.fragOpcode !== -1) return void this.fail("new data frame during a fragmented message");
        if (fin) return this.deliver(opcode, payload); // the common case: a whole message in one frame
        this.fragOpcode = opcode;
        this.fragments = [payload];
        return;
      case OP_CONT:
        if (this.fragOpcode === -1) return void this.fail("continuation with no message in progress");
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = [];
          this.fragOpcode = -1;
          this.deliver(op, whole);
        }
        return;
      default:
        this.fail(`unknown opcode ${opcode}`);
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (opcode === OP_TEXT) this.hooks.onText(payload.toString("utf8"));
    // Binary frames are outside our JSON protocol — silently dropped.
  }

  private fail(reason: string): boolean {
    if (!this.failed) {
      this.failed = true;
      this.hooks.onError(reason);
    }
    return false;
  }
}

/** A live WebSocket connection: `send` a JSON string, and register message/close handlers. */
export class WsConn {
  onMessage?: (msg: string) => void;
  onClose?: () => void;
  /** Heartbeat liveness — set false before each ping, flipped true again on the client's pong. */
  isAlive = true;
  private closed = false;
  private decoder: FrameDecoder;
  private socket: Duplex;

  constructor(socket: Duplex) {
    this.socket = socket;
    this.decoder = new FrameDecoder({
      onText: (s) => this.onMessage?.(s),
      onPing: (p) => this.rawSend(OP_PONG, p),
      onPong: () => { this.isAlive = true; },
      onClose: () => this.close(),
      onError: () => this.destroy(),
    });
    socket.on("data", (d: Buffer) => this.decoder.push(d));
    socket.on("close", () => this.markClosed());
    socket.on("error", () => this.markClosed());
    if ("setNoDelay" in socket) (socket as { setNoDelay(v: boolean): void }).setNoDelay(true);
  }

  /** Feed the trailing bytes that arrived with the HTTP upgrade (the `head` buffer). */
  feed(bytes: Buffer): void {
    if (bytes.length) this.decoder.push(bytes);
  }

  send(text: string): void {
    if (!this.closed) this.rawSend(OP_TEXT, Buffer.from(text, "utf8"));
  }

  ping(): void {
    if (!this.closed) this.rawSend(OP_PING, Buffer.alloc(0));
  }

  private rawSend(opcode: number, payload: Buffer): void {
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      this.markClosed();
    }
  }

  /** Graceful close: send a close frame and end the socket. */
  close(): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
      this.socket.end();
    } catch { /* already gone */ }
    this.markClosed();
  }

  /** Hard close (protocol error / abuse). */
  destroy(): void {
    if (this.closed) return;
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

/**
 * Attach WebSocket handling to an http.Server: perform the RFC 6455 handshake on every valid upgrade and
 * hand a live `WsConn` to `onConnection`. Non-WebSocket upgrades are dropped.
 */
export function attachWebSocketServer(server: Server, onConnection: (conn: WsConn) => void): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const key = req.headers["sec-websocket-key"];
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const conn = new WsConn(socket);
    onConnection(conn);
    conn.feed(head);
  });
}
