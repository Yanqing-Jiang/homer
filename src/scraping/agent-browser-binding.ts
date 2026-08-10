import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browserLeaseBroker, probeCdp } from "./chrome-launcher.js";

const execFileAsync = promisify(execFile);
const AGENT_BROWSER = "/opt/homebrew/bin/agent-browser";

// DEBT: agent-browser 0.21.4 exposes no public target-id selector, so named-session binding is validated at startup rather than guaranteed by API, upgrade when agent-browser exposes target-id attach or the first binding mismatch is observed.
export async function runAgentBrowserBindingSelfTest(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while ((await probeCdp()).state === "absent") {
    if (Date.now() >= deadline) throw new Error("CDP unavailable for agent-browser binding self-test");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await browserLeaseBroker.observeTargets();
  const sessions: Array<{ session: string; leaseId: string; targetId?: string; marker: string }> = [];
  try {
    for (let i = 1; i <= 2; i++) {
      const session = `homer-binding-selftest-${i}-${randomUUID()}`;
      const surface = `agent.binding-selftest-${i}`;
      const marker = `about:blank#homer-binding-${randomUUID()}`;
      const reserved = await browserLeaseBroker.reserveExternal(surface, `startup-selftest:${i}`, 60) as { leaseId: string; baselineTargetIds: string[] };
      const entry = { session, leaseId: reserved.leaseId, marker } as { session: string; leaseId: string; targetId?: string; marker: string };
      sessions.push(entry);
      await execFileAsync(AGENT_BROWSER, ["--session", session, "connect", "9222"], { timeout: 15_000 });
      await execFileAsync(AGENT_BROWSER, ["--session", session, "tab", "new", marker], { timeout: 15_000 });
      const targets = await fetch("http://127.0.0.1:9222/json/list").then((response) => response.json()) as Array<{ id: string; type: string; url: string }>;
      const created = targets.filter((target) => target.type === "page" && !reserved.baselineTargetIds.includes(target.id));
      if (created.length !== 1 || created[0]!.url !== marker) throw new Error(`session ${i} created ${created.length} distinguishable targets`);
      entry.targetId = created[0]!.id;
      await browserLeaseBroker.registerExternalTarget(reserved.leaseId, created[0]!.id);
    }
    for (const entry of sessions) {
      const { stdout } = await execFileAsync(AGENT_BROWSER, ["--session", entry.session, "get", "url"], { timeout: 10_000 });
      const target = (await fetch("http://127.0.0.1:9222/json/list").then((response) => response.json()) as Array<{ id: string; url: string }>).find((item) => item.id === entry.targetId);
      if (stdout.trim() !== entry.marker || target?.url !== entry.marker) throw new Error(`named session binding mismatch for ${entry.session}`);
    }
  } finally {
    for (const entry of sessions.reverse()) {
      await execFileAsync(AGENT_BROWSER, ["--session", entry.session, "close"], { timeout: 10_000 }).catch(() => undefined);
      await browserLeaseBroker.release(entry.leaseId, Boolean(entry.targetId), entry.targetId).catch(() => undefined);
    }
  }
}
