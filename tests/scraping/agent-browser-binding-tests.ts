import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserLeaseBroker } from "../../src/scraping/browser-control.js";
import { runAgentBrowserBindingSelfTest } from "../../src/scraping/agent-browser-binding.js";

test("a failed binding closes its named daemon without reconnecting through CDP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-binding-"));
  const binary = join(dir, "fake-agent-browser.mjs");
  const cleanupLog = join(dir, "cleanup.jsonl");
  const http = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end("[]");
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", () => resolve()));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const releases: Array<{ leaseId: string; closeTarget: boolean; targetId?: string }> = [];
  const broker = {
    maxAgents: 1,
    externalLeaseCount: () => 0,
    reserveExternal: async () => ({ leaseId: "lease" }),
    registerExternalTarget: async () => { throw new Error("binding should fail before registration"); },
    release: async (leaseId: string, closeTarget: boolean, targetId?: string) => { releases.push({ leaseId, closeTarget, targetId }); },
  } as unknown as BrowserLeaseBroker;
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('close')) {
  appendFileSync(${JSON.stringify(cleanupLog)}, JSON.stringify({ args, cdp: process.env.AGENT_BROWSER_CDP ?? null, pin: process.env.AGENT_BROWSER_PIN_TAB ?? null }) + '\\n');
  process.exit(0);
}
process.exit(47);
`, { mode: 0o700 });
  const previous = {
    binary: process.env.HOMER_AGENT_BROWSER_BIN,
    socketDir: process.env.AGENT_BROWSER_SOCKET_DIR,
    cdp: process.env.AGENT_BROWSER_CDP,
    pin: process.env.AGENT_BROWSER_PIN_TAB,
  };
  process.env.HOMER_AGENT_BROWSER_BIN = binary;
  process.env.AGENT_BROWSER_SOCKET_DIR = dir;
  process.env.AGENT_BROWSER_CDP = "9876";
  process.env.AGENT_BROWSER_PIN_TAB = "1";
  try {
    await assert.rejects(runAgentBrowserBindingSelfTest(broker, address.port, 1), /binding command failed \(47\)/);
    const cleanup = (await readFile(cleanupLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(cleanup.length, 1);
    assert.deepEqual(cleanup[0]!.args.slice(-1), ["close"]);
    assert.ok(cleanup[0]!.args.includes("--session"));
    assert.ok(!cleanup[0]!.args.includes("--cdp"));
    assert.ok(!cleanup[0]!.args.includes("--pin-tab"));
    assert.equal(cleanup[0]!.cdp, null);
    assert.equal(cleanup[0]!.pin, null);
    assert.deepEqual(releases, [{ leaseId: "lease", closeTarget: false, targetId: undefined }]);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      const key = ({ binary: "HOMER_AGENT_BROWSER_BIN", socketDir: "AGENT_BROWSER_SOCKET_DIR", cdp: "AGENT_BROWSER_CDP", pin: "AGENT_BROWSER_PIN_TAB" } as const)[name as keyof typeof previous];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
