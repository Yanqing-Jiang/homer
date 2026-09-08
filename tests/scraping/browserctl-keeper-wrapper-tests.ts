/**
 * Keeper policy end to end: the real control server and broker, the real `bin/browserctl`, a fake
 * CDP endpoint and a fake agent-browser daemon that models the pinned 0.37 binary as measured on
 * 2026-09-07 (attaching over --cdp creates a page only when Chrome has none; `--pin-tab open`
 * creates a fresh pinned page).
 *
 * Invariant under test: every interactive session starts and ends with exactly one broker-owned
 * idle `about:blank` (record `keeper.interactive`, no lease), no leases and no reservations, and
 * never touches a non-blank page. The wrapper skips the keeper reconcile whenever it could turn into
 * a null-origin sweep.
 */
import "../helpers/no-telegram.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BrowserLeaseBroker, HttpBrowserTargetClient, startBrowserControlServer, stopBrowserControlServer, type BrowserControlInstance } from "../../src/scraping/browser-control.js";

type Page = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
async function fixture(initial: Array<[string, string]>, state = "ready") {
  const dir = await mkdtemp(join(tmpdir(), "ctl-keeper-"));
  const socketPath = join(dir, "broker.sock");
  const binary = join(dir, "fake-agent-browser.mjs");
  let next = 0;
  let creates = 0;
  const pages = new Map<string, Page>(initial.map(([id, url]) => [id, { id, type: "page", url, webSocketDebuggerUrl: `ws://x/${id}` }]));
  const http = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/json/new") {
      creates++;
      const id = `p${++next}`;
      const target = { id, type: "page", url: decodeURIComponent(url.search.slice(1)), webSocketDebuggerUrl: `ws://x/${id}` };
      pages.set(id, target); res.end(JSON.stringify(target)); return;
    }
    if (url.pathname.startsWith("/json/close/")) { pages.delete(url.pathname.slice("/json/close/".length)); res.end("Target is closing"); return; }
    res.end(JSON.stringify([...pages.values()]));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", () => resolve()));
  const port = (http.address() as { port: number }).port;
  const broker = new BrowserLeaseBroker(new HttpBrowserTargetClient(port), Date.now, true, 4);
  broker.beginGeneration(1);
  const instance: BrowserControlInstance = {
    id: "interactive", endpoint: `http://127.0.0.1:${port}`, broker,
    ready: async () => {},
    status: async () => ({ state, leases: broker.snapshot(), reservations: broker.externalReservationSummary() }),
    changed: () => {},
  };
  const server = startBrowserControlServer(new BrowserLeaseBroker(new HttpBrowserTargetClient(port)), async () => {}, socketPath, undefined, [instance]);
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const session = args.includes('--session') ? args[args.indexOf('--session') + 1] : process.env.AGENT_BROWSER_SESSION;
const base = 'http://127.0.0.1:${port}';
const dir = process.env.AGENT_BROWSER_SOCKET_DIR;
const list = async () => (await (await fetch(base + '/json/list')).json());
const create = async (url) => (await (await fetch(base + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json()).id;
if (args.includes('close')) process.exit(0);
if (!existsSync(dir + '/' + session + '.connected')) {
  if ((await list()).length === 0) await create('about:blank');
  writeFileSync(dir + '/' + session + '.connected', '1');
}
if (args.includes('open')) {
  const id = await create(args.at(-1));
  writeFileSync(dir + '/' + session + '.target', JSON.stringify({ targetId: id, pinned: args.includes('--pin-tab') }));
} else if (args.includes('get')) console.log(process.env.HOMER_BROWSER_TARGET_ID ?? '');
`, { mode: 0o700 });
  const env = { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath, HOMER_AGENT_BROWSER_BIN: binary, AGENT_BROWSER_SOCKET_DIR: dir, HOMER_BROWSER_GRANT: "" };
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ["bin/browserctl", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  const countDuringLease = [process.execPath, "-e", "fetch(process.env.HOMER_CDP_HTTP + '/json/list').then(r => r.json()).then(t => console.log(t.length))"];
  const lease = (workflow: string[]) => run(["agent", "agent.keeper-test", "--instance", "interactive", "--", ...workflow]);
  const blanks = () => [...pages.values()].filter(page => page.url === "about:blank").map(page => page.id);
  const keeper = () => broker.snapshot().find(record => record.surface === "keeper.interactive");
  const idle = () => {
    assert.equal(broker.externalLeaseCount(), 0);
    assert.deepEqual(broker.externalReservationSummary(), []);
    assert.equal(broker.snapshot().filter(record => record.leaseId).length, 0, "no lease remains");
  };
  const close = async () => { await stopBrowserControlServer(server, socketPath); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); };
  return { pages, broker, run, lease, countDuringLease, blanks, keeper, idle, creates: () => creates, close };
}

test("repeated interactive sessions start and end with exactly one keeper blank and nothing leased", async () => {
  const h = await fixture([["launch", "about:blank"]]);
  try {
    for (let i = 0; i < 3; i++) {
      const result = await h.lease(h.countDuringLease);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "2\n", `session ${i + 1}: keeper plus its own marker while leased`);
      assert.deepEqual(h.blanks(), ["launch"], `session ${i + 1}: the launch blank is the keeper`);
      assert.equal(h.pages.size, 1, `session ${i + 1}: the marker is gone`);
      assert.equal(h.keeper()?.targetId, "launch");
      assert.equal(h.keeper()?.leaseId, null);
      h.idle();
      assert.doesNotMatch(result.stderr, /keeper/);
    }
  } finally { await h.close(); }
});

test("a failing workflow ends in the same state", async () => {
  const h = await fixture([["launch", "about:blank"]]);
  try {
    const result = await h.lease(["/bin/sh", "-c", "exit 7"]);
    assert.equal(result.code, 7);
    assert.deepEqual([...h.pages.keys()], ["launch"]);
    assert.equal(h.keeper()?.targetId, "launch");
    h.idle();
  } finally { await h.close(); }
});

test("leaked blanks collapse to the keeper; a non-blank page is untouched", async () => {
  const h = await fixture([["portal", "https://unusualwhales.com/flow"], ["b1", "about:blank"], ["b2", "about:blank"], ["b3", "about:blank"]]);
  try {
    const result = await h.lease(h.countDuringLease);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(h.blanks().length, 1);
    assert.equal(h.keeper()?.targetId, h.blanks()[0]);
    assert.equal(h.pages.get("portal")?.url, "https://unusualwhales.com/flow");
    assert.equal(h.pages.size, 2);
    assert.equal(h.creates(), 1, "only the session's own marker was created");
    h.idle();
  } finally { await h.close(); }
});

test("any other null-origin page suppresses the keeper reconcile: no sweep, nothing closed", async () => {
  const h = await fixture([["launch", "about:blank"], ["data", "data:text/html,keep-me"], ["extra", "about:blank"]]);
  try {
    const result = await h.lease(["/bin/sh", "-c", "exit 0"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /keeper: 1 other null-origin page\(s\) present \(data:text\/html,keep-me\); no sweep/);
    assert.deepEqual([...h.pages.keys()].sort(), ["data", "extra", "launch"]);
    assert.equal(h.keeper(), undefined);
    h.idle();
  } finally { await h.close(); }
});

test("a keeper tab someone navigated away is never closed", async () => {
  const h = await fixture([["launch", "about:blank"]]);
  try {
    const first = await h.run(["keeper", "--instance", "interactive"]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).targetId, "launch");
    h.pages.get("launch")!.url = "https://unusualwhales.com/login";
    const second = await h.run(["keeper", "--instance", "interactive"]);
    assert.match(JSON.parse(second.stdout).skipped, /navigated to https:\/\/unusualwhales\.com\/login; left untouched/);
    const session = await h.lease(["/bin/sh", "-c", "exit 0"]);
    assert.equal(session.code, 0, session.stderr);
    assert.match(session.stderr, /keeper: keeper tab launch was navigated/);
    assert.equal(h.pages.get("launch")?.url, "https://unusualwhales.com/login");
    assert.equal(h.pages.size, 1);
    assert.equal(h.creates(), 1, "only the session marker was created; no replacement keeper");
  } finally { await h.close(); }
});

test("keeper verb is idempotent, reports reuse, and refuses the downloads instance", async () => {
  const h = await fixture([["launch", "about:blank"], ["leak", "about:blank"]]);
  try {
    const first = JSON.parse((await h.run(["keeper"])).stdout);
    assert.deepEqual(first, { surface: "keeper.interactive", instance: "interactive", targetId: "launch", reused: false, blanks: 1, pages: 1 });
    const second = JSON.parse((await h.run(["keeper", "--instance", "interactive"])).stdout);
    assert.deepEqual(second, { ...first, reused: true });
    const downloads = await h.run(["keeper", "--instance", "downloads"]);
    assert.equal(downloads.code, 1);
    assert.match(downloads.stderr, /interactive instance only/);
    assert.equal(h.creates(), 0);
  } finally { await h.close(); }
});

test("keeper verb does not launch or touch a stopped Chrome and defers to an in-flight agent setup", async () => {
  const stopped = await fixture([], "idle");
  try {
    const result = JSON.parse((await stopped.run(["keeper"])).stdout);
    assert.match(result.skipped, /interactive Chrome is idle; the keeper is its launch page/);
    assert.equal(stopped.creates(), 0);
  } finally { await stopped.close(); }
  const busy = await fixture([["launch", "about:blank"], ["leak", "about:blank"]]);
  try {
    const reserved = JSON.parse((await busy.run(["acquire-external", "agent.other", `holder:${process.pid}`, "60", "--instance", "interactive"])).stdout);
    const result = JSON.parse((await busy.run(["keeper"])).stdout);
    assert.equal(result.skipped, "agent setup in flight");
    assert.equal(busy.pages.size, 2, "nothing swept under a pending reservation");
    const released = await busy.run(["release", reserved.leaseId, "--instance", "interactive"]);
    assert.equal(released.code, 0, released.stderr);
    busy.idle();
  } finally { await busy.close(); }
});
