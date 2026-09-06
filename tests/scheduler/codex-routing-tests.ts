import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCodexCLI } from "../../src/executors/codex-cli.js";
import { executeBrowserScrape } from "../../src/executors/browser-scrape.js";
import { executeResolvedHarness } from "../../src/harness/dispatch.js";
import { createInMemoryHarnessSelectionStore } from "../../src/harness/resolution/store.js";

test("Codex routing reaches the child process with model, effort, lease and read-only boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-routing-"));
  const oldPath = process.env.PATH;
  const fake = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(process.argv.slice(2))}})+'\\n');
`;
  for (const name of ["codex", "browserctl"]) {
    const path = join(dir, name); writeFileSync(path, fake); chmodSync(path, 0o755);
  }
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    for (const [selection, base, effort] of [
      [undefined, "gpt-5.6-terra", "high"],
      ["gpt-5.6-luna-max", "gpt-5.6-luna", "max"],
      ["gpt-5.6-terra-max", "gpt-5.6-terra", "max"],
      ["gpt-6-astra", "gpt-6-astra", "high"],
      ["gpt-5.6-sol-medium", "gpt-5.6-sol", "medium"],
    ]) {
      const result = await executeCodexCLI("---literal prompt", {
        cwd: dir, model: selection, timeout: 5000,
        // A max selection must override stale baseline effort.
        ...(selection?.endsWith("-max") ? { reasoningEffort: "medium" } : {}),
      });
      assert.equal(result.exitCode, 0);
      const args = JSON.parse(result.output);
      assert.ok(args.includes("--skip-git-repo-check"));
      assert.equal(args[args.indexOf("-m") + 1], base);
      assert.ok(args.includes(`model_reasoning_effort="${effort}"`));
      assert.deepEqual(args.slice(-2), ["--", "---literal prompt"]);
    }
    const scrape = await executeBrowserScrape("read page", "", { timeout: 5000, browserInstance: "interactive" });
    const args = JSON.parse(scrape.output);
    assert.deepEqual(args.slice(0, 5), ["agent", "--instance", "interactive", "--", "codex"]);
    assert.equal(args[args.indexOf("-m") + 1], "gpt-5.6-terra");
    assert.ok(args.includes('model_reasoning_effort="high"'));

    const advisor = await executeResolvedHarness({
      source: "system", mode: "runtime-turn", prompt: "diagnose only", cwd: dir, timeoutMs: 5000,
      explicit: { harness: "codex", model: "gpt-5.6-terra" },
      baselineProfile: { invocation: { readOnly: true, reasoningEffort: "high" } },
      store: createInMemoryHarnessSelectionStore([]),
    });
    const readOnlyArgs = JSON.parse(advisor.output);
    assert.equal(readOnlyArgs[readOnlyArgs.indexOf("--sandbox") + 1], "read-only");
    assert.ok(!readOnlyArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(readOnlyArgs.includes('approval_policy="never"'));
    assert.ok(readOnlyArgs.includes("--ignore-user-config"));
    await assert.rejects(executeCodexCLI("x", { cwd: dir, readOnly: true, sessionId: "old" }), /fresh Codex session/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
