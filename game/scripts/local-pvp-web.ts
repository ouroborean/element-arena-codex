/**
 * Manual PvP test harness: start the match server + a static web server, then open TWO browser windows of
 * the real web client — one for each side — so you can navigate the menus and pick skills/targets yourself.
 *
 *   node game/scripts/local-pvp-web.ts
 *
 * Each window gets a distinct guest identity via `?player=1` / `?player=2` (the server never self-pairs one
 * identity), so pressing **Quick Match** in both — with a full team of 3 — pairs them against each other.
 * The script stays running; press Ctrl+C to shut the server + web host down.
 *
 * Flags: --serverPort (8790), --webPort (8000), --no-open (print the URLs instead of launching a browser),
 *        --browser=<cmd> (force a specific browser command). Needs Node 24+.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { createInterface } from "node:readline";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq >= 0 ? hit.slice(eq + 1) : "true";
}

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const gameDir = normalize(join(scriptsDir, ".."));  // scripts/ -> game/
const repoRoot = normalize(join(gameDir, ".."));     // game/ -> repo root (the web client needs ../../assets)

const serverPort = arg("serverPort", process.env.ARENA_PORT || "8790")!;
const webPort = Number(arg("webPort", "8000"));
const noOpen = arg("no-open") === "true";
const browserCmd = arg("browser");

const children = new Set<ChildProcess>();
let shuttingDown = false;
function shutdown(code: number): never {
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { webServer.close(); } catch { /* not started */ }
  process.exit(code);
}
process.on("SIGINT", () => { console.log("\n[local-pvp-web] shutting down"); shutdown(0); });

// ── a minimal static file server rooted at the repo root (localhost only) ─────────────────────────────── //
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};
const webServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    // Resolve within the repo root; reject anything that escapes it (directory traversal).
    const abs = normalize(join(repoRoot, rel));
    if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) { res.writeHead(403).end("forbidden"); return; }
    let target = abs;
    const info = await stat(abs).catch(() => null);
    if (info?.isDirectory()) target = join(abs, "index.html");
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

function waitForPort(p: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = connect({ host: "127.0.0.1", port: p }, () => { sock.destroy(); resolve(); });
      sock.on("error", () => { sock.destroy(); Date.now() > deadline ? reject(new Error(`nothing listening on :${p} within ${timeoutMs / 1000}s`)) : setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
}

function pipePrefixed(child: ChildProcess, prefix: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) createInterface({ input: stream }).on("line", (line) => console.log(prefix, line));
  }
}

function openBrowser(url: string): void {
  try {
    if (browserCmd) spawn(browserCmd, [url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch { console.log(`   (couldn't auto-open a browser — open this yourself: ${url})`); }
}

async function main(): Promise<void> {
  // 1) the authoritative match server (in-memory accounts — records/ratings reset when you stop it).
  console.log(`[local-pvp-web] starting match server on :${serverPort}…`);
  const server = spawn(process.execPath, [join("server", "index.ts")], { cwd: gameDir, env: { ...process.env, ARENA_PORT: serverPort, ARENA_DB: ":memory:" } });
  children.add(server);
  pipePrefixed(server, "[server]");
  server.on("exit", (code) => { if (!shuttingDown) { console.error(`[local-pvp-web] match server exited (code ${code}) — aborting`); shutdown(1); } });

  // 2) the static web host, serving the repo root so the client's ../../assets resolve.
  await new Promise<void>((r) => webServer.listen(webPort, "127.0.0.1", r));
  console.log(`[local-pvp-web] web client served at http://localhost:${webPort}/game/web/`);

  try { await waitForPort(Number(serverPort), 15_000); } catch (e) { console.error(`[local-pvp-web] ${(e as Error).message}`); shutdown(1); }

  // 3) open the two clients — distinct identities via ?player=, both dial the match server on :serverPort.
  // The web client defaults to :8790, so only pin ?server= when we started it somewhere else.
  const serverQ = serverPort === "8790" ? "" : `&server=ws://localhost:${serverPort}`;
  const u1 = `http://localhost:${webPort}/game/web/?player=1${serverQ}`;
  const u2 = `http://localhost:${webPort}/game/web/?player=2${serverQ}`;
  console.log("\n[local-pvp-web] ready — two clients:");
  console.log(`   Player 1:  ${u1}`);
  console.log(`   Player 2:  ${u2}`);
  console.log("\n   In EACH window: pick a 3-hero team, then press \"Quick Match\" -- they pair against each other.");
  console.log("   Press Ctrl+C here to stop.\n");

  if (noOpen) console.log("[local-pvp-web] --no-open: open the two URLs above yourself.");
  else { openBrowser(u1); setTimeout(() => openBrowser(u2), 400); } // small stagger so the browser opens two tabs cleanly
}

main();
