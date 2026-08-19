/**
 * Browser transport for Quick Match: a thin, typed wrapper around the platform WebSocket that speaks the
 * shared protocol (../../net/protocol.ts). It only moves JSON messages — all match logic lives in main.ts,
 * which subscribes to `onMessage` and drives the existing board rendering from the server's authoritative
 * state. Nothing here simulates the game.
 */
import type { ClientMsg, Profile, ServerMsg } from "../../net/protocol.ts";
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
  const scheme = location.protocol === "https:" ? "wss" : "ws"; // match the page so an https client isn't mixed-content-blocked
  return `${scheme}://${host}:${DEFAULT_PORT}`;
}

/** The http(s) origin matching serverUrl (ws→http, wss→https) — for the /profile endpoint. */
export function httpBase(): string {
  return serverUrl().replace(/^ws/, "http").replace(/\/+$/, "");
}

/**
 * Fetch (create-or-verify) the guest profile over HTTP, so the team-select screen can show a name + record
 * without opening a match socket. Returns null if the server is unreachable or the identity is refused.
 */
export async function fetchProfile(playerId: string, secret: string, name: string): Promise<Profile | null> {
  try {
    // text/plain avoids a CORS preflight; the server reads the body as JSON.
    const res = await fetch(`${httpBase()}/profile`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ playerId, secret, name }) });
    if (!res.ok) return null;
    return ((await res.json()) as { profile: Profile }).profile ?? null;
  } catch {
    return null;
  }
}
