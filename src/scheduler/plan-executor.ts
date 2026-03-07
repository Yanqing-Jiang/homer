/**
 * Plan Executor — Spawns Claude Code on an isolated git branch to implement approved plans.
 *
 * Design:
 * - Plan text IS the prompt (no translation — LLM decides how to implement)
 * - Branch isolation: every run on `homer/auto/{slug}-{date}`
 * - Build gate: independent `npm run build` verification
 * - Max 1 execution/day (hardcoded safety rail)
 * - Never auto-merges to main
 */

import { executeClaudeCommand } from "../executors/claude.js";
import { execSync } from "child_process";
import type { StateManager } from "../state/manager.js";
import type { Bot } from "grammy";

const HOMER_DIR = "/Users/yj/homer";
const MAX_PLAN_EXECUTIONS_PER_DAY = 1;

interface PlanExecutionResult {
  success: boolean;
  branch: string;
  filesChanged: string[];
  buildPassed: boolean;
  output: string;
  error?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Check daily execution limit (safety rail — not LLM decision)
 */
function canExecuteToday(db: ReturnType<StateManager["getDb"]>): boolean {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM plan_executions
      WHERE started_at >= date('now') AND started_at < date('now', '+1 day')
    `).get() as { cnt: number };
    return row.cnt < MAX_PLAN_EXECUTIONS_PER_DAY;
  } catch {
    return true; // table may not exist yet
  }
}

/**
 * Execute an approved plan via Claude Code on an isolated branch.
 */
export async function executePlan(params: {
  jobId: string;
  plan: string;
  stateManager: StateManager;
  bot: Bot;
  chatId: number;
}): Promise<PlanExecutionResult> {
  const { jobId, plan, stateManager, bot, chatId } = params;
  const db = stateManager.getDb();
  const startTime = Date.now();

  // Safety: concurrent execution guard
  try {
    const running = db.prepare(
      "SELECT COUNT(*) as cnt FROM plan_executions WHERE status = 'running'"
    ).get() as { cnt: number };
    if (running.cnt > 0) {
      try {
        await bot.api.sendMessage(chatId, "⏸️ Another plan is already executing. Try again later.");
      } catch { /* best effort */ }
      return { success: false, branch: "", filesChanged: [], buildPassed: false, output: "Another plan already running" };
    }
  } catch { /* table may not exist */ }

  // Safety: daily limit
  if (!canExecuteToday(db)) {
    try {
      await bot.api.sendMessage(chatId,
        `⏸️ Daily plan execution limit reached (${MAX_PLAN_EXECUTIONS_PER_DAY}/day). Try again tomorrow.`
      );
    } catch { /* best effort */ }
    return { success: false, branch: "", filesChanged: [], buildPassed: false, output: "Daily limit reached" };
  }

  // Create branch (unique suffix prevents same-day collisions)
  const slug = jobId.replace(/[^a-z0-9-]/gi, "-").slice(0, 30);
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toISOString().slice(11, 16).replace(":", "");
  const branchName = `homer/auto/${slug}-${datePart}-${timePart}`;

  // Save original state so we can restore after execution
  let originalBranch = "main";
  let didStash = false;
  try {
    originalBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: HOMER_DIR, timeout: 10_000, encoding: "utf-8" }).trim();
  } catch { /* default to main */ }
  try {
    const stashOutput = execSync("git stash --include-untracked", { cwd: HOMER_DIR, timeout: 10_000, encoding: "utf-8" });
    didStash = !stashOutput.includes("No local changes");
  } catch { /* nothing to stash */ }
  try {
    execSync("git checkout main", { cwd: HOMER_DIR, timeout: 10_000 });
  } catch { /* may already be on main */ }

  try {
    execSync(`git checkout -b "${branchName}"`, { cwd: HOMER_DIR, timeout: 10_000 });
  } catch {
    // Branch may already exist
    try {
      execSync(`git checkout "${branchName}"`, { cwd: HOMER_DIR, timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, branch: branchName, filesChanged: [], buildPassed: false, output: "", error: `Git branch failed: ${msg}` };
    }
  }

  // Record execution start
  let execId: number | undefined;
  try {
    const stmt = db.prepare(`
      INSERT INTO plan_executions (job_id, plan_text, branch_name, status)
      VALUES (?, ?, ?, 'running')
    `);
    const result = stmt.run(jobId, plan, branchName);
    execId = Number(result.lastInsertRowid);
  } catch { /* table may not exist */ }

  // Notify user
  try {
    await bot.api.sendMessage(chatId,
      `🔧 <b>Executing plan</b>\n<b>Branch:</b> <code>${escapeHtml(branchName)}</code>\n<b>Source:</b> ${escapeHtml(jobId)}`,
      { parse_mode: "HTML" }
    );
  } catch { /* best effort */ }

  try {
    // Build the execution prompt — plan text IS the prompt
    const prompt = `You are implementing an approved improvement plan for the Homer codebase.

## The Plan

${plan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT run \`npm run deploy\` or restart the daemon.

## Safety Rules

- You are on branch \`${branchName}\`. All changes stay here.
- Do NOT modify \`schedule.json\` or run \`launchctl\` commands.
- Do NOT push to remote or create PRs.
- Do NOT modify \`.env\` or credential files.
- Do NOT modify CLAUDE.md.
- If the plan seems risky or unclear, implement what you're confident about and note what you skipped.

## Output

After implementation, output a JSON summary:
\`\`\`json
{
  "filesChanged": ["src/path/to/file.ts"],
  "summary": "1-3 sentence description of what was done",
  "buildPassed": true,
  "skipped": null,
  "confidence": 0.85
}
\`\`\``;

    const result = await executeClaudeCommand(prompt, {
      cwd: HOMER_DIR,
      model: "sonnet",
    });

    // Parse result
    let filesChanged: string[] = [];
    let summary = result.output;

    const jsonMatch = result.output.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch?.[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        filesChanged = Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [];
        summary = parsed.summary || summary;
      } catch { /* use raw output */ }
    }

    // Verify build independently (don't trust LLM's claim)
    let buildVerified = false;
    let buildOutput = "";
    try {
      buildOutput = execSync("npm run build 2>&1", {
        cwd: HOMER_DIR,
        timeout: 60_000,
        encoding: "utf-8",
      });
      buildVerified = true;
    } catch (err) {
      buildOutput = err instanceof Error && "stdout" in err
        ? String((err as { stdout: unknown }).stdout).slice(-2000)
        : "Build failed";
      buildVerified = false;
    }

    // Get actual diff
    let diffSummary = "";
    try {
      diffSummary = execSync("git diff --stat main", { cwd: HOMER_DIR, timeout: 10_000, encoding: "utf-8" });
    } catch { /* ignore */ }

    const status = buildVerified ? "success" : "build_failed";
    const durationMs = Date.now() - startTime;

    // Record outcome
    if (execId) {
      try {
        db.prepare(`
          UPDATE plan_executions
          SET status = ?, executor_output = ?, build_output = ?, files_changed = ?, completed_at = CURRENT_TIMESTAMP, duration_ms = ?
          WHERE id = ?
        `).run(status, result.output.slice(0, 50_000), buildOutput.slice(0, 10_000), JSON.stringify(filesChanged), durationMs, execId);
      } catch { /* ignore */ }
    }

    // Clean up: return to original branch and restore stash
    try {
      execSync(`git checkout "${originalBranch}"`, { cwd: HOMER_DIR, timeout: 10_000 });
    } catch {
      try { execSync("git checkout main", { cwd: HOMER_DIR, timeout: 10_000 }); } catch { /* last resort */ }
    }
    if (didStash) {
      try { execSync("git stash pop", { cwd: HOMER_DIR, timeout: 10_000 }); } catch { /* stash may conflict — preserved in stash list */ }
    }

    // Notify user
    const emoji = buildVerified ? "✅" : "❌";
    const buildStatus = buildVerified ? "passed" : "FAILED";
    const diffLines = diffSummary ? `\n<pre>${escapeHtml(diffSummary.slice(0, 1000))}</pre>` : "";

    try {
      await bot.api.sendMessage(chatId,
        `${emoji} <b>Plan execution ${status}</b>\n` +
        `<b>Branch:</b> <code>${escapeHtml(branchName)}</code>\n` +
        `<b>Build:</b> ${buildStatus}\n` +
        `<b>Duration:</b> ${Math.round(durationMs / 1000)}s\n` +
        `<b>Summary:</b> ${escapeHtml(String(summary).slice(0, 500))}` +
        diffLines +
        (buildVerified
          ? `\n\n<i>To apply: </i><code>cd ~/homer && git merge ${branchName} && npm run deploy</code>`
          : `\n\n<i>Branch preserved for inspection. Fix and merge manually.</i>`),
        { parse_mode: "HTML" }
      );
    } catch { /* best effort */ }

    return {
      success: buildVerified,
      branch: branchName,
      filesChanged,
      buildPassed: buildVerified,
      output: String(summary),
    };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    // Record error
    if (execId) {
      try {
        db.prepare(`
          UPDATE plan_executions SET status = 'error', executor_output = ?, completed_at = CURRENT_TIMESTAMP, duration_ms = ? WHERE id = ?
        `).run(msg.slice(0, 50_000), durationMs, execId);
      } catch { /* ignore */ }
    }

    // Clean up: return to original branch and restore stash
    try {
      execSync(`git checkout "${originalBranch}"`, { cwd: HOMER_DIR, timeout: 10_000 });
    } catch {
      try { execSync("git checkout main", { cwd: HOMER_DIR, timeout: 10_000 }); } catch { /* last resort */ }
    }
    if (didStash) {
      try { execSync("git stash pop", { cwd: HOMER_DIR, timeout: 10_000 }); } catch { /* preserved in stash list */ }
    }

    // Notify
    try {
      await bot.api.sendMessage(chatId,
        `❌ <b>Plan execution error</b>\n<code>${escapeHtml(msg.slice(0, 500))}</code>`,
        { parse_mode: "HTML" }
      );
    } catch { /* best effort */ }

    return { success: false, branch: branchName, filesChanged: [], buildPassed: false, output: "", error: msg };
  }
}
