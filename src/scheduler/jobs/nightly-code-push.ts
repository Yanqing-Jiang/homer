/**
 * Auto-commit ~/homer/ code changes nightly and push to GitHub without
 * Telegram approval.
 *
 *   1. If the working tree has changes → `git add -A` + Codex-generated commit.
 *   2. If there are unpushed commits → `git push origin main` (with retries).
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import type { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import { PROJECT_DIR } from "../code-push-proposal.js";
import type { RegisteredJob } from "../types.js";
import { runInternalJobHarness } from "../executor.js";

const PUSH_RETRIES = 3;
const PUSH_RETRY_DELAY_MS = 5_000;
const MAX_DIFF_CHARS = 12_000;

interface CodePushRepo {
  name: string;
  dir: string;
}

const CODE_PUSH_REPOS: CodePushRepo[] = [
  { name: "homer", dir: PROJECT_DIR },
  { name: "homer-web", dir: process.env.HOMER_WEB_PROJECT_DIR ?? join(dirname(PROJECT_DIR), "homer-web") },
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logPrefix(repo?: CodePushRepo): string {
  return repo ? `[NightlyPush:${repo.name}]` : "[NightlyPush]";
}

/**
 * Use Codex GPT-5.4 to generate a descriptive commit message from the staged diff.
 * Falls back to a generic message if Codex is unavailable or fails.
 */
async function generateCommitMessage(
  repo: CodePushRepo,
  date: string,
  fileCount: number,
  job?: RegisteredJob,
  startedAt = new Date(),
): Promise<string> {
  const fallback = `chore: nightly snapshot ${date} (${fileCount} files)`;
  if (!job) return fallback;

  try {
    const stat = execSync("git diff --cached --stat", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    let diff = execSync("git diff --cached", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();

    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)";
    }

    const prompt = `You are generating a git commit message for the ${repo.name} repo's nightly snapshot.

Stat summary:
${stat}

Diff:
${diff}

Write a commit message with:
- Title line: start with "chore: nightly snapshot ${date} —" then a short (max 72 chars total) summary of the most significant change
- Blank line
- Body: 3-8 bullet points (- prefix) describing what changed and why it matters, grouped by theme

Output ONLY the commit message. No preamble, no explanation, no markdown fences.`;

    const result = await runInternalJobHarness(job, prompt, {
      stage: "push",
      startedAt,
      emitCompletedEvent: false,
    });

    const output = result.output?.trim() ?? "";
    if (!output || output.length < 10) {
      logger.warn(`${logPrefix(repo)} Codex returned empty response, using fallback`);
      return fallback;
    }

    logger.info(`${logPrefix(repo)} Generated commit message via Codex`);
    return output;
  } catch (err: any) {
    logger.warn(`${logPrefix(repo)} Codex commit generation failed: ${err.message ?? err}, using fallback`);
    return fallback;
  }
}

async function pushWithRetries(repo: CodePushRepo): Promise<{ ok: true } | { ok: false; error: string }> {
  const GH_BIN = "/opt/homebrew/bin/gh";
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
    try {
      let ghToken = process.env.GH_TOKEN ?? "";
      if (!ghToken) {
        ghToken = execSync(`${GH_BIN} auth token`, {
          encoding: "utf-8",
          timeout: 5_000,
        }).trim();
      }
      execSync("git push origin main", {
        cwd: repo.dir,
        timeout: 900_000,
        env: {
          ...process.env,
          GH_TOKEN: ghToken,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: `!${GH_BIN} auth git-credential`,
        },
      });
      return { ok: true };
    } catch (err: any) {
      lastErr = err.message ?? String(err);
      logger.warn(`${logPrefix(repo)} Push attempt ${attempt}/${PUSH_RETRIES} failed: ${lastErr}`);
      if (attempt < PUSH_RETRIES) await sleep(PUSH_RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: lastErr ?? "unknown push error" };
}

interface CodePushDeps {
  bot?: Bot;
  chatId?: number;
  stateManager?: StateManager;
  job?: RegisteredJob;
  startedAt?: Date;
}

async function runNightlyCodePushForRepo(repo: CodePushRepo, deps: CodePushDeps): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const prefix = logPrefix(repo);

  try {
    if (!existsSync(repo.dir)) {
      return { success: false, output: "", error: `Directory not found: ${repo.dir}` };
    }

    const status = execSync("git status --porcelain", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    let commitMsg = "";
    if (status) {
      const lines = status.split("\n").filter(Boolean);
      const date = new Date().toISOString().slice(0, 10);

      logger.info({ fileCount: lines.length }, `${prefix} Staging + committing locally...`);
      execSync("git add -A", { cwd: repo.dir, timeout: 30_000 });

      commitMsg = await generateCommitMessage(repo, date, lines.length, deps.job, deps.startedAt);

      execSync(`git commit -F -`, {
        cwd: repo.dir,
        timeout: 30_000,
        input: commitMsg,
      });
      logger.info(`${prefix} Committed locally: ${commitMsg.split("\n")[0]}`);
    }

    const unpushedRaw = execSync("git rev-list --count origin/main..HEAD", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const unpushedCount = parseInt(unpushedRaw, 10) || 0;

    if (unpushedCount === 0) {
      return { success: true, output: "No changes to commit" };
    }

    logger.info({ unpushedCount }, `${prefix} Auto-pushing ${unpushedCount} commit(s) to origin/main`);
    const pushResult = await pushWithRetries(repo);
    if (!pushResult.ok) {
      return { success: false, output: "", error: `Push failed: ${pushResult.error}` };
    }

    const summary = commitMsg
      ? `Pushed: ${commitMsg.split("\n")[0]} — ${unpushedCount} commit(s)`
      : `Pushed ${unpushedCount} commit(s)`;
    logger.info({ unpushedCount }, `${prefix} ${summary}`);
    return { success: true, output: summary };

  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, `${prefix} Failed`);
    return { success: false, output: "", error: msg };
  }
}

export async function runNightlyCodePush(deps: CodePushDeps = {}): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const results: Array<{ repo: CodePushRepo; success: boolean; output: string; error?: string }> = [];
  for (const repo of CODE_PUSH_REPOS) {
    results.push({ repo, ...(await runNightlyCodePushForRepo(repo, deps)) });
  }

  const failures = results.filter((result) => !result.success);
  const output = results
    .map((result) => `${result.repo.name}: ${result.output || result.error || "no output"}`)
    .join("; ");
  if (failures.length > 0) {
    return {
      success: false,
      output,
      error: failures.map((result) => `${result.repo.name}: ${result.error ?? "unknown error"}`).join("; "),
    };
  }
  return { success: true, output };
}
