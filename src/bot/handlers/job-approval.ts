/**
 * Job approval handler — Telegram inline buttons for job queue.
 * Pattern: one-at-a-time queue, Approve/Hold/Deny buttons.
 * Callback format: a:j:<jobId>:<action>
 */

import { Bot, InlineKeyboard } from "grammy";
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";

const MAX_APPROVALS_PER_DAY = 5;

interface QueuedJob {
  queue_id: string;
  job_id: string;
  title: string;
  company: string;
  location: string;
  match_score: number;
  match_summary: string;
  salary_range: string;
  url: string;
}

function getDailyApprovalCount(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM approval_queue WHERE decision = 'approved' AND decided_at >= date('now') AND decided_at < date('now', '+1 day')"
  ).get() as { c: number };
  return row.c;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function createJobKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Approve", `a:j:${jobId}:approve`)
    .text("Hold", `a:j:${jobId}:hold`)
    .text("Deny", `a:j:${jobId}:deny`);
}

function formatJobForTelegram(job: QueuedJob, queueSize?: number): string {
  const score = (job.match_score * 100).toFixed(0);
  const title = escapeHtml(job.title);
  const company = escapeHtml(job.company);
  const location = escapeHtml(job.location || "Not specified");
  const salary = job.salary_range ? escapeHtml(job.salary_range) : "Not listed";

  const queueLabel = queueSize ? ` (1 of ${queueSize})` : "";
  let msg = `<b>Job Match (${score}%)${queueLabel}</b>\n\n`;
  msg += `<b>${title}</b>\n`;
  msg += `${company} | ${location}\n`;
  msg += `Salary: ${salary}\n\n`;

  if (job.match_summary) {
    // Show abbreviated match info
    const parts = job.match_summary.split(" | ").slice(1, 5);
    msg += parts.map((p) => `  ${escapeHtml(p)}`).join("\n");
    msg += "\n";
  }

  if (job.url) {
    msg += `\n<a href="${escapeHtml(job.url)}">View on LinkedIn</a>`;
  }

  return msg;
}

/**
 * Send next pending job for approval (one at a time).
 */
export async function sendNextJobForApproval(
  bot: Bot,
  chatId: number,
  db: Database.Database
): Promise<boolean> {
  const dailyCount = getDailyApprovalCount(db);
  if (dailyCount >= MAX_APPROVALS_PER_DAY) {
    logger.info({ count: dailyCount }, "Daily job approval limit reached");
    return false;
  }

  // Check if there's already a pending approval message (one at a time)
  const activePending = db.prepare(`
    SELECT 1 FROM approval_queue
    WHERE decision = 'pending' AND telegram_message_id IS NOT NULL
    LIMIT 1
  `).get();
  if (activePending) {
    logger.info("Already have an active approval message, skipping");
    return false;
  }

  // Get next queued job by priority (highest score first)
  const next = db.prepare(`
    SELECT aq.id as queue_id, aq.job_id, jp.title, jp.company, jp.location,
           aq.match_score, aq.match_summary, aq.salary_range, jp.url
    FROM approval_queue aq
    JOIN job_postings jp ON aq.job_id = jp.id
    WHERE aq.decision = 'pending' AND aq.telegram_message_id IS NULL
    ORDER BY aq.match_score DESC
    LIMIT 1
  `).get() as QueuedJob | undefined;

  if (!next) {
    return false;
  }

  // Get queue position info
  const pendingTotal = (db.prepare(
    "SELECT COUNT(*) as c FROM approval_queue WHERE decision = 'pending'"
  ).get() as { c: number }).c;

  const message = formatJobForTelegram(next, pendingTotal);
  const keyboard = createJobKeyboard(next.job_id);

  try {
    const sent = await bot.api.sendMessage(chatId, message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    // Record the telegram message ID
    db.prepare(`
      UPDATE approval_queue SET telegram_message_id = ?, telegram_chat_id = ?
      WHERE id = ?
    `).run(sent.message_id, chatId, next.queue_id);

    logger.info({ jobId: next.job_id, company: next.company, score: next.match_score }, "Sent job for approval");
    return true;
  } catch (error) {
    logger.error({ error, jobId: next.job_id }, "Failed to send job approval");
    return false;
  }
}

/**
 * Expire stale approvals (> 72 hours with no decision).
 */
export function expireStaleApprovals(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE approval_queue
    SET decision = 'expired', auto_expired = 1, decided_at = datetime('now')
    WHERE decision = 'pending'
      AND datetime(queued_at, '+' || expiry_hours || ' hours') < datetime('now')
  `).run();
  return result.changes;
}

/**
 * Get held jobs ready to resurface (held > 3 days ago).
 */
export function getHeldJobsToResurface(db: Database.Database): QueuedJob[] {
  return db.prepare(`
    SELECT aq.id as queue_id, aq.job_id, jp.title, jp.company, jp.location,
           aq.match_score, aq.match_summary, aq.salary_range, jp.url
    FROM approval_queue aq
    JOIN job_postings jp ON aq.job_id = jp.id
    WHERE aq.decision = 'hold'
      AND datetime(aq.decided_at, '+3 days') <= datetime('now')
  `).all() as QueuedJob[];
}

/**
 * Register job approval callback handlers on the bot.
 */
export function registerJobApprovalHandlers(bot: Bot, stateManager: StateManager): void {
  const db = stateManager.getDb();

  // Approve
  bot.callbackQuery(/^a:j:([^:]+):approve$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) { await ctx.answerCallbackQuery("Invalid"); return; }

    try {
      // Update approval_queue
      db.prepare(`
        UPDATE approval_queue SET decision = 'approved', decided_at = datetime('now')
        WHERE job_id = ? AND decision = 'pending'
      `).run(jobId);

      // Update job_postings status
      db.prepare("UPDATE job_postings SET status = 'approved' WHERE id = ?").run(jobId);

      const job = db.prepare("SELECT title, company FROM job_postings WHERE id = ?").get(jobId) as { title: string; company: string } | undefined;
      const label = job ? `${job.company} - ${job.title}` : jobId;

      await ctx.editMessageText(
        `<b>Approved:</b> ${escapeHtml(label)}\n\n<em>Queued for resume optimization...</em>`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery("Approved!");

      // Send next job for approval
      await sendNextJobForApproval(bot, ctx.chat!.id, db);
    } catch (error) {
      logger.error({ error, jobId }, "Failed to approve job");
      await ctx.answerCallbackQuery("Error approving");
    }
  });

  // Hold
  bot.callbackQuery(/^a:j:([^:]+):hold$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) { await ctx.answerCallbackQuery("Invalid"); return; }

    try {
      db.prepare(`
        UPDATE approval_queue SET decision = 'hold', decided_at = datetime('now')
        WHERE job_id = ? AND decision = 'pending'
      `).run(jobId);

      const job = db.prepare("SELECT title, company FROM job_postings WHERE id = ?").get(jobId) as { title: string; company: string } | undefined;
      const label = job ? `${job.company} - ${job.title}` : jobId;

      await ctx.editMessageText(
        `<b>On hold:</b> ${escapeHtml(label)}\n<em>Will resurface in 3 days.</em>`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery("Held");

      await sendNextJobForApproval(bot, ctx.chat!.id, db);
    } catch (error) {
      logger.error({ error, jobId }, "Failed to hold job");
      await ctx.answerCallbackQuery("Error");
    }
  });

  // Deny
  bot.callbackQuery(/^a:j:([^:]+):deny$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) { await ctx.answerCallbackQuery("Invalid"); return; }

    try {
      db.prepare(`
        UPDATE approval_queue SET decision = 'denied', decided_at = datetime('now')
        WHERE job_id = ? AND decision = 'pending'
      `).run(jobId);

      db.prepare("UPDATE job_postings SET status = 'rejected' WHERE id = ?").run(jobId);

      const job = db.prepare("SELECT title, company FROM job_postings WHERE id = ?").get(jobId) as { title: string; company: string } | undefined;
      const label = job ? `${job.company} - ${job.title}` : jobId;

      await ctx.editMessageText(
        `<b>Denied:</b> ${escapeHtml(label)}`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery("Denied");

      await sendNextJobForApproval(bot, ctx.chat!.id, db);
    } catch (error) {
      logger.error({ error, jobId }, "Failed to deny job");
      await ctx.answerCallbackQuery("Error");
    }
  });

  logger.info("Job approval handlers registered");
}
