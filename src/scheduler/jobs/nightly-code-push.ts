/**
 * Auto-commit ~/homer/ code changes and push to GitHub nightly.
 * Provides: version history, backup, and triggers GitHub Actions (web UI rebuild).
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runNightlyCodePush(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const logPrefix = "[NightlyPush]";

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
    const commitMsg = `chore: nightly snapshot ${date} (${lines.length} files)`;

    logger.info({ fileCount: lines.length }, `${logPrefix} Staging changes...`);
    execSync("git add -A", { cwd: PROJECT_DIR, timeout: 30_000 });
    execSync(`git commit -m "${commitMsg}"`, { cwd: PROJECT_DIR, timeout: 30_000 });
    logger.info(`${logPrefix} Committed: ${commitMsg}`);

    // Push with retry
    let pushError: string | undefined;
    for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
      try {
        execSync("git push origin main", { cwd: PROJECT_DIR, timeout: 60_000 });
        pushError = undefined;
        break;
      } catch (err: any) {
        pushError = err.message ?? String(err);
        logger.warn(`${logPrefix} Push attempt ${attempt}/${PUSH_RETRIES} failed: ${pushError}`);
        if (attempt < PUSH_RETRIES) await sleep(PUSH_RETRY_DELAY_MS);
      }
    }

    if (pushError) {
      logger.error(`${logPrefix} Push failed after ${PUSH_RETRIES} attempts`);
      return {
        success: false,
        output: `Committed locally: ${commitMsg}`,
        error: `Push failed: ${pushError}`,
      };
    }

    const output = `Committed and pushed: ${commitMsg}`;
    logger.info(`${logPrefix} ${output}`);
    return { success: true, output };

  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, `${logPrefix} Failed`);
    return { success: false, output: "", error: msg };
  }
}
