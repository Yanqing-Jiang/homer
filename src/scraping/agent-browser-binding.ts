import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { PATHS } from "../config/paths.js";
import { BrowserLeaseBroker, HttpBrowserTargetClient } from "./browser-control.js";
import { browserLeaseBroker } from "./chrome-launcher.js";

/** Admission is real: contention defers the assertion without changing the health verdict. */
export async function runAgentBrowserBindingSelfTest(broker: BrowserLeaseBroker = browserLeaseBroker, port = 9222, capacity = broker.maxAgents): Promise<"passed" | "deferred"> {
  const count = capacity > 1 ? 2 : 1;
  if (broker.externalLeaseCount() + count > broker.maxAgents) return "deferred";
  const targets = new HttpBrowserTargetClient(port);
  // Downloads Chrome can still be starting at daemon boot; transient absence is not a binding failure.
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await targets.list(); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR ?? join(homedir(), ".agent-browser");
  const pinned = join(PATHS.homerRoot, "node_modules", ".bin", "agent-browser");
  const binary = process.env.HOMER_AGENT_BROWSER_BIN ?? (existsSync(pinned) ? pinned : "/opt/homebrew/bin/agent-browser");
  const sessions: Array<{ session: string; marker: string; leaseId: string; targetId?: string; started?: boolean }> = [];
  const { AGENT_BROWSER_CDP: _inheritedCdp, AGENT_BROWSER_PIN_TAB: _inheritedPin, ...cleanupEnv } = process.env;
  const run = (session: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
    // Boot-time self-test only: a bounded spawn timeout keeps a hung CLI from stalling daemon start.
    // Real agent sessions (browserctl) carry no such deadline.
    const child = spawn(binary, ["--session", session, "--cdp", String(port), "--pin-tab", ...args], {
      env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`agent-browser binding command failed (${code}): ${stderr}`)));
  });
  // `agent-browser --cdp` launches before every command, including `close`.  Cleanup must only
  // address the already-named daemon; retrying its broken CDP attachment leaves it alive.
  const closeSession = (session: string): Promise<void> => new Promise(resolve => {
    const child = spawn(binary, ["--session", session, "close"], {
      env: { ...cleanupEnv, AGENT_BROWSER_SOCKET_DIR: socketDir }, stdio: "ignore", timeout: 10_000,
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  try {
    // Reserve both slots before creating either tab; a partially admitted test must defer cleanly.
    for (let i = 0; i < count; i++) {
      const session = `ht-${randomUUID().slice(0, 8)}`;
      try {
        const reserved = await broker.reserveExternal(`agent.${session}`, `startup-selftest:${process.pid}:${i}`, 180, false, { bypassDegraded: true });
        sessions.push({ session, leaseId: String(reserved.leaseId), marker: `about:blank#homer-agent-${randomUUID()}` });
      } catch (error) {
        if (error instanceof Error && /agent capacity|adoption grace/.test(error.message)) return "deferred";
        throw error;
      }
    }
    // allSettled matters: cleanup cannot race a slower sibling still creating its target.
    const created = await Promise.allSettled(sessions.map(async row => {
      row.started = true;
      // `open`, not `tab new`: a fresh pinned daemon creates its own page on connect, and `tab new`
      // added a second one that nothing released (one orphan about:blank per session; see browserctl).
      await run(row.session, ["open", row.marker]);
      const binding = JSON.parse(await readFile(join(socketDir, `${row.session}.target`), "utf8")) as { targetId: string; pinned: boolean };
      if (binding.pinned !== true || !binding.targetId) throw new Error("self-test session is not pinned");
      row.targetId = binding.targetId;
      await broker.registerExternalTarget(row.leaseId, row.targetId);
    }));
    for (const result of created) if (result.status === "rejected") throw result.reason;
    if (new Set(sessions.map(row => row.targetId)).size !== sessions.length) throw new Error("concurrent sessions share a target");
    const checks = await Promise.allSettled(sessions.map(async row => {
      const url = await run(row.session, ["get", "url"]);
      const target = (await targets.list()).find(target => target.id === row.targetId);
      if (url !== row.marker || target?.url !== row.marker) throw new Error("pinned session binding mismatch");
    }));
    for (const result of checks) if (result.status === "rejected") throw result.reason;
    if (sessions.length > 1) {
      await closeSession(sessions[0]!.session);
      await broker.release(sessions[0]!.leaseId, true, sessions[0]!.targetId);
      if (await run(sessions[1]!.session, ["get", "url"]) !== sessions[1]!.marker) throw new Error("closing a session disturbed its sibling");
    }
    return "passed";
  } finally {
    for (const row of sessions) {
      if (row.started) await closeSession(row.session);
      // Also recover a uniquely marked tab when setup failed before reading its binding file.
      if (row.started && !row.targetId) row.targetId = (await targets.list().catch(() => [])).find(target => target.url === row.marker)?.id;
      await broker.release(row.leaseId, Boolean(row.targetId), row.targetId).catch(() => undefined);
    }
  }
}
