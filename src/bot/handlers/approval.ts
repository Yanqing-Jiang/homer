import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { StateManager } from "../../state/manager.js";
import { updatePreferences, type PreferenceSignal } from "../../preferences/engine.js";
import { trackIdeaArchived } from "../../outcomes/hooks.js";
import {
  recordFeedback,
  createReviewSession,
  completeReviewSession,
  recordImpression,
} from "../../feedback/events.js";
import {
  parseIdeasMd,
  type ParsedIdea,
} from "../../ideas/parser.js";
import * as dao from "../../ideas/dao.js";
import * as packetDao from "../../ideas/source-packets.js";
import * as discussionDao from "../../ideas/discussions.js";
import { PATHS } from "../../config/paths.js";
import { staleMapCleaner } from "../../utils/stale-map-cleaner.js";
import { config } from "../../config/index.js";
import {
  formatScheduledTelegramHtml,
} from "../../notifications/telegram-router.js";
import { escapeHtml } from "../../utils/telegram-format.js";
import type { SourcePacket } from "../../ideas/source-packets.js";

const IDEAS_FILE = PATHS.ideasMd;

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

// Track active discussion reply targets (telegram messageId -> discussion context)
interface PendingDiscussion {
  discussionId: string;
  packetId?: string;
  ideaId?: string;
  title: string;
  createdAt: number;
}
const pendingDiscussions = new Map<number, PendingDiscussion>();

let stateManagerRef: StateManager | null = null;

// Register Maps for cleanup via shared StaleMapCleaner (30min interval, replaces per-module setInterval)
staleMapCleaner.register(pendingDenyReasons, "approval:deny");
staleMapCleaner.register(pendingInstructionRequests, "approval:instructions");
staleMapCleaner.register(pendingImpressions, "approval:impressions", {
  maxAgeMs: 86400000, // 24 hours
  timestampKey: "displayedAt",
});
staleMapCleaner.register(pendingDiscussions, "approval:discussions", {
  maxAgeMs: 4 * 60 * 60 * 1000, // 4 hours — discussions are longer-lived
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

  return { success: true, message: `Instructions saved for ${idea.title}`, title: idea.title };
}

/**
 * Create inline keyboard for an idea.
 * Telegram callback_data max is 64 bytes — truncate ID to fit.
 * Callback handlers use startsWith matching, so truncation is safe.
 */
/**
 * Truncate a callback data ID to fit Telegram's 64-byte limit.
 * The suffix is the longest action name that will be appended.
 */
function truncateCallbackId(ideaId: string, maxSuffix = ":deep_dive"): string {
  const maxIdBytes = 64 - "a:i:".length - maxSuffix.length;
  let id = ideaId;
  if (Buffer.byteLength(id, 'utf8') > maxIdBytes) {
    const buf = Buffer.from(id, 'utf8');
    id = buf.subarray(0, maxIdBytes).toString('utf8');
    id = id.replace(/\uFFFD/g, '');
  }
  return id;
}

/**
 * Keyboard for existing ideas (legacy flow, still used for promoted ideas).
 */
export function createIdeaKeyboard(ideaId: string): InlineKeyboard {
  const id = truncateCallbackId(ideaId);
  return new InlineKeyboard()
    .text("💬 Talk", `a:i:${id}:talk`)
    .text("🗂 Skip", `a:i:${id}:archive`);
}

/**
 * Keyboard for source packets (morning review of un-promoted packets).
 */
export function createPacketKeyboard(packetId: string): InlineKeyboard {
  const id = truncateCallbackId(packetId, ":talk");
  return new InlineKeyboard()
    .text("💬 Talk", `a:p:${id}:talk`)
    .text("🗂 Skip", `a:p:${id}:archive`);
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

  let msg = `<b>${emoji} ${title}</b>${indicator}\n`;
  msg += `${source}${tagsStr}\n\n`;

  // Use enrichment if available, fall back to raw content
  let enrichment: Record<string, unknown> | null = null;
  if (idea.enrichment) {
    try { enrichment = JSON.parse(idea.enrichment); } catch { /* ignore */ }
  }

  if (enrichment) {
    const dive = enrichment.deep_dive as { core_claim?: string } | undefined;
    const links = enrichment.deep_links as Array<{ target: string; relationship: string }> | undefined;
    const imp = enrichment.homer_improvement as { relevant?: boolean; summary?: string; area?: string; priority?: string } | undefined;

    if (dive?.core_claim) {
      msg += `${escapeHtml(dive.core_claim)}\n`;
    }

    if (links?.length) {
      const linkStr = links.slice(0, 3).map(l => escapeHtml(l.target)).join(", ");
      msg += `\n🔗 <i>${escapeHtml(links[0]?.relationship ?? "connects to")}: ${linkStr}</i>\n`;
    }

    if (imp?.relevant && imp.summary) {
      const priorityIcon = imp.priority === "high" ? "🔴" : imp.priority === "medium" ? "🟡" : "🟢";
      msg += `⚡ ${priorityIcon} <b>${escapeHtml(imp.summary)}</b>\n`;
    }
  } else {
    let summary = idea.content || "";
    summary = summary.slice(0, 600);
    if (summary.length === 600) summary = summary.slice(0, summary.lastIndexOf(" ")) + "...";
    msg += `${escapeHtml(summary)}\n`;
  }

  if (idea.link) {
    msg += `\n<a href="${escapeHtml(idea.link)}">来源链接</a>\n`;
  }
  msg += `\n<code>${id}</code>`;
  return formatScheduledTelegramHtml(msg);
}

/**
 * Load full packet context for an idea (if it has a source_packet_id).
 * Returns enriched content string or null if no packet linked.
 */
// @ts-ignore — better-sqlite3 type import
async function loadPacketContextForIdea(db: any, idea: ParsedIdea): Promise<string | null> {
  try {
    // Check if idea has a linked source packet
    const row = db.prepare("SELECT source_packet_id FROM ideas WHERE id = ?").get(idea.id) as { source_packet_id: string | null } | undefined;
    if (!row?.source_packet_id) return null;

    const packet = packetDao.getPacket(db, row.source_packet_id);
    if (!packet) return null;

    // Build rich context from packet
    const parts: string[] = [];
    if (packet.rawContent) parts.push(`## Original Source Content\n${packet.rawContent}`);
    if (packet.deepFetchContent) parts.push(`## Deep-Fetched Content\n${packet.deepFetchContent}`);
    if (packet.metadata?.externalUrls?.length) {
      parts.push(`## External Links\n${packet.metadata.externalUrls.join("\n")}`);
    }
    if (packet.metadata?.extractedTopics?.length) {
      parts.push(`## Extracted Topics\n${packet.metadata.extractedTopics.join(", ")}`);
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch {
    return null;
  }
}

/**
 * Build a concise Telegram HTML breakdown of a source packet from enrichment data.
 * No LLM call — uses structured enrichment already produced by the pipeline.
 */
function buildPacketBreakdown(packet: SourcePacket): string {
  const parts: string[] = [];
  const e = packet.enrichment;

  parts.push(`<b>${escapeHtml(packet.title ?? "Source Packet")}</b>\n`);

  // Core idea
  if (e?.deepDive?.coreClaim) {
    parts.push(`<b>核心观点:</b> ${escapeHtml(e.deepDive.coreClaim)}`);
  } else if (e?.candidate?.content) {
    const preview = e.candidate.content.slice(0, 400);
    parts.push(`<b>核心观点:</b> ${escapeHtml(preview)}${e.candidate.content.length > 400 ? "..." : ""}`);
  } else if (packet.summary) {
    parts.push(`<b>核心观点:</b> ${escapeHtml(packet.summary)}`);
  }

  // Why it matters
  const whyParts: string[] = [];
  if (e?.candidate?.relevance) whyParts.push(e.candidate.relevance);
  if (e?.critique?.strengths?.length) whyParts.push(e.critique.strengths.slice(0, 2).join(". "));
  if (whyParts.length) {
    parts.push(`\n<b>为什么重要:</b> ${escapeHtml(whyParts.join(". "))}`);
  }

  // Homer/project relevance
  if (e?.homerImprovement?.relevant && e.homerImprovement.summary) {
    const area = e.homerImprovement.area ?? "";
    const priority = e.homerImprovement.priority ?? "";
    const suffix = area ? ` (${escapeHtml(area)}${priority ? `, ${priority}` : ""})` : "";
    parts.push(`\n<b>Homer关联:</b> ${escapeHtml(e.homerImprovement.summary)}${suffix}`);
  }

  // Risks / open questions
  const questions: string[] = [];
  if (e?.critique?.risks?.length) {
    questions.push(...e.critique.risks.slice(0, 2));
  }
  if (e?.deepDive?.validationPath) {
    questions.push(`Validate: ${e.deepDive.validationPath}`);
  }
  if (questions.length) {
    parts.push(`\n<b>风险与疑点:</b>`);
    for (const q of questions) {
      parts.push(`- ${escapeHtml(q)}`);
    }
  }

  // Deep links
  if (e?.deepLinks?.length) {
    const linkStr = e.deepLinks.slice(0, 3)
      .map((l: any) => `${escapeHtml(l.target)} (${escapeHtml(l.relationship)})`)
      .join(", ");
    parts.push(`\n<b>关联:</b> ${linkStr}`);
  }

  // Source URL
  if (packet.primaryUrl) {
    parts.push(`\n<a href="${escapeHtml(packet.primaryUrl)}">Source</a>`);
  }

  parts.push(`\n<code>${escapeHtml(packet.id)}</code>`);
  parts.push(`\nReply to discuss.`);

  return parts.join("\n");
}

/**
 * Generate a conversational AI reply within a discussion thread.
 * Loads discussion history and packet context, calls Sonnet.
 */
async function generateDiscussionReply(
  db: any,
  discussionId: string,
  latestUserMessage: string,
): Promise<string> {
  const messages = discussionDao.getMessages(db, discussionId);

  // System message (first msg) has full packet context
  const systemContext = (messages.find(m => m.role === "system")?.content ?? "").slice(0, 6000);

  // Recent conversation turns (skip system, last 10)
  const recentTurns = messages
    .filter(m => m.role !== "system")
    .slice(-10)
    .map(m => `${m.role === "user" ? "User" : "Homer"}: ${m.content}`)
    .join("\n\n");

  const prompt = `You are Homer, having a focused discussion about a source packet or idea with Yanqing.

## Context
${systemContext}

## Conversation so far
${recentTurns}

## Latest message from Yanqing
${latestUserMessage}

## Instructions
- Respond directly to what Yanqing said
- Stay on topic. Be concise (2-4 paragraphs max)
- Be opinionated and analytical. Challenge weak thinking. Surface non-obvious connections
- Connect to active projects/goals (career, trading, Homer, analytics, P&G) when relevant
- Respond in the same language the user uses (Chinese or English)
- Output valid Telegram HTML only. No Markdown. No code fences
- End with a follow-up question or observation to keep discussion productive`;

  const { executeResolvedHarness } = await import("../../harness/dispatch.js");
  const result = await executeResolvedHarness({
    source: "runtime",
    mode: "runtime-turn",
    prompt,
    cwd: config.paths.homerRoot,
    timeoutMs: 900_000,
    outputContract: { kind: "text" },
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output?.slice(0, 300) || "Discussion reply generation failed");
  }

  return (result.output ?? "")
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "");
}

/**
 * Format a source packet for Telegram morning review.
 */
export function formatPacketForTelegram(packet: SourcePacket, index: number): string {
  const emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"][index] || "▪️";
  const title = escapeHtml(packet.title ?? "Untitled Source");
  const source = escapeHtml(packet.sourceType);
  const enrichment = packet.enrichment;
  const candidate = enrichment?.candidate;
  const confidence = candidate?.confidence;
  const indicator = confidence !== undefined
    ? (confidence >= 0.7 ? " 🟢" : confidence >= 0.5 ? " 🟡" : " 🔴")
    : "";
  const tags = candidate?.tags ?? packet.metadata?.extractedTopics ?? [];
  const tagsStr = tags.length ? ` · ${tags.filter((t: string) => t !== "synthesized").map((t: string) => escapeHtml(t)).join(", ")}` : "";

  let msg = `<b>${emoji} ${title}</b>${indicator}\n`;
  msg += `${source}${tagsStr}\n\n`;

  // Show enrichment if available
  if (enrichment) {
    const dive = enrichment.deepDive;
    const links = enrichment.deepLinks ?? [];
    const imp = enrichment.homerImprovement;

    if (dive?.coreClaim) {
      msg += `${escapeHtml(dive.coreClaim)}\n`;
    } else if (candidate?.content) {
      const preview = candidate.content.slice(0, 400);
      msg += `${escapeHtml(preview)}${candidate.content.length > 400 ? "..." : ""}\n`;
    }

    if (links.length) {
      const linkStr = links.slice(0, 3).map((l: { target: string }) => escapeHtml(l.target)).join(", ");
      msg += `\n🔗 <i>${escapeHtml(links[0]?.relationship ?? "connects to")}: ${linkStr}</i>\n`;
    }

    if (imp?.relevant && imp.summary) {
      const priorityIcon = imp.priority === "high" ? "🔴" : imp.priority === "medium" ? "🟡" : "🟢";
      msg += `⚡ ${priorityIcon} <b>${escapeHtml(imp.summary)}</b>\n`;
    }
  } else {
    // Show raw content preview
    const preview = (packet.rawContent ?? "").slice(0, 400);
    msg += `${escapeHtml(preview)}${(packet.rawContent ?? "").length > 400 ? "..." : ""}\n`;
  }

  if (packet.primaryUrl) {
    msg += `\n<a href="${escapeHtml(packet.primaryUrl)}">来源链接</a>\n`;
  }
  msg += `\n<code>${escapeHtml(packet.id)}</code>`;
  return formatScheduledTelegramHtml(msg);
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
  // Legacy: idea snooze — no longer rendered, kept for old messages
  bot.callbackQuery(/^a:i:([^:]+):snooze$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active. Use Talk or Skip.");
  });

  // Legacy: idea review — no longer rendered, kept for old messages
  bot.callbackQuery(/^a:i:([^:]+):review$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active. Use Talk or Skip.");
  });

  // Handle talk button on IDEAS — creates/resumes a real discussion thread
  bot.callbackQuery(/^a:i:([^:]+):talk$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) { await ctx.answerCallbackQuery("Invalid request"); return; }

    try {
      const db = stateManagerRef?.getDb();
      const idea = db ? dao.getIdea(db, ideaId) : null;
      if (!idea || !db) {
        await ctx.editMessageText(`❌ Idea not found: ${escapeHtml(ideaId)}`, { parse_mode: "HTML" });
        return;
      }

      await ctx.answerCallbackQuery("Discussion opened below");

      // Get or create discussion for this idea
      const discussion = discussionDao.getOrCreateDiscussion(db, {
        ideaId: idea.id,
        title: idea.title,
      });

      const msgCount = discussionDao.messageCount(db, discussion.id);

      // Update status to discussion
      dao.updateIdea(db, idea.id, { status: "discussion" });

      // Load full packet context if available
      const packetContent = await loadPacketContextForIdea(db, idea);

      // Send discussion opener as a NEW message (edits are invisible on Telegram)
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      let headerMsg = `💬 <b>Discussion: ${escapeHtml(idea.title)}</b>\n`;
      headerMsg += `<code>${escapeHtml(discussion.id)}</code>\n`;
      if (msgCount > 0) {
        headerMsg += `\n📝 Resuming thread (${msgCount} prior messages)\n`;
      }
      headerMsg += `\nReply to this message to continue the discussion.`;
      if (packetContent) {
        headerMsg += `\n\n<b>Source material loaded</b> (full packet context available)`;
      }

      const sent = await ctx.reply(formatScheduledTelegramHtml(headerMsg), {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      });

      // Track the NEW message for reply capture
      pendingDiscussions.set(sent.message_id, {
        discussionId: discussion.id,
        ideaId: idea.id,
        title: idea.title,
        createdAt: Date.now(),
      });
      // Also track the original message in case user replies to that
      const origMessageId = ctx.callbackQuery?.message?.message_id;
      if (origMessageId) {
        pendingDiscussions.set(origMessageId, {
          discussionId: discussion.id,
          ideaId: idea.id,
          title: idea.title,
          createdAt: Date.now(),
        });
      }

      logger.info({ ideaId: idea.id, discussionId: discussion.id, resumed: msgCount > 0 }, "Idea discussion opened in Telegram");

      // Record system message with full source context (only for new discussions)
      if (msgCount === 0) {
        const contextParts: string[] = [`Discussion started from Telegram on idea: ${idea.title}`];
        if (packetContent) {
          contextParts.push(packetContent);
        } else {
          if (idea.content) contextParts.push(`## Idea Content\n${idea.content}`);
          if (idea.context) contextParts.push(`## Context\n${idea.context}`);
        }
        if (idea.notes) contextParts.push(`## Notes\n${idea.notes}`);
        if (idea.enrichment) {
          try {
            const enrichment = JSON.parse(idea.enrichment);
            if (enrichment.deep_links?.length) {
              contextParts.push(`## Connections\n${enrichment.deep_links.map((l: any) => `- ${l.target} (${l.relationship})`).join("\n")}`);
            }
          } catch { /* ignore parse errors */ }
        }

        discussionDao.addMessage(db, {
          discussionId: discussion.id,
          role: "system",
          content: contextParts.join("\n\n"),
          metadata: { source: "telegram", ideaId: idea.id },
        });
      }

      // Feedback tracking
      sendPreferenceSignals(idea, 0.2);
      try {
        recordFeedback(db, {
          contentType: "idea",
          contentId: ideaId,
          action: "talk",
          source: "telegram",
          impressionId: pendingImpressions.get(ideaId)?.impressionId,
          delta: 0.2,
        });
      } catch { /* best-effort */ }
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to start discussion");
      await ctx.answerCallbackQuery("Error starting discussion");
    }
  });

  // Handle talk button on PACKETS — creates discussion over a source packet
  bot.callbackQuery(/^a:p:([^:]+):talk$/, async (ctx) => {
    const packetId = ctx.match?.[1];
    if (!packetId) { await ctx.answerCallbackQuery("Invalid request"); return; }

    try {
      const db = stateManagerRef?.getDb();
      if (!db) { await ctx.answerCallbackQuery("DB unavailable"); return; }

      const packet = packetDao.getPacket(db, packetId);
      if (!packet) {
        await ctx.editMessageText(`❌ Packet not found: ${escapeHtml(packetId)}`, { parse_mode: "HTML" });
        return;
      }

      await ctx.answerCallbackQuery("Discussion opened below");

      // Get or create discussion for this packet
      const discussion = discussionDao.getOrCreateDiscussion(db, {
        packetId: packet.id,
        title: packet.title ?? "Source packet discussion",
      });

      const msgCount = discussionDao.messageCount(db, discussion.id);

      // Update packet status
      packetDao.updatePacket(db, packet.id, { status: "review" });

      const chatId = ctx.chat?.id;
      if (!chatId) return;

      // Build discussion opener as a NEW message (edits are invisible on Telegram)
      let displayMsg = `💬 <b>Discussion: ${escapeHtml(packet.title ?? "Source Packet")}</b>\n`;
      displayMsg += `<code>${escapeHtml(discussion.id)}</code>\n`;
      if (msgCount > 0) {
        displayMsg += `\n📝 Resuming thread (${msgCount} prior messages)\n`;
      } else {
        // Include packet breakdown for new discussions
        const breakdown = buildPacketBreakdown(packet);
        // Strip the trailing "Reply to discuss." since we add our own
        displayMsg += `\n${breakdown.replace(/\nReply to discuss\.\s*$/, "")}\n`;
      }
      displayMsg += `\nReply to this message to continue the discussion.`;

      const sent = await ctx.reply(formatScheduledTelegramHtml(displayMsg), {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      });

      // Track the NEW message for reply capture
      pendingDiscussions.set(sent.message_id, {
        discussionId: discussion.id,
        packetId: packet.id,
        title: packet.title ?? "Source Packet",
        createdAt: Date.now(),
      });
      // Also track the original message in case user replies to that
      const origMessageId = ctx.callbackQuery?.message?.message_id;
      if (origMessageId) {
        pendingDiscussions.set(origMessageId, {
          discussionId: discussion.id,
          packetId: packet.id,
          title: packet.title ?? "Source Packet",
          createdAt: Date.now(),
        });
      }

      // Record system message with full packet context (only for new discussions)
      if (msgCount === 0) {
        const packetParts: string[] = [`Discussion started from Telegram on packet: ${packet.title ?? packet.id}`];
        if (packet.rawContent) packetParts.push(`## Original Source Content\n${packet.rawContent}`);
        if (packet.deepFetchContent) packetParts.push(`## Deep-Fetched Content\n${packet.deepFetchContent}`);
        if (packet.metadata?.externalUrls?.length) {
          packetParts.push(`## External Links\n${packet.metadata.externalUrls.join("\n")}`);
        }
        if (packet.metadata?.extractedTopics?.length) {
          packetParts.push(`## Extracted Topics\n${packet.metadata.extractedTopics.join(", ")}`);
        }
        if (packet.enrichment) {
          const e = packet.enrichment;
          if (e.deepDive?.coreClaim) packetParts.push(`## Core Claim\n${e.deepDive.coreClaim}`);
          if (e.deepLinks?.length) {
            packetParts.push(`## Connections\n${e.deepLinks.map((l: any) => `- ${l.target} (${l.relationship})`).join("\n")}`);
          }
        }

        discussionDao.addMessage(db, {
          discussionId: discussion.id,
          role: "system",
          content: packetParts.join("\n\n"),
          metadata: { source: "telegram", packetId: packet.id },
        });
      }

      // Feedback tracking (was missing for packets)
      try {
        recordFeedback(db, {
          contentType: "packet",
          contentId: packetId,
          action: "talk",
          source: "telegram",
          impressionId: pendingImpressions.get(packetId)?.impressionId,
          delta: 0.2,
        });
      } catch { /* best-effort */ }

      logger.info({ packetId: packet.id, discussionId: discussion.id, resumed: msgCount > 0 }, "Packet discussion opened in Telegram");
    } catch (error) {
      logger.error({ error, packetId }, "Failed to start packet discussion");
      await ctx.answerCallbackQuery("Error starting discussion");
    }
  });

  // Legacy: packet snooze — no longer rendered, kept for old messages
  bot.callbackQuery(/^a:p:([^:]+):snooze$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active. Use Talk or Skip.");
  });

  // Handle archive on PACKETS
  bot.callbackQuery(/^a:p:([^:]+):archive$/, async (ctx) => {
    const packetId = ctx.match?.[1];
    if (!packetId) { await ctx.answerCallbackQuery("Invalid request"); return; }
    try {
      const db = stateManagerRef?.getDb();
      if (!db) { await ctx.answerCallbackQuery("DB unavailable"); return; }
      const packet = packetDao.getPacket(db, packetId);
      if (packet) {
        packetDao.updatePacket(db, packet.id, { status: "archived" });
        await ctx.editMessageText(`🗂 <b>Archived: ${escapeHtml(packet.title ?? packetId)}</b>`, { parse_mode: "HTML" });
      } else {
        await ctx.editMessageText(`❌ Packet not found`, { parse_mode: "HTML" });
      }
    } catch (error) {
      logger.error({ error, packetId }, "Failed to archive packet");
      await ctx.answerCallbackQuery("Error");
    }
  });

  // Legacy: packet deep dive — no longer rendered, kept for old messages
  bot.callbackQuery(/^a:p:([^:]+):deep_dive$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active. Use Talk or Skip.");
  });

  // Legacy: idea deep dive — no longer rendered, kept for old messages
  bot.callbackQuery(/^a:i:([^:]+):deep_dive$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active. Use Talk or Skip.");
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

    // Plan review revision replies
    if (pendingPlanRevisions.has(replyTo)) {
      const chatId = ctx.chat?.id;
      if (chatId) {
        const consumed = await handlePlanRevisionReply(
          bot, stateManager, replyTo, ctx.message.text.trim(), chatId,
        );
        if (consumed) return;
      }
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

    // Discussion reply handler — user replies to a discussion header or AI response
    if (pendingDiscussions.has(replyTo)) {
      const pending = pendingDiscussions.get(replyTo)!;
      const userText = ctx.message.text.trim();
      if (!userText) {
        await ctx.reply("❌ Message cannot be empty.");
        return;
      }

      try {
        const db = stateManagerRef?.getDb();
        if (!db) {
          await ctx.reply("❌ DB unavailable");
          return;
        }

        // Verify discussion still exists and is active
        const discussion = discussionDao.getDiscussion(db, pending.discussionId);
        if (!discussion || discussion.status !== "active") {
          await ctx.reply("❌ Discussion ended or not found.");
          pendingDiscussions.delete(replyTo);
          return;
        }

        // Save user message
        discussionDao.addMessage(db, {
          discussionId: pending.discussionId,
          role: "user",
          content: userText,
          metadata: { source: "telegram", telegramMessageId: ctx.message.message_id },
        });

        logger.info(
          { discussionId: pending.discussionId, length: userText.length },
          "User reply saved to discussion"
        );

        // Typing indicator
        const replyChatId = ctx.chat?.id;
        if (!replyChatId) return;
        await ctx.api.sendChatAction(replyChatId, "typing");

        // Generate AI response
        const aiResponse = await generateDiscussionReply(db, pending.discussionId, userText);

        // Save assistant message
        discussionDao.addMessage(db, {
          discussionId: pending.discussionId,
          role: "assistant",
          content: aiResponse,
          metadata: { source: "telegram", model: "sonnet" },
        });

        // Send response (reply to user's message for visual threading)
        const sent = await ctx.reply(
          formatScheduledTelegramHtml(aiResponse),
          {
            parse_mode: "HTML",
            reply_to_message_id: ctx.message.message_id,
          }
        );

        // Register AI response message so user can reply to it and continue the chain
        pendingDiscussions.set(sent.message_id, {
          ...pending,
          createdAt: Date.now(),
        });

        logger.info(
          { discussionId: pending.discussionId, responseMessageId: sent.message_id },
          "Discussion AI response sent"
        );
      } catch (error) {
        logger.error({ error, discussionId: pending.discussionId }, "Discussion reply failed");
        try {
          await ctx.reply(
            `⚠️ Reply failed: ${escapeHtml((error instanceof Error ? error.message : String(error)).slice(0, 200))}`,
            { parse_mode: "HTML" }
          );
        } catch { /* best-effort */ }
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

  const db = stateManagerRef?.getDb();
  let sent = 0;

  // ========================================
  // PHASE 1: Send queued source packets first (new pipeline)
  // ========================================
  if (db) {
    const packets = packetDao.getReviewQueue(db, remaining);
    if (packets.length > 0) {
      // Create review session
      let reviewSessionId: string | undefined;
      try {
        reviewSessionId = createReviewSession(db, "packet_review", packets.length);
      } catch (err) {
        logger.warn({ error: err }, "Failed to create review session");
      }

      await bot.api.sendMessage(
        chatId,
        formatScheduledTelegramHtml(`📋 <b>新发现审阅</b> (${packets.length})`),
        { parse_mode: "HTML" }
      );

      for (let i = 0; i < packets.length; i++) {
        const packet = packets[i]!;
        const message = formatPacketForTelegram(packet, i);
        const keyboard = createPacketKeyboard(packet.id);

        try {
          await bot.api.sendMessage(chatId, message, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
          sent++;

          // Record impression
          if (reviewSessionId) {
            try {
              const impressionId = recordImpression(db, {
                sessionId: reviewSessionId,
                contentType: "packet",
                contentId: packet.id,
                position: i,
                scoreAtDisplay: packet.enrichment?.candidate?.confidence,
              });
              pendingImpressions.set(packet.id, { impressionId, displayedAt: Date.now() });
            } catch (err) {
              logger.warn({ error: err, packetId: packet.id }, "Failed to record impression");
            }
          }

          // Mark packet as under review
          packetDao.updatePacket(db, packet.id, { status: "review" });
        } catch (error) {
          logger.error({ error, packetId: packet.id }, "Failed to send packet for review");
        }

        if (i < packets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      if (reviewSessionId) {
        try { completeReviewSession(db, reviewSessionId); } catch { /* best-effort */ }
      }

      remaining -= sent;
      logger.info({ count: sent, ids: packets.map(p => p.id) }, "Sent source packets for review");
    }
  }

  // Legacy Phase 2 removed — morning review is packets-only now.
  // Ideas are only created via explicit Promote action.

  if (stateManagerRef && sent > 0) {
    stateManagerRef.incrementIdeaReviewCount(sent);
  }

  logger.info({ count: sent }, "Morning review complete (packets + ideas)");
  return sent;
}

// ============================================
// Plan Review Cards (Structured Approve/Revise/Deny)
// ============================================

import type { GeneratedPlan } from "../../plans/review-types.js";
import { renderPlanCard, renderPlanDetails, renderRevisionPrompt, renderApproved, renderDenied } from "../../plans/review-renderer.js";
import { parsePlanFromOutput } from "../../plans/review-parser.js";

// Track pending revision replies (telegram messageId -> plan context)
interface PendingPlanRevision {
  planId: string;
  chatId: number;
  createdAt: number;
}
const pendingPlanRevisions = new Map<number, PendingPlanRevision>();
staleMapCleaner.register(pendingPlanRevisions, "plan-revisions", {
  maxAgeMs: 2 * 60 * 60 * 1000,  // 2 hours
  timestampKey: "createdAt",
});

/**
 * Create inline keyboard for plan review card.
 * Uses plan:* namespace to avoid collision with existing a:p:* handlers.
 */
export function createPlanReviewKeyboard(planId: string): InlineKeyboard {
  // Telegram 64-byte limit for callback_data
  const maxIdLen = 64 - "plan:approve:".length;
  const id = planId.length > maxIdLen ? planId.slice(0, maxIdLen) : planId;
  return new InlineKeyboard()
    .text("✅ Approve", `plan:approve:${id}`)
    .text("✏️ Revise", `plan:revise:${id}`)
    .text("❌ Deny", `plan:deny:${id}`);
}

/**
 * Send a structured plan review card to Telegram.
 * Can be called from scheduler, Claude sessions, or any executor.
 */
export async function sendPlanForReview(
  bot: Bot,
  stateManager: StateManager,
  chatId: number,
  plan: GeneratedPlan,
): Promise<number | null> {
  // Store structured plan
  stateManager.savePlanReview(
    plan.id,
    JSON.stringify(plan),
    plan.title,
    plan.riskLevel,
    plan.source,
    chatId,
  );

  // Also save raw text in old table for backward compat
  if (plan.rawText) {
    stateManager.savePendingPlan(plan.id, plan.rawText);
  }

  try {
    // Send summary card
    const card = renderPlanCard(plan);
    const cardMsg = await bot.api.sendMessage(chatId, card, {
      parse_mode: "HTML",
      reply_markup: createPlanReviewKeyboard(plan.id),
    });

    // Update with message ID
    stateManager.updatePlanReviewStatus(plan.id, "pending_review", {
      cardMessageId: cardMsg.message_id,
    });

    // Send detail messages if plan is large
    const details = renderPlanDetails(plan);
    for (const detail of details) {
      await bot.api.sendMessage(chatId, detail, { parse_mode: "HTML" });
    }

    logger.info({ planId: plan.id, phases: plan.phases.length }, "Plan review card sent");
    return cardMsg.message_id;
  } catch (err) {
    logger.error({ planId: plan.id, error: err }, "Failed to send plan review card");
    return null;
  }
}

/**
 * Register plan review card callback handlers (plan:approve, plan:revise, plan:deny).
 */
export function registerPlanReviewCallbacks(bot: Bot, stateManager: StateManager): void {

  // ── Approve ──
  bot.callbackQuery(/^plan:approve:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) { await ctx.answerCallbackQuery("Invalid"); return; }

    const review = stateManager.getPlanReview(planId);
    if (!review || review.status !== "pending_review") {
      await ctx.answerCallbackQuery("Plan not found or already processed");
      return;
    }

    const plan: GeneratedPlan = JSON.parse(review.planJson);

    // Edit card to approved
    await ctx.editMessageText(renderApproved(plan), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery("Plan approved — executing!");

    stateManager.updatePlanReviewStatus(planId, "approved", { decidedAt: true });
    logger.info({ planId }, "Plan approved via review card");

    try {
      recordFeedback(stateManager.getDb(), {
        contentType: "plan",
        contentId: planId,
        action: "approve",
        source: "telegram",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    // Execute plan
    const chatId = ctx.chat?.id;
    if (chatId) {
      stateManager.updatePlanReviewStatus(planId, "executing");
      stateManager.clearPendingPlan(planId);

      import("../../harness/dispatch.js").then(({ executeResolvedHarness }) => {
        const rawPlan = plan.rawText || review.planJson;
        const prompt = `You are implementing an approved Homer improvement plan.

## The Plan

${rawPlan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes described. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT push to remote, restart the daemon, or modify .env/credentials/CLAUDE.md.
7. Do NOT create git branches — work directly on the current branch.

Output a brief summary of what you changed and whether the build passes.`;

        executeResolvedHarness({
          source: "runtime",
          mode: "runtime-turn",
          prompt,
          cwd: config.paths.homerRoot,
          timeoutMs: 20 * 60 * 1000,
          requiredCapabilities: [
            { capability: "code.edit", required: true, reason: "implement approved plan" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run npm build + commit" },
          ],
        }).then(async (result) => {
          stateManager.updatePlanReviewStatus(planId, "completed");
          const summary = (result.output || "completed").slice(0, 1500);
          try {
            await bot.api.sendMessage(chatId,
              `✅ <b>Plan implemented</b>\n<b>${escapeHtml(plan.title)}</b>\n\n${escapeHtml(summary)}`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        }).catch(async (err) => {
          stateManager.updatePlanReviewStatus(planId, "completed", { feedback: String(err).slice(0, 500) });
          logger.error({ planId, error: err }, "Plan execution failed");
          try {
            await bot.api.sendMessage(chatId,
              `❌ <b>Plan failed</b>\n<b>${escapeHtml(plan.title)}</b>\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        });
      }).catch(err => logger.error({ planId, error: err }, "Failed to import harness dispatch"));
    }
  });

  // ── Revise ──
  bot.callbackQuery(/^plan:revise:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) { await ctx.answerCallbackQuery("Invalid"); return; }

    const review = stateManager.getPlanReview(planId);
    if (!review || review.status !== "pending_review") {
      await ctx.answerCallbackQuery("Plan not found or already processed");
      return;
    }

    const plan: GeneratedPlan = JSON.parse(review.planJson);

    // Edit card to show revision requested
    await ctx.editMessageText(renderRevisionPrompt(plan), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery("Reply with what to change");

    stateManager.updatePlanReviewStatus(planId, "awaiting_revision");

    // Send force_reply prompt
    const chatId = ctx.chat?.id;
    if (chatId) {
      try {
        const promptMsg = await bot.api.sendMessage(chatId, renderRevisionPrompt(plan), {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        });

        pendingPlanRevisions.set(promptMsg.message_id, {
          planId,
          chatId,
          createdAt: Date.now(),
        });
      } catch (err) {
        logger.error({ planId, error: err }, "Failed to send revision prompt");
      }
    }
  });

  // ── Deny ──
  bot.callbackQuery(/^plan:deny:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) { await ctx.answerCallbackQuery("Invalid"); return; }

    const review = stateManager.getPlanReview(planId);
    if (!review || review.status !== "pending_review") {
      await ctx.answerCallbackQuery("Plan not found or already processed");
      return;
    }

    const plan: GeneratedPlan = JSON.parse(review.planJson);

    await ctx.editMessageText(renderDenied(plan), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery("Plan denied");

    stateManager.updatePlanReviewStatus(planId, "denied", { decidedAt: true });
    stateManager.clearPendingPlan(planId);

    logger.info({ planId }, "Plan denied via review card");

    try {
      recordFeedback(stateManager.getDb(), {
        contentType: "plan",
        contentId: planId,
        action: "reject",
        source: "telegram",
        delta: -0.1,
      });
    } catch { /* best-effort */ }
  });

  logger.info("Plan review card callbacks registered");
}

/**
 * Handle revision reply — called from the main message:text handler.
 * Returns true if the message was consumed as a revision reply.
 */
export async function handlePlanRevisionReply(
  bot: Bot,
  stateManager: StateManager,
  replyToMessageId: number,
  feedbackText: string,
  chatId: number,
): Promise<boolean> {
  const pending = pendingPlanRevisions.get(replyToMessageId);
  if (!pending) return false;

  pendingPlanRevisions.delete(replyToMessageId);

  const review = stateManager.getPlanReview(pending.planId);
  if (!review) {
    await bot.api.sendMessage(chatId, `❌ Plan not found: <code>${escapeHtml(pending.planId)}</code>`, { parse_mode: "HTML" });
    return true;
  }

  const oldPlan: GeneratedPlan = JSON.parse(review.planJson);

  stateManager.updatePlanReviewStatus(pending.planId, "revising");

  const historyContext = `Revision ${oldPlan.revisionNumber}: ${feedbackText}`;

  await bot.api.sendMessage(chatId, `🔄 <b>Revising plan...</b>\n<i>${escapeHtml(feedbackText.slice(0, 200))}</i>`, { parse_mode: "HTML" });

  try {
    const { executeResolvedHarness } = await import("../../harness/dispatch.js");
    const prompt = `You are revising a Homer implementation plan based on user feedback.

## Original Plan
${oldPlan.rawText || JSON.stringify(oldPlan, null, 2)}

## Revision History
${historyContext}

## Latest Feedback
${feedbackText}

## Instructions
1. Read the original plan carefully.
2. Apply the user's feedback to produce a REVISED plan.
3. Keep the same structure: ## Implementation Plan, ### Step N:, **Files:**, **Risk:**
4. Only change what the feedback asks for. Keep everything else.
5. Output ONLY the revised plan text, nothing else.`;

    const result = await executeResolvedHarness({
      source: "runtime",
      mode: "runtime-turn",
      prompt,
      cwd: config.paths.homerRoot,
      timeoutMs: 90_000,
      outputContract: { kind: "text" },
    });

    if (result.exitCode !== 0) throw new Error(result.output?.slice(0, 300) || "Revision failed");

    // Parse new plan
    const newPlan = parsePlanFromOutput(result.output || "", oldPlan.source);
    newPlan.revisionNumber = oldPlan.revisionNumber + 1;
    newPlan.id = oldPlan.id;  // Keep same ID, bump version

    // Mark old as superseded
    stateManager.updatePlanReviewStatus(pending.planId, "superseded");

    // Save and send new card
    stateManager.savePlanReview(
      newPlan.id,
      JSON.stringify(newPlan),
      newPlan.title,
      newPlan.riskLevel,
      newPlan.source,
      chatId,
    );
    if (newPlan.rawText) stateManager.savePendingPlan(newPlan.id, newPlan.rawText);

    // Send new card
    const card = renderPlanCard(newPlan);
    const cardMsg = await bot.api.sendMessage(chatId, card, {
      parse_mode: "HTML",
      reply_markup: createPlanReviewKeyboard(newPlan.id),
    });

    stateManager.updatePlanReviewStatus(newPlan.id, "pending_review", {
      cardMessageId: cardMsg.message_id,
      revisionNumber: newPlan.revisionNumber,
    });

    // Send details if needed
    const details = renderPlanDetails(newPlan);
    for (const detail of details) {
      await bot.api.sendMessage(chatId, detail, { parse_mode: "HTML" });
    }

    logger.info({ planId: newPlan.id, revision: newPlan.revisionNumber }, "Plan revised and resent");
  } catch (err) {
    logger.error({ planId: pending.planId, error: err }, "Plan revision failed");
    // Restore to pending_review so user can try again
    stateManager.updatePlanReviewStatus(pending.planId, "pending_review");
    await bot.api.sendMessage(chatId,
      `❌ <b>Revision failed</b>\n<code>${escapeHtml(String(err).slice(0, 300))}</code>\n\nOriginal plan restored. Try again.`,
      { parse_mode: "HTML" }
    );
  }

  return true;
}

// ============================================
// Implementation Plan Approval (Legacy)
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

    // Fire-and-forget: spawn the selected harness to implement the plan on main (no branch)
    const cmdChatId = ctx.chat?.id;
    if (cmdChatId) {
      import("../../harness/dispatch.js").then(({ executeResolvedHarness }) => {
        const prompt = `You are implementing an approved Homer improvement plan.

## The Plan

${plan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes described. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT push to remote, restart the daemon, or modify .env/credentials/CLAUDE.md.
7. Do NOT create git branches — work directly on the current branch.

Output a brief summary of what you changed and whether the build passes.`;

        executeResolvedHarness({
          source: "runtime",
          mode: "runtime-turn",
          prompt,
          cwd: config.paths.homerRoot,
          timeoutMs: 20 * 60 * 1000,
          requiredCapabilities: [
            { capability: "code.edit", required: true, reason: "implement approved plan" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run npm build + commit" },
          ],
        }).then(async (result) => {
          const summary = (result.output || "completed").slice(0, 1500);
          try {
            await bot.api.sendMessage(cmdChatId,
              `✅ <b>Plan implemented</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<b>Result:</b>\n${escapeHtml(summary)}`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        }).catch(async (err) => {
          logger.error({ jobId, error: err }, "Plan implementation via selected harness failed");
          try {
            await bot.api.sendMessage(cmdChatId,
              `❌ <b>Plan implementation failed</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        });
      }).catch(err => {
        logger.error({ jobId, error: err }, "Failed to import claude executor");
      });
    }
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

    // Fire-and-forget: spawn the selected harness to implement the plan on main (no branch)
    const chatId = ctx.chat?.id;
    if (chatId) {
      stateManager.clearPendingPlan(jobId);
      import("../../harness/dispatch.js").then(({ executeResolvedHarness }) => {
        const prompt = `You are implementing an approved Homer improvement plan.

## The Plan

${plan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes described. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT push to remote, restart the daemon, or modify .env/credentials/CLAUDE.md.
7. Do NOT create git branches — work directly on the current branch.

Output a brief summary of what you changed and whether the build passes.`;

        executeResolvedHarness({
          source: "runtime",
          mode: "runtime-turn",
          prompt,
          cwd: config.paths.homerRoot,
          timeoutMs: 20 * 60 * 1000,
          requiredCapabilities: [
            { capability: "code.edit", required: true, reason: "implement approved plan" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run npm build + commit" },
          ],
        }).then(async (result) => {
          const summary = (result.output || "completed").slice(0, 1500);
          try {
            await bot.api.sendMessage(chatId,
              `✅ <b>Plan implemented</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<b>Result:</b>\n${escapeHtml(summary)}`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        }).catch(async (err) => {
          logger.error({ jobId, error: err }, "Plan implementation via selected harness failed");
          try {
            await bot.api.sendMessage(chatId,
              `❌ <b>Plan implementation failed</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        });
      }).catch(err => {
        logger.error({ jobId, error: err }, "Failed to import harness dispatch");
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
