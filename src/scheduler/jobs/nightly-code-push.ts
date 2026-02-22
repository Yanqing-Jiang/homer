/**
 * Auto-commit ~/homer/ code changes and push to GitHub nightly.
 * Provides: version history, backup, and triggers GitHub Actions (web UI rebuild).
 *
 * Uses Claude Code Sonnet to generate descriptive commit messages from the staged diff.
 *
 * NOTE: Does NOT run `npm run deploy` — that kills the running daemon (launchctl bootout).
 * Web UI rebuild is handled by GitHub Actions on push. Daemon code changes deploy manually.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { logger } from "../../utils/logger.js";

const PROJECT_DIR = "/Users/yj/homer";
const PUSH_RETRIES = 3;
const PUSH_RETRY_DELAY_MS = 5_000;
const CLAUDE_BIN = "/Users/yj/.local/bin/claude";
const GH_BIN = "/opt/homebrew/bin/gh";
const MAX_DIFF_CHARS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Use Claude Code Sonnet to generate a descriptive commit message from the staged diff.
 * Falls back to a generic message if Claude is unavailable or fails.
 */
async function generateCommitMessage(date: string, fileCount: number): Promise<string> {
  const fallback = `chore: nightly snapshot ${date} (${fileCount} files)`;

  try {
    const stat = execSync("git diff --cached --stat", {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    let diff = execSync("git diff --cached", {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();

    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)";
    }

    const prompt = `You are generating a git commit message for the Homer AI system's nightly snapshot.

Stat summary:
${stat}

Diff:
${diff}

Write a commit message with:
- Title line: start with "chore: nightly snapshot ${date} —" then a short (max 72 chars total) summary of the most significant change
- Blank line
- Body: 3-8 bullet points (- prefix) describing what changed and why it matters, grouped by theme

Output ONLY the commit message. No preamble, no explanation, no markdown fences.`;

    // Unset CLAUDECODE so the daemon can spawn Claude without "nested session" error
    const env = { ...process.env };
    delete env["CLAUDECODE"];

    const result = execSync(
      `${CLAUDE_BIN} -p --model sonnet --tools "" --no-session-persistence`,
      {
        cwd: PROJECT_DIR,
        encoding: "utf-8",
        timeout: 60_000,
        input: prompt,
        env,
      }
    ).trim();

    if (!result || result.length < 10) {
      logger.warn(`${logPrefix()} Claude returned empty response, using fallback`);
      return fallback;
    }

    logger.info(`${logPrefix()} Generated commit message via Claude Sonnet`);
    return result;
  } catch (err: any) {
    logger.warn(`${logPrefix()} Claude commit generation failed: ${err.message ?? err}, using fallback`);
    return fallback;
  }
}

function logPrefix(): string {
  return "[NightlyPush]";
}

export async function runNightlyCodePush(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const prefix = logPrefix();

  try {
    if (!existsSync(PROJECT_DIR)) {
      return { success: false, output: "", error: `Directory not found: ${PROJECT_DIR}` };
    }

    // Check for changes
    const status = execSync("git status --porcelain", {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (!status) {
      return { success: true, output: "No changes to commit" };
    }

    const lines = status.split("\n").filter(Boolean);
    const date = new Date().toISOString().slice(0, 10);

    logger.info({ fileCount: lines.length }, `${prefix} Staging changes...`);
    execSync("git add -A", { cwd: PROJECT_DIR, timeout: 30_000 });

    // Generate descriptive commit message via Claude Sonnet
    const commitMsg = await generateCommitMessage(date, lines.length);

    execSync(`git commit -F -`, {
      cwd: PROJECT_DIR,
      timeout: 30_000,
      input: commitMsg,
    });
    logger.info(`${prefix} Committed: ${commitMsg.split("\n")[0]}`);

    // Push with retry (using gh CLI for auth — osxkeychain fails in daemon context)
    let pushError: string | undefined;
    for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
      try {
        const ghToken = execSync(`${GH_BIN} auth token`, {
          encoding: "utf-8",
          timeout: 5_000,
        }).trim();
        execSync("git push origin main", {
          cwd: PROJECT_DIR,
          timeout: 60_000,
          env: {
            ...process.env,
            GH_TOKEN: ghToken,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "credential.helper",
            GIT_CONFIG_VALUE_0: `!${GH_BIN} auth git-credential`,
          },
        });
        pushError = undefined;
        break;
      } catch (err: any) {
        pushError = err.message ?? String(err);
        logger.warn(`${prefix} Push attempt ${attempt}/${PUSH_RETRIES} failed: ${pushError}`);
        if (attempt < PUSH_RETRIES) await sleep(PUSH_RETRY_DELAY_MS);
      }
    }

    if (pushError) {
      logger.error(`${prefix} Push failed after ${PUSH_RETRIES} attempts`);
      return {
        success: false,
        output: `Committed locally: ${commitMsg.split("\n")[0]}`,
        error: `Push failed: ${pushError}`,
      };
    }

    const output = `Committed and pushed: ${commitMsg.split("\n")[0]}`;
    logger.info(`${prefix} ${output}`);
    return { success: true, output };

  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, `${logPrefix()} Failed`);
    return { success: false, output: "", error: msg };
  }
}
