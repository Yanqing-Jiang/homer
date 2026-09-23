import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeGeminiCLIDirect, executeGeminiSpecialist } from "../../src/executors/gemini-cli.js";

function makeFakeAgy(dir: string): { bin: string; argsFile: string } {
  const bin = join(dir, "agy");
  const argsFile = join(dir, "args.json");
  writeFileSync(bin, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.AGY_TEST_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.AGY_TEST_MODE === "wait") setInterval(() => {}, 1000);
else console.log(process.env.AGY_TEST_RESULT);
`, { mode: 0o755 });
  return { bin, argsFile };
}

async function withFakeAgy<T>(
  scenario: { result?: Record<string, unknown>; rawOutput?: string; mode?: "wait" },
  run: (argsFile: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "homer-agy-specialist-"));
  const { bin, argsFile } = makeFakeAgy(dir);
  const priorBin = process.env.AGY_BIN;
  const priorArgsFile = process.env.AGY_TEST_ARGS_FILE;
  const priorMode = process.env.AGY_TEST_MODE;
  const priorResult = process.env.AGY_TEST_RESULT;
  process.env.AGY_BIN = bin;
  process.env.AGY_TEST_ARGS_FILE = argsFile;
  process.env.AGY_TEST_MODE = scenario.mode ?? "result";
  process.env.AGY_TEST_RESULT = scenario.rawOutput ?? JSON.stringify(scenario.result ?? {});
  try {
    return await run(argsFile);
  } finally {
    if (priorBin === undefined) delete process.env.AGY_BIN; else process.env.AGY_BIN = priorBin;
    if (priorArgsFile === undefined) delete process.env.AGY_TEST_ARGS_FILE; else process.env.AGY_TEST_ARGS_FILE = priorArgsFile;
    if (priorMode === undefined) delete process.env.AGY_TEST_MODE; else process.env.AGY_TEST_MODE = priorMode;
    if (priorResult === undefined) delete process.env.AGY_TEST_RESULT; else process.env.AGY_TEST_RESULT = priorResult;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("news research pins Flash 3.8 high and forwards its CLI deadline", { concurrency: false }, async () => {
  await withFakeAgy({ rawOutput: '{"items":[]}' }, async (argsFile) => {
    const result = await executeGeminiCLIDirect("public news", {
      model: "gemini-3.8-flash-high", effort: "high", role: "research", timeout: 420_000, cwd: tmpdir(),
    });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), [
      "--dangerously-skip-permissions", "--model", "gemini-3.8-flash-high",
      "--effort", "high", "--print-timeout", "420s", "-p", "public news",
    ]);
    assert.equal(result.resolvedModel, "gemini-3.8-flash-high");
    assert.equal(result.exitCode, 0);
  });
});

test("specialist uses the bounded agy contract and returns structured fields", { concurrency: false }, async () => {
  const result = await withFakeAgy({
    result: {
      conversation_id: "agy-session-42",
      status: "SUCCESS",
      response: "Implemented the requested change.",
      usage: { input_tokens: 12, output_tokens: 34 },
    },
  }, async (argsFile) => {
    const direct = await executeGeminiSpecialist("make the change", { cwd: tmpdir() });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), [
      "--agent", "homer-specialist",
      "--model", "gemini-3.8-flash-high",
      "--effort", "high",
      "--mode", "accept-edits",
      "--sandbox",
      "--output-format", "json",
      "--print-timeout", "900s",
      "-p", "make the change",
    ]);
    return direct;
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "Implemented the requested change.");
  assert.equal(result.requestedModel, "gemini-3.8-flash-high");
  assert.equal(result.resolvedModel, "gemini-3.8-flash-high");
  assert.equal(result.sessionId, "agy-session-42");
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 34 });
});

test("specialist rejects a non-success agy status even when agy exits zero", { concurrency: false }, async () => {
  const result = await withFakeAgy({
    result: { conversation_id: "failed-session", status: "FAILED", response: "provider rejected the request" },
  }, () => executeGeminiSpecialist("fail", { cwd: tmpdir(), timeout: 1_000 }));

  assert.equal(result.exitCode, 1);
  assert.equal(result.output, "agy returned non-success specialist status: FAILED");
  assert.equal(result.status, "FAILED");
});

test("specialist enforces a 15-minute minimum and preserves a longer caller deadline", { concurrency: false }, async () => {
  await withFakeAgy({ result: { status: "SUCCESS", response: "done" } }, async (argsFile) => {
    await executeGeminiSpecialist("minimum", { cwd: tmpdir(), timeout: 1_000 });
    const minimumArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.equal(minimumArgs[minimumArgs.indexOf("--print-timeout") + 1], "900s");
  });

  await withFakeAgy({ result: { status: "SUCCESS", response: "done" } }, async (argsFile) => {
    await executeGeminiSpecialist("longer", { cwd: tmpdir(), timeout: 1_200_000 });
    const longerArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.equal(longerArgs[longerArgs.indexOf("--print-timeout") + 1], "1200s");
  });
});

test("specialist rejects malformed, empty, and incomplete JSON results", { concurrency: false }, async () => {
  for (const scenario of [
    { rawOutput: "not json" },
    { rawOutput: "" },
    { result: { conversation_id: "x", status: "UNKNOWN", response: "ignored" } },
    { result: { conversation_id: "x", status: "SUCCESS" } },
  ]) {
    const result = await withFakeAgy(scenario, () =>
      executeGeminiSpecialist("validate", { cwd: tmpdir(), timeout: 1_000 }),
    );
    assert.equal(result.exitCode, 1, JSON.stringify(scenario));
  }
});

test("a pre-aborted specialist signal does not spawn agy", { concurrency: false }, async () => {
  const controller = new AbortController();
  controller.abort();
  await withFakeAgy({ result: { status: "SUCCESS", response: "should not run" } }, async (argsFile) => {
    const result = await executeGeminiSpecialist("cancelled", {
      cwd: tmpdir(), timeout: 1_000, signal: controller.signal,
    });
    assert.equal(result.exitCode, 130);
    assert.equal(result.output, "Cancelled");
    assert.equal(existsSync(argsFile), false);
  });
});

test("specialist CLI reads a prompt file and writes its executor result as JSON", { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "homer-specialist-cli-"));
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "edit the selected file");
  try {
    await withFakeAgy({
      result: { conversation_id: "cli-session", status: "SUCCESS", response: "done", usage: { total_tokens: 7 } },
    }, async (argsFile) => {
      const cli = spawnSync("npx", ["tsx", resolve("src/scripts/gemini-specialist.ts"), "--cwd", dir, "--prompt-file", promptFile, "--timeout-ms", "1000"], {
        cwd: resolve("."),
        env: process.env,
        encoding: "utf8",
      });
      assert.equal(cli.status, 0, cli.stderr);
      const jsonLine = cli.stdout.trim().split("\n").at(-1);
      assert.ok(jsonLine, "CLI should write a JSON result");
      const result = JSON.parse(jsonLine) as Record<string, unknown>;
      assert.equal(result.output, "done");
      assert.equal(result.exitCode, 0);
      assert.equal(result.executor, "gemini-cli");
      assert.equal(result.requestedModel, "gemini-3.8-flash-high");
      assert.equal(result.resolvedModel, "gemini-3.8-flash-high");
      assert.equal(result.model, "gemini-3.8-flash-high");
      assert.equal(result.sessionId, "cli-session");
      assert.equal(result.status, "SUCCESS");
      assert.deepEqual(result.usage, { total_tokens: 7 });
      assert.equal(typeof result.duration, "number");
      assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")).slice(-2), ["-p", "edit the selected file"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("specialist kills its process group when its abort signal fires", { concurrency: false }, async () => {
  const controller = new AbortController();
  const pending = withFakeAgy({ mode: "wait" }, () =>
    executeGeminiSpecialist("cancel", { cwd: tmpdir(), timeout: 5_000, signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 50);
  const result = await pending;

  assert.equal(result.exitCode, 130);
  assert.equal(result.output, "Cancelled");
});
