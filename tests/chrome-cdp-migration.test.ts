import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  probeCdp,
  ResidentChromeSupervisor,
  type ChromeSupervisorDeps,
} from "../src/scraping/chrome-launcher.js";
import {
  BROWSER_CONTROL_SOCKET,
  BROWSER_CONTROL_STATE_DIR,
  BROWSER_STATUS_PATH,
  BrowserLeaseBroker,
  type BrowserTargetClient,
} from "../src/scraping/browser-control.js";
import { writeStatusAtomic, type ChromeStatus } from "../src/scraping/browser-status.js";
import { logger } from "../src/utils/logger.js";
import { stewardshipBackoffMs, stewardshipJitterMs, stewardshipSkip } from "../src/scraping/session-stewardship.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

test("launcher lifecycle probe characterizes absent, empty, and ready", async () => {
  const unused = createServer();
  const absentPort = await listen(unused);
  await close(unused);
  assert.deepEqual(await probeCdp(absentPort), { state: "absent", pages: 0 });

  let targets: object[] = [];
  const stub = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") response.end('{"Browser":"Chrome/stub"}');
    else if (request.url === "/json/list") response.end(JSON.stringify(targets));
    else { response.statusCode = 404; response.end("{}"); }
  });
  const port = await listen(stub);
  try {
    assert.deepEqual(await probeCdp(port), { state: "empty", pages: 0 });
    targets = [{ id: "page-a", type: "page" }];
    assert.deepEqual(await probeCdp(port), { state: "ready", pages: 1 });
  } finally {
    await close(stub);
  }
});

test("URL enumeration can return a target that disappears before WebSocket attach", async () => {
  let activeTarget = "page-a";
  let port = 0;
  const stub = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{
      id: activeTarget,
      type: "page",
      url: "https://<ads-portal-host>/",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${activeTarget}`,
    }]));
    activeTarget = "page-b";
  });
  stub.on("upgrade", (request, socket) => {
    const requestedTarget = request.url?.split("/").pop();
    if (requestedTarget !== activeTarget) {
      socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  });
  port = await listen(stub);
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json()) as Array<{ id: string; webSocketDebuggerUrl: string }>;
    assert.equal(listed[0]?.id, "page-a");
    const outcome = await new Promise<"opened" | "failed">((resolve) => {
      const socket = new WebSocket(listed[0]!.webSocketDebuggerUrl);
      socket.addEventListener("open", () => resolve("opened"), { once: true });
      socket.addEventListener("error", () => resolve("failed"), { once: true });
    });
    assert.equal(outcome, "failed", "the enumerated target is stale at attach time");
    assert.equal(activeTarget, "page-b");
  } finally {
    await close(stub);
  }
});

const fakeAgentBrowser = String.raw`
  const { createServer } = require("node:net");
  const { homedir } = require("node:os");
  const { join } = require("node:path");
  const session = process.env.AGENT_BROWSER_SESSION;
  const socketPath = join(homedir(), ".agent-browser", "default.sock");
  const server = createServer();
  server.on("error", (error) => {
    process.stdout.write(JSON.stringify({ session, socketPath, error: error.code }) + "\n");
    process.exit(0);
  });
  server.listen(socketPath, () => {
    process.stdout.write(JSON.stringify({ session, socketPath, state: "listening" }) + "\n");
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

function readLine(child: ReturnType<typeof spawn>): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)) as Record<string, string>);
    });
  });
}

test("agent-browser binding hazard: independent processes contend on default.sock", async () => {
  const home = await mkdtemp(join(tmpdir(), "homer-cdp-test-"));
  await mkdir(join(home, ".agent-browser"));
  const env = { ...process.env, HOME: home };
  const first = spawn(process.execPath, ["-e", fakeAgentBrowser], {
    env: { ...env, AGENT_BROWSER_SESSION: "amazon-vc" }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const firstResult = await readLine(first);
    assert.equal(firstResult.state, "listening");

    const second = spawn(process.execPath, ["-e", fakeAgentBrowser], {
      env: { ...env, AGENT_BROWSER_SESSION: "amazon-amc" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const secondResult = await readLine(second);
    assert.notEqual(secondResult.session, firstResult.session);
    assert.equal(secondResult.socketPath, firstResult.socketPath);
    assert.equal(secondResult.error, "EADDRINUSE", "shared default.sock cannot bind a second workflow");
  } finally {
    first.kill("SIGTERM");
    await new Promise((resolve) => first.once("exit", resolve));
    await rm(home, { recursive: true, force: true });
  }
});

class FakeChrome extends EventEmitter {
  killed = false;
  constructor(readonly pid: number) { super(); }
  kill(): boolean { this.killed = true; return true; }
}

class FakeTimers {
  tasks: Array<{ callback: () => void; delayMs: number; timer: ReturnType<typeof setTimeout> }> = [];

  set = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = { fake: true } as unknown as ReturnType<typeof setTimeout>;
    this.tasks.push({ callback, delayMs, timer });
    return timer;
  };

  clear = (timer: ReturnType<typeof setTimeout>): void => {
    this.tasks = this.tasks.filter((task) => task.timer !== timer);
  };

  run(delayMs: number): void {
    const index = this.tasks.findIndex((task) => task.delayMs === delayMs);
    assert.notEqual(index, -1, `no timer scheduled for ${delayMs}ms`);
    const [task] = this.tasks.splice(index, 1);
    task!.callback();
  }
}

/** Flushes every pending microtask, including the drain chain inside scheduleRestart. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The singleton-forward classification and the flap breaker are observable only
 * through the log, so tests read it directly rather than asserting on side
 * effects the supervisor deliberately keeps identical (both still restart).
 */
function captureLogs(): { warns: string[]; errors: string[]; restore: () => void } {
  const warns: string[] = [];
  const errors: string[] = [];
  const original = { warn: logger.warn, error: logger.error };
  const record = (sink: string[]) => (...args: unknown[]) => {
    sink.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  Object.assign(logger, { warn: record(warns), error: record(errors) });
  return { warns, errors, restore: () => { Object.assign(logger, original); } };
}

function supervisorHarness(
  probe: ChromeSupervisorDeps["probe"] = async () => ({ state: "ready", pages: 1 }),
  overrides: Partial<ChromeSupervisorDeps> = {},
) {
  const timers = new FakeTimers();
  const children: FakeChrome[] = [];
  let generation = 0;
  let drains = 0;
  const supervisor = new ResidentChromeSupervisor({
    spawnChrome: () => {
      const child = new FakeChrome(1000 + children.length);
      children.push(child);
      return child;
    },
    probe,
    ensureProfile: () => {},
    nextGeneration: () => ++generation,
    drainLeases: async () => { drains++; },
    setTimer: timers.set,
    clearTimer: timers.clear,
    heartbeatMs: 999,
    backoffMs: [2, 5, 15, 30, 60],
    ...overrides,
  });
  return { supervisor, timers, children, drains: () => drains };
}

test("resident supervisor restarts on unexpected child exit and increments generation", async () => {
  const { supervisor, timers, children } = supervisorHarness();
  supervisor.start();
  assert.equal(supervisor.generation, 1);
  children[0]!.emit("exit", 1, null);
  await Promise.resolve(); await Promise.resolve();
  timers.run(2);
  assert.equal(children.length, 2);
  assert.equal(supervisor.generation, 2);
  supervisor.stop();
});

test("resident supervisor walks the 2,5,15,30,60 restart backoff up to the flap breaker", async () => {
  const { supervisor, timers, children } = supervisorHarness();
  supervisor.start();
  // The ladder's repeating 60 tail is now unreachable: the flap breaker stops the
  // loop at the sixth restart inside its window, well before the ladder saturates.
  for (const expected of [2, 5, 15, 30, 60]) {
    children[children.length - 1]!.emit("exit", 1, null);
    await Promise.resolve(); await Promise.resolve();
    timers.run(expected);
  }
  assert.equal(children.length, 6);
  assert.equal(supervisor.maintenance().enabled, false);
  supervisor.stop();
});

test("resident supervisor restarts after three consecutive failed heartbeats", async () => {
  const { supervisor, timers, children } = supervisorHarness(async () => ({ state: "absent", pages: 0 }));
  supervisor.start();
  await supervisor.heartbeatNow();
  await Promise.resolve(); await Promise.resolve();
  await supervisor.heartbeatNow();
  assert.equal(children[0]!.killed, false);
  await supervisor.heartbeatNow();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(children[0]!.killed, true);
  timers.run(2);
  assert.equal(children.length, 2);
  supervisor.stop();
});

test("resident supervisor re-reconciles surfaces once per generation after a restart", async () => {
  const { supervisor, timers, children } = supervisorHarness();
  supervisor.start();
  let reconciles = 0;
  // Registering after startup means the current generation counts as reconciled.
  supervisor.setSurfaceReconciler(async () => { reconciles++; });
  await supervisor.heartbeatNow();
  assert.equal(reconciles, 0, "steady-state heartbeats must not re-reconcile");

  children[children.length - 1]!.emit("exit", 1, null);
  await Promise.resolve(); await Promise.resolve();
  timers.run(2);
  assert.equal(children.length, 2);

  await supervisor.heartbeatNow();
  assert.equal(reconciles, 1, "first healthy heartbeat of a new generation reconciles surfaces");
  await supervisor.heartbeatNow();
  assert.equal(reconciles, 1, "reconcile happens once per generation, not every heartbeat");
  supervisor.stop();
});

test("surface reconcile failure after restart is retried on the next heartbeat", async () => {
  const { supervisor, timers, children } = supervisorHarness();
  supervisor.start();
  let attempts = 0;
  supervisor.setSurfaceReconciler(async () => {
    attempts++;
    if (attempts === 1) throw new Error("CDP not ready yet");
  });
  children[children.length - 1]!.emit("exit", 1, null);
  await Promise.resolve(); await Promise.resolve();
  timers.run(2);
  await supervisor.heartbeatNow();
  assert.equal(attempts, 1);
  await supervisor.heartbeatNow();
  assert.equal(attempts, 2, "a failed reconcile must not mark the generation as done");
  await supervisor.heartbeatNow();
  assert.equal(attempts, 2, "the successful retry marks the generation reconciled");
  supervisor.stop();
});

test("maintenance drains leases and suppresses restart until disabled", async () => {
  const harness = supervisorHarness();
  harness.supervisor.start();
  await harness.supervisor.setMaintenance(true, "profile cutover");
  assert.deepEqual(harness.supervisor.maintenance(), { enabled: true, reason: "profile cutover" });
  assert.equal(harness.drains(), 1);
  harness.children[0]!.emit("exit", 0, null);
  assert.equal(harness.timers.tasks.some((task) => task.delayMs === 2), false);
  await harness.supervisor.setMaintenance(false, "complete");
  assert.equal(harness.children.length, 2);
  harness.supervisor.stop();
});

test("a fast child exit while CDP still answers is classified as a singleton forward", async () => {
  let portChecks = 0;
  const harness = supervisorHarness(undefined, {
    cdpPortOccupied: async () => { portChecks++; return true; },
  });
  const logs = captureLogs();
  try {
    harness.supervisor.start();
    harness.children[0]!.emit("exit", 0, null);
    await flush();
    assert.equal(portChecks, 1);
    assert.match(logs.warns.join("\n"), /singleton forward/);
    // Classification names the condition and feeds the breaker; it must not
    // suppress the restart on its own.
    harness.timers.run(2);
    assert.equal(harness.children.length, 2);
  } finally {
    logs.restore();
    harness.supervisor.stop();
  }
});

test("a fast child exit with a dead CDP port stays an ordinary crash", async () => {
  const harness = supervisorHarness(undefined, { cdpPortOccupied: async () => false });
  const logs = captureLogs();
  try {
    harness.supervisor.start();
    harness.children[0]!.emit("exit", 1, null);
    await flush();
    assert.equal(logs.warns.join("\n").includes("singleton forward"), false);
    harness.timers.run(2);
    assert.equal(harness.children.length, 2);
  } finally {
    logs.restore();
    harness.supervisor.stop();
  }
});

test("more than five restarts inside the flap window trip the breaker into maintenance", async () => {
  const harness = supervisorHarness();
  const logs = captureLogs();
  try {
    harness.supervisor.start();
    for (const delayMs of [2, 5, 15, 30, 60]) {
      harness.children[harness.children.length - 1]!.emit("exit", 1, null);
      await flush();
      harness.timers.run(delayMs);
    }
    assert.equal(harness.children.length, 6, "five restarts stay under the limit");
    assert.equal(harness.supervisor.maintenance().enabled, false);

    harness.children[5]!.emit("exit", 1, null);
    await flush();
    assert.equal(harness.timers.tasks.some((task) => task.delayMs === 60), false, "the sixth restart is not scheduled");
    assert.equal(harness.children.length, 6);
    assert.equal(harness.supervisor.maintenance().enabled, true);
    assert.match(harness.supervisor.maintenance().reason ?? "", /circuit breaker/);
    assert.match(logs.errors.join("\n"), /flap breaker tripped/);

    // browserctl maintenance off is the whole re-arm: it relaunches and the
    // breaker starts a fresh window.
    await harness.supervisor.setMaintenance(false, "operator re-arm");
    assert.equal(harness.children.length, 7);
    harness.children[6]!.emit("exit", 1, null);
    await flush();
    assert.equal(harness.supervisor.maintenance().enabled, false, "one restart after re-arm must not re-trip");
  } finally {
    logs.restore();
    harness.supervisor.stop();
  }
});

test("heartbeat seeds a page target when the probe reports an empty listener", async () => {
  let pages = 0;
  let seeds = 0;
  const harness = supervisorHarness(
    async () => pages > 0 ? { state: "ready", pages } : { state: "empty", pages: 0 },
    { ensurePage: async () => { seeds++; pages = 1; return true; } },
  );
  harness.supervisor.start();
  await harness.supervisor.heartbeatNow();
  assert.equal(seeds, 1, "--no-startup-window leaves zero page targets; the heartbeat seeds the first");
  assert.equal(harness.supervisor.status().cdp.state, "ready");
  await harness.supervisor.heartbeatNow();
  assert.equal(seeds, 1, "a ready listener is never re-seeded");
  harness.supervisor.stop();
});

test("heartbeat never seeds when the target list was unreadable", async () => {
  let seeds = 0;
  const harness = supervisorHarness(
    async () => ({ state: "empty", pages: 0, reason: "list probe failed" }),
    { ensurePage: async () => { seeds++; return true; } },
  );
  harness.supervisor.start();
  await harness.supervisor.heartbeatNow();
  assert.equal(seeds, 0, "an unreadable list is transient — mutating on it is the documented mistake");
  assert.equal(harness.supervisor.status().cdp.reason, "list probe failed");
  harness.supervisor.stop();
});

type CliResult = { code: number; stdout: string; stderr: string };
function runBrowserctl(socketPath: string, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "bin/browserctl"), ...args], {
      env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function runBrowserctlStatus(statusPath: string, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "bin/browserctl"), "status", ...args], {
      env: { ...process.env, HOMER_BROWSER_STATUS_FILE: statusPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function startBroker(socketPath: string, generation: number) {
  const child = spawn(join(process.cwd(), "node_modules/.bin/tsx"), ["tests/helpers/browser-broker-server.ts"], {
    env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath, BROKER_GENERATION: String(generation) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("broker test server did not become ready")), 5_000);
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); }
    });
  });
  return child;
}

async function stopBroker(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("cross-process leases exclude same surface, allow different surfaces, and recover after expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homer-broker-test-"));
  const socketPath = join(dir, "control.sock");
  const broker = await startBroker(socketPath, 41);
  try {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    for (const surface of ["amazon.vc", "amazon.amc"]) {
      const result = await runBrowserctl(socketPath, "reconcile", surface, "https://example.test", "https://example.test/bootstrap");
      assert.equal(result.code, 0, result.stderr);
    }
    const contenders = await Promise.all([
      runBrowserctl(socketPath, "acquire", "amazon.vc", "process-one", "5"),
      runBrowserctl(socketPath, "acquire", "amazon.vc", "process-two", "5"),
    ]);
    const vc1 = contenders.find((result) => result.code === 0)!;
    const vc2 = contenders.find((result) => result.code === 1)!;
    assert.ok(vc1);
    assert.ok(vc2);
    assert.match(vc2.stderr, /leased by process-(one|two)/);
    const amc = await runBrowserctl(socketPath, "acquire", "amazon.amc", "process-three", "5");
    assert.equal(amc.code, 0, amc.stderr);
    assert.equal(JSON.parse(amc.stdout).generation, 41);
    const lease = JSON.parse(vc1.stdout).leaseId as string;
    assert.equal((await runBrowserctl(socketPath, "release", lease)).code, 0);

    const short = await runBrowserctl(socketPath, "acquire", "amazon.vc", "crashed-process", "0.1");
    assert.equal(short.code, 0, short.stderr);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const recovered = await runBrowserctl(socketPath, "acquire", "amazon.vc", "recovery-process", "5");
    assert.equal(recovered.code, 0, recovered.stderr);
    console.log("cross-process: same-surface=excluded different-surface=concurrent expired-lease=recovered");
  } finally {
    await stopBroker(broker);
    await rm(dir, { recursive: true, force: true });
  }
});

test("control state is outside the case-insensitive Chrome profile path", () => {
  assert.equal(BROWSER_CONTROL_STATE_DIR, "/Users/yj/Library/Application Support/Homer/cdp-state");
  assert.equal(BROWSER_CONTROL_SOCKET, `${BROWSER_CONTROL_STATE_DIR}/browser-control.sock`);
  assert.equal(BROWSER_STATUS_PATH, `${BROWSER_CONTROL_STATE_DIR}/status.json`);
  assert.notEqual(BROWSER_CONTROL_STATE_DIR.toLowerCase(), "/Users/yj/Library/Application Support/Homer/Chrome-CDP".toLowerCase());
});

test("restart generation invalidates prior targets and leases across processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homer-generation-test-"));
  const socketPath = join(dir, "control.sock");
  let broker = await startBroker(socketPath, 7);
  try {
    assert.equal((await runBrowserctl(socketPath, "reconcile", "amazon.vc", "https://example.test", "https://example.test/")).code, 0);
    const acquired = await runBrowserctl(socketPath, "acquire", "amazon.vc", "generation-seven", "30");
    assert.equal(acquired.code, 0, acquired.stderr);
    const old = JSON.parse(acquired.stdout);
    await stopBroker(broker);
    broker = await startBroker(socketPath, 8);
    const renewed = await runBrowserctl(socketPath, "renew", old.leaseId, "30");
    assert.equal(renewed.code, 1);
    assert.match(renewed.stderr, /unknown or expired lease/);
    console.log(`cross-process: generation=${old.generation}->8 old-lease=invalidated old-target=${old.targetId}`);
  } finally {
    await stopBroker(broker);
    await rm(dir, { recursive: true, force: true });
  }
});

test("external agent target creation is serialized, registered exactly, and cleaned on release", async () => {
  const targets = new Map<string, { id: string; type: string; url: string; webSocketDebuggerUrl: string }>();
  const client: BrowserTargetClient = {
    list: async () => [...targets.values()],
    create: async () => { throw new Error("not used"); },
    close: async (targetId) => { targets.delete(targetId); },
  };
  const broker = new BrowserLeaseBroker(client);
  broker.beginGeneration(9);
  const first = await broker.reserveExternal("agent.test-one", "wrapper-one", 30) as { leaseId: string };
  await assert.rejects(() => broker.reserveExternal("agent.test-two", "wrapper-two", 30), /creation is reserved/);
  targets.set("external-1", { id: "external-1", type: "page", url: "about:blank#one", webSocketDebuggerUrl: "ws://test/external-1" });
  const registered = await broker.registerExternalTarget(first.leaseId, "external-1") as { targetId: string };
  assert.equal(registered.targetId, "external-1");
  await assert.rejects(
    () => broker.reserveExternal("agent.test-two", "wrapper-two", 30),
    /agent-browser session is globally serialized/,
  );
  await broker.release(first.leaseId, true);
  const second = await broker.reserveExternal("agent.test-two", "wrapper-two", 30) as { leaseId: string };
  await broker.release(second.leaseId);
  assert.equal(targets.has("external-1"), false);
  broker.setDegraded("binding mismatch");
  await assert.rejects(() => broker.reserveExternal("agent.blocked", "wrapper", 30), /automation degraded/);
});

test("agent-browser degradation does not block exact-target reconcile and acquire", async () => {
  const targets = new Map<string, { id: string; type: string; url: string; webSocketDebuggerUrl: string }>();
  const client: BrowserTargetClient = {
    list: async () => [...targets.values()],
    create: async (url) => {
      const target = { id: "direct-1", type: "page", url, webSocketDebuggerUrl: "ws://test/direct-1" };
      targets.set(target.id, target);
      return target;
    },
    close: async (targetId) => { targets.delete(targetId); },
  };
  const broker = new BrowserLeaseBroker(client);
  broker.beginGeneration(10);
  broker.setDegraded("named-session binding mismatch");
  const reconciled = await broker.reconcile("amazon.vc", ["https://example.test"], "https://example.test/bootstrap");
  assert.equal(reconciled.targetId, "direct-1");
  const acquired = await broker.acquire("amazon.vc", "direct-client", 30) as { targetId: string; webSocketDebuggerUrl: string };
  assert.equal(acquired.targetId, "direct-1");
  assert.equal(acquired.webSocketDebuggerUrl, "ws://test/direct-1");
});

test("touch scheduler bounds independent jitter and backs off exponentially", () => {
  assert.equal(stewardshipJitterMs(() => 0), -15 * 60_000);
  assert.equal(stewardshipJitterMs(() => 0.5), 0);
  assert.ok(stewardshipJitterMs(() => 0.999999) < 15 * 60_000);
  assert.deepEqual([1, 2, 3, 9].map(stewardshipBackoffMs), [15, 30, 60, 360].map((m) => m * 60_000));
});

test("touch scheduler skips leases, recent human activity, and active backoff", () => {
  const now = 1_000_000_000;
  const record = { surface: "amazon.vc", generation: 1, targetId: "vc", expectedOrigins: ["https://example.test"], currentUrl: "https://example.test", lastVerifiedUrl: "https://example.test", owner: null, leaseId: null, leaseExpiresAt: null, lastActivityAt: 0 };
  assert.match(stewardshipSkip({ ...record, owner: "collector", leaseId: "lease" }, null, now, 0)!, /leased/);
  assert.match(stewardshipSkip(record, now - 29 * 60_000, now, 0)!, /human activity/);
  assert.match(stewardshipSkip(record, null, now, now + 1)!, /backoff/);
  assert.equal(stewardshipSkip(record, now - 31 * 60_000, now, 0), null);
});

test("status publication uses sibling temp, fsync, and atomic rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homer-status-test-")); const path = join(dir, "status.json");
  const status: ChromeStatus = { schema: 1, updatedAt: new Date(0).toISOString(), generation: 3, supervisorPid: 1, chromePid: 2,
    profilePath: "/profile", cdp: { state: "ready", pages: 2, restartCount: 0, reason: null }, maintenance: { enabled: false, reason: null }, surfaces: {} };
  try {
    writeStatusAtomic(path, status);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), status);
    assert.deepEqual(await readdir(dir), ["status.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("browserctl status applies 90-second service and 8-hour surface staleness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homer-status-cli-test-")); const path = join(dir, "status.json");
  const now = Date.now();
  const status: ChromeStatus = { schema: 1, updatedAt: new Date(now).toISOString(), generation: 3, supervisorPid: 1, chromePid: 2,
    profilePath: "/profile", cdp: { state: "ready", pages: 2, restartCount: 0, reason: null }, maintenance: { enabled: false, reason: null },
    surfaces: { "amazon.vc": { state: "authenticated", lastProbeAt: new Date(now - 7 * 60 * 60_000).toISOString(), lastOkAt: null, lastTouchAt: null, reason: null, targetId: "vc", lease: null } } };
  try {
    writeStatusAtomic(path, status);
    const healthy = await runBrowserctlStatus(path, "amazon.vc");
    assert.equal(healthy.code, 0, healthy.stderr);
    assert.equal(JSON.parse(healthy.stdout).state, "healthy");

    status.updatedAt = new Date(now - 91_000).toISOString();
    writeStatusAtomic(path, status);
    const staleService = await runBrowserctlStatus(path);
    assert.equal(staleService.code, 1);
    assert.match(JSON.parse(staleService.stdout).reasons.join(" "), /> 90s/);

    status.updatedAt = new Date(now).toISOString();
    status.surfaces["amazon.vc"]!.lastProbeAt = new Date(now - (8 * 60 * 60_000 + 1_000)).toISOString();
    writeStatusAtomic(path, status);
    const staleSurface = await runBrowserctlStatus(path, "amazon.vc");
    assert.equal(staleSurface.code, 1);
    assert.match(JSON.parse(staleSurface.stdout).reasons.join(" "), /> 8h/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
