import { execFileSync, spawn } from "child_process";
import { InlineKeyboard, type Bot } from "grammy";
import type { StateManager } from "../state/manager.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { logger } from "../utils/logger.js";

const HOMER_DIR = "/Users/yj/homer";
const RESTART_RUNNER = "/Users/yj/homer/scripts/run-plan-restart.mjs";
const REPAIR_ATTEMPT_LIMIT = 3;
const SNOOZE_MS = 2 * 60 * 60 * 1000;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

type IntegrationStatus =
  | "ready"
  | "snoozed"
  | "merging"
  | "repairing"
  | "deploying"
  | "deployed"
  | "dismissed"
  | "failed";

type DeployStatus = "pending" | "restarting" | "deployed" | "failed" | null;

interface PlanExecutionRow {
  id: number;
  job_id: string;
  branch_name: string;
  status: string;
  summary_text: string | null;
  diff_summary: string | null;
  files_changed: string | null;
  chat_id: number | null;
  integration_status: IntegrationStatus | null;
  deploy_status: DeployStatus;
  snooze_until: string | null;
  ready_message_id: number | null;
  ready_notified_at: string | null;
  pre_merge_sha: string | null;
  pre_merge_tag: string | null;
  merged_commit_sha: string | null;
  merged_at: string | null;
  deploy_started_at: string | null;
  deployed_at: string | null;
  repair_attempts: number;
  last_error: string | null;
  final_notified_at: string | null;
}

interface ValidationResult {
  success: boolean;
  failedStep?: string;
  details: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tail(text: string, maxChars = 2000): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function commandErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }

  const err = error as {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    message?: string;
  };
  const stdout = err.stdout ? String(err.stdout) : "";
  const stderr = err.stderr ? String(err.stderr) : "";
  const message = err.message ?? String(error);
  return tail([stdout, stderr, message].filter(Boolean).join("\n"), 4000);
}

function runCommand(command: string, args: string[], timeout = 60_000): string {
  return execFileSync(command, args, {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout,
    maxBuffer: COMMAND_MAX_BUFFER,
    env: process.env,
  }).trim();
}

function loadExecution(stateManager: StateManager, execId: number): PlanExecutionRow | null {
  return (
    stateManager.getDb().prepare(`
      SELECT
        id,
        job_id,
        branch_name,
        status,
        summary_text,
        diff_summary,
        files_changed,
        chat_id,
        integration_status,
        deploy_status,
        snooze_until,
        ready_message_id,
        ready_notified_at,
        pre_merge_sha,
        pre_merge_tag,
        merged_commit_sha,
        merged_at,
        deploy_started_at,
        deployed_at,
        repair_attempts,
        last_error,
        final_notified_at
      FROM plan_executions
      WHERE id = ?
    `).get(execId) as PlanExecutionRow | undefined
  ) ?? null;
}

function parseFilesChanged(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function formatReadyMessage(row: PlanExecutionRow): string {
  const filesChanged = parseFilesChanged(row.files_changed);
  const filesPreview = filesChanged.length > 0
    ? filesChanged.slice(0, 8).map((file) => `• ${file}`).join("\n")
    : "• Files not reported";
  const diffBlock = row.diff_summary
    ? `\n<pre>${escapeHtml(row.diff_summary.slice(0, 1200))}</pre>`
    : "";

  return (
    `✅ <b>Build passed. Ready to merge and deploy.</b>\n` +
    `<b>Branch:</b> <code>${escapeHtml(row.branch_name)}</code>\n` +
    `<b>Plan:</b> ${escapeHtml(row.job_id)}\n` +
    `<b>Summary:</b> ${escapeHtml((row.summary_text || "No summary").slice(0, 500))}\n` +
    `<b>Files:</b>\n<pre>${escapeHtml(filesPreview)}</pre>` +
    diffBlock
  );
}

function formatFinalMessage(row: PlanExecutionRow, statusLabel: string): string {
  const currentSha = safeGitSha("HEAD");
  const commit = row.merged_commit_sha || currentSha || "unknown";
  const recovery = row.pre_merge_tag || "not recorded";
  const error = row.last_error ? `\n<b>Error:</b> <pre>${escapeHtml(row.last_error.slice(0, 1600))}</pre>` : "";

  return (
    `${statusLabel}\n` +
    `<b>Branch:</b> <code>${escapeHtml(row.branch_name)}</code>\n` +
    `<b>Commit:</b> <code>${escapeHtml(commit)}</code>\n` +
    `<b>Repairs:</b> ${row.repair_attempts}\n` +
    `<b>Recovery Tag:</b> <code>${escapeHtml(recovery)}</code>\n` +
    `<b>Main:</b> <code>${escapeHtml(currentSha || "unknown")}</code>` +
    error
  );
}

function safeGitSha(ref = "HEAD"): string | null {
  try {
    return runCommand("git", ["rev-parse", "--short", ref], 10_000);
  } catch {
    return null;
  }
}

async function editMessage(
  bot: Bot,
  row: PlanExecutionRow,
  text: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  if (!row.chat_id || !row.ready_message_id) return;
  try {
    await bot.api.editMessageText(row.chat_id, row.ready_message_id, text, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  } catch (error) {
    logger.warn({ error, execId: row.id }, "Failed to edit plan execution message");
  }
}

async function sendMessage(bot: Bot, row: PlanExecutionRow, text: string): Promise<void> {
  if (!row.chat_id) return;
  try {
    await bot.api.sendMessage(row.chat_id, text, { parse_mode: "HTML" });
  } catch (error) {
    logger.warn({ error, execId: row.id }, "Failed to send plan execution message");
  }
}

function updateExecution(
  stateManager: StateManager,
  execId: number,
  fields: Record<string, unknown>
): void {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const columns = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  stateManager.getDb()
    .prepare(`UPDATE plan_executions SET ${columns} WHERE id = ?`)
    .run(...values, execId);
}

function validationSteps(): Array<{ label: string; command: string; args: string[]; timeout: number }> {
  return [
    { label: "TypeScript build", command: "npm", args: ["run", "build"], timeout: 10 * 60 * 1000 },
    { label: "App build", command: "npm", args: ["run", "app:build"], timeout: 10 * 60 * 1000 },
    { label: "Smoke test", command: "node", args: ["scripts/smoke-test.mjs"], timeout: 5 * 60 * 1000 },
  ];
}

function runValidation(): ValidationResult {
  const outputs: string[] = [];

  for (const step of validationSteps()) {
    try {
      const output = execFileSync(step.command, step.args, {
        cwd: HOMER_DIR,
        encoding: "utf-8",
        timeout: step.timeout,
        maxBuffer: COMMAND_MAX_BUFFER,
        env: process.env,
      });
      outputs.push(`## ${step.label}\n${tail(output, 1200) || "ok"}`);
    } catch (error) {
      const details = commandErrorOutput(error);
      outputs.push(`## ${step.label}\n${details}`);
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

function ensureCleanMainWorktree(): void {
  const status = runCommand("git", ["status", "--porcelain"], 10_000);
  if (status) {
    throw new Error(`Live repo is dirty. Refusing merge.\n${status}`);
  }
  runCommand("git", ["checkout", "main"], 10_000);
}

function mergeBranch(row: PlanExecutionRow): { preMergeSha: string; preMergeTag: string; mergedCommitSha: string } {
  const preMergeSha = runCommand("git", ["rev-parse", "HEAD"], 10_000);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const preMergeTag = `homer/pre-merge/${row.id}-${timestamp}`;

  runCommand("git", ["tag", "-f", preMergeTag, preMergeSha], 10_000);
  try {
    runCommand("git", ["merge", "--no-ff", "--no-edit", row.branch_name], 60_000);
  } catch (error) {
    try {
      runCommand("git", ["merge", "--abort"], 10_000);
    } catch {
      // Best effort; merge may not have started.
    }
    throw new Error(`Merge failed.\n${commandErrorOutput(error)}`);
  }

  return {
    preMergeSha,
    preMergeTag,
    mergedCommitSha: runCommand("git", ["rev-parse", "HEAD"], 10_000),
  };
}

function maybeCommitRepair(branchName: string): boolean {
  const status = runCommand("git", ["status", "--porcelain"], 10_000);
  if (!status) return false;
  runCommand("git", ["add", "-A"], 30_000);
  const shortBranch = branchName.replace(/^homer\/auto\//, "");
  runCommand("git", ["commit", "-m", `fix: post-merge auto-repair for ${shortBranch}`], 30_000);
  return true;
}

async function runRepairAttempt(
  row: PlanExecutionRow,
  failedStep: string,
  details: string
): Promise<{ changed: boolean; output: string }> {
  const prompt = `You are repairing a post-merge validation failure on the live Homer main branch.

Context:
- Repository: ${HOMER_DIR}
- Current branch: main
- Approved branch already merged: ${row.branch_name}
- Validation failed at: ${failedStep}

Failure details:
${details}

Instructions:
1. Read the relevant files and fix the repo-controlled problem.
2. You may modify any file in the repository.
3. Do NOT run git push, npm run deploy, npm run restart, launchctl, or edit credential files.
4. Do NOT create git commits. Homer will commit any repair changes.
5. Keep the fix scoped to getting validation green.

Return a short summary and the files you changed.`;

  const result = await executeClaudeCommand(prompt, {
    cwd: HOMER_DIR,
    model: "opus",
    timeout: 15 * 60 * 1000,
  });

  const changed = maybeCommitRepair(row.branch_name);
  return { changed, output: result.output };
}

function spawnRestartRunner(execId: number): void {
  const child = spawn(process.execPath, [RESTART_RUNNER, String(execId)], {
    cwd: HOMER_DIR,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOMER_DIR,
    },
  });
  child.unref();
}

function describeCurrentState(row: PlanExecutionRow): string {
  switch (row.integration_status) {
    case "merging":
    case "repairing":
    case "deploying":
      return "Already in progress";
    case "deployed":
      return "Already deployed";
    case "dismissed":
      return "Already dismissed";
    case "snoozed":
      return "Currently snoozed";
    case "failed":
      return "Already failed";
    default:
      return "Not ready to merge";
  }
}

export function createPlanExecutionReadyKeyboard(execId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Merge + Deploy", `a:pe:${execId}:merge_deploy`)
    .row()
    .text("Snooze 2h", `a:pe:${execId}:snooze`)
    .text("Dismiss", `a:pe:${execId}:dismiss`);
}

export async function sendPlanExecutionReadyMessage(params: {
  bot: Bot;
  stateManager: StateManager;
  execId: number;
}): Promise<void> {
  const { bot, stateManager, execId } = params;
  const row = loadExecution(stateManager, execId);
  if (!row || !row.chat_id) return;

  const message = await bot.api.sendMessage(
    row.chat_id,
    formatReadyMessage(row),
    {
      parse_mode: "HTML",
      reply_markup: createPlanExecutionReadyKeyboard(execId),
    }
  );

  updateExecution(stateManager, execId, {
    integration_status: "ready",
    deploy_status: "pending",
    ready_message_id: message.message_id,
    ready_notified_at: new Date().toISOString(),
    snooze_until: null,
    last_error: null,
    final_notified_at: null,
  });
}

export function snoozePlanExecution(params: {
  stateManager: StateManager;
  execId: number;
}): { ok: boolean; message: string; until?: Date } {
  const { stateManager, execId } = params;
  const row = loadExecution(stateManager, execId);
  if (!row) return { ok: false, message: "Plan execution not found" };
  if (row.integration_status !== "ready") {
    return { ok: false, message: describeCurrentState(row) };
  }

  const snoozeUntil = new Date(Date.now() + SNOOZE_MS);
  updateExecution(stateManager, execId, {
    integration_status: "snoozed",
    snooze_until: snoozeUntil.toISOString(),
  });

  return { ok: true, message: "Snoozed", until: snoozeUntil };
}

export function dismissPlanExecution(params: {
  stateManager: StateManager;
  execId: number;
}): { ok: boolean; message: string } {
  const { stateManager, execId } = params;
  const row = loadExecution(stateManager, execId);
  if (!row) return { ok: false, message: "Plan execution not found" };
  if (row.integration_status === "dismissed") {
    return { ok: false, message: "Already dismissed" };
  }
  if (row.integration_status && row.integration_status !== "ready" && row.integration_status !== "snoozed") {
    return { ok: false, message: describeCurrentState(row) };
  }

  updateExecution(stateManager, execId, {
    integration_status: "dismissed",
    final_notified_at: new Date().toISOString(),
  });

  return { ok: true, message: "Dismissed" };
}

export async function mergeAndDeployPlanExecution(params: {
  bot: Bot;
  stateManager: StateManager;
  execId: number;
}): Promise<{ ok: boolean; message: string }> {
  const { bot, stateManager, execId } = params;
  const db = stateManager.getDb();

  const gate = db.transaction((id: number) => {
    const row = loadExecution(stateManager, id);
    if (!row) return { ok: false, reason: "Plan execution not found" };
    if (row.status !== "success" || row.integration_status !== "ready") {
      return { ok: false, reason: describeCurrentState(row) };
    }

    const active = db.prepare(`
      SELECT id
      FROM plan_executions
      WHERE id != ?
        AND integration_status IN ('merging', 'repairing', 'deploying')
      LIMIT 1
    `).get(id) as { id: number } | undefined;
    if (active) {
      return { ok: false, reason: `Another merge/deploy is already running (exec ${active.id})` };
    }

    updateExecution(stateManager, id, {
      integration_status: "merging",
      snooze_until: null,
      last_error: null,
      final_notified_at: null,
    });
    return { ok: true };
  });

  const gateResult = gate(execId);
  if (!gateResult.ok) {
    return { ok: false, message: gateResult.reason ?? "Merge + deploy not available" };
  }

  let row = loadExecution(stateManager, execId);
  if (!row) return { ok: false, message: "Plan execution not found" };

  await editMessage(
    bot,
    row,
    `🔄 <b>Merging on main...</b>\n<b>Branch:</b> <code>${escapeHtml(row.branch_name)}</code>`
  );

  try {
    ensureCleanMainWorktree();
    const mergeResult = mergeBranch(row);
    updateExecution(stateManager, execId, {
      pre_merge_sha: mergeResult.preMergeSha,
      pre_merge_tag: mergeResult.preMergeTag,
      merged_commit_sha: mergeResult.mergedCommitSha,
      merged_at: new Date().toISOString(),
    });

    row = loadExecution(stateManager, execId) ?? row;
    await editMessage(
      bot,
      row,
      `🧪 <b>Merged into main. Running validation...</b>\n` +
      `<b>Branch:</b> <code>${escapeHtml(row.branch_name)}</code>\n` +
      `<b>Commit:</b> <code>${escapeHtml(mergeResult.mergedCommitSha)}</code>`
    );

    let validation = runValidation();
    let repairs = 0;

    while (!validation.success && repairs < REPAIR_ATTEMPT_LIMIT) {
      repairs += 1;
      updateExecution(stateManager, execId, {
        integration_status: "repairing",
        repair_attempts: repairs,
        last_error: validation.details.slice(-4000),
      });
      row = loadExecution(stateManager, execId) ?? row;

      await editMessage(
        bot,
        row,
        `🛠️ <b>Validation failed. Claude Opus repairing live main...</b>\n` +
        `<b>Attempt:</b> ${repairs}/${REPAIR_ATTEMPT_LIMIT}\n` +
        `<b>Failed Step:</b> ${escapeHtml(validation.failedStep || "unknown")}`
      );

      const repair = await runRepairAttempt(row, validation.failedStep || "unknown", validation.details);
      const headAfterRepair = runCommand("git", ["rev-parse", "HEAD"], 10_000);
      updateExecution(stateManager, execId, {
        merged_commit_sha: headAfterRepair,
        repair_attempts: repairs,
        last_error: repair.changed ? null : validation.details.slice(-4000),
      });

      validation = runValidation();
      if (!repair.changed && !validation.success) {
        break;
      }
    }

    if (!validation.success) {
      updateExecution(stateManager, execId, {
        integration_status: "failed",
        deploy_status: "failed",
        last_error: validation.details.slice(-4000),
        final_notified_at: new Date().toISOString(),
      });
      row = loadExecution(stateManager, execId) ?? row;
      const failureMessage = formatFinalMessage(row, "❌ <b>Merge/deploy stopped before restart.</b>");
      await editMessage(bot, row, failureMessage);
      return { ok: false, message: "Validation failed" };
    }

    const mergedCommitSha = runCommand("git", ["rev-parse", "HEAD"], 10_000);
    updateExecution(stateManager, execId, {
      integration_status: "deploying",
      deploy_status: "restarting",
      merged_commit_sha: mergedCommitSha,
      deploy_started_at: new Date().toISOString(),
      last_error: null,
    });
    row = loadExecution(stateManager, execId) ?? row;

    await editMessage(
      bot,
      row,
      `🚀 <b>Merged and validated. Restarting daemon...</b>\n` +
      `<b>Branch:</b> <code>${escapeHtml(row.branch_name)}</code>\n` +
      `<b>Commit:</b> <code>${escapeHtml(mergedCommitSha)}</code>\n` +
      `<b>Repairs:</b> ${repairs}\n` +
      `<i>Final deploy status will follow after restart.</i>`
    );

    spawnRestartRunner(execId);
    return { ok: true, message: "Merge + deploy started" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateExecution(stateManager, execId, {
      integration_status: "failed",
      deploy_status: "failed",
      last_error: message.slice(-4000),
      final_notified_at: new Date().toISOString(),
    });
    row = loadExecution(stateManager, execId) ?? row;
    const failureMessage = formatFinalMessage(row, "❌ <b>Merge/deploy stopped.</b>");
    await editMessage(bot, row, failureMessage);
    await sendMessage(bot, row, `❌ <b>Merge/deploy stopped.</b>\n<pre>${escapeHtml(message.slice(-2000))}</pre>`);
    return { ok: false, message };
  }
}

function markRestartedRowsDeployed(stateManager: StateManager): number {
  const restartingRows = stateManager.getDb().prepare(`
    SELECT id, merged_commit_sha
    FROM plan_executions
    WHERE deploy_status = 'restarting'
      AND deploy_started_at IS NOT NULL
      AND julianday(deploy_started_at) <= julianday('now', '-2 minutes')
  `).all() as Array<{ id: number; merged_commit_sha: string | null }>;

  if (restartingRows.length === 0) return 0;
  const currentHead = safeGitSha("HEAD");
  if (!currentHead) return 0;

  let marked = 0;
  for (const row of restartingRows) {
    if (!row.merged_commit_sha) continue;
    const shortMerged = row.merged_commit_sha.slice(0, currentHead.length);
    if (shortMerged !== currentHead) continue;
    updateExecution(stateManager, row.id, {
      integration_status: "deployed",
      deploy_status: "deployed",
      deployed_at: new Date().toISOString(),
      last_error: null,
    });
    marked += 1;
  }
  return marked;
}

export async function processPlanExecutionFollowups(params: {
  bot: Bot;
  chatId: number;
  stateManager: StateManager;
}): Promise<{ resurfaced: number; finalized: number }> {
  const { bot, chatId, stateManager } = params;
  const db = stateManager.getDb();

  markRestartedRowsDeployed(stateManager);

  const snoozedRows = db.prepare(`
    SELECT id
    FROM plan_executions
    WHERE integration_status = 'snoozed'
      AND snooze_until IS NOT NULL
      AND julianday(snooze_until) <= julianday('now')
  `).all() as Array<{ id: number }>;

  let resurfaced = 0;
  for (const row of snoozedRows) {
    updateExecution(stateManager, row.id, {
      integration_status: "ready",
      snooze_until: null,
      final_notified_at: null,
    });
    await sendPlanExecutionReadyMessage({ bot, stateManager, execId: row.id });
    resurfaced += 1;
  }

  const finalRows = db.prepare(`
    SELECT
      id,
      job_id,
      branch_name,
      status,
      summary_text,
      diff_summary,
      files_changed,
      chat_id,
      integration_status,
      deploy_status,
      snooze_until,
      ready_message_id,
      ready_notified_at,
      pre_merge_sha,
      pre_merge_tag,
      merged_commit_sha,
      merged_at,
      deploy_started_at,
      deployed_at,
      repair_attempts,
      last_error,
      final_notified_at
    FROM plan_executions
    WHERE chat_id = ?
      AND final_notified_at IS NULL
      AND deploy_status IN ('deployed', 'failed')
    ORDER BY id ASC
  `).all(chatId) as PlanExecutionRow[];

  let finalized = 0;
  for (const row of finalRows) {
    const message = row.deploy_status === "deployed"
      ? formatFinalMessage(row, "✅ <b>Merged and deployed.</b>")
      : formatFinalMessage(row, "❌ <b>Merge/deploy stopped.</b>");

    await sendMessage(bot, row, message);
    updateExecution(stateManager, row.id, {
      final_notified_at: new Date().toISOString(),
    });
    finalized += 1;
  }

  return { resurfaced, finalized };
}
