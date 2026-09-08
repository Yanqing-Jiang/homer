// Opt-in only: one throwaway headless Chrome, a fixture broker, and no production CDP.
import "../helpers/no-telegram.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { BrowserLeaseBroker, HttpBrowserTargetClient, startBrowserControlServer, stopBrowserControlServer } from "../../src/scraping/browser-control.js";
import { runAgentBrowserBindingSelfTest } from "../../src/scraping/agent-browser-binding.js";

test("three pinned browserctl sessions share Chrome across commands, cleanup and broker recovery", { skip: process.env.HOMER_LIVE_BROWSER_TESTS !== "1", timeout: 180_000 }, async () => {
  const root = process.env.HOMER_BROWSER_TEST_ROOT ?? tmpdir();
  const dir = await mkdtemp(join(root, "b-"));
  // Short names fit Darwin's 103-byte Unix socket path even under the operator's scratch root.
  const socketDir = await mkdtemp(join(root, "s"));
  const previousSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;
  process.env.AGENT_BROWSER_SOCKET_DIR = socketDir;
  const port = Number(process.env.HOMER_BROWSER_TEST_PORT ?? 9607);
  assert.ok(port >= 9600, "live fixture ports must be >=9600");
  const targets = new HttpBrowserTargetClient(port);
  // Refuse an occupied fixture port rather than attaching to someone else's browser.
  await assert.rejects(targets.list(), /fetch failed/);
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const http = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end('<title>fixture</title><input id="value"><p id="count">0</p>'); });
  let broker = new BrowserLeaseBroker(targets, Date.now, false, 3);
  const socketPath = join(dir, "b.sock");
  const startBroker = () => startBrowserControlServer(new BrowserLeaseBroker(targets), async () => { throw new Error("fixture refuses maintenance"); }, socketPath, undefined, [{ id: "interactive", endpoint: `http://127.0.0.1:${port}`, broker, ready: async () => {}, status: async () => ({ state: "ready", leases: broker.snapshot(), reservations: broker.externalReservationSummary() }), changed: () => {} }]);
  let server: ReturnType<typeof startBroker> | undefined;
  const clients: ReturnType<typeof client>[] = [];
  function client(label: string) {
    const child = spawn(process.execPath, ["bin/browserctl", "agent", `agent.${label}`, "--instance", "interactive", "--rpc"], { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] });
    let n = 0, stderr = "";
    const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
    child.stderr.on("data", chunk => { stderr += chunk; });
    let readyResolve!: (session: string) => void, readyReject!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    readline.createInterface({ input: child.stdout }).on("line", line => {
      const r = JSON.parse(line); if (r.ready) { readyResolve(r.session); return; }
      const p = pending.get(r.id); if (!p) return; pending.delete(r.id);
      if (r.ok) p.resolve(r.stdout); else p.reject(new Error(r.error));
    });
    child.on("exit", code => { const error = new Error(`fixture driver exited ${code}: ${stderr}`); readyReject(error); for (const p of pending.values()) p.reject(error); });
    return { child, ready, async command(args: string[]) { await ready; const id = ++n; return new Promise<string>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, args, timeoutMs: 20_000 }) + "\n"); }); }, async close() { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) await once(child, "exit"); } };
  }
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { await targets.list(); break; } catch { if (Date.now() >= deadline) throw new Error("fixture Chrome startup timed out"); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const initialTargetIds = (await targets.list()).map(t => t.id).sort();
    await broker.reconcile("keeper.interactive", ["about:blank"], "about:blank");
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    server = startBroker(); await once(server, "listening");
    clients.push(client("a"), client("b"), client("c"));
    const sessions = await Promise.all(clients.map(c => c.ready));
    const bindings = await Promise.all(sessions.map(async session => JSON.parse(await readFile(join(socketDir, `${session}.target`), "utf8"))));
    assert.equal(new Set(bindings.map(b => b.targetId)).size, 3);
    assert.ok(bindings.every(b => b.pinned === true));
    assert.equal((await targets.list()).length, initialTargetIds.length + 3, "one page per session; no extra connect blanks");
    const orphan = await targets.create("about:blank");
    const cleanup = await promisify(execFile)(process.execPath, ["bin/browserctl", "cleanup-blanks", "--instance", "interactive"], { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath } });
    const swept = JSON.parse(cleanup.stdout);
    assert.ok(swept.closed.includes(orphan.id));
    assert.ok(bindings.every(b => !swept.closed.includes(b.targetId)), "broker cleanup preserves active sessions even when they are blank");
    assert.ok(initialTargetIds.every(id => !swept.closed.includes(id)), "the registered keeper survives cleanup");
    assert.equal(await runAgentBrowserBindingSelfTest(broker, port, 3), "deferred");
    assert.equal(broker.degraded(), null);
    await Promise.all(clients.map((c, i) => c.command(["open", `${url}/#${i}`])));
    for (let iteration = 0; iteration < 3; iteration++) {
      const values = await Promise.all(clients.map((c, i) => c.command(["eval", `document.title='session-${i}'; document.querySelector('#value').value='${i}'; location.hash`])));
      values.forEach((value, i) => assert.equal(JSON.parse(value), `#${i}`));
      const titles = await Promise.all(clients.map(c => c.command(["get", "title"])));
      titles.forEach((title, i) => assert.equal(title.trim(), `session-${i}`));
      const urls = await Promise.all(clients.map(c => c.command(["get", "url"])));
      urls.forEach((value, i) => assert.equal(value.trim(), `${url}/#${i}`));
      await Promise.all(clients.map(c => c.command(["snapshot"])));
    }
    await assert.rejects(clients[0]!.command(["tab", "new"]), /isolation/);
    const holder = broker.externalHolderSnapshot()!;
    await stopBrowserControlServer(server, socketPath);
    broker = new BrowserLeaseBroker(targets, Date.now, false, 3); broker.beginGeneration(2);
    assert.equal((await broker.restoreExternalHolder(holder)).records, 3);
    assert.equal((await broker.restoreExternalHolder(holder)).unresolvedLiveHolders, 0);
    server = startBroker(); await once(server, "listening");
    await clients[0]!.close();
    assert.ok(!(await targets.list()).some(t => t.id === bindings[0].targetId));
    assert.equal((await clients[1]!.command(["get", "title"])).trim(), "session-1");
    assert.equal((await clients[2]!.command(["get", "title"])).trim(), "session-2");
    await Promise.all(clients.slice(1).map(c => c.close()));
    assert.equal(broker.externalLeaseCount(), 0);
    assert.equal(await runAgentBrowserBindingSelfTest(broker, port, 3), "passed");
    assert.equal(await runAgentBrowserBindingSelfTest(new BrowserLeaseBroker(targets), port, 1), "passed");
    assert.deepEqual((await targets.list()).map(t => t.id).sort(), initialTargetIds, "sessions and startup self-tests must restore the exact original page set");
    console.log(`PASS: three browserctl sessions, pinned isolation, recovery, scoped close, contention deferral and both self-tests on :${port}`);
  } finally {
    await Promise.allSettled(clients.map(c => c.close()));
    if (server) await stopBrowserControlServer(server, socketPath).catch(() => {});
    http.close();
    if (chrome.exitCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGKILL"); await exited; }
    if (previousSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR; else process.env.AGENT_BROWSER_SOCKET_DIR = previousSocketDir;
    await rm(dir, { recursive: true, force: true }); await rm(socketDir, { recursive: true, force: true });
  }
});
