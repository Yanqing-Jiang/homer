/**
 * Job hunt Telegram commands:
 *   /job_status  — pipeline summary
 *   /job_queue   — show next 5 pending approvals
 *   /job_search  — manually trigger discovery
 *   /job_pause   — disable all job-hunt jobs
 *   /job_resume  — re-enable all job-hunt jobs
 *   /job_report  — generate weekly report now
 */

import type { Bot } from "grammy";
import type { StateManager } from "../../state/manager.js";
import type { Scheduler } from "../../scheduler/index.js";
import { logger } from "../../utils/logger.js";
import { escapeHtml } from "../../utils/telegram-format.js";


let schedulerRef: Scheduler | null = null;

export function setJobScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

export function registerJobCommands(bot: Bot, stateManager: StateManager): void {
  const db = stateManager.getDb();

  // /job_status — pipeline summary
  bot.command("job_status", async (ctx) => {
    try {
      const counts = db.prepare(`
        SELECT status, COUNT(*) as c FROM job_postings GROUP BY status
      `).all() as Array<{ status: string; c: number }>;

      const appCounts = db.prepare(`
        SELECT status, COUNT(*) as c FROM applications GROUP BY status
      `).all() as Array<{ status: string; c: number }>;

      const pendingApprovals = (db.prepare(
        "SELECT COUNT(*) as c FROM approval_queue WHERE decision = 'pending'"
      ).get() as { c: number }).c;

      // Today's applied count
      const todayApplied = (db.prepare(
        "SELECT COUNT(*) as c FROM applications WHERE status = 'application_submitted' AND updated_at >= date('now') AND updated_at < date('now', '+1 day')"
      ).get() as { c: number }).c;

      let msg = "<b>Job Hunt Pipeline</b>\n\n";

      msg += "<b>Job Postings:</b>\n";
      const statusMap = Object.fromEntries(counts.map((r) => [r.status, r.c]));
      const total = counts.reduce((sum, r) => sum + r.c, 0);
      msg += `  Total: ${total}\n`;
      for (const [status, count] of Object.entries(statusMap)) {
        msg += `  ${escapeHtml(status)}: ${count}\n`;
      }

      if (appCounts.length > 0) {
        msg += "\n<b>Applications:</b>\n";
        for (const row of appCounts) {
          msg += `  ${escapeHtml(row.status)}: ${row.c}\n`;
        }
      }

      msg += `\n<b>Pending in queue:</b> ${pendingApprovals}`;
      msg += `\n<b>Applied today:</b> ${todayApplied}`;

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (error) {
      logger.error({ error }, "job_status failed");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // /job_queue — show next 5 pending jobs
  bot.command("job_queue", async (ctx) => {
    try {
      const queue = db.prepare(`
        SELECT aq.match_score, jp.title, jp.company, jp.location,
               jp.work_arrangement, jp.application_type
        FROM approval_queue aq
        JOIN job_postings jp ON aq.job_id = jp.id
        WHERE aq.decision = 'pending'
        ORDER BY aq.match_score DESC
        LIMIT 5
      `).all() as Array<{ match_score: number; title: string; company: string; location: string; work_arrangement: string | null; application_type: string | null }>;

      if (queue.length === 0) {
        await ctx.reply("No pending jobs in queue.");
        return;
      }

      let msg = "<b>Apply Queue</b> (top 5)\n\n";
      for (let i = 0; i < queue.length; i++) {
        const j = queue[i]!;
        const score = (j.match_score * 100).toFixed(0);
        const arr = j.work_arrangement ? ` [${j.work_arrangement}]` : "";
        const method = j.application_type === "easy_apply" ? " \u{26A1}" : " \u{1F310}";
        msg += `${i + 1}. <b>${escapeHtml(j.company)}</b> — ${escapeHtml(j.title)}\n`;
        msg += `   ${escapeHtml(j.location || "?")}${arr}${method} | ${score}%\n\n`;
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (error) {
      logger.error({ error }, "job_queue failed");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // /job_search — manually trigger discovery
  bot.command("job_search", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }
    const triggered = schedulerRef.triggerJob("job-hunt-discover");
    if (triggered) {
      await ctx.reply("Job discovery triggered. You'll be notified when complete.");
    } else {
      await ctx.reply("Failed to trigger job discovery. Check if job is registered.");
    }
  });

  // /job_pause — disable all job-hunt jobs via DB flag
  bot.command("job_pause", async (ctx) => {
    try {
      db.prepare(`
        INSERT INTO circuit_breaker_state (name, state, failure_count)
        VALUES ('job_hunt_global', 'open', 0)
        ON CONFLICT(name) DO UPDATE SET state = 'open', opened_at = datetime('now')
      `).run();
      await ctx.reply("Job hunt paused. All job-hunt handlers will skip until /job_resume.");
    } catch (error) {
      logger.error({ error }, "job_pause failed");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // /job_resume — re-enable all job-hunt jobs
  bot.command("job_resume", async (ctx) => {
    try {
      db.prepare(`
        UPDATE circuit_breaker_state SET state = 'closed', failure_count = 0, opened_at = NULL
        WHERE name = 'job_hunt_global'
      `).run();
      await ctx.reply("Job hunt resumed. Handlers will run on their normal schedule.");
    } catch (error) {
      logger.error({ error }, "job_resume failed");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // /job_report — generate weekly report now
  bot.command("job_report", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }
    const triggered = schedulerRef.triggerJob("job-hunt-weekly-report");
    if (triggered) {
      await ctx.reply("Weekly report triggered. You'll receive it shortly.");
    } else {
      await ctx.reply("Failed to trigger report. Check if job is registered.");
    }
  });

  // Follow-up draft callbacks: a:fu:<draftId>:send/edit/discard
  bot.callbackQuery(/^a:fu:([^:]+):send$/, async (ctx) => {
    const draftId = ctx.match?.[1];
    if (!draftId) { await ctx.answerCallbackQuery("Invalid"); return; }
    try {
      const draft = db.prepare(
        "SELECT id, to_addr, subject, body_preview, job_id FROM email_log WHERE id = ? AND status = 'draft'"
      ).get(draftId) as { id: string; to_addr: string; subject: string; body_preview: string; job_id: string } | undefined;
      if (!draft) { await ctx.answerCallbackQuery("Draft not found"); return; }
      if (!draft.to_addr) {
        await ctx.answerCallbackQuery("No recipient email — edit to add one");
        return;
      }
      // Import gmail client and send
      const { sendEmail } = await import("../../job-hunt/gmail-client.js");
      await sendEmail(draft.to_addr, draft.subject, draft.body_preview);
      db.prepare("UPDATE email_log SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(draftId);
      await ctx.editMessageText(`<b>Sent:</b> ${escapeHtml(draft.subject)}\nTo: ${escapeHtml(draft.to_addr)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery("Sent!");
    } catch (error) {
      logger.error({ error, draftId }, "Failed to send follow-up");
      await ctx.answerCallbackQuery("Send failed");
    }
  });

  bot.callbackQuery(/^a:fu:([^:]+):edit$/, async (ctx) => {
    const draftId = ctx.match?.[1];
    if (!draftId) { await ctx.answerCallbackQuery("Invalid"); return; }
    try {
      db.prepare("UPDATE email_log SET status = 'editing' WHERE id = ?").run(draftId);
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text + "\n\n<em>Marked for editing — reply to this message with the corrected text.</em>",
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery("Edit mode");
    } catch (error) {
      logger.error({ error, draftId }, "Failed to mark follow-up for edit");
      await ctx.answerCallbackQuery("Error");
    }
  });

  bot.callbackQuery(/^a:fu:([^:]+):discard$/, async (ctx) => {
    const draftId = ctx.match?.[1];
    if (!draftId) { await ctx.answerCallbackQuery("Invalid"); return; }
    try {
      db.prepare("UPDATE email_log SET status = 'discarded' WHERE id = ?").run(draftId);
      await ctx.editMessageText("<b>Discarded</b> follow-up draft.", { parse_mode: "HTML" });
      await ctx.answerCallbackQuery("Discarded");
    } catch (error) {
      logger.error({ error, draftId }, "Failed to discard follow-up");
      await ctx.answerCallbackQuery("Error");
    }
  });

  logger.info("Job commands registered");
}
