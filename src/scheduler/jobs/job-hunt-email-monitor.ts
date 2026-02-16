/**
 * Job Hunt Email Monitor — polls Gmail every 30 min,
 * classifies emails, links to job_postings, updates application status.
 */

import type Database from "better-sqlite3";
import { checkInbox, type GmailMessage } from "../../job-hunt/gmail-client.js";
import { parseInterviewEmail } from "../../job-hunt/interview-parser.js";
import { logger } from "../../utils/logger.js";

// Map known company domains to company names
function extractCompanyFromEmail(from: string, db: Database.Database): string | null {
  const domainMatch = from.match(/@([a-z0-9.-]+)/i);
  if (!domainMatch) return null;
  const domain = domainMatch[1]!.toLowerCase();

  // Strip common email providers
  const genericDomains = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com"];
  if (genericDomains.includes(domain)) return null;

  // Try to match domain against known companies
  const companyPart = domain.split(".")[0]!;
  const match = db.prepare(
    "SELECT DISTINCT company FROM job_postings WHERE LOWER(company) LIKE ? LIMIT 1"
  ).get(`%${companyPart}%`) as { company: string } | undefined;

  return match?.company ?? null;
}

function linkEmailToJob(
  email: GmailMessage,
  db: Database.Database
): { jobId: string; applicationId: string } | null {
  // Strategy 1: Match by thread ID from our sent emails
  const byThread = db.prepare(
    "SELECT job_id FROM email_log WHERE thread_id = ? AND direction = 'outbound' LIMIT 1"
  ).get(email.threadId) as { job_id: string } | undefined;
  if (byThread?.job_id) {
    const app = db.prepare("SELECT id FROM applications WHERE job_id = ?").get(byThread.job_id) as { id: string } | undefined;
    if (app) return { jobId: byThread.job_id, applicationId: app.id };
  }

  // Strategy 2: Match by company domain
  const company = extractCompanyFromEmail(email.from, db);
  if (company) {
    const jobRow = db.prepare(`
      SELECT jp.id as job_id, a.id as app_id
      FROM job_postings jp
      LEFT JOIN applications a ON a.job_id = jp.id
      WHERE LOWER(jp.company) = LOWER(?)
      ORDER BY jp.discovered_at DESC LIMIT 1
    `).get(company) as { job_id: string; app_id: string | null } | undefined;
    if (jobRow?.app_id) return { jobId: jobRow.job_id, applicationId: jobRow.app_id };
  }

  // Strategy 3: Match by job title in subject
  const words = email.subject.split(/\s+/).filter((w) => w.length > 4);
  for (const word of words) {
    const match = db.prepare(
      "SELECT jp.id as job_id, a.id as app_id FROM job_postings jp LEFT JOIN applications a ON a.job_id = jp.id WHERE jp.title LIKE ? LIMIT 1"
    ).get(`%${word}%`) as { job_id: string; app_id: string | null } | undefined;
    if (match?.app_id) return { jobId: match.job_id, applicationId: match.app_id };
  }

  return null;
}

function updateApplicationStatus(
  db: Database.Database,
  applicationId: string,
  category: string,
  email: GmailMessage
): void {
  switch (category) {
    case "interview-invite": {
      const details = parseInterviewEmail(email.subject, email.snippet, email.snippet);
      const newStatus = details.type === "onsite" ? "onsite" : "phone_screen";
      db.prepare(`
        UPDATE applications SET status = ?,
          phone_screen_at = CASE WHEN ? IS NOT NULL THEN ? ELSE phone_screen_at END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(newStatus, details.dateTime?.toISOString() ?? null, details.dateTime?.toISOString() ?? null, applicationId);
      break;
    }
    case "rejection":
      db.prepare(`
        UPDATE applications SET status = 'rejected',
          rejection_reason = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(email.snippet.slice(0, 500), applicationId);
      break;
    case "recruiter-reply":
      // Don't change status, just log
      break;
  }
}

export async function runJobHuntEmailMonitor(db: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const messages = await checkInbox(35); // 35 min window to avoid gaps with 30 min cron
    if (messages.length === 0) {
      return { success: true, output: "No new job-related emails" };
    }

    const stats = { total: messages.length, linked: 0, unlinked: 0, interviews: 0, rejections: 0, recruiter: 0 };

    for (const email of messages) {
      // Skip non-job emails
      if (email.category === "other") continue;

      // Check if already processed
      const existing = db.prepare(
        "SELECT 1 FROM email_log WHERE gmail_id = ?"
      ).get(email.id);
      if (existing) continue;

      // Link to job posting
      const link = linkEmailToJob(email, db);
      if (link) {
        stats.linked++;
        updateApplicationStatus(db, link.applicationId, email.category, email);

        // Log with job linkage
        db.prepare(`
          INSERT OR IGNORE INTO email_log
            (id, direction, gmail_id, thread_id, from_addr, to_addr, subject,
             body_preview, received_at, category, job_id, status)
          VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed')
        `).run(
          `email_${email.id}`, email.id, email.threadId,
          email.from, email.to, email.subject,
          email.snippet, email.date, email.category, link.jobId
        );
      } else {
        stats.unlinked++;
        // Log without linkage
        db.prepare(`
          INSERT OR IGNORE INTO email_log
            (id, direction, gmail_id, thread_id, from_addr, to_addr, subject,
             body_preview, received_at, category, status)
          VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(
          `email_${email.id}`, email.id, email.threadId,
          email.from, email.to, email.subject,
          email.snippet, email.date, email.category
        );
      }

      if (email.category === "interview-invite") stats.interviews++;
      if (email.category === "rejection") stats.rejections++;
      if (email.category === "recruiter-reply") stats.recruiter++;
    }

    const output = [
      `Email monitor: ${stats.total} checked`,
      stats.interviews > 0 ? `${stats.interviews} interview invites` : null,
      stats.rejections > 0 ? `${stats.rejections} rejections` : null,
      stats.recruiter > 0 ? `${stats.recruiter} recruiter replies` : null,
      `${stats.linked} linked, ${stats.unlinked} unlinked`,
    ].filter(Boolean).join(", ");

    logger.info({ stats }, "Email monitor completed");
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error }, "Email monitor failed");
    return { success: false, output: "", error: msg };
  }
}
