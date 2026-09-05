// Explicit local-fixture integration drill. Never connects to production :9222.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { InteractiveBrowser } from "../../src/scraping/interactive-browser.js";
import { startBrowserControlServer, stopBrowserControlServer, type BrowserControlInstance } from "../../src/scraping/browser-control.js";

const dir = await mkdtemp(join(tmpdir(), "amz-browsers-"));
const output = process.env.AMZ_BROWSER_DRILL_OUTPUT ?? dir; await mkdir(output, { recursive: true });
const http = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end('<title>AMZ isolated fixture</title><input id="value"><p id="count">0</p>'); });
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const address = http.address(); assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
const download = new InteractiveBrowser(join(dir, "profile-download"), join(dir, "state-download.json"), 9441, 1000);
const interactive = new InteractiveBrowser(join(dir, "profile-interactive"), join(dir, "state-interactive.json"), 9442, 1000);
const fixtureDownload: BrowserControlInstance = { id: "downloads", endpoint: download.endpoint, broker: download.broker, ready: () => download.ready(), status: () => download.status(), changed: () => download.changed() };
await Promise.all([download.initialize(), interactive.initialize()]);
const socketPath = join(dir, "broker.sock");
let server = startBrowserControlServer(download.broker, async () => { throw new Error("fixture never permits maintenance"); }, socketPath, undefined, [fixtureDownload, interactive]);
await new Promise<void>(resolve => server.once("listening", resolve));
function client(instance: string) {
  const child = spawn(process.execPath, [join(process.cwd(), "bin/browserctl"), "agent", `agent.fixture-${instance}`, "--instance", instance, "--ttl", "300", "--rpc"], { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] });
  let n = 0; let stderr = "";
  const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", chunk => { stderr += chunk; });
  let readyResolve: () => void; let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const r = JSON.parse(line); if (r.ready) { readyResolve(); return; }
    const p = pending.get(r.id); if (!p) return; pending.delete(r.id);
    if (r.ok) p.resolve(r.stdout); else p.reject(new Error(r.error));
  });
  child.on("exit", code => { const error = new Error(`fixture driver exited ${code}: ${stderr}`); readyReject(error); for (const p of pending.values()) p.reject(error); });
  return { child, ready, async command(args: string[]) { await ready; const id = ++n; return new Promise<string>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, args, timeoutMs: 20000 }) + "\n"); }); }, async close() { child.stdin.end(); if (child.exitCode === null) await new Promise<void>(resolve => child.once("exit", () => resolve())); } };
}
const a = client("downloads"); const b = client("interactive");
const start = Date.now(); let operations = 0;
try {
  await Promise.all([a.ready, b.ready]); console.log("both fixture browsers ready", Date.now() - start);
  await Promise.all([a.command(["open", url]), b.command(["open", url])]);
  const expr = (label: string) => `(() => { const e=document.querySelector('#value'); e.value=${JSON.stringify(label)}; document.cookie='fixture='+e.value+'; path=/; max-age=86400'; const count=document.querySelector('#count'); count.textContent=String(Number(count.textContent)+1); return {value:e.value,count:Number(count.textContent),cookie:document.cookie}; })()`;
  for (let i = 1; i <= 50; i++) {
    const values = await Promise.all([a.command(["eval", expr("downloads")]), b.command(["eval", expr("interactive")])]);
    for (let j = 0; j < 2; j++) { const value = JSON.parse(values[j]!); assert.equal(value.value, j === 0 ? "downloads" : "interactive"); assert.equal(value.count, i); assert.equal(value.cookie, `fixture=${value.value}`); }
    operations += 2; if (i % 10 === 0) console.log("interleaved operations", operations);
  }
  await Promise.all([a.command(["screenshot", join(output, "download-fixture.png")]), b.command(["screenshot", join(output, "interactive-fixture.png")])]);
  const before = await download.status();
  await b.close();
  assert.match(await a.command(["eval", "document.querySelector('#value').value"]), /downloads/);
  assert.deepEqual((await download.status() as { pid: number }).pid, (before as { pid: number }).pid);
  await stopBrowserControlServer(server, socketPath);
  interactive.shutdown();
  // Recreate interactive admission state without recycling its persistent browser.
  const restored = new InteractiveBrowser(interactive.profile, interactive.statePath, interactive.port, 1000);
  await restored.initialize();
  server = startBrowserControlServer(download.broker, async () => {}, socketPath, undefined, [fixtureDownload, restored]);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const c = client("interactive"); await c.ready;
  await c.command(["open", url]); assert.match(await c.command(["eval", "document.cookie"]), /fixture=interactive/);
  await c.close(); await a.close();
  await new Promise(resolve => setTimeout(resolve, 1500)); restored.shutdown();
  await writeFile(join(output, "browser-concurrency-result.json"), JSON.stringify({ ok: true, operations, durationMs: Date.now() - start, fixtures: dir, ports: [9441, 9442], production9222Touched: false }, null, 2));
  console.log("PASS: isolation, scoped close, control restart, persistent fixture cookie");
} finally {
  await Promise.allSettled([a.close(), b.close()]);
  await stopBrowserControlServer(server, socketPath).catch(() => {});
  await new Promise<void>(resolve => http.close(() => resolve()));
  // Idle timers stop only the verified fixture browsers; profile artifacts stay available.
  await new Promise(resolve => setTimeout(resolve, 2000));
  download.shutdown(); interactive.shutdown();
}
