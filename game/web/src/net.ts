/**
 * Browser transport for Quick Match: a thin, typed wrapper around the platform WebSocket that speaks the
 * shared protocol (../../net/protocol.ts). It only moves JSON messages — all match logic lives in main.ts,
 * which subscribes to `onMessage` and drives the existing board rendering from the server's authoritative
 * state. Nothing here simulates the game.
 */
import type { ClientMsg, ServerMsg } from "../../net/protocol.ts";
import { DEFAULT_PORT, parseMessage } from "../../net/protocol.ts";

export class MatchSocket {
  private ws: WebSocket;
  onMessage?: (msg: ServerMsg) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => this.onOpen?.());
    this.ws.addEventListener("close", () => this.onClose?.());
    this.ws.addEventListener("error", () => this.onError?.());
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = parseMessage<ServerMsg>(String(ev.data));
      if (msg) this.onMessage?.(msg);
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closing */ }
  }
}

/**
 * Where to reach the match server. Overridable (so a GitHub-Pages-hosted client can point at any server):
 *   ?server=wss://host        query param  (highest priority)
 *   localStorage.arenaServer  persisted override
 * else ws://<page-host>:8790  the local-dev default.
 */
export function serverUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get("server");
  if (fromQuery) return fromQuery;
  const stored = localStorage.getItem("arenaServer");
  if (stored) return stored;
  const host = location.hostname || "localhost";
  return `ws://${host}:${DEFAULT_PORT}`;
}
