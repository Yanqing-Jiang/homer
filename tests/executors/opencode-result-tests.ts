import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOpenCodeCLI } from "../../src/executors/opencode-cli.js";

test("OpenCode distinguishes successful synthesis prose from process and stream failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-result-"));
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const prose = "<weekly_summary>Auth incident recovery had zero failures. Demo rate limit 10/IP/hour.</weekly_summary>";
    const cases = [
      { text: prose, code: 0, expected: 0 },
      { text: "rate limit reached", code: 1, expected: 2 },
      { text: "401 Unauthorized", code: 1, expected: 3 },
      { text: "", code: 0, error: "rate limit reached", expected: 2 },
      { text: "", code: 0, error: "401 Unauthorized", expected: 3 },
      { text: "partial answer", code: 0, error: "provider connection closed", expected: 1 },
    ];
    for (const scenario of cases) {
      writeFileSync(join(dir, "opencode"), `#!/usr/bin/env node
const scenario = ${JSON.stringify(scenario)};
console.log(JSON.stringify({type:"text",part:{text:scenario.text}}));
if (scenario.error) console.log(JSON.stringify({type:"error",error:{name:"APIError",data:{message:scenario.error}}}));
process.exitCode = scenario.code;
`, { mode: 0o755 });
      const result = await executeOpenCodeCLI("synthesize", "", {
        model: "github-copilot/claude-opus-5", cwd: dir, timeout: 5000,
        forceOpenCode: true, researchOnly: false,
      });
      assert.equal(result.exitCode, scenario.expected, JSON.stringify(scenario));
      if (scenario.expected === 0) assert.equal(result.output, prose);
      if (scenario.error) assert.ok(result.output.includes(scenario.error));
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
