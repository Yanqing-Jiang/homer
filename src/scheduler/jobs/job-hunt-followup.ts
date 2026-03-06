/**
 * Job Hunt Follow-up — generates personalized follow-up emails,
 * sends to Telegram for approval before sending.
 */

import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { geminiUrl } from "../../job-hunt/config.js";
import { routeTelegramNotification } from "../../notifications/telegram-router.js";
import { logger } from "../../utils/logger.js";

interface FollowUpCandidate {
  app_id: string;
  job_id: string;
  company: string;
  title: string;
  status: string;
  follow_up_date: string;
  match_analysis: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runJobHuntFollowup(
  db: Database.Database,
  bot?: Bot,
  chatId?: number
): Promise<{
  success: boolean;
  output: string;
  error?: string;
  draftsGenerated: number;
  sentToTelegram: number;
}> {
  try {
    // Find applications needing follow-up
    const candidates = db.prepare(`
      SELECT a.id as app_id, a.job_id, jp.company, jp.title, a.status,
             a.follow_up_date, jp.match_analysis
      FROM applications a
      JOIN job_postings jp ON a.job_id = jp.id
      WHERE a.status IN ('application_submitted', 'confirmation_received')
        AND a.follow_up_date IS NOT NULL
        AND a.follow_up_date <= date('now')
    `).all() as FollowUpCandidate[];

    if (candidates.length === 0) {
      return {
        success: true,
        output: "No follow-ups due today",
        draftsGenerated: 0,
        sentToTelegram: 0,
      };
    }

    let draftsGenerated = 0;
    let sentToTelegram = 0;

    for (const candidate of candidates) {
      // Check if we already sent a follow-up recently
      const recentFollowUp = db.prepare(`
        SELECT 1 FROM email_log
        WHERE job_id = ? AND direction = 'outbound' AND category = 'follow-up'
          AND datetime(sent_at) > datetime('now', '-5 days')
        LIMIT 1
      `).get(candidate.job_id);

      if (recentFollowUp) continue;

      // Generate follow-up email draft using Gemini
      const draft = await generateFollowUpDraft(candidate);
      if (draft) {
        draftsGenerated++;

        // Look up recruiter email from recent inbound emails for this job
        const emailRow = db.prepare(`
          SELECT from_addr FROM email_log
          WHERE job_id = ? AND direction = 'inbound'
          ORDER BY datetime(received_at) DESC LIMIT 1
        `).get(candidate.job_id) as { from_addr: string } | undefined;
        const toAddr = emailRow?.from_addr ?? "";

        const draftId = `draft_${Date.now()}_${candidate.app_id}`;
        const subject = `Following up: ${candidate.title} at ${candidate.company}`;

        // Store draft for Telegram approval
        db.prepare(`
          INSERT INTO email_log
            (id, direction, job_id, to_addr, subject, body_preview, category, status)
          VALUES (?, 'outbound', ?, ?, ?, ?, 'follow-up', 'draft')
        `).run(draftId, candidate.job_id, toAddr, subject, draft.slice(0, 500));

        // Surface draft to Telegram for approval
        if (bot && chatId) {
          try {
            const toLine = toAddr ? `<b>To:</b> ${escapeHtml(toAddr)}` : "<b>To:</b> <em>No email found — manual input needed</em>";
            const msg = [
              `<b>Follow-up Draft</b>`,
              ``,
              `<b>${escapeHtml(candidate.company)}</b> — ${escapeHtml(candidate.title)}`,
              toLine,
              ``,
              `<blockquote>${escapeHtml(draft.slice(0, 400))}</blockquote>`,
            ].join("\n");

            const keyboard = new InlineKeyboard()
              .text("Send", `a:fu:${draftId}:send`)
              .text("Edit", `a:fu:${draftId}:edit`)
              .text("Discard", `a:fu:${draftId}:discard`);

            const delivery = await routeTelegramNotification({
              db,
              sourceType: "job_handler",
              sourceId: `followup_draft:${draftId}`,
              intent: "decision_request",
              title: `${candidate.company} — ${candidate.title}`,
              messageText: msg,
              metadata: {
                applicationId: candidate.app_id,
                jobId: candidate.job_id,
              },
              deliver: async () => bot.api.sendMessage(chatId, msg, {
                parse_mode: "HTML",
                reply_markup: keyboard,
              }),
            });
            if (delivery.decision === "sent") {
              sentToTelegram++;
            }
          } catch (err) {
            logger.warn({ error: err, draftId }, "Failed to send follow-up to Telegram");
          }
        }

        // Advance follow-up date by 7 days
        db.prepare(`
          UPDATE applications SET follow_up_date = date('now', '+7 days')
          WHERE id = ?
        `).run(candidate.app_id);
      }
    }

    const parts: string[] = [];
    if (draftsGenerated > 0) parts.push(`${draftsGenerated} follow-up drafts generated`);
    if (sentToTelegram > 0) parts.push(`${sentToTelegram} sent for approval`);
    if (draftsGenerated > sentToTelegram) {
      const undelivered = draftsGenerated - sentToTelegram;
      parts.push(`${undelivered} approval prompt${undelivered === 1 ? "" : "s"} not delivered`);
    }
    const output = parts.join(", ") || "No follow-ups needed";

    logger.info({ count: draftsGenerated, sentToTelegram }, "Follow-up generation completed");
    return { success: true, output, draftsGenerated, sentToTelegram };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error }, "Follow-up generation failed");
    return {
      success: false,
      output: "",
      error: msg,
      draftsGenerated: 0,
      sentToTelegram: 0,
    };
  }
}

async function generateFollowUpDraft(candidate: FollowUpCandidate): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY_Primary || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `Write a brief professional follow-up email for a job application.

Context:
- Applied for: ${candidate.title} at ${candidate.company}
- Application status: ${candidate.status}
- Match analysis: ${candidate.match_analysis || "N/A"}

Requirements:
- 3-4 sentences max
- Reference the specific role
- Express continued interest
- Politely ask about timeline
- Professional but warm tone
- No filler phrases

Output the email body text only (no subject line, no greeting).`;

  try {
    const resp = await fetch(
      geminiUrl(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 65536 },
        }),
      }
    );

    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}
