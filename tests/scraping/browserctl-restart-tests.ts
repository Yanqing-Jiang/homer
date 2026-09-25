/**
 * A daemon restart must not interrupt a running `browserctl agent`: the real control server and
 * broker, the real `bin/browserctl`, a fake CDP endpoint and a fake agent-browser. The first broker
 * generation's socket disappears mid-run exactly as it does when launchd cycles the daemon; a second
 * broker restores the persisted holder snapshot and the agent's renew/release land on it unchanged.
 */
import "../helpers/no-telegram.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { BrowserLeaseBroker, HttpBrowserTargetClient, startBrowserControlServer, stopBrowserControlServer, type BrowserControlInstance } from "../../src/scraping/browser-control.js";

type Page = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
const SURFACE = "agent.restart-test";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ctl-restart-"));
  const socketPath = join(dir, "broker.sock");
  const binary = join(dir, "fake-agent-browser.mjs");
  let next = 0;
  const pages = new Map<string, Page>([["launch", { id: "launch", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://x/launch" }]]);
  const http = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/json/new") {
      const id = `p${++next}`;
      const target = { id, type: "page", url: decodeURIComponent(url.search.slice(1)), webSocketDebuggerUrl: `ws://x/${id}` };
      pages.set(id, target); res.end(JSON.stringify(target)); return;
    }
    if (url.pathname.startsWith("/json/close/")) { pages.delete(url.pathname.slice("/json/close/".length)); res.end("Target is closing"); return; }
    res.end(JSON.stringify([...pages.values()]));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", () => resolve()));
  const port = (http.address() as { port: number }).port;
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1];
if (args.includes('close')) process.exit(0);
if (args.includes('open')) {
  const id = (await (await fetch('http://127.0.0.1:${port}/json/new?' + encodeURIComponent(args.at(-1)), { method: 'PUT' })).json()).id;
  writeFileSync(process.env.AGENT_BROWSER_SOCKET_DIR + '/' + session + '.target', JSON.stringify({ targetId: id, pinned: args.includes('--pin-tab') }));
}
`, { mode: 0o700 });

  let server: ReturnType<typeof startBrowserControlServer> | null = null;
  /** One broker generation: the downloads-shaped expiry policy, so a lapsed TTL is really tested. */
  const generation = async () => {
    const broker = new BrowserLeaseBroker(new HttpBrowserTargetClient(port), Date.now, false, 4);
    broker.beginGeneration(1);
    const instance: BrowserControlInstance = {
      id: "interactive", endpoint: `http://127.0.0.1:${port}`, broker,
      ready: async () => {},
      status: async () => ({ state: "ready", leases: broker.snapshot(), reservations: broker.externalReservationSummary() }),
      changed: () => {},
    };
    server = startBrowserControlServer(new BrowserLeaseBroker(new HttpBrowserTargetClient(port)), async () => {}, socketPath, undefined, [instance]);
    await new Promise<void>(resolve => server!.once("listening", () => resolve()));
    return broker;
  };
  const stopServer = async () => { if (server) await stopBrowserControlServer(server, socketPath); server = null; };
  const go = join(dir, "go");
  // --ttl 2: renew every second, and the lease lapses during the outage unless the restore graces it.
  const agent = (): { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } => {
    const child = spawn(process.execPath, ["bin/browserctl", "agent", SURFACE, "--instance", "interactive", "--ttl", "2", "--",
      "/bin/sh", "-c", `while [ ! -f '${go}' ]; do sleep 0.1; done`],
    { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath, HOMER_AGENT_BROWSER_BIN: binary, AGENT_BROWSER_SOCKET_DIR: dir, HOMER_BROWSER_GRANT: "" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    return { child, done: new Promise(resolve => child.once("close", code => resolve({ code, stderr }))) };
  };
  const close = async () => { await stopServer(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); };
  return { pages, generation, stopServer, agent, go, socketPath, close };
}

test("an agent survives a broker restart: same leaseId renews on the restored broker and release closes its tab", async () => {
  const h = await fixture();
  let child: ChildProcess | undefined;
  try {
    const first = await h.generation();
    const run = h.agent(); child = run.child;
    await until(() => first.snapshot().some(record => record.surface === SURFACE && record.leaseId), "the agent to register its tab");
    const record = first.snapshot().find(row => row.surface === SURFACE)!;
    const holder = first.externalHolderSnapshot()!;
    assert.equal(holder.records.length, 1);

    // The daemon goes away. Its socket is unlinked; the agent's renews fail with ENOENT.
    await h.stopServer();
    await sleep(2_500);
    assert.equal(child.exitCode, null, "the workflow keeps running while no broker is listening");

    // The next generation listens before its restore finishes: renews meanwhile answer RESTORING.
    const second = await h.generation();
    second.setRestoring(Date.now() + 60_000);
    const renewed: string[] = [];
    const renew = second.renew.bind(second);
    second.renew = (leaseId, ttl) => { const result = renew(leaseId, ttl); renewed.push(leaseId); return result; };
    await sleep(1_500);
    assert.equal(renewed.length, 0, "RESTORING is a transient answer, not a lost lease");
    assert.equal(child.exitCode, null);
    const restored = await second.restoreExternalHolder(holder);
    second.setRestoring(null);
    assert.equal(restored.outcome, "restored");
    await until(() => renewed.length > 0, "a successful renew on the restored broker");
    await sleep(1_500);
    assert.ok(renewed.every(id => id === record.leaseId), "renewed with the original leaseId");
    assert.ok(h.pages.has(record.targetId), "the agent's tab survived the restart");

    await writeFile(h.go, "1");
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /browser broker unavailable for renew/);
    assert.doesNotMatch(result.stderr, /renewal failed/);
    assert.equal(h.pages.has(record.targetId), false, "release on the restored broker closed the tab");
    assert.equal(second.snapshot().filter(row => row.leaseId).length, 0, "nothing is left leased");
  } finally { child?.kill("SIGKILL"); await h.close(); }
});

test("an agent that died during the outage is discarded on restore and its tab is closed", async () => {
  const h = await fixture();
  let child: ChildProcess | undefined;
  try {
    const first = await h.generation();
    const run = h.agent(); child = run.child;
    await until(() => first.snapshot().some(record => record.surface === SURFACE && record.leaseId), "the agent to register its tab");
    const record = first.snapshot().find(row => row.surface === SURFACE)!;
    const holder = first.externalHolderSnapshot()!;
    await h.stopServer();

    // SIGKILL: no release, no cleanup. Its workflow group goes too, so no driver keeps it "alive".
    const drivers = `${h.socketPath}.drivers.${child.pid}.json`;
    const groups: number[] = existsSync(drivers) ? JSON.parse(readFileSync(drivers, "utf8")) : [];
    child.kill("SIGKILL");
    for (const pgid of groups) try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    await run.done;

    const second = await h.generation();
    const restored = await second.restoreExternalHolder(holder);
    assert.equal(restored.outcome, "holders-gone");
    assert.equal(second.hasLease(record.leaseId!), false, "the dead holder's lease is not resurrected");
    assert.equal(h.pages.has(record.targetId), false, "its abandoned tab is closed");
    assert.ok(h.pages.has("launch"), "an unrelated page is untouched");
  } finally { child?.kill("SIGKILL"); await h.close(); }
});
