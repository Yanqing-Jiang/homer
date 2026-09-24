/**
 * Remote resident Chromes (a remote host behind the SSH tunnel): identity is the per-launch browser
 * id from /json/version, never a local pid. A fake CDP HTTP endpoint stands in for the tunnel.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InteractiveBrowser } from "../../src/scraping/interactive-browser.js";
import { RemoteChromeChild, RemoteInteractiveHost, remoteBrowserIdentity } from "../../src/scraping/remote-chrome.js";
import { ResidentChromeSupervisor } from "../../src/scraping/chrome-launcher.js";

type FakeCdp = { server: Server; port: number; set(id: string | null, userAgent?: string): void };
async function fakeCdp(): Promise<FakeCdp> {
  let id: string | null = "11111111-aaaa-bbbb-cccc-000000000001";
  let userAgent = "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0";
  const server = createServer((req, res) => {
    if (id === null) { req.socket.destroy(); return; }
    const port = (server.address() as { port: number }).port;
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/json/version")) res.end(JSON.stringify({ "User-Agent": userAgent, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${id}` }));
    else if (req.url?.startsWith("/json/list")) res.end("[]");
    else { res.statusCode = 404; res.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, port: (server.address() as { port: number }).port, set(next, ua) { id = next; if (ua) userAgent = ua; } };
}

test("identity reads the browser id, refuses a non-Linux Chrome, and reports a dead tunnel as down", async () => {
  const cdp = await fakeCdp();
  try {
    assert.deepEqual(await remoteBrowserIdentity(cdp.port), { state: "up", id: "11111111-aaaa-bbbb-cccc-000000000001" });
    cdp.set("x", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/154");
    assert.equal((await remoteBrowserIdentity(cdp.port)).state, "foreign");
    cdp.set(null);
    assert.deepEqual(await remoteBrowserIdentity(cdp.port, 500), { state: "down" });
  } finally { cdp.server.close(); }
});

test("interactive instance adopts the remote Chrome, re-adopts after a remote restart, and never idle-stops", async () => {
  const cdp = await fakeCdp();
  const dir = mkdtempSync(join(tmpdir(), "remote-interactive-"));
  const controller = new InteractiveBrowser(join(dir, "profile"), join(dir, "state.json"), cdp.port, 10, 4, [], new RemoteInteractiveHost("fakehost", cdp.port));
  try {
    await controller.ready();
    const first = await controller.status() as { state: string; profile: string; pid: number | null; idleStopBlockedBy: string | null };
    assert.equal(first.state, "ready");
    assert.equal(first.profile, "fakehost:homer-chrome@interactive");
    assert.equal(first.pid, null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await controller.status() as { state: string }).state, "ready", "remote Chrome is not idle-stopped");
    cdp.set("11111111-aaaa-bbbb-cccc-000000000002");
    await controller.ready();
    assert.equal((await controller.status() as { state: string }).state, "ready");
    cdp.set("x", "Mozilla/5.0 (Macintosh) Chrome/154");
    await assert.rejects(controller.ready(), /busy or owner is unverified/);
  } finally { controller.shutdown(); cdp.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("remote child reports its first identity and exits when the remote browser id changes", async () => {
  const cdp = await fakeCdp();
  const seen: string[] = [];
  const child = new RemoteChromeChild("downloads", cdp.port, id => seen.push(id), 20, 1_000);
  try {
    const exited = once(child, "exit");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(seen, ["11111111-aaaa-bbbb-cccc-000000000001"]);
    cdp.set("11111111-aaaa-bbbb-cccc-000000000009");
    const [, reason] = await exited as [unknown, string];
    assert.match(reason, /restarted/);
  } finally { child.detach(); cdp.server.close(); }
});

test("remote supervisor stop never signals Chrome and hands live holders to the next generation", () => {
  const kills: string[] = []; const handoffs: string[] = []; let leases = 1;
  const supervisor = new ResidentChromeSupervisor({
    remote: true,
    spawnChrome: () => ({ pid: undefined, once: () => undefined, kill: (signal?: NodeJS.Signals) => { kills.push(String(signal)); return true; } }),
    probe: async () => ({ state: "ready", pages: 1 }), ensureProfile: () => {}, nextGeneration: () => 1, drainLeases: async () => {},
    externalLeases: () => leases, onLeaveForAdoption: kind => { handoffs.push(kind); },
    setTimer: () => setTimeout(() => {}, 0), clearTimer: timer => clearTimeout(timer), heartbeatMs: 60_000, backoffMs: [1],
  });
  supervisor.start(); supervisor.stop();
  assert.deepEqual(kills, []); assert.deepEqual(handoffs, ["deliberate-shutdown-remote"]);
  leases = 0; supervisor.start(); supervisor.stop();
  assert.deepEqual(kills, []); assert.equal(handoffs.length, 1);
});
