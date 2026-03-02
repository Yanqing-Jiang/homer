/**
 * Auto-commit ~/memory/ changes to git after nightly processing.
 * Safety net: provides version history before self-modification goes live.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const MEMORY_DIR = PATHS.memory;

export async function runMemoryGitCommit(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Initialize git if needed
    if (!existsSync(`${MEMORY_DIR}/.git`)) {
      execSync("git init", { cwd: MEMORY_DIR, timeout: 10_000 });
      execSync('printf "*.db\\n*.db-journal\\n*.db-wal\\n.DS_Store\\n" > .gitignore', {
        cwd: MEMORY_DIR,
        timeout: 5_000,
      });
      execSync('git add -A && git commit -m "Initial memory commit"', {
        cwd: MEMORY_DIR,
        timeout: 30_000,
      });
      logger.info("Initialized git repo in ~/memory/");
    }

    // Check for changes
    const status = execSync("git status --porcelain", {
      cwd: MEMORY_DIR,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (!status) {
      return { success: true, output: "No memory changes to commit" };
    }

    // Count changes
    const lines = status.split("\n").filter(Boolean);
    const added = lines.filter(l => l.startsWith("??") || l.startsWith("A")).length;
    const modified = lines.filter(l => l.includes("M")).length;
    const deleted = lines.filter(l => l.includes("D")).length;

    // Commit all changes
    const date = new Date().toISOString().slice(0, 10);
    const commitMsg = `memory: ${date} — ${added} added, ${modified} modified, ${deleted} deleted`;

    execSync("git add -A", { cwd: MEMORY_DIR, timeout: 10_000 });
    execSync(`git commit -m "${commitMsg}"`, { cwd: MEMORY_DIR, timeout: 30_000 });

    const output = `Committed: ${commitMsg}`;
    logger.info({ added, modified, deleted }, "Memory git commit complete");
    return { success: true, output };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Memory git commit failed");
    return { success: false, output: "", error: msg };
  }
}
