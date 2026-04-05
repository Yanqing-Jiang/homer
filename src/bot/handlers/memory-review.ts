/**
 * Memory Review Handlers — Telegram callbacks for human-gated memory curation.
 *
 * Callback namespace: m:* (all under 20 bytes)
 *   m:a:<id>  — approve candidate
 *   m:r:<id>  — reject candidate
 *   m:e:<id>  — start edit (captures next reply)
 *   m:t:<id>  — start talk/discussion
 *   m:x:<id>  — expand (show full content + sources)
 *   m:lr:<id> — lint: remove (archive)
 *   m:lu:<id> — lint: update (start thread)
 *   m:lk:<id> — lint: keep (validate)
 */

import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import { getCanonicalMemoryService } from "../../memory/canonical-service.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import {
  approveCandidate,
  rejectCandidate,
  editAndApprove,
  getClaim,
  setClaimTelegramMessage,
  markClaimValidated,
  archiveClaim,
  type KnowledgeClaim,
} from "../../memory/claims.js";
import {
  formatScheduledTelegramHtml,
} from "../../notifications/telegram-router.js";
import { escapeHtml } from "../../utils/telegram-format.js";
import { staleMapCleaner } from "../../utils/stale-map-cleaner.js";

// ── State tracking ──────────────────────────────────────────

interface PendingEdit {
  claimId: string;
  createdAt: number;
}

interface PendingTalk {
  claimId: string;
  title: string;
  createdAt: number;
}

const pendingEdits = new Map<number, PendingEdit>();
const pendingTalks = new Map<number, PendingTalk>();

staleMapCleaner.register(pendingEdits, "memory:edits", { maxAgeMs: 60 * 60 * 1000 }); // 1hr
staleMapCleaner.register(pendingTalks, "memory:talks", { maxAgeMs: 4 * 60 * 60 * 1000 }); // 4hr

let stateManagerRef: StateManager | null = null;

// ── Claim Type Badges ───────────────────────────────────────

const CLAIM_BADGES: Record<string, string> = {
  fact: "📝",
  decision: "⚖️",
  preference: "🎯",
  hypothesis: "🔬",
  insight: "💡",
  commitment: "📅",
  question: "❓",
  lesson: "⚠️",
};

// ── Keyboard Builders ───────────────────────────────────────

function createCandidateKeyboard(claimId: string): InlineKeyboard {
  const id = claimId.slice(-10);
  return new InlineKeyboard()
    .text("✅ Approve", `m:a:${id}`)
    .text("✏️ Edit", `m:e:${id}`)
    .row()
    .text("❌ Reject", `m:r:${id}`)
    .text("💬 Talk", `m:t:${id}`);
}

function createLintKeyboard(claimId: string): InlineKeyboard {
  const id = claimId.slice(-10);
  return new InlineKeyboard()
    .text("🗑 Remove", `m:lr:${id}`)
    .text("📝 Update", `m:lu:${id}`)
    .text("✅ Keep", `m:lk:${id}`);
}

// ── Formatting ──────────────────────────────────────────────

function formatCandidateCard(claim: KnowledgeClaim): string {
  const badge = CLAIM_BADGES[claim.claimType] ?? "📝";
  const conf = Math.round(claim.confidence * 100);
  let msg = `${badge} <b>${escapeHtml(claim.claimType.toUpperCase())}</b> (${conf}%)\n\n`;
  msg += `<i>"${escapeHtml(claim.content)}"</i>\n\n`;
  msg += `→ <code>${escapeHtml(claim.targetFile)}.md</code>`;
  if (claim.section) msg += ` / ${escapeHtml(claim.section)}`;
  return formatScheduledTelegramHtml(msg);
}

// ── Public API ──────────────────────────────────────────────

/**
 * Send Memory Moments batch to Telegram. Called after nightly job.
 */
export async function sendMemoryMoments(
  bot: Bot,
  chatId: number,
  candidates: KnowledgeClaim[],
): Promise<void> {
  if (candidates.length === 0) return;

  const db = stateManagerRef?.getDb();
  if (!db) return;

  // Header message
  const header = formatScheduledTelegramHtml(
    `📋 <b>Memory Moments</b> (${candidates.length} new)\n━━━━━━━━━━━━`
  );
  await bot.api.sendMessage(chatId, header, { parse_mode: "HTML" });

  // Individual candidate cards with inline keyboards
  for (const claim of candidates) {
    try {
      const text = formatCandidateCard(claim);
      const sent = await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: createCandidateKeyboard(claim.id),
      });
      // Track telegram_message_id for callback lookup
      setClaimTelegramMessage(db, claim.id, sent.message_id);
    } catch (err) {
      logger.error({ error: err, claimId: claim.id }, "Failed to send candidate card");
    }
  }
}

/**
 * Send lint findings to Telegram. Called after weekly consolidation.
 */
export async function sendLintFindings(
  bot: Bot,
  chatId: number,
  staleClaims: KnowledgeClaim[],
): Promise<void> {
  if (staleClaims.length === 0) return;

  const header = formatScheduledTelegramHtml(
    `🔍 <b>Memory Health</b> (${staleClaims.length} items)\n━━━━━━━━━━━━`
  );
  await bot.api.sendMessage(chatId, header, { parse_mode: "HTML" });

  for (const claim of staleClaims.slice(0, 7)) {
    try {
      const msg = `<b>${escapeHtml(claim.targetFile)}.md</b>: "${escapeHtml(claim.content.slice(0, 100))}"`;
      const text = formatScheduledTelegramHtml(msg);
      await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: createLintKeyboard(claim.id),
      });
    } catch (err) {
      logger.error({ error: err, claimId: claim.id }, "Failed to send lint finding");
    }
  }
}

// ── Handler Registration ────────────────────────────────────

export function registerMemoryReviewHandlers(bot: Bot, stateManager: StateManager): void {
  stateManagerRef = stateManager;

  // Helper: find claim by callback ID suffix
  function findClaim(idSuffix: string): KnowledgeClaim | null {
    const db = stateManagerRef?.getDb();
    if (!db) return null;
    // Search by ID suffix match
    const row = db.prepare(`
      SELECT id FROM knowledge_claims WHERE id LIKE ? LIMIT 1
    `).get(`%${idSuffix}`) as { id: string } | undefined;
    if (!row) return null;
    return getClaim(db, row.id);
  }

  // ── Approve ──
  bot.callbackQuery(/^m:a:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }
    if (claim.status !== "candidate") {
      await ctx.answerCallbackQuery(`Already ${claim.status}`);
      return;
    }

    const db = stateManagerRef!.getDb();
    const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
    const ok = await approveCandidate(db, claim.id, cms);

    if (ok) {
      await ctx.editMessageText(
        `✅ <b>Approved</b> → ${escapeHtml(claim.targetFile)}.md\n<i>"${escapeHtml(claim.content.slice(0, 120))}"</i>`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCallbackQuery("Approved ✅");
    } else {
      await ctx.answerCallbackQuery("Approval failed — check logs");
    }
  });

  // ── Reject ──
  bot.callbackQuery(/^m:r:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    const db = stateManagerRef!.getDb();
    rejectCandidate(db, claim.id);

    await ctx.editMessageText(
      `❌ <b>Rejected</b>\n<s>"${escapeHtml(claim.content.slice(0, 120))}"</s>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCallbackQuery("Rejected ❌");
  });

  // ── Edit (start) ──
  bot.callbackQuery(/^m:e:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    await ctx.answerCallbackQuery("Reply with your edited version");

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sent = await ctx.reply(
      formatScheduledTelegramHtml(
        `✏️ <b>Edit mode</b>\n\nOriginal: <i>"${escapeHtml(claim.content)}"</i>\n\nReply to this message with your corrected version.`
      ),
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      },
    );

    pendingEdits.set(sent.message_id, { claimId: claim.id, createdAt: Date.now() });
    // Also track the original message
    const origId = ctx.callbackQuery?.message?.message_id;
    if (origId) pendingEdits.set(origId, { claimId: claim.id, createdAt: Date.now() });
  });

  // ── Talk (start discussion) ──
  bot.callbackQuery(/^m:t:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    await ctx.answerCallbackQuery("Discussion opened");

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sent = await ctx.reply(
      formatScheduledTelegramHtml(
        `💬 <b>Discussion: ${escapeHtml(claim.claimType)}</b>\n\n` +
        `"${escapeHtml(claim.content)}"\n→ ${escapeHtml(claim.targetFile)}.md\n\n` +
        `Reply to discuss. When done, I'll update or reject based on your input.`
      ),
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      },
    );

    pendingTalks.set(sent.message_id, { claimId: claim.id, title: claim.content.slice(0, 50), createdAt: Date.now() });
    const origId = ctx.callbackQuery?.message?.message_id;
    if (origId) pendingTalks.set(origId, { claimId: claim.id, title: claim.content.slice(0, 50), createdAt: Date.now() });
  });

  // ── Lint: Remove (archive) ──
  bot.callbackQuery(/^m:lr:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    const db = stateManagerRef!.getDb();
    archiveClaim(db, claim.id);

    await ctx.editMessageText(
      `🗑 <b>Archived</b>\n<s>"${escapeHtml(claim.content.slice(0, 120))}"</s>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCallbackQuery("Archived");
  });

  // ── Lint: Update (start thread) ──
  bot.callbackQuery(/^m:lu:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    await ctx.answerCallbackQuery("Reply with the updated version");

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sent = await ctx.reply(
      formatScheduledTelegramHtml(
        `📝 <b>Update stale claim</b>\n\nCurrent: <i>"${escapeHtml(claim.content)}"</i>\n\nReply with the updated version, or "delete" to remove.`
      ),
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      },
    );

    pendingEdits.set(sent.message_id, { claimId: claim.id, createdAt: Date.now() });
  });

  // ── Lint: Keep (validate) ──
  bot.callbackQuery(/^m:lk:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    const db = stateManagerRef!.getDb();
    markClaimValidated(db, claim.id);

    await ctx.editMessageText(
      `✅ <b>Still valid</b>\n"${escapeHtml(claim.content.slice(0, 120))}"`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCallbackQuery("Marked as valid ✅");
  });

  // ── Reply capture for edits ──
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return next();

    // Check for pending edit
    const editCtx = pendingEdits.get(replyTo);
    if (editCtx) {
      pendingEdits.delete(replyTo);
      const db = stateManagerRef?.getDb();
      if (!db) return next();

      const newContent = ctx.message.text.trim();
      if (newContent.toLowerCase() === "delete") {
        archiveClaim(db, editCtx.claimId);
        await ctx.reply("🗑 Claim deleted.", { reply_parameters: { message_id: ctx.message.message_id } });
        return;
      }

      const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
      const ok = await editAndApprove(db, editCtx.claimId, newContent, cms);

      if (ok) {
        await ctx.reply(
          formatScheduledTelegramHtml(`✅ <b>Edited & approved</b>\n<i>"${escapeHtml(newContent.slice(0, 120))}"</i>`),
          { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        await ctx.reply("❌ Edit failed — claim may have already been processed.", {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
      return;
    }

    // Check for pending talk
    const talkCtx = pendingTalks.get(replyTo);
    if (talkCtx) {
      // Log the discussion message as a claim event
      const db = stateManagerRef?.getDb();
      if (db) {
        db.prepare(`
          INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
          VALUES (?, 'reviewed', 'user', ?, datetime('now'))
        `).run(talkCtx.claimId, ctx.message.text);
      }

      // Keep the talk context active for further replies
      pendingTalks.set(ctx.message.message_id, talkCtx);

      await ctx.reply("💬 Noted. Reply again to continue, or use the buttons above to decide.", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
      return;
    }

    return next();
  });
}
