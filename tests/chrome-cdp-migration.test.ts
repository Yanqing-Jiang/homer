import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  probeCdp,
  ResidentChromeSupervisor,
  type ChromeSupervisorDeps,
} from "../src/scraping/chrome-launcher.js";

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
      url: "https://advertising.amazon.com/",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${activeTarget}`,
    }]));
    activeTarget = "page-b";
  });
  stub.on("upgrade", (request, socket) => {
    const requestedTarget = request.url?.split("/").at(-1);
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

function supervisorHarness(probe: ChromeSupervisorDeps["probe"] = async () => ({ state: "ready", pages: 1 })) {
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
  });
  return { supervisor, timers, children, drains: () => drains };
}

test("resident supervisor restarts on unexpected child exit and increments generation", () => {
  const { supervisor, timers, children } = supervisorHarness();
  supervisor.start();
  assert.equal(supervisor.generation, 1);
  children[0]!.emit("exit", 1, null);
  timers.run(2);
  assert.equal(children.length, 2);
  assert.equal(supervisor.generation, 2);
  supervisor.stop();
});

test("resident supervisor uses capped 2,5,15,30,60 restart backoff", () => {
  const { supervisor, timers, children } = supervisorHarness();
  supervisor.start();
  for (const expected of [2, 5, 15, 30, 60, 60]) {
    children.at(-1)!.emit("exit", 1, null);
    timers.run(expected);
  }
  assert.equal(children.length, 7);
  supervisor.stop();
});

test("resident supervisor restarts after three consecutive failed heartbeats", async () => {
  const { supervisor, timers, children } = supervisorHarness(async () => ({ state: "absent", pages: 0 }));
  supervisor.start();
  await supervisor.heartbeatNow();
  await supervisor.heartbeatNow();
  assert.equal(children[0]!.killed, false);
  await supervisor.heartbeatNow();
  assert.equal(children[0]!.killed, true);
  timers.run(2);
  assert.equal(children.length, 2);
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

test("restart generation invalidates prior targets and leases", {
  skip: "Step 3 implements the target registry and generation contract",
}, () => {});

test("lease expiry releases same-surface exclusion", {
  skip: "Step 3 implements expiring per-surface leases",
}, () => {});

test("status publication uses sibling temp, fsync, and atomic rename", {
  skip: "Step 5 implements the status writer",
}, () => {});
