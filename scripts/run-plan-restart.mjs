import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const HOMER_DIR = process.env.HOMER_DIR || "/Users/yj/homer";
const DB_PATH = process.env.HOMER_DB_PATH || "/Users/yj/homer/data/homer.db";
const HOME_DIR = process.env.HOME || os.homedir();
const CLAUDE_PATH = process.env.CLAUDE_PATH || path.join(HOME_DIR, ".local", "bin", "claude");
const CLAUDE_TOKEN_FILE = path.join(HOME_DIR, ".homer-claude-token");
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const REVIEW_OUTPUT_LIMIT = 50_000;
const execId = Number(process.argv[2] || "0");

if (!Number.isFinite(execId) || execId <= 0) {
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 5000");

function update(fields) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const setClause = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE plan_executions SET ${setClause} WHERE id = ?`).run(...values, execId);
}

function loadExecution() {
  return db.prepare(`
    SELECT
      id,
      branch_name,
      merged_commit_sha,
      repair_attempts
    FROM plan_executions
    WHERE id = ?
  `).get(execId);
}

function captureError(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const stdout = error.stdout ? String(error.stdout) : "";
  const stderr = error.stderr ? String(error.stderr) : "";
  const message = error.message ? String(error.message) : String(error);
  return [stdout, stderr, message].filter(Boolean).join("\n").slice(-4000);
}

function tail(text, maxChars = 2000) {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function runCommand(command, args, timeout = 60_000) {
  return execFileSync(command, args, {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: process.env,
  }).trim();
}

function gitStatus() {
  return runCommand("git", ["status", "--porcelain"], 10_000);
}

function runValidation() {
  const steps = [
    { label: "TypeScript build", command: "npm", args: ["run", "build"], timeout: 10 * 60 * 1000 },
    { label: "App build", command: "npm", args: ["run", "app:build"], timeout: 10 * 60 * 1000 },
    { label: "Smoke test", command: "node", args: ["scripts/smoke-test.mjs"], timeout: 5 * 60 * 1000 },
  ];

  const outputs = [];
  for (const step of steps) {
    try {
      const output = execFileSync(step.command, step.args, {
        cwd: HOMER_DIR,
        encoding: "utf-8",
        timeout: step.timeout,
        maxBuffer: COMMAND_MAX_BUFFER,
        env: process.env,
      });
      outputs.push(`## ${step.label}\n${tail(output || "ok", 1200) || "ok"}`);
    } catch (error) {
      outputs.push(`## ${step.label}\n${captureError(error)}`);
      return {
        success: false,
        failedStep: step.label,
        details: outputs.join("\n\n"),
      };
    }
  }

  return {
    success: true,
    details: outputs.join("\n\n"),
  };
}

function restartDaemon() {
  execFileSync("bash", ["scripts/pre-restart-check.sh"], {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      HOMER_DEPLOY_POLICY: process.env.HOMER_DEPLOY_POLICY || "force",
    },
  });

  execFileSync("npm", ["run", "restart"], {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout: 2 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
}

function discardUncommittedReviewEdits() {
  if (!gitStatus()) {
    return;
  }
  execFileSync("git", ["reset", "--hard", "HEAD"], {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: process.env,
  });
  execFileSync("git", ["clean", "-fd"], {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: process.env,
  });
}

function maybeCommitReviewPatch(branchName) {
  if (!gitStatus()) {
    return null;
  }

  runCommand("git", ["add", "-A"], 30_000);
  const shortBranch = String(branchName || "unknown").replace(/^homer\/auto\//, "");
  runCommand("git", ["commit", "-m", `fix: post-deploy review patch for ${shortBranch}`], 60_000);
  return runCommand("git", ["rev-parse", "--short", "HEAD"], 10_000);
}

function buildReviewPrompt(row) {
  return [
    "You are reviewing a freshly deployed HOMER main branch.",
    "",
    `Repository: ${HOMER_DIR}`,
    "Branch: main",
    `Approved branch already merged and deployed: ${row.branch_name}`,
    `Deployed commit: ${row.merged_commit_sha || "unknown"}`,
    "",
    "Tasks:",
    "1. Check completeness and soundness of the deployed implementation.",
    "2. If something is missing or unsafe, patch the repository directly.",
    "3. You may run repo-local validation commands as needed.",
    "",
    "Constraints:",
    "- Do NOT run git push, git pull, git fetch, npm run restart, npm run deploy, launchctl, or edit credentials.",
    "- Do NOT create git commits or tags.",
    "- Keep any code changes narrowly scoped to deployment fixes.",
    "",
    "Return ONLY JSON with this shape:",
    '{',
    '  "verdict": "clean" | "warning" | "patched",',
    '  "summary": "short summary",',
    '  "warnings": ["optional warning"]',
    '}',
  ].join("\n");
}

function extractJsonCandidate(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1).trim();
  }

  return null;
}

function parseReviewOutput(output) {
  const candidate = extractJsonCandidate(output.trim());
  if (!candidate) {
    return {
      verdict: "clean",
      summary: tail(output.trim(), 1000) || "Claude review completed.",
      warnings: [],
    };
  }

  try {
    const parsed = JSON.parse(candidate);
    const verdict = parsed?.verdict === "warning" || parsed?.verdict === "patched"
      ? parsed.verdict
      : "clean";
    const summary = typeof parsed?.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "Claude review completed.";
    const warnings = Array.isArray(parsed?.warnings)
      ? parsed.warnings.map((item) => String(item)).filter(Boolean)
      : [];
    return { verdict, summary, warnings };
  } catch {
    return {
      verdict: "clean",
      summary: tail(output.trim(), 1000) || "Claude review completed.",
      warnings: [],
    };
  }
}

function buildClaudeEnv() {
  const env = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "homer",
    CI: process.env.CI || "1",
    TERM: process.env.TERM || "dumb",
    NO_COLOR: process.env.NO_COLOR || "1",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    TMPDIR: process.env.TMPDIR || "/tmp",
    HOME: HOME_DIR,
  };

  if (!env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(CLAUDE_TOKEN_FILE)) {
    try {
      const token = readFileSync(CLAUDE_TOKEN_FILE, "utf-8").trim();
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token;
      }
    } catch {
      // Best effort only.
    }
  }

  return env;
}

function executeClaudeReview(prompt) {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, args, {
      cwd: HOMER_DIR,
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let resultContent = "";
    let sessionId;
    let settled = false;
    let stdoutLineBuffer = "";

    const finalize = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
        return;
      }

      const output = resultContent.trim() || stdout.trim();
      resolve({
        output: output ? `${output}${stderr ? `\n\nStderr:\n${stderr}` : ""}` : stderr,
        claudeSessionId: sessionId,
      });
    };

    const parseLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if ((event.type === "system" || event.type === "init") && event.session_id) {
          sessionId = event.session_id;
        }
        if (event.type === "assistant" && event.message?.content) {
          const content = Array.isArray(event.message.content)
            ? event.message.content
              .filter((item) => item?.type === "text" && typeof item.text === "string")
              .map((item) => item.text)
              .join("")
            : String(event.message.content ?? "");
          resultContent += content;
        }
        if (event.type === "result" && typeof event.result === "string") {
          resultContent = event.result;
        }
      } catch {
        // Ignore non-JSON lines.
      }
    };

    proc.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split("\n");
      stdoutLineBuffer = lines.pop() || "";
      for (const line of lines) {
        parseLine(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    proc.on("error", (error) => finalize(error));
    proc.on("close", (code, signal) => {
      if (stdoutLineBuffer) {
        parseLine(stdoutLineBuffer);
      }
      if (code !== 0) {
        finalize(new Error(`Claude review failed (code ${code ?? "null"}, signal ${signal ?? "none"}): ${tail(stderr || stdout, 2000)}`));
        return;
      }
      finalize(null);
    });

    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // Best effort.
      }
      finalize(new Error("Claude review timed out"));
    }, 30 * 60 * 1000);
  });
}

async function main() {
  const row = loadExecution();
  if (!row) {
    process.exitCode = 1;
    return;
  }

  try {
    restartDaemon();
    update({
      integration_status: "deployed",
      deploy_status: "deployed",
      deployed_at: new Date().toISOString(),
      review_status: "queued",
      last_error: null,
      final_notified_at: null,
    });
  } catch (error) {
    update({
      integration_status: "failed",
      deploy_status: "failed",
      last_error: captureError(error),
      final_notified_at: null,
    });
    process.exitCode = 1;
    return;
  }

  let reviewResult = null;
  let reviewSummary = "Claude review completed.";
  let reviewWarnings = [];
  let reviewPatchCommitSha = null;

  try {
    update({
      review_status: "running",
      review_started_at: new Date().toISOString(),
      review_completed_at: null,
      review_last_error: null,
      final_notified_at: null,
    });

    reviewResult = await executeClaudeReview(buildReviewPrompt(row));
    const parsedReview = parseReviewOutput(reviewResult.output || "");
    reviewSummary = parsedReview.summary;
    reviewWarnings = parsedReview.warnings;

    update({
      review_session_id: reviewResult.claudeSessionId || null,
      review_output: String(reviewResult.output || "").slice(0, REVIEW_OUTPUT_LIMIT),
      review_summary: reviewSummary.slice(0, 2000),
      review_last_error: reviewWarnings.length > 0 ? reviewWarnings.join("\n").slice(0, 4000) : null,
    });

    if (!gitStatus()) {
      update({
        review_status: parsedReview.verdict === "warning" ? "warning" : "clean",
        review_completed_at: new Date().toISOString(),
        final_notified_at: null,
      });
      return;
    }

    const validation = runValidation();
    if (!validation.success) {
      discardUncommittedReviewEdits();
      update({
        review_status: "failed",
        review_completed_at: new Date().toISOString(),
        review_last_error: validation.details.slice(-4000),
        final_notified_at: null,
      });
      return;
    }

    reviewPatchCommitSha = maybeCommitReviewPatch(row.branch_name);
    if (!reviewPatchCommitSha) {
      update({
        review_status: "warning",
        review_completed_at: new Date().toISOString(),
        final_notified_at: null,
      });
      return;
    }

    runCommand("git", ["push", "origin", "main"], 2 * 60 * 1000);
    restartDaemon();

    update({
      integration_status: "deployed",
      deploy_status: "deployed",
      deployed_at: new Date().toISOString(),
      review_status: "patched",
      review_patch_commit_sha: reviewPatchCommitSha,
      review_completed_at: new Date().toISOString(),
      review_last_error: null,
      last_error: null,
      final_notified_at: null,
    });
  } catch (error) {
    const errorText = captureError(error);
    try {
      if (gitStatus()) {
        discardUncommittedReviewEdits();
      }
    } catch {
      // Best effort only.
    }

    update({
      review_status: "failed",
      review_output: reviewResult?.output
        ? String(reviewResult.output).slice(0, REVIEW_OUTPUT_LIMIT)
        : null,
      review_summary: reviewSummary.slice(0, 2000),
      review_patch_commit_sha: reviewPatchCommitSha,
      review_completed_at: new Date().toISOString(),
      review_last_error: errorText,
      final_notified_at: null,
    });
    process.exitCode = 1;
  }
}

await main().finally(() => {
  db.close();
});
