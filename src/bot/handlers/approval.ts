import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync } from "fs";
import type { StateManager } from "../../state/manager.js";
import { updatePreferences, type PreferenceSignal } from "../../preferences/engine.js";
import { trackIdeaProgress, trackIdeaArchived } from "../../outcomes/hooks.js";
import {
  recordFeedback,
  createReviewSession,
  completeReviewSession,
  recordImpression,
} from "../../feedback/events.js";
import {
  loadIdeasFromDir,
  parseIdeasMd,
  type ParsedIdea,
} from "../../ideas/parser.js";
import * as dao from "../../ideas/dao.js";
import { PATHS } from "../../config/paths.js";
import { staleMapCleaner } from "../../utils/stale-map-cleaner.js";

const IDEAS_FILE = PATHS.ideasMd;
const FEEDBACK_FILE = PATHS.feedback;
const DENY_HISTORY_FILE = PATHS.denyHistory;

// Track pending deny reasons (messageId -> pending info)
interface PendingDeny {
  ideaId: string;
  title: string;
  source: string;
  link?: string;
  createdAt: number;
}
const pendingDenyReasons = new Map<number, PendingDeny>();

// Track pending instruction replies (messageId -> pending info)
interface PendingInstruction {
  type: "idea" | "plan";
  id: string;
  title?: string;
  createdAt: number;
}
const pendingInstructionRequests = new Map<number, PendingInstruction>();

// Track impressions for feedback event linking (ideaId -> impression data)
interface ImpressionRecord {
  impressionId: number;
  displayedAt: number;
}
const pendingImpressions = new Map<string, ImpressionRecord>();

let stateManagerRef: StateManager | null = null;

// Register Maps for cleanup via shared StaleMapCleaner (30min interval, replaces per-module setInterval)
staleMapCleaner.register(pendingDenyReasons, "approval:deny");
staleMapCleaner.register(pendingInstructionRequests, "approval:instructions");
staleMapCleaner.register(pendingImpressions, "approval:impressions", {
  maxAgeMs: 86400000, // 24 hours
  timestampKey: "displayedAt",
});

/**
 * Format an idea for ideas.md (LEGACY — only used for ideas.md write-back)
 */
function formatIdea(idea: ParsedIdea): string {
  let output = `### [${idea.timestamp}] ${idea.title}\n`;
  output += `- **ID:** ${idea.id}\n`;
  output += `- **Source:** ${idea.source}\n`;
  output += `- **Status:** ${idea.status}\n`;
  output += `- **Content:** ${idea.content}\n`;
  if (idea.context) output += `- **Context:** ${idea.context}\n`;
  if (idea.link) output += `- **Link:** ${idea.link}\n`;
  if (idea.notes) output += `- **Notes:** ${idea.notes}\n`;
  return output;
}

/**
 * Rebuild ideas.md from parsed ideas (LEGACY — only used for ideas.md write-back)
 */
function rebuildIdeasFile(ideas: ParsedIdea[]): string {
  const draft = ideas.filter(i => i.status === "draft");
  const review = ideas.filter(i => i.status === "review" || i.status === "discussion");
  const archived = ideas.filter(i => i.status === "archived" || i.status === "planning" || i.status === "execution");

  let output = "# Ideas\n\nRaw ideas collected by HOMER. Reviewed daily at 7 AM.\n\n";
  output += "## Draft Ideas\n\n";
  for (const idea of draft) {
    output += formatIdea(idea) + "\n";
  }
  output += "## Under Review\n\n";
  for (const idea of review) {
    output += formatIdea(idea) + "\n";
  }
  output += "## Archived\n\n";
  for (const idea of archived) {
    output += formatIdea(idea) + "\n";
  }
  return output;
}

/**
 * Log feedback to feedback.md
 */
async function logFeedback(action: string, target: string, notes?: string): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  const timestamp = `${year}-${month}-${day} ${hours}:${mins}`;
  

  let entry = `\n### [${timestamp}] ${action.charAt(0).toUpperCase() + action.slice(1)} - ${target}\n`;
  entry += `Decision: ${action}\n`;
  if (notes) entry += `Notes: ${notes}\n`;

  await appendFile(FEEDBACK_FILE, entry, "utf-8");
}

/**
 * Find idea by ID (partial match) — used for legacy ideas.md fallback
 */
function findIdea(ideas: ParsedIdea[], id: string): ParsedIdea | undefined {
  return ideas.find(i =>
    i.id === id ||
    i.id.startsWith(id) ||
    i.timestamp.replace(/[- :]/g, "").includes(id)
  );
}

/**
 * Archive an idea (no reason required)
 */

/**
 * Helper to send preference signals from an idea's properties
 */
function sendPreferenceSignals(idea: ParsedIdea, delta: number) {
  if (!stateManagerRef) return;
  const signals: PreferenceSignal[] = [];
  const tags = idea.tags || [];
  const source = idea.source || "unknown";

  for (const tag of tags) {
    if (tag) signals.push({ dimension: `topic:${tag}`, delta });
  }
  if (source) signals.push({ dimension: `source:${source}`, delta });

  if (signals.length > 0) {
    try {
      updatePreferences(stateManagerRef.getDb(), signals);
      logger.info({ ideaId: idea.id, delta, tags, source }, "Sent real-time preference signals");
    } catch (err) {
      logger.warn({ error: err }, "Failed to update preferences from bot handler");
    }
  }
}

async function archiveIdea(
  ideaId: string,
  reason: string = "Archived"
): Promise<{ success: boolean; message: string; idea?: ParsedIdea }> {
  const db = stateManagerRef?.getDb();

  // DB-backed path (primary)
  if (db) {
    const idea = dao.getIdea(db, ideaId);
    if (idea) {
      dao.updateIdea(db, idea.id, { status: "archived" });
      dao.appendNote(db, idea.id, reason);
      await logDenyHistory(idea.title, idea.source, reason, idea.link);
      await logFeedback("archive", idea.title, reason);
      try {
        trackIdeaArchived(db, idea.id, idea.title);
        sendPreferenceSignals(idea, -0.1);
      } catch { /* outcome tracking best-effort */ }
      return { success: true, message: `Archived: ${idea.title}`, idea };
    }
  }

  // Fallback to legacy ideas.md
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasMd(content);
  const idea = findIdea(ideas, ideaId);

  if (!idea) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  idea.status = "archived";
  idea.notes = (idea.notes ? idea.notes + "; " : "") + reason;
  await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");

  await logDenyHistory(idea.title, idea.source, reason, idea.link);
  await logFeedback("archive", idea.title, reason);
  sendPreferenceSignals(idea, -0.1);

  return { success: true, message: `Archived: ${idea.title}`, idea };
}


/**
 * Add user instructions to an idea
 */
async function addIdeaInstructions(
  ideaId: string,
  instructions: string
): Promise<{ success: boolean; message: string; title?: string }> {
  const db = stateManagerRef?.getDb();

  // DB-backed path (primary)
  if (db) {
    const idea = dao.getIdea(db, ideaId);
    if (idea) {
      dao.appendNote(db, idea.id, `User instructions: ${instructions}`);
      await logFeedback("instruction", idea.title, instructions);
      sendPreferenceSignals(idea, 0.1);
      try {
        recordFeedback(db, {
          contentType: "idea",
          contentId: ideaId,
          action: "instruction",
          source: "telegram",
          impressionId: pendingImpressions.get(ideaId)?.impressionId,
          delta: 0.1,
          metadata: { instructions },
        });
      } catch { /* best-effort */ }
      return { success: true, message: `Instructions saved for ${idea.title}`, title: idea.title };
    }
  }

  // Fallback to legacy ideas.md
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasMd(content);
  const idea = findIdea(ideas, ideaId);

  if (!idea) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  sendPreferenceSignals(idea, 0.1);
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  const timestamp = `${year}-${month}-${day} ${hours}:${mins}`;
  const note = `User instructions (${timestamp}): ${instructions}`;
  idea.notes = idea.notes ? `${idea.notes}; ${note}` : note;

  await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");
  await logFeedback("instruction", idea.title, instructions);

  return { success: true, message: `Instructions saved for ${idea.title}`, title: idea.title };
}

/**
 * Log denial to deny-history.md for preference learning
 */
async function logDenyHistory(
  title: string,
  source: string,
  reason: string,
  link?: string
): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  // const timestamp = `${year}-${month}-${day} ${hours}:${mins}`;
  const date = `${year}-${month}-${day}`;

  let entry = `\n### [${date}] ${title}\n`;
  entry += `- **Source:** ${source}\n`;
  entry += `- **Reason:** ${reason}\n`;
  if (link) entry += `- **Link:** ${link}\n`;

  try {
    await appendFile(DENY_HISTORY_FILE, entry, "utf-8");
    logger.info({ title, source, reason }, "Logged to deny history");
  } catch (error) {
    logger.warn({ error }, "Failed to log deny history");
  }
}

/**
 * Get deny history patterns for filtering
 */
export async function getDenyPatterns(): Promise<string[]> {
  if (!existsSync(DENY_HISTORY_FILE)) {
    return [];
  }

  try {
    const content = await readFile(DENY_HISTORY_FILE, "utf-8");
    const reasons: string[] = [];
    const reasonRegex = /- \*\*Reason:\*\* (.+)$/gm;
    let match;
    while ((match = reasonRegex.exec(content)) !== null) {
      reasons.push(match[1] ?? "");
    }
    return reasons.filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Create inline keyboard for an idea.
 * Telegram callback_data max is 64 bytes — truncate ID to fit.
 * Callback handlers use startsWith matching, so truncation is safe.
 */
export function createIdeaKeyboard(ideaId: string): InlineKeyboard {
  // Longest payload: "a:i:" + id + ":archive" = 12 + id.length bytes
  const maxIdBytes = 64 - "a:i:".length - ":archive".length; // 52

  // Truncate by bytes to prevent Telegram API crashes, ensure collision safety
  let id = ideaId;
  if (Buffer.byteLength(id, 'utf8') > maxIdBytes) {
    const buf = Buffer.from(id, 'utf8');
    id = buf.subarray(0, maxIdBytes).toString('utf8');
    // In case of multibyte character split, remove the last potentially corrupted char
    id = id.replace(/\uFFFD/g, '');
  }

  return new InlineKeyboard()
    .text("💬 聊聊", `a:i:${id}:talk`)
    .text("💤 暂缓", `a:i:${id}:snooze`)
    .text("🗂 归档", `a:i:${id}:archive`);
}

/**
 * Format idea for Telegram message with intent summary
 */
/**
 * Extract confidence score from synthesizer context field.
 * Returns undefined for ideas without confidence metadata.
 */
function extractConfidence(idea: ParsedIdea): number | undefined {
  if (!idea.context) return undefined;
  const match = idea.context.match(/Confidence:\s*([\d.]+)/);
  return match ? parseFloat(match[1]!) : undefined;
}

/**
 * Get a visual confidence indicator (1-3 bars)
 */
function confidenceIndicator(score: number | undefined): string {
  if (score === undefined) return "";
  if (score >= 0.7) return " 🟢";
  if (score >= 0.5) return " 🟡";
  return " 🔴";
}

export function formatIdeaForTelegram(idea: ParsedIdea, index: number): string {
  const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"][index] || "▪️";
  const title = escapeHtml(idea.title);
  const source = escapeHtml(idea.source);
  const tagsStr = idea.tags?.length ? ` · ${idea.tags.filter(t => t !== "synthesized").map(t => escapeHtml(t)).join(", ")}` : "";
  const id = escapeHtml(idea.id);
  const confidence = extractConfidence(idea);
  const indicator = confidenceIndicator(confidence);

  // Build summary from content (skip context — it's metadata now)
  let summary = idea.content || "";
  summary = summary.slice(0, 800);
  if (summary.length === 800) summary = summary.slice(0, summary.lastIndexOf(" ")) + "...";
  const summaryHtml = escapeHtml(summary);

  let msg = `<b>${emoji} ${title}</b>${indicator}\n`;
  msg += `${source}${tagsStr}\n\n`;
  msg += `${summaryHtml}\n`;
  if (idea.link) {
    msg += `\n<a href="${escapeHtml(idea.link)}">来源链接</a>\n`;
  }
  msg += `\n<code>${id}</code>`;
  return msg;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Register approval callback handlers on the bot
 */
export function registerApprovalHandlers(bot: Bot, stateManager: StateManager): void {
  stateManagerRef = stateManager;
  // Handle legacy approve button (no longer active — kept for old messages)
  bot.callbackQuery(/^a:i:([^:]+):approve$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active");
  });

  // Handle archive button
  bot.callbackQuery(/^a:i:([^:]+):archive$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Archive button clicked");

    try {
      const result = await archiveIdea(ideaId);

      if (result.success) {
        await ctx.editMessageText(`🗂 <b>${escapeHtml(result.message)}</b>`, { parse_mode: "HTML" });

        // Record feedback event
        const db = stateManagerRef?.getDb();
        if (db) {
          try {
            recordFeedback(db, {
              contentType: "idea",
              contentId: ideaId,
              action: "archive",
              source: "telegram",
              impressionId: pendingImpressions.get(ideaId)?.impressionId,
              delta: -0.1,
              responseTimeMs: pendingImpressions.has(ideaId)
                ? Date.now() - pendingImpressions.get(ideaId)!.displayedAt
                : undefined,
            });
          } catch { /* best-effort */ }
        }
      } else {
        await ctx.editMessageText(`❌ ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
      }
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to archive idea");
      await ctx.answerCallbackQuery("Error processing archive");
    }
  });

  // Handle snooze button — weak positive signal, re-draft for tomorrow
  bot.callbackQuery(/^a:i:([^:]+):snooze$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Snooze button clicked");

    try {
      // Move back to draft — it'll show up again in a future review
      const db = stateManagerRef?.getDb();
      const idea = db ? dao.getIdea(db, ideaId) : null;

      if (idea && db) {
        dao.updateIdea(db, idea.id, { status: "draft" });
        dao.appendNote(db, idea.id, "Snoozed — will resurface later");
        await logFeedback("snooze", idea.title);
        sendPreferenceSignals(idea, 0.05); // weak positive signal
        try {
          recordFeedback(db, {
            contentType: "idea",
            contentId: ideaId,
            action: "snooze",
            source: "telegram",
            impressionId: pendingImpressions.get(ideaId)?.impressionId,
            delta: 0.05,
            responseTimeMs: pendingImpressions.has(ideaId)
              ? Date.now() - pendingImpressions.get(ideaId)!.displayedAt
              : undefined,
          });
        } catch { /* best-effort */ }
        await ctx.editMessageText(`💤 <b>Snoozed: ${escapeHtml(idea.title)}</b>`, { parse_mode: "HTML" });
      } else {
        await ctx.editMessageText(`❌ Idea not found: ${escapeHtml(ideaId)}`, { parse_mode: "HTML" });
      }
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to snooze idea");
      await ctx.answerCallbackQuery("Error processing snooze");
    }
  });

  // Handle talk button — triggers multi-model analysis
  bot.callbackQuery(/^a:i:([^:]+):talk$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Talk button clicked — starting analysis");

    try {
      await ctx.answerCallbackQuery("Starting analysis...");

      // Load idea
      const db = stateManagerRef?.getDb();
      const idea = db ? dao.getIdea(db, ideaId) : null;

      if (!idea || !db) {
        await ctx.editMessageText(`❌ Idea not found: ${escapeHtml(ideaId)}`, { parse_mode: "HTML" });
        return;
      }

      // Update message to show analysis in progress
      await ctx.editMessageText(
        `🔬 <b>Analyzing: ${escapeHtml(idea.title)}</b>\n` +
        `Running multi-model analysis (opencode opus + 2x flash)...\n` +
        `Results in 1-5 minutes.`,
        { parse_mode: "HTML" }
      );

      // Update status + append note
      dao.updateIdea(db, idea.id, { status: "discussion" });
      dao.appendNote(db, idea.id, "Multi-model analysis started");
      await logFeedback("talk", idea.title);

      // Track outcome for this idea entering discussion
      try {
        if (stateManagerRef) {
          trackIdeaProgress(stateManagerRef.getDb(), ideaId, idea.title);
        }
      sendPreferenceSignals(idea, 0.15);
      } catch { /* outcome tracking best-effort */ }

      // Record feedback event
      try {
        recordFeedback(db, {
          contentType: "idea",
          contentId: ideaId,
          action: "talk",
          source: "telegram",
          impressionId: pendingImpressions.get(ideaId)?.impressionId,
          delta: 0.15,
          responseTimeMs: pendingImpressions.has(ideaId)
            ? Date.now() - pendingImpressions.get(ideaId)!.displayedAt
            : undefined,
        });
      } catch { /* best-effort */ }

      // Build notify callback using bot.api (ctx expires after handler returns)
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const notify = async (text: string, _parseMode?: string) => {
        await bot.api.sendMessage(chatId, text);
      };

      // Fire-and-forget analysis
      import("../../ideas/analyze.js").then(({ analyzeIdea }) => {
        analyzeIdea(
          {
            id: idea.id,
            title: idea.title,
            content: idea.content,
            context: idea.context,
            link: idea.link,
            source: idea.source,
            tags: idea.tags,
            notes: idea.notes,
          },
          notify
        ).then(() => {
          try { if (db) dao.appendNote(db, idea.id, "Analysis complete"); } catch { /* best-effort */ }
        }).catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ ideaId, error: msg }, "Idea analysis failed");
          await bot.api.sendMessage(chatId, `❌ Analysis failed for "${idea.title}": ${msg}`);
        });
      }).catch(err => {
        logger.error({ ideaId, error: err }, "Failed to import analyze module");
      });
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to initiate analysis");
      await ctx.answerCallbackQuery("Error starting analysis");
    }
  });

  // Handle add instructions button
  bot.callbackQuery(/^a:i:([^:]+):note$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Add instructions clicked");

    try {
      // Look up idea from DB, fallback to legacy
      const db = stateManagerRef?.getDb();
      let idea = db ? dao.getIdea(db, ideaId) : null;

      if (!idea && existsSync(IDEAS_FILE)) {
        const content = await readFile(IDEAS_FILE, "utf-8");
        const legacyIdeas = parseIdeasMd(content);
        idea = findIdea(legacyIdeas, ideaId) ?? null;
      }

      if (!idea) {
        await ctx.editMessageText(`❌ Idea not found: ${ideaId}`);
        await ctx.answerCallbackQuery();
        return;
      }

      const noteMsg = await ctx.reply(
        `✍️ <b>Add instructions</b>\n` +
        `<b>Idea:</b> ${escapeHtml(idea.title)}\n` +
        `<b>ID:</b> <code>${escapeHtml(idea.id)}</code>\n\n` +
        `Reply to this message with instructions for the executor.`,
        {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        }
      );

      pendingInstructionRequests.set(noteMsg.message_id, {
        type: "idea",
        id: idea.id,
        title: idea.title,
        createdAt: Date.now(),
      });

      await ctx.answerCallbackQuery("Reply with instructions");
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to initiate instructions");
      await ctx.answerCallbackQuery("Error starting instruction capture");
    }
  });

  // Handle instruction or reject reason replies
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) {
      return next();
    }

    if (pendingInstructionRequests.has(replyTo)) {
      const pending = pendingInstructionRequests.get(replyTo);
      if (!pending) return next();

      const instructions = ctx.message.text.trim();
      if (!instructions) {
        await ctx.reply("❌ Instructions cannot be empty.");
        return;
      }

      try {
        if (pending.type === "idea") {
          const result = await addIdeaInstructions(pending.id, instructions);
          if (result.success) {
            await ctx.reply(
              `✅ <b>Instructions saved</b>\n` +
              `<b>Idea:</b> ${escapeHtml(result.title || pending.id)}\n` +
              `<b>ID:</b> <code>${escapeHtml(pending.id)}</code>`,
              { parse_mode: "HTML" }
            );
          } else {
            await ctx.reply(`❌ ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
          }
        } else {
          const plan = stateManager.getPendingPlan(pending.id);
          if (!plan) {
            await ctx.reply(`❌ Plan not found: ${escapeHtml(pending.id)}`, { parse_mode: "HTML" });
          } else {
            const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  const timestamp = `${year}-${month}-${day} ${hours}:${mins}`;
            const updated = `${plan}\n\n## User Instructions (${timestamp})\n${instructions}\n`;
            stateManager.savePendingPlan(pending.id, updated);
            await logFeedback("instruction", `Plan ${pending.id}`, instructions);
            await ctx.reply(
              `✅ <b>Instructions saved</b>\n<b>Plan ID:</b> <code>${escapeHtml(pending.id)}</code>`,
              { parse_mode: "HTML" }
            );
          }
        }
      } catch (error) {
        logger.error({ error, id: pending.id, type: pending.type }, "Failed to save instructions");
        await ctx.reply(
          `❌ Error: ${escapeHtml(error instanceof Error ? error.message : "Unknown")}`,
          { parse_mode: "HTML" }
        );
      } finally {
        pendingInstructionRequests.delete(replyTo);
      }
      return;
    }

    if (!pendingDenyReasons.has(replyTo)) {
      return next();
    }

    // Legacy reject reason flow (unused)
    pendingDenyReasons.delete(replyTo);
    return next();
  });

  logger.info("Approval handlers registered");
}

/**
 * Send a batch of draft ideas for review (up to daily limit).
 * Sends all ideas simultaneously as separate messages with Talk+Archive buttons.
 * Returns the number of ideas sent.
 */
/**
 * Score an idea for ranking in morning review.
 * Combines confidence (from synthesizer), freshness, and source diversity.
 */
function scoreIdeaForReview(idea: ParsedIdea): number {
  const confidence = extractConfidence(idea) ?? 0.5; // default for non-synthesized ideas

  // Freshness: ideas from last 24h get a boost
  const ageMs = Date.now() - new Date(idea.timestamp).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const freshness = ageHours < 24 ? 1.0 : ageHours < 48 ? 0.8 : 0.6;

  return confidence * 0.6 + freshness * 0.4;
}

export async function sendBatchIdeasForReview(bot: Bot, chatId: number, dailyLimit: number = 3): Promise<number> {
  // Check remaining daily quota
  let remaining = dailyLimit;
  if (stateManagerRef) {
    const sentCount = stateManagerRef.getIdeaReviewCount();
    remaining = dailyLimit - sentCount;
    if (remaining <= 0) {
      logger.info({ sentCount, dailyLimit }, "Daily idea review limit reached");
      return 0;
    }
  }

  // Load drafts — DB primary, legacy fallback
  const db = stateManagerRef?.getDb();
  const dirDrafts = db
    ? dao.getAllIdeas(db, { status: "draft" })
    : loadIdeasFromDir().filter(i => i.status === "draft");

  let legacyDrafts: ParsedIdea[] = [];
  if (existsSync(IDEAS_FILE)) {
    const content = await readFile(IDEAS_FILE, "utf-8");
    const legacyIdeas = parseIdeasMd(content);
    const existingIds = new Set(dirDrafts.map(i => i.id));
    legacyDrafts = legacyIdeas.filter(i => i.status === "draft" && !existingIds.has(i.id));
  }

  const allDrafts = [...dirDrafts, ...legacyDrafts];

  if (allDrafts.length === 0) {
    return 0;
  }

  // Ranked selection: score and sort, then pick with diversity constraint
  const scored = allDrafts.map(idea => ({
    idea,
    score: scoreIdeaForReview(idea),
    primaryTag: idea.tags?.[0] ?? idea.source,
  })).sort((a, b) => b.score - a.score);

  // Pick top ideas with tag diversity (no 2 ideas with same primary tag)
  const selected: ParsedIdea[] = [];
  const usedTags = new Set<string>();

  // First pass: pick highest-scored with diversity
  for (const entry of scored) {
    if (selected.length >= remaining) break;
    if (usedTags.has(entry.primaryTag)) continue;
    selected.push(entry.idea);
    usedTags.add(entry.primaryTag);
  }

  // Second pass: fill remaining slots from top-scored (allow tag overlap)
  if (selected.length < remaining) {
    const selectedIds = new Set(selected.map(s => s.id));
    for (const entry of scored) {
      if (selected.length >= remaining) break;
      if (selectedIds.has(entry.idea.id)) continue;
      selected.push(entry.idea);
    }
  }

  if (selected.length === 0) {
    return 0;
  }

  // Create review session for feedback tracking
  let reviewSessionId: string | undefined;
  if (db) {
    try {
      reviewSessionId = createReviewSession(db, "idea_review", selected.length);
    } catch (err) {
      logger.warn({ error: err }, "Failed to create review session");
    }
  }

  // Send header
  await bot.api.sendMessage(
    chatId,
    `📋 <b>想法审阅</b> (${selected.length})`,
    { parse_mode: "HTML" }
  );

  // Send each idea with buttons, mark as "review"
  let sent = 0;
  for (let i = 0; i < selected.length; i++) {
    const idea = selected[i]!;
    const message = formatIdeaForTelegram(idea, i);
    const keyboard = createIdeaKeyboard(idea.id);

    try {
      await bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      sent++;

      // Record impression for feedback linking
      if (db && reviewSessionId) {
        try {
          const impressionId = recordImpression(db, {
            sessionId: reviewSessionId,
            contentType: "idea",
            contentId: idea.id,
            position: i,
            scoreAtDisplay: scored.find(s => s.idea.id === idea.id)?.score,
            metadata: { primaryTag: scored.find(s => s.idea.id === idea.id)?.primaryTag },
          });
          pendingImpressions.set(idea.id, {
            impressionId,
            displayedAt: Date.now(),
          });
        } catch (err) {
          logger.warn({ error: err, ideaId: idea.id }, "Failed to record impression");
        }
      }

      // Mark as review only after successful send
      if (db) {
        dao.updateIdea(db, idea.id, { status: "review" });
      } else {
        const isFileBased = dirDrafts.some(d => d.id === idea.id);
        if (!isFileBased) {
          // Legacy system — update in memory and write once after loop
          idea.status = "review";
        }
      }
    } catch (error) {
      logger.error({ error, ideaId: idea.id }, "Failed to send idea for review");
    }

    // Small delay to avoid rate limiting
    if (i < selected.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Write legacy file once if any legacy ideas were updated
  const updatedLegacy = selected.filter(i => i.status === "review" && legacyDrafts.some(l => l.id === i.id));
  if (updatedLegacy.length > 0 && existsSync(IDEAS_FILE)) {
    const content = await readFile(IDEAS_FILE, "utf-8");
    const legacyIdeas = parseIdeasMd(content);
    for (const updated of updatedLegacy) {
      const found = findIdea(legacyIdeas, updated.id);
      if (found) found.status = "review";
    }
    await writeFile(IDEAS_FILE, rebuildIdeasFile(legacyIdeas), "utf-8");
  }

  // Complete review session
  if (db && reviewSessionId) {
    try { completeReviewSession(db, reviewSessionId); } catch { /* best-effort */ }
  }

  if (stateManagerRef && sent > 0) {
    stateManagerRef.incrementIdeaReviewCount(sent);
  }

  logger.info({ count: sent, ids: selected.filter(i => i.status === "review").map(i => i.id) }, "Sent ranked ideas for review");
  return sent;
}

// ============================================
// Implementation Plan Approval
// ============================================

/**
 * Register plan approval command handlers
 */
export function registerPlanApprovalHandlers(bot: Bot, stateManager: StateManager): void {
  // /approve <jobId> - Approve and execute a pending plan
  bot.command("approve", async (ctx) => {
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    const jobId = args[0];

    if (!jobId) {
      // List pending plans
      const plans = stateManager.listPendingPlans();
      if (plans.length === 0) {
        await ctx.reply("📋 No pending plans awaiting approval.");
        return;
      }

      let msg = "📋 *Pending Plans*\n\n";
      for (const plan of plans) {
        const preview = plan.plan.slice(0, 200).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
        msg += `*${plan.jobId}*\n${preview}...\n\n`;
      }
      msg += "_Use `/approve <jobId>` to approve a plan._";

      await ctx.reply(msg, { parse_mode: "Markdown" });
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.reply(`❌ No pending plan found for: ${jobId}`);
      return;
    }

    // Clear the pending plan (prevent double-execution)
    stateManager.clearPendingPlan(jobId);

    await ctx.reply(
      `✅ *Plan approved: ${jobId}*\n\n` +
      `_Executing on branch..._`,
      { parse_mode: "Markdown" }
    );

    logger.info({ jobId }, "Plan approved by user");
    await logFeedback("approve", `Plan ${jobId}`);
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "approve",
        source: "telegram",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    // Fire-and-forget plan execution
    import("../../scheduler/plan-executor.js").then(({ executePlan }) => {
      executePlan({
        jobId,
        plan,
        stateManager,
        bot,
        chatId: ctx.chat?.id ?? 0,
      }).catch(err => {
        logger.error({ jobId, error: err }, "Plan execution failed (command)");
      });
    }).catch(err => {
      logger.error({ jobId, error: err }, "Failed to import plan-executor");
    });
  });

  // /reject <jobId> - Reject and discard a pending plan
  bot.command("reject", async (ctx) => {
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    const jobId = args[0];

    if (!jobId) {
      await ctx.reply("Usage: `/reject <jobId>`\n\nUse `/approve` to see pending plans.", {
        parse_mode: "Markdown",
      });
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.reply(`❌ No pending plan found for: ${jobId}`);
      return;
    }

    stateManager.clearPendingPlan(jobId);

    await ctx.reply(`🗑️ Plan rejected and discarded: ${jobId}`);
    logger.info({ jobId }, "Plan rejected by user");
    await logFeedback("reject", `Plan ${jobId}`);
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "reject",
        source: "telegram",
        delta: -0.1,
      });
    } catch { /* best-effort */ }
  });

  // /plans - List pending plans
  bot.command("plans", async (ctx) => {
    const plans = stateManager.listPendingPlans();

    if (plans.length === 0) {
      await ctx.reply("📋 No pending plans awaiting approval.");
      return;
    }

    let msg = "📋 *Pending Implementation Plans*\n\n";
    for (const plan of plans) {
      const age = Math.round((Date.now() - plan.createdAt) / 60000);
      const preview = plan.plan.slice(0, 300).replace(/[_*[\]()~#+\-=|{}.!]/g, "\\$&");
      msg += `🔧 *${plan.jobId}* _(${age}m ago)_\n`;
      msg += `\`\`\`\n${preview}...\n\`\`\`\n\n`;
    }
    msg += "Commands:\n";
    msg += "`/approve <jobId>` \\- Execute plan\n";
    msg += "`/reject <jobId>` \\- Discard plan";

    await ctx.reply(msg, { parse_mode: "MarkdownV2" });
  });

  logger.info("Plan approval handlers registered");
}

/**
 * Check if output contains an implementation plan requiring approval
 */
export function isPlanRequiringApproval(output: string): boolean {
  // Must have "## Implementation Plan" as primary marker (used by homer-improvements)
  // Plus at least one detail marker to reduce false positives from other job outputs
  if (!output.includes("## Implementation Plan")) return false;

  const detailMarkers = [
    "### Step 1:",
    "### Files to Modify",
    "### Description",
    "**Risk:**",
    "**Files:**",
  ];

  return detailMarkers.some(marker => output.includes(marker));
}

/**
 * Create inline keyboard for plan approval
 */
export function createPlanApprovalKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `a:p:${jobId}:approve`)
    .text("❌ Reject", `a:p:${jobId}:reject`)
    .row()
    .text("✍️ Add Instructions", `a:p:${jobId}:note`);
}

/**
 * Register inline button handlers for plan approval
 */
export function registerPlanApprovalCallbacks(bot: Bot, stateManager: StateManager): void {
  bot.callbackQuery(/^a:p:([^:]+):approve$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.editMessageText(`❌ Plan not found or already processed: ${escapeHtml(jobId)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.editMessageText(
      `✅ <b>Plan approved</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n\n<em>Executing on branch...</em>`,
      { parse_mode: "HTML" }
    );

    await ctx.answerCallbackQuery("Plan approved — executing!");
    logger.info({ jobId }, "Plan approved via inline button");
    await logFeedback("approve", `Plan ${jobId}`);
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "approve",
        source: "telegram",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    // Fire-and-forget plan execution — clear plan only after launch succeeds
    const chatId = ctx.chat?.id;
    if (chatId) {
      import("../../scheduler/plan-executor.js").then(({ executePlan }) => {
        stateManager.clearPendingPlan(jobId);
        executePlan({
          jobId,
          plan,
          stateManager,
          bot,
          chatId,
        }).catch(err => {
          logger.error({ jobId, error: err }, "Plan execution failed (inline)");
        });
      }).catch(err => {
        logger.error({ jobId, error: err }, "Failed to import plan-executor");
      });
    }
  });

  bot.callbackQuery(/^a:p:([^:]+):reject$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.editMessageText(`❌ Plan not found or already processed: ${escapeHtml(jobId)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    stateManager.clearPendingPlan(jobId);

    await ctx.editMessageText(
      `🗑️ <b>Plan rejected</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>`,
      { parse_mode: "HTML" }
    );
    await ctx.answerCallbackQuery("Plan rejected");
    logger.info({ jobId }, "Plan rejected via inline button");
    await logFeedback("reject", `Plan ${jobId}`);
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "reject",
        source: "telegram",
        delta: -0.1,
      });
    } catch { /* best-effort */ }
  });

  bot.callbackQuery(/^a:p:([^:]+):note$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.editMessageText(`❌ Plan not found or already processed: ${escapeHtml(jobId)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    try {
      const noteMsg = await ctx.reply(
        `✍️ <b>Add instructions</b>\n<b>Plan ID:</b> <code>${escapeHtml(jobId)}</code>\n\n` +
        `Reply to this message with instructions for the executor.`,
        {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        }
      );

      pendingInstructionRequests.set(noteMsg.message_id, {
        type: "plan",
        id: jobId,
        createdAt: Date.now(),
      });

      await ctx.answerCallbackQuery("Reply with instructions");
    } catch (error) {
      logger.error({ error, jobId }, "Failed to initiate plan instructions");
      await ctx.answerCallbackQuery("Error starting instruction capture");
    }
  });
}
