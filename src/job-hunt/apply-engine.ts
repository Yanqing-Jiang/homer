/**
 * Application engine core — orchestrates auto-apply methods,
 * records steps, sends Telegram FYI notifications.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import { linkedInEasyApply } from "./apply-linkedin.js";
import { careerSiteApply } from "./apply-career-site.js";
import { optimizeResume, getBaseResumePath } from "./resume-optimizer.js";
import { generateCoverLetter } from "./cover-letter.js";
import { validateOptimizedResume } from "./resume-validator.js";
import { readFileSync } from "fs";
import { logger } from "../utils/logger.js";
import { trackApplicationSubmitted } from "../outcomes/hooks.js";

export interface ApplyResult {
  success: boolean;
  confirmationNumber?: string;
  confirmationScreenshot?: string;
  steps: ApplicationStep[];
  error?: string;
  escalation?: EscalationType;
}

export interface ApplicationStep {
  stepNumber: number;
  stepType: string;
  stepStatus: "completed" | "failed" | "skipped";
  durationMs?: number;
  pageUrl?: string;
  screenshotPath?: string;
  formData?: Record<string, any>;
  error?: string;
}

export type EscalationType = "captcha" | "unknown_field" | "account_locked" | "mfa_required" | "form_changed";

const DAILY_LIMIT_EASY_APPLY = 10;
const DAILY_LIMIT_CAREER_SITE = 5;

export class ApplyEngine {
  constructor(
    private db: Database.Database,
    private bot: Bot,
    private chatId: number
  ) {}

  async applyToJob(
    jobId: string,
    method: "linkedin_easy" | "career_site"
  ): Promise<ApplyResult> {
    const job = this.db.prepare(
      "SELECT * FROM job_postings WHERE id = ?"
    ).get(jobId) as any;
    if (!job) return { success: false, steps: [], error: "Job not found" };

    let app = this.db.prepare(
      "SELECT * FROM applications WHERE job_id = ?"
    ).get(jobId) as any;

    // Create application record if doesn't exist
    if (!app) {
      const appId = createHash("sha256")
        .update(`${jobId}${Date.now()}`)
        .digest("hex")
        .slice(0, 12);
      this.db.prepare(`
        INSERT INTO applications (id, job_id, status, updated_at)
        VALUES (?, ?, 'applying', datetime('now'))
      `).run(appId, jobId);
      app = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(appId) as any;
    }

    // Check daily limits
    const todayEasy = (this.db.prepare(`
      SELECT COUNT(*) as c FROM applications a
      JOIN job_postings jp ON a.job_id = jp.id
      WHERE a.status = 'application_submitted'
        AND a.updated_at >= date('now') AND a.updated_at < date('now', '+1 day')
        AND jp.application_type = 'easy_apply'
    `).get() as { c: number }).c;

    const todayCareer = (this.db.prepare(`
      SELECT COUNT(*) as c FROM applications a
      JOIN job_postings jp ON a.job_id = jp.id
      WHERE a.status = 'application_submitted'
        AND a.updated_at >= date('now') AND a.updated_at < date('now', '+1 day')
        AND (jp.application_type = 'external' OR jp.application_type IS NULL)
    `).get() as { c: number }).c;

    if (method === "linkedin_easy" && todayEasy >= DAILY_LIMIT_EASY_APPLY) {
      return { success: false, steps: [], error: `Daily Easy Apply limit (${DAILY_LIMIT_EASY_APPLY}) reached` };
    }
    if (method === "career_site" && todayCareer >= DAILY_LIMIT_CAREER_SITE) {
      return { success: false, steps: [], error: `Daily career site limit (${DAILY_LIMIT_CAREER_SITE}) reached` };
    }

    // Update status to applying
    this.db.prepare("UPDATE applications SET status = 'applying', updated_at = datetime('now') WHERE id = ?").run(app.id);

    // Optimize resume (fallback to base if fails)
    let resumePath = getBaseResumePath();
    try {
      const optimized = await optimizeResume(jobId, job.description ?? "", job.company, job.title);
      if (optimized.success && optimized.pdfPath) {
        const txtPath = optimized.pdfPath.replace(/\.pdf$/i, ".txt");
        let optimizedText: string | null = null;
        try { optimizedText = readFileSync(txtPath, "utf8").slice(0, 5000); } catch { /* no txt companion */ }

        if (optimizedText) {
          const originalText = readFileSync(getBaseResumePath(), "utf8");
          const validation = await validateOptimizedResume(originalText, optimizedText, job.description ?? "");
          if (validation.valid) {
            resumePath = optimized.pdfPath;
          } else {
            logger.warn({ issues: validation.issues, jobId }, "Optimized resume failed validation, using base");
          }
        } else {
          resumePath = optimized.pdfPath;
          logger.info({ jobId }, "Using optimized resume (no text companion for validation)");
        }
      }
    } catch (err) {
      logger.warn({ error: err, jobId }, "Resume optimization failed, using base");
    }

    // Generate cover letter
    let coverPath: string | undefined;
    try {
      const cover = await generateCoverLetter(job.company, job.title, job.description ?? "", job.match_analysis ?? "");
      coverPath = cover?.filePath;
    } catch (err) {
      logger.warn({ error: err, jobId }, "Cover letter generation failed");
    }

    // Update application with resume/cover letter paths
    this.db.prepare("UPDATE applications SET resume_version = ?, cover_letter = ?, updated_at = datetime('now') WHERE id = ?")
      .run(resumePath, coverPath ?? null, app.id);
    app.resume_version = resumePath;
    app.cover_letter = coverPath;

    const result = method === "linkedin_easy"
      ? await linkedInEasyApply(job, app, (step) => this.recordStep(app.id, step))
      : await careerSiteApply(job, app, this.db, (step) => this.recordStep(app.id, step));

    // Update application status
    if (result.success) {
      this.db.prepare(`
        UPDATE applications SET status = 'application_submitted',
          confirmation_number = ?, confirmation_screenshot = ?,
          follow_up_date = date('now', '+7 days'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(result.confirmationNumber ?? null, result.confirmationScreenshot ?? null, app.id);

      this.db.prepare("UPDATE job_postings SET status = 'applied' WHERE id = ?").run(jobId);

      // Track outcome for this application
      try {
        trackApplicationSubmitted(this.db, jobId, `${job.company} — ${job.title}`);
      } catch { /* outcome tracking best-effort */ }
    } else if (!result.escalation) {
      this.db.prepare("UPDATE applications SET status = 'failed', notes = ?, updated_at = datetime('now') WHERE id = ?")
        .run(result.error ?? null, app.id);
    }

    // Escalate to Telegram if needed
    if (result.escalation) {
      await this.escalateToTelegram(result.escalation, {
        jobId,
        company: job.company,
        title: job.title,
        error: result.error,
      });
    }

    return result;
  }

  private async recordStep(applicationId: string, step: ApplicationStep): Promise<void> {
    const stepId = createHash("sha256")
      .update(`${applicationId}${step.stepType}${Date.now()}`)
      .digest("hex")
      .slice(0, 12);

    this.db.prepare(`
      INSERT INTO application_steps
        (id, application_id, step_number, step_type, step_status, started_at, completed_at,
         duration_ms, page_url, screenshot_path, form_data_submitted, error_message)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?)
    `).run(
      stepId,
      applicationId,
      step.stepNumber,
      step.stepType,
      step.stepStatus,
      step.durationMs ?? null,
      step.pageUrl ?? null,
      step.screenshotPath ?? null,
      step.formData ? JSON.stringify(step.formData) : null,
      step.error ?? null
    );
  }

  private async escalateToTelegram(
    type: EscalationType,
    context: { jobId: string; company: string; title: string; error?: string }
  ): Promise<void> {
    const emoji: Record<EscalationType, string> = {
      captcha: "\u{1F512}",
      unknown_field: "\u{2753}",
      account_locked: "\u{1F6AB}",
      mfa_required: "\u{1F4F1}",
      form_changed: "\u{26A0}\u{FE0F}",
    };

    try {
      await this.bot.api.sendMessage(
        this.chatId,
        `${emoji[type]} <b>Application Escalation</b>\n\n` +
          `<b>Type:</b> ${type}\n` +
          `<b>Job:</b> ${context.company} - ${context.title}\n` +
          (context.error ? `<b>Error:</b> ${context.error}\n` : "") +
          `\n<em>Manual intervention may be required.</em>`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      logger.warn({ error, type }, "Failed to send escalation");
    }
  }
}

// ── Auto-Apply Queue Processor ──────────────────────────────────

export async function processApprovalQueue(
  db: Database.Database,
  bot: Bot,
  chatId: number
): Promise<{ applied: number; failed: number; skipped: number }> {
  const stats = { applied: 0, failed: 0, skipped: 0 };
  const engine = new ApplyEngine(db, bot, chatId);

  const pending = db.prepare(`
    SELECT aq.id as queue_id, aq.job_id, jp.title, jp.company, jp.location,
           jp.application_type, jp.work_arrangement, jp.match_score, jp.match_analysis, jp.url
    FROM approval_queue aq
    JOIN job_postings jp ON aq.job_id = jp.id
    WHERE aq.decision = 'pending'
    ORDER BY aq.match_score DESC
    LIMIT 5
  `).all() as Array<{
    queue_id: string; job_id: string; title: string; company: string;
    location: string; application_type: string | null; work_arrangement: string | null;
    match_score: number; match_analysis: string; url: string;
  }>;

  if (pending.length === 0) {
    logger.info("No pending jobs in approval queue");
    return stats;
  }

  logger.info({ count: pending.length }, "Processing approval queue (auto-apply)");

  for (const job of pending) {
    try {
      // Mark as approved (auto)
      db.prepare(`
        UPDATE approval_queue SET decision = 'approved', decided_at = datetime('now')
        WHERE id = ?
      `).run(job.queue_id);

      db.prepare("UPDATE job_postings SET status = 'approved' WHERE id = ?").run(job.job_id);

      // Determine method
      const method = job.application_type === "easy_apply" ? "linkedin_easy" : "career_site";

      // Apply
      const result = await engine.applyToJob(job.job_id, method as "linkedin_easy" | "career_site");

      if (result.success) {
        stats.applied++;
      } else if (result.escalation) {
        stats.skipped++; // escalated, not a failure
      } else {
        stats.failed++;
      }

      // Send FYI notification
      await sendApplicationFYI(bot, chatId, job, result);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error, jobId: job.job_id }, "Auto-apply failed");
      stats.failed++;

      // Still send FYI about the failure
      await sendApplicationFYI(bot, chatId, job, {
        success: false, steps: [], error: msg,
      });
    }
  }

  logger.info(stats, "Approval queue processing complete");
  return stats;
}

// ── Telegram FYI Notification ───────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendApplicationFYI(
  bot: Bot,
  chatId: number,
  job: { title: string; company: string; location: string; work_arrangement: string | null; match_score: number; application_type: string | null; url: string },
  result: ApplyResult,
): Promise<void> {
  const status = result.success ? "\u{2705} Applied" : result.escalation ? "\u{26A0}\u{FE0F} Escalated" : "\u{274C} Failed";
  const score = (job.match_score * 100).toFixed(0);
  const method = job.application_type === "easy_apply" ? "Easy Apply" : "Career Site";
  const arrangement = job.work_arrangement ? ` | ${job.work_arrangement}` : "";

  let msg = `${status}: <b>${escapeHtml(job.title)}</b>\n`;
  msg += `${escapeHtml(job.company)} | ${escapeHtml(job.location || "?")}${arrangement}\n`;
  msg += `Score: ${score}% | ${method}\n`;

  if (result.error) {
    msg += `\n<em>${escapeHtml(result.error.slice(0, 200))}</em>\n`;
  }

  if (job.url) {
    msg += `\n<a href="${escapeHtml(job.url)}">View posting</a>`;
  }

  try {
    await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML" });
  } catch (error) {
    logger.warn({ error }, "Failed to send application FYI");
  }
}
