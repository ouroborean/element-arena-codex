/**
 * One-command local PvP smoke test: start the Quick Match server, then launch two headless bot clients
 * that get matched and play a full match against each other. Prints the server log and each client's
 * perspective, then tears everything down. Exits 0 only if both clients reached a clean match end.
 *
 *   node game/scripts/local-pvp.ts
 *   node game/scripts/local-pvp.ts --port=8899 --ranked
 *   node game/scripts/local-pvp.ts --teamA=pyrrha,jarrik,gommar --teamB=ando,syl,riverdaughter
 *
 * The server runs on an in-memory account store (ARENA_DB=:memory:), so nothing is written to disk.
 * Needs Node 24+. Ctrl+C shuts the whole thing down.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq >= 0 ? hit.slice(eq + 1) : "true";
}

const gameDir = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> game/
const port = arg("port", process.env.ARENA_PORT || "8790")!;
const ranked = arg("ranked") === "true";
const teamA = arg("teamA", "pyrrha,jarrik,gommar")!;
const teamB = arg("teamB", "ando,syl,riverdaughter")!;
const READY_TIMEOUT_MS = 15_000;
const MATCH_TIMEOUT_MS = Number(arg("timeoutMs", "180000")); // whole-match safety net

const children = new Set<ChildProcess>();
let shuttingDown = false;
function shutdown(code: number): never {
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  process.exit(code);
}
process.on("SIGINT", () => { console.log("\n[local-pvp] interrupted — shutting down"); shutdown(130); });

/** Pipe a child's stdout+stderr through, line-buffered, with a prefix. */
function pipePrefixed(child: ChildProcess, prefix: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", (line) => console.log(prefix, line));
  }
}

/** Resolve once something is accepting TCP connections on the port (the server has bound). */
function waitForPort(p: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = connect({ host: "127.0.0.1", port: p }, () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`server did not open :${p} within ${timeoutMs / 1000}s`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function onExit(child: ChildProcess, label: string): Promise<number> {
  return new Promise((resolve) => child.on("exit", (code) => {
    if (!shuttingDown) console.log(`[local-pvp] ${label} exited (code ${code ?? 0})`);
    resolve(code ?? 0);
  }));
}

function spawnBot(name: string, team: string): ChildProcess {
  const args = ["scripts/bot-client.ts", `--server=ws://127.0.0.1:${port}`, `--name=${name}`, `--team=${team}`];
  if (ranked) args.push("--ranked");
  const bot = spawn(process.execPath, args, { cwd: gameDir });
  children.add(bot);
  pipePrefixed(bot, ""); // the bot already prefixes its own lines with [name]
  return bot;
}

async function main(): Promise<void> {
  console.log(`[local-pvp] starting server on :${port} (in-memory accounts)…`);
  const server = spawn(process.execPath, [join("server", "index.ts")], {
    cwd: gameDir,
    env: { ...process.env, ARENA_PORT: port, ARENA_DB: ":memory:" },
  });
  children.add(server);
  pipePrefixed(server, "[server]");
  server.on("exit", (code) => { if (!shuttingDown) { console.error(`[local-pvp] server exited early (code ${code}) — aborting`); shutdown(1); } });

  try {
    await waitForPort(Number(port), READY_TIMEOUT_MS);
  } catch (e) {
    console.error(`[local-pvp] ${(e as Error).message}`);
    shutdown(1);
  }
  console.log(`[local-pvp] server is up — launching two ${ranked ? "RANKED" : "casual"} clients`);

  const alice = spawnBot("Alice", teamA);
  const bob = spawnBot("Bob", teamB);

  const timeout = setTimeout(() => { console.error(`[local-pvp] match did not finish within ${MATCH_TIMEOUT_MS / 1000}s — aborting`); shutdown(1); }, MATCH_TIMEOUT_MS);
  timeout.unref?.();

  const codes = await Promise.all([onExit(alice, "Alice"), onExit(bob, "Bob")]);
  clearTimeout(timeout);
  console.log("[local-pvp] both clients finished — stopping server");
  const ok = codes.every((c) => c === 0);
  console.log(`[local-pvp] ${ok ? "PASS ✓ both clients reached a clean match end" : "FAIL ✗ a client exited with an error"}`);
  shutdown(ok ? 0 : 1);
}

main();
