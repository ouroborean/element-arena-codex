/**
 * A headless test client for the Quick Match server. It authenticates a guest identity, joins the queue
 * with a team, and — once matched — plays the whole match automatically with the engine's own AI
 * (`defaultPolicy` for turns, `autoDraft` for the between-round upgrade), printing each event. It exits 0
 * on a clean `matchEnd`, non-zero on an error or timeout.
 *
 * Standalone and reusable: point it at any server. Two of these against one server play a full PvP match.
 *
 *   node game/scripts/bot-client.ts --name=Alice --team=pyrrha,jarrik,gommar
 *   node game/scripts/bot-client.ts --server=ws://127.0.0.1:8790 --name=Bob --team=ando,syl,riverdaughter --ranked
 *
 * Needs Node 24+ (native .ts execution + global WebSocket).
 */
import { defaultPolicy } from "../engine/content/match.ts";
import { autoDraft } from "../client/draft.ts";
import { parseMessage, PROTOCOL_VERSION, DEFAULT_PORT, type ClientMsg, type ServerMsg } from "../net/protocol.ts";
import type { TeamId } from "../engine/src/types.ts";

// ---- args ----------------------------------------------------------------- //
function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq >= 0 ? hit.slice(eq + 1) : "true";
}

const name = arg("name", "Bot")!;
const team = (arg("team", "pyrrha,jarrik,gommar")!).split(",").map((s) => s.trim()).filter(Boolean);
const ranked = arg("ranked") === "true";
const server = arg("server", `ws://127.0.0.1:${process.env.ARENA_PORT || DEFAULT_PORT}`)!;
const playerId = arg("id", `bot-${name.toLowerCase()}`)!;
const secret = arg("secret", `secret-${playerId}`)!;
// If nothing happens for this long, something is wrong (deadlock / lost socket) — bail loudly.
const IDLE_TIMEOUT_MS = Number(arg("idleMs", "90000"));

const tag = `[${name}]`;
const log = (...a: unknown[]) => console.log(tag, ...a);

// ---- connect + play ------------------------------------------------------- //
const ws = new WebSocket(server);
let you: TeamId | undefined;
let turns = 0;
let idle: NodeJS.Timeout;

function bumpIdle(): void {
  clearTimeout(idle);
  idle = setTimeout(() => {
    console.error(tag, `no server message for ${IDLE_TIMEOUT_MS / 1000}s — giving up`);
    process.exit(2);
  }, IDLE_TIMEOUT_MS);
  idle.unref?.();
}

const send = (m: ClientMsg) => ws.send(JSON.stringify(m));

ws.addEventListener("open", () => {
  log(`connected to ${server}; authenticating as "${name}"`);
  send({ t: "auth", playerId, secret, name, protocolVersion: PROTOCOL_VERSION });
  bumpIdle();
});

ws.addEventListener("error", (e) => {
  console.error(tag, "socket error:", (e as unknown as { message?: string }).message ?? e);
  process.exit(1);
});

ws.addEventListener("close", () => {
  // A close before matchEnd is unexpected; matchEnd itself calls process.exit first.
  clearTimeout(idle);
});

ws.addEventListener("message", (ev) => {
  bumpIdle();
  const msg = parseMessage<ServerMsg>(String(ev.data));
  if (!msg) return;
  switch (msg.t) {
    case "authed":
      log(`authed (record ${msg.profile.wins}-${msg.profile.losses}-${msg.profile.draws}, rating ${msg.profile.rating}); queueing ${ranked ? "RANKED" : "casual"} with [${team.join(", ")}]`);
      send({ t: "queue", team, ranked, protocolVersion: PROTOCOL_VERSION });
      break;
    case "authError":
      console.error(tag, "auth refused:", msg.message);
      process.exit(1);
      break;
    case "queued":
      log("in queue, waiting for an opponent…");
      break;
    case "start":
      you = msg.you;
      log(`MATCHED — you are Team ${msg.you} vs "${msg.opponentName}" [${msg.opponentTeam.join(", ")}] (match ${msg.matchId})`);
      break;
    case "yourTurn": {
      const actions = defaultPolicy(msg.state, you!);
      turns++;
      log(`turn ${turns}: submitting ${actions.length} action(s)`);
      send({ t: "turn", actions }); // genericPay omitted — the engine auto-allocates generic for a bot
      break;
    }
    case "opponentTurn":
      break; // the opponent is acting; nothing to do
    case "yourDraft": {
      const choice = autoDraft(msg.state, you!);
      log(`between-round draft: ${describeDraft(choice)}`);
      send({ t: "draftChoice", choice });
      break;
    }
    case "opponentDraft":
      break;
    case "opponentDisconnected":
      log(`opponent dropped — holding ${Math.round(msg.graceMs / 1000)}s for a reconnect`);
      break;
    case "opponentReconnected":
      log("opponent reconnected");
      break;
    case "matchEnd": {
      const won = msg.outcome.winner === you;
      const rating = msg.rating ? ` (rating ${msg.rating.rating}, ${msg.rating.delta >= 0 ? "+" : ""}${msg.rating.delta})` : "";
      log(`MATCH OVER — ${won ? "WON" : msg.outcome.winner ? "LOST" : "DRAW"} by ${msg.reason} (winner: Team ${msg.outcome.winner ?? "none"})${rating}`);
      clearTimeout(idle);
      ws.close();
      process.exit(0); // a match that reaches a clean end is a successful test, regardless of who won
      break;
    }
    case "error":
      console.error(tag, "server error:", msg.message);
      process.exit(1);
      break;
  }
});

function describeDraft(c: ReturnType<typeof autoDraft>): string {
  if (c.kind === "fuse") return `fuse ${c.unitId} -> ${c.formKey}`;
  if (c.kind === "augment") return `augment ${c.unitId} (${c.augmentId})`;
  return "skip";
}
