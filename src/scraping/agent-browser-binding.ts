import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browserLeaseBroker, probeCdp } from "./chrome-launcher.js";

const execFileAsync = promisify(execFile);
const AGENT_BROWSER = "/opt/homebrew/bin/agent-browser";

// DEBT: agent-browser sessions are globally serialized due to 0.21.4 concurrent rebinding, upgrade when agent-browser exposes target-id attach.
export async function runAgentBrowserBindingSelfTest(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while ((await probeCdp()).state === "absent") {
    if (Date.now() >= deadline) throw new Error("CDP unavailable for agent-browser binding self-test");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await browserLeaseBroker.observeTargets();
  // Owner labels carry this daemon's pid in the `<name>:<pid>` slot the broker's dead-owner
  // reclaim parses. `startup-selftest:2` read as pid 2 (ESRCH on macOS), so the reservation
  // was reclaimed between `tab new` and `registerExternalTarget` — a deterministic degraded
  // start on 2026-09-01 22:09Z.
  for (let i = 1; i <= 2; i++) {
    const session = `homer-binding-selftest-${i}-${randomUUID()}`;
    const surface = `agent.binding-selftest-${i}`;
    const marker = `data:text/html,<title>homer-binding-${i}</title><p>${randomUUID()}</p>`;
    const reserved = await browserLeaseBroker.reserveExternal(surface, `startup-selftest:${process.pid}:${i}`, 60, false, { bypassDegraded: true }) as { leaseId: string; baselineTargetIds: string[] };
    let targetId: string | undefined;
    try {
      await execFileAsync(AGENT_BROWSER, ["--session", session, "connect", "9222"], { timeout: 15_000 });
      // On a cold boot Chrome registers its own startup tab *after* the lease baseline is
      // captured, so counting against that baseline alone attributed Chrome's blank tab to
      // this session and failed the test deterministically. Re-read the target list here so
      // only tabs opened by the `tab new` below are counted as session-created.
      const preCreate = await fetch("http://127.0.0.1:9222/json/list").then((response) => response.json()) as Array<{ id: string; type: string; url: string }>;
      const ignoredTargetIds = new Set([...reserved.baselineTargetIds, ...preCreate.filter((target) => target.type === "page").map((target) => target.id)]);
      await execFileAsync(AGENT_BROWSER, ["--session", session, "tab", "new", marker], { timeout: 15_000 });
      const targets = await fetch("http://127.0.0.1:9222/json/list").then((response) => response.json()) as Array<{ id: string; type: string; url: string }>;
      const created = targets.filter((target) => target.type === "page" && !ignoredTargetIds.has(target.id));
      if (created.length !== 1 || created[0]!.url !== marker) throw new Error(`session ${i} created ${created.length} distinguishable targets`);
      targetId = created[0]!.id;
      await browserLeaseBroker.registerExternalTarget(reserved.leaseId, created[0]!.id);
      const { stdout } = await execFileAsync(AGENT_BROWSER, ["--session", session, "get", "url"], { timeout: 10_000 });
      const target = (await fetch("http://127.0.0.1:9222/json/list").then((response) => response.json()) as Array<{ id: string; url: string }>).find((item) => item.id === targetId);
      if (stdout.trim() !== marker || target?.url !== marker) throw new Error(`serialized named session binding mismatch for ${session}`);
      if (i === 1) {
        await browserLeaseBroker.reserveExternal("agent.binding-selftest-concurrent", `startup-selftest:${process.pid}:concurrent`, 60, false, { bypassDegraded: true })
          .then(async (unexpected) => {
            await browserLeaseBroker.release(String(unexpected.leaseId));
            throw new Error("concurrent agent-browser session was not refused");
          }, (error: unknown) => {
            if (!(error instanceof Error) || !error.message.includes("globally serialized")) throw error;
          });
      }
    } finally {
      await execFileAsync(AGENT_BROWSER, ["--session", session, "close"], { timeout: 10_000 }).catch(() => undefined);
      await browserLeaseBroker.release(reserved.leaseId, Boolean(targetId), targetId).catch(() => undefined);
    }
  }
}
