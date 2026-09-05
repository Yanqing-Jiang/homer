import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { BrowserLeaseBroker, startBrowserControlServer, stopBrowserControlServer, type BrowserTargetClient } from "../../src/scraping/browser-control.js";
class Targets implements BrowserTargetClient {
  rows: Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }> = [];
  async list() { await new Promise(resolve => setTimeout(resolve, 2)); return this.rows.map(row => ({ ...row })); }
  async create(url: string) { const row = { id: String(this.rows.length + 1), type: "page", url, webSocketDebuggerUrl: "ws://fixture" }; this.rows.push(row); return row; }
  async close(id: string) { this.rows = this.rows.filter(row => row.id !== id); }
}
function request(path: string, payload: object): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let body = "";
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", data => { body += data; });
    socket.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}
test("same-instance concurrent creation has one winner; separate brokers do not block", async () => {
  const downloads = new BrowserLeaseBroker(new Targets());
  const interactive = new BrowserLeaseBroker(new Targets());
  const outcomes = await Promise.allSettled([downloads.reserveExternal("agent.a", `fixture:${process.pid}`, 60), downloads.reserveExternal("agent.b", `fixture:${process.pid}`, 60)]);
  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
  assert.ok((await interactive.reserveExternal("agent.c", `fixture:${process.pid}`, 60)).leaseId);
});
test("expiry does not admit a new interactive driver while its former owner is alive", async () => {
  let now = 1000; const broker = new BrowserLeaseBroker(new Targets(), () => now, true);
  const old = await broker.reserveExternal("agent.old", `fixture:${process.pid}`, 1);
  now += 2000;
  await assert.rejects(broker.reserveExternal("agent.new", `fixture:${process.pid}`, 60), /reserved/);
  await broker.release(String(old.leaseId));
  assert.ok((await broker.reserveExternal("agent.new", `fixture:${process.pid}`, 60)).leaseId);
});
test("control socket routes leases, endpoints and cleanup to the issuing instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-instances-")); const socketPath = join(dir, "control.sock");
  const downloads = new BrowserLeaseBroker(new Targets()); const interactive = new BrowserLeaseBroker(new Targets());
  let started = 0; let maintenance = 0;
  const server = startBrowserControlServer(downloads, async () => { maintenance++; }, socketPath, undefined, [{ id: "interactive", endpoint: "http://127.0.0.1:9444", broker: interactive, ready: async () => { started++; }, status: async () => ({ state: "ready" }), changed: () => {} }]);
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const dl = await request(socketPath, { verb: "reserve-external", surface: "agent.download", owner: `fixture:${process.pid}`, ttl: 60 });
    const ad = await request(socketPath, { verb: "reserve-external", instance: "interactive", surface: "agent.apply", owner: `fixture:${process.pid}`, ttl: 60 });
    assert.equal(dl.ok, true); assert.equal(ad.ok, true);
    assert.equal(ad.result?.cdpEndpoint, "http://127.0.0.1:9444"); assert.equal(started, 1);
    assert.equal((await request(socketPath, { verb: "renew", leaseId: ad.result?.leaseId, ttl: 60 })).result?.instance, "interactive");
    assert.equal((await request(socketPath, { verb: "release", instance: "downloads", leaseId: ad.result?.leaseId })).ok, false);
    assert.equal((await request(socketPath, { verb: "release", instance: "interactive", leaseId: dl.result?.leaseId })).ok, false);
    assert.equal((await request(socketPath, { verb: "maintenance", instance: "interactive", enabled: true })).ok, false); assert.equal(maintenance, 0);
    assert.equal((await request(socketPath, { verb: "release", leaseId: ad.result?.leaseId })).ok, true);
    assert.ok(downloads.hasLease(String(dl.result?.leaseId)));
    assert.equal((await request(socketPath, { verb: "reserve-external", surface: "agent.other", owner: `fixture:${process.pid}`, ttl: 60 })).ok, false);
  } finally { await stopBrowserControlServer(server, socketPath); await rm(dir, { recursive: true }); }
});
