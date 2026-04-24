/**
 * Outcome Tracker — weekly job that checks whether past decisions led to outcomes.
 *
 * Flow:
 * 1. Query pending outcome_checks where check_at <= now
 * 2. For each, use Codex GPT-5.4 to check for evidence of outcome
 * 3. Auto-resolve when evidence is clear; send to Telegram when ambiguous
 */

// @ts-ignore
import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { z } from "zod";
import { executeCodexCLI } from "../../executors/codex-cli.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import {
  formatScheduledTelegramHtml,
  routeTelegramNotification,
} from "../../notifications/telegram-router.js";
import { logger } from "../../utils/logger.js";
import { escapeHtml } from "../../utils/telegram-format.js";

interface OutcomeCheck {
  id: string;
  source_type: string;
  source_id: string;
  source_title: string;
  created_at: string;
  check_at: string;
}

const EvidenceResultSchema = z.object({
  outcome: z.enum(["yes", "no", "partial", "ambiguous"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

type EvidenceResult = z.infer<typeof EvidenceResultSchema>;


function createOutcomeKeyboard(checkId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Yes", `a:oc:${checkId}:yes`)
    .text("No", `a:oc:${checkId}:no`)
    .text("Partial", `a:oc:${checkId}:partial`)
    .text("Skip", `a:oc:${checkId}:skip`);
}

async function gatherEvidence(db: Database.Database, check: OutcomeCheck): Promise<string> {
  const evidence: string[] = [];

  if (check.source_type === "idea") {
    // Check if idea status changed
    try {
      const { loadIdeasFromDir } = await import("../../ideas/parser.js");
      const ideas = loadIdeasFromDir();
      const idea = ideas.find(i => i.id === check.source_id || i.title === check.source_title);
      if (idea) {
        evidence.push(`Idea status: ${idea.status}`);
        if (idea.notes) evidence.push(`Notes: ${idea.notes}`);
      }
    } catch { /* ideas dir may not exist */ }
  }

  if (check.source_type === "application") {
    // Check application status in job_hunt DB
    try {
      const app = db.prepare(`
        SELECT a.status, a.updated_at, jp.company, jp.title
        FROM applications a JOIN job_postings jp ON a.job_id = jp.id
        WHERE a.job_id = ? OR jp.title LIKE ?
      `).get(check.source_id, `%${check.source_title.slice(0, 30)}%`) as {
        status: string; updated_at: string; company: string; title: string;
      } | undefined;

      if (app) {
        evidence.push(`Application status: ${app.status} (updated: ${app.updated_at})`);
      }
    } catch { /* job tables may not exist */ }
  }

  if (check.source_type === "promotion") {
    // Check if the promoted fact was referenced in recent sessions
    try {
      const refs = db.prepare(`
        SELECT COUNT(*) as count FROM session_summaries
        WHERE summary LIKE ? AND julianday(started_at) > julianday(?)
      `).get(`%${check.source_title.slice(0, 40)}%`, check.created_at) as { count: number };

      evidence.push(`Referenced in ${refs.count} session(s) since promotion`);
    } catch { /* session_summaries may not exist */ }
  }

  if (check.source_type === "improvement") {
    // Check if improvement was implemented (look in session summaries)
    try {
      const refs = db.prepare(`
        SELECT COUNT(*) as count FROM session_summaries
        WHERE summary LIKE ? AND julianday(started_at) > julianday(?)
      `).get(`%${check.source_title.slice(0, 40)}%`, check.created_at) as { count: number };

      evidence.push(`Mentioned in ${refs.count} session(s) since proposal`);
    } catch { /* */ }
  }

  // Always check session summaries for general references
  try {
    const mentions = db.prepare(`
      SELECT title, summary, started_at FROM session_summaries
      WHERE (summary LIKE ? OR title LIKE ?)
        AND julianday(started_at) > julianday(?)
      ORDER BY started_at DESC LIMIT 3
    `).all(
      `%${check.source_title.slice(0, 30)}%`,
      `%${check.source_title.slice(0, 30)}%`,
      check.created_at
    ) as Array<{ title: string; summary: string; started_at: string }>;

    if (mentions.length > 0) {
      evidence.push(`Session mentions:`);
      for (const m of mentions) {
        evidence.push(`  - [${m.started_at.slice(0, 10)}] ${m.title}: ${(m.summary || "").slice(0, 100)}`);
      }
    }
  } catch { /* */ }

  return evidence.join("\n") || "No direct evidence found.";
}

async function evaluateOutcome(check: OutcomeCheck, evidence: string, signal?: AbortSignal): Promise<EvidenceResult> {
  const prompt = `You are checking whether a past decision led to an outcome.

Item: ${check.source_title}
Type: ${check.source_type}
Created: ${check.created_at}
Evidence gathered:
${evidence}

Based on the evidence, determine the outcome:
- "yes" = clear positive outcome/progress
- "no" = no progress, abandoned, or negative outcome
- "partial" = some progress but incomplete
- "ambiguous" = not enough evidence to determine

Return JSON: { "outcome": "yes|no|partial|ambiguous", "confidence": 0.0-1.0, "evidence": "one sentence summary" }`;

  try {
    const result = await executeCodexCLI(
      prompt + "\n\nReturn ONLY valid JSON, no markdown fences.",
      { cwd: process.env.HOME ?? "/Users/yj", model: "gpt-5.5", reasoningEffort: "high", timeout: 120_000, signal },
    );

    if (result.exitCode === 0 && result.output) {
      return parseSwarmJSON(result.output, EvidenceResultSchema);
    }
  } catch (err) {
    logger.warn({ error: err, checkId: check.id }, "Failed to evaluate outcome with LLM");
  }

  return { outcome: "ambiguous", confidence: 0, evidence: "LLM evaluation failed" };
}

export async function runOutcomeTracker(
  db: Database.Database,
  bot?: Bot,
  chatId?: number,
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  output: string;
  error?: string;
  autoResolved: number;
  sentToTelegram: number;
  errors: number;
}> {
  try {
    // Auto-expire stale pending checks (>14 days past due)
    const expired = db.prepare(`
      UPDATE outcome_checks
      SET status = 'skipped', outcome_notes = 'auto-expired: pending >14 days past due', checked_at = datetime('now')
      WHERE status = 'pending' AND check_at < datetime('now', '-14 days')
    `).run();
    if (expired.changes > 0) {
      logger.info({ count: expired.changes }, "Auto-expired stale outcome checks (>14 days past due)");
    }

    // Get due outcome checks (up to 5)
    const dueChecks = db.prepare(`
      SELECT id, source_type, source_id, source_title, created_at, check_at
      FROM outcome_checks
      WHERE status = 'pending' AND check_at <= datetime('now')
      ORDER BY check_at ASC LIMIT 5
    `).all() as OutcomeCheck[];

    if (dueChecks.length === 0) {
      return {
        success: true,
        output: "No outcome checks due",
        autoResolved: 0,
        sentToTelegram: 0,
        errors: 0,
      };
    }

    let autoResolved = 0;
    let sentToTelegram = 0;
    let errors = 0;

    for (const check of dueChecks) {
      if (signal?.aborted) {
        logger.info("Outcome tracker aborted by signal");
        break;
      }
      try {
        const evidence = await gatherEvidence(db, check);
        const result = await evaluateOutcome(check, evidence, signal);

        if (result.outcome !== "ambiguous" && result.confidence >= 0.7) {
          // Auto-resolve
          db.prepare(`
            UPDATE outcome_checks
            SET status = 'checked', outcome = ?, outcome_notes = ?, checked_at = datetime('now')
            WHERE id = ?
          `).run(result.outcome, result.evidence, check.id);
          autoResolved++;

          logger.info({
            checkId: check.id,
            outcome: result.outcome,
            confidence: result.confidence,
          }, "Outcome auto-resolved");
        } else if (bot && chatId) {
          // Send to Telegram for human decision
          const msg = `<b>Outcome Check</b>\n\n` +
            `<b>Type:</b> ${escapeHtml(check.source_type)}\n` +
            `<b>Item:</b> ${escapeHtml(check.source_title)}\n` +
            `<b>Created:</b> ${check.created_at.slice(0, 10)}\n\n` +
            `<b>Evidence:</b>\n${escapeHtml(result.evidence)}\n\n` +
            `Did this lead to a positive outcome?`;
          const formattedMessage = formatScheduledTelegramHtml(msg);

          try {
            const delivery = await routeTelegramNotification({
              db,
              sourceType: "job_handler",
              sourceId: `outcome_check:${check.id}`,
              intent: "decision_request",
              title: check.source_title,
              messageText: formattedMessage,
              metadata: {
                outcomeCheckId: check.id,
                sourceType: check.source_type,
                sourceId: check.source_id,
              },
              deliver: async () => bot.api.sendMessage(chatId, formattedMessage, {
                parse_mode: "HTML",
                reply_markup: createOutcomeKeyboard(check.id),
              }),
            });
            if (delivery.decision === "sent") {
              sentToTelegram++;
            }
          } catch (err) {
            logger.warn({ error: err, checkId: check.id }, "Failed to send outcome check to Telegram");
            errors++;
          }
        } else {
          // No bot available, skip for now
          logger.info({ checkId: check.id }, "Outcome check ambiguous, no bot available to send");
        }
      } catch (err) {
        logger.error({ error: err, checkId: check.id }, "Error processing outcome check");
        errors++;
      }
    }

    const parts: string[] = [];
    if (autoResolved > 0) parts.push(`${autoResolved} auto-resolved`);
    if (sentToTelegram > 0) parts.push(`${sentToTelegram} sent to Telegram`);
    if (errors > 0) parts.push(`${errors} errors`);

    return {
      success: true,
      output: `${dueChecks.length} checks processed: ${parts.join(", ") || "none actionable"}`,
      autoResolved,
      sentToTelegram,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: "",
      error: message,
      autoResolved: 0,
      sentToTelegram: 0,
      errors: 1,
    };
  }
}
