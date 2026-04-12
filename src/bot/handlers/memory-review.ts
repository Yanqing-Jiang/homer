/**
 * Memory Review Handlers — Telegram callbacks for human-gated memory curation.
 *
 * Callback namespace: m:* (all under 20 bytes)
 *   m:a:<id>  — approve candidate as-is
 *   m:r:<id>  — reject candidate
 *   m:p:<id>  — reply (edit, discuss, or correct — intent inferred from text)
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

interface PendingReply {
  claimId: string;
  originalContent: string;
  createdAt: number;
}

const pendingReplies = new Map<number, PendingReply>();

staleMapCleaner.register(pendingReplies, "memory:replies", { maxAgeMs: 4 * 60 * 60 * 1000 }); // 4hr

let stateManagerRef: StateManager | null = null;

// ── Claim Type Badges ───────────────────────────────────────

const CLAIM_BADGES: Record<string, string> = {
  fact: "📝",
  decision: "⚖️",
  preference: "🎯",
  question: "❓",
  lesson: "⚠️",
  skill: "🧩",
  cleanup: "🧹",
};

// ── Intent Detection ────────────────────────────────────────

const REJECT_PATTERNS = /^(delete|reject|no|wrong|nope|nah|remove|skip|trash|not true|incorrect|drop it)$/i;

function detectReplyIntent(replyText: string, _originalContent: string): "reject" | "edit" {
  const trimmed = replyText.trim();

  // Explicit rejection keywords
  if (REJECT_PATTERNS.test(trimmed)) return "reject";

  // Everything else is treated as a corrected version (edit + approve)
  return "edit";
}

// ── Keyboard Builders ───────────────────────────────────────

function createLintKeyboard(claimId: string): InlineKeyboard {
  const id = claimId.slice(-10);
  return new InlineKeyboard()
    .text("🗑 Remove", `m:lr:${id}`)
    .text("📝 Update", `m:lu:${id}`)
    .text("✅ Keep", `m:lk:${id}`);
}

// ── Batch keyboard rebuild ──────────────────────────────────

/**
 * After a single item action (approve/reject), rebuild the batch keyboard
 * to visually mark processed items.
 */
async function updateBatchKeyboard(
  ctx: { editMessageReplyMarkup: (opts: { reply_markup: InlineKeyboard }) => Promise<unknown> },
  messageId: number,
): Promise<void> {
  const db = stateManagerRef?.getDb();
  if (!db) return;

  // Find all claims in this batch, preserving original display order
  const batchClaims = db.prepare(`
    SELECT id, status FROM knowledge_claims
    WHERE telegram_message_id = ?
    ORDER BY batch_position ASC, created_at ASC
  `).all(messageId) as Array<{ id: string; status: string }>;

  if (batchClaims.length === 0) return;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < batchClaims.length; i++) {
    const c = batchClaims[i]!;
    const id = c.id.slice(-10);
    const label = `${i + 1}`;

    if (c.status === "approved") {
      keyboard.text(`✅ ${label} done`, `m:noop`).text(`—`, `m:noop`).text(`—`, `m:noop`);
    } else if (c.status === "rejected" || c.status === "archived") {
      keyboard.text(`❌ ${label} skip`, `m:noop`).text(`—`, `m:noop`).text(`—`, `m:noop`);
    } else {
      keyboard.text(`✅ ${label}`, `m:a:${id}`).text(`💬 ${label}`, `m:p:${id}`).text(`❌ ${label}`, `m:r:${id}`);
    }
    keyboard.row();
  }

  // Only show bulk actions if some items are still pending
  const hasPending = batchClaims.some(c => c.status === "candidate" || c.status === "stale");
  if (hasPending) {
    keyboard.text("✅ Approve All", "m:aa").text("❌ Dismiss All", "m:da");
  }

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
  } catch {
    // Message may have been deleted or keyboard unchanged — ignore
  }
}

// ── Public API ──────────────────────────────────────────────

// ── Rendering helpers ───────────────────────────────────────

export interface SendMemoryMomentsOptions {
  /** Custom header text, e.g. "🌅 Morning Review — Sun, Apr 12" */
  title?: string;
  /** Optional subtitle line shown under the header (e.g. counts). */
  subtitle?: string;
  /** When true, render full content inline instead of truncating. */
  expanded?: boolean;
  /** Character budget per chunk. Defaults to 3500 (Telegram hard limit is 4096). */
  chunkCharBudget?: number;
  /** Override the starting ordinal for global numbering continuity. */
  startOrdinal?: number;
}

const DEFAULT_CHUNK_BUDGET = 3500;

/**
 * Render a single candidate block in compact or expanded mode.
 * Compact: 150-char content preview. Expanded: full content inline.
 */
function renderCandidateBlock(
  claim: KnowledgeClaim,
  ordinal: number,
  expanded: boolean,
): string {
  const badge = CLAIM_BADGES[claim.claimType] ?? "📝";
  const conf = Math.round(claim.confidence * 100);
  const statusTag = claim.status === "stale" ? "STALE" : claim.claimType.toUpperCase();
  const target = `<code>${escapeHtml(claim.targetFile)}.md</code>${claim.section ? ` / ${escapeHtml(claim.section)}` : ""}`;

  const lines: string[] = [];
  lines.push(`<b>${ordinal}.</b> ${badge} [${statusTag}] (${conf}%)`);
  lines.push(`→ ${target}`);
  if (expanded) {
    // Full content, cap at 2000 chars to keep a single item from dominating a chunk
    const body = claim.content.length > 2000 ? claim.content.slice(0, 2000) + "…" : claim.content;
    lines.push(`<blockquote>${escapeHtml(body)}</blockquote>`);
  } else {
    lines.push(`<i>"${escapeHtml(claim.content.slice(0, 150))}"</i>`);
  }
  return lines.join("\n");
}

interface CandidateChunk {
  items: KnowledgeClaim[];
  startIndex: number; // index into the full candidates array
  body: string;
}

/**
 * Split candidates into chunks such that each chunk's rendered body stays under
 * the char budget. Preserves input order and ordinal continuity.
 */
function splitCandidateBatches(
  candidates: KnowledgeClaim[],
  options: { title: string; subtitle?: string; expanded: boolean; startOrdinal: number; chunkCharBudget: number },
): CandidateChunk[] {
  const chunks: CandidateChunk[] = [];
  let cursor = 0;

  while (cursor < candidates.length) {
    const items: KnowledgeClaim[] = [];
    let body = "";
    const startIndex = cursor;

    while (cursor < candidates.length) {
      const ordinal = options.startOrdinal + cursor;
      const block = renderCandidateBlock(candidates[cursor]!, ordinal, options.expanded);
      const candidateBody = body ? body + "\n\n" + block : block;
      // Reserve ~200 chars for header + chunk pagination suffix
      if (candidateBody.length > options.chunkCharBudget && items.length > 0) break;
      body = candidateBody;
      items.push(candidates[cursor]!);
      cursor++;
    }

    chunks.push({ items, startIndex, body });
  }

  return chunks;
}

/**
 * Send Memory Moments as one or more batched Telegram messages. Each chunk
 * renders numbered items inline with per-item action buttons + chunk-local
 * bulk actions. Global numbering is preserved across chunks.
 *
 * Called by morning review (expanded=true) and by ad-hoc review flows (compact).
 */
export async function sendMemoryMoments(
  bot: Bot,
  chatId: number,
  candidates: KnowledgeClaim[],
  options: SendMemoryMomentsOptions = {},
): Promise<void> {
  if (candidates.length === 0) return;

  const db = stateManagerRef?.getDb();
  if (!db) return;

  const expanded = options.expanded ?? false;
  const chunkCharBudget = options.chunkCharBudget ?? DEFAULT_CHUNK_BUDGET;
  const startOrdinal = options.startOrdinal ?? 1;
  const title = options.title ?? `📋 Memory Review (${candidates.length} items)`;

  const chunks = splitCandidateBatches(candidates, {
    title,
    subtitle: options.subtitle,
    expanded,
    startOrdinal,
    chunkCharBudget,
  });

  const totalChunks = chunks.length;
  const setBatch = db.prepare(
    `UPDATE knowledge_claims SET telegram_message_id = ?, batch_position = ? WHERE id = ?`
  );

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;
    const chunkHeader = totalChunks > 1
      ? `<b>${escapeHtml(title)}</b> (${ci + 1}/${totalChunks})`
      : `<b>${escapeHtml(title)}</b>`;
    const subtitleLine = options.subtitle ? `\n<i>${escapeHtml(options.subtitle)}</i>` : "";
    const divider = "\n━━━━━━━━━━━━\n";
    const text = formatScheduledTelegramHtml(chunkHeader + subtitleLine + divider + chunk.body);

    // Build keyboard: one row per item in this chunk + chunk-scoped bulk actions
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < chunk.items.length; i++) {
      const globalIdx = chunk.startIndex + i;
      const claim = chunk.items[i]!;
      const id = claim.id.slice(-10);
      const label = `${startOrdinal + globalIdx}`;
      keyboard
        .text(`✅ ${label}`, `m:a:${id}`)
        .text(`💬 ${label}`, `m:p:${id}`)
        .text(`❌ ${label}`, `m:r:${id}`)
        .row();
    }
    keyboard.text("✅ Approve All", "m:aa").text("❌ Dismiss All", "m:da");
    if (ci === chunks.length - 1) {
      keyboard.row().text("⏰ Review Later", "mr:skip");
    }

    try {
      const sent = await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      for (let i = 0; i < chunk.items.length; i++) {
        setBatch.run(sent.message_id, chunk.startIndex + i, chunk.items[i]!.id);
      }
    } catch (err) {
      logger.error(
        { error: err, chunkIndex: ci, chunkSize: chunk.items.length },
        "Failed to send Memory Moments chunk",
      );
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

  // Noop handler for already-processed buttons
  bot.callbackQuery(/^m:noop$/, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

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

  // ── Approve (single item — update keyboard to show completion) ──
  bot.callbackQuery(/^m:a:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }
    if (claim.status !== "candidate" && claim.status !== "stale") {
      await ctx.answerCallbackQuery(`Already ${claim.status}`);
      return;
    }

    const db = stateManagerRef!.getDb();
    const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
    const ok = claim.status === "stale"
      ? markClaimValidated(db, claim.id)
      : await approveCandidate(db, claim.id, cms);

    await ctx.answerCallbackQuery(ok ? `✅ Approved` : "Already processed");
    if (ok && ctx.callbackQuery.message) {
      await updateBatchKeyboard(ctx, ctx.callbackQuery.message.message_id);
    }
  });

  // ── Reject (single item — update keyboard to show completion) ──
  bot.callbackQuery(/^m:r:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }
    if (claim.status !== "candidate" && claim.status !== "stale") {
      await ctx.answerCallbackQuery(`Already ${claim.status}`);
      return;
    }

    const db = stateManagerRef!.getDb();
    const ok = claim.status === "stale"
      ? archiveClaim(db, claim.id)
      : rejectCandidate(db, claim.id);

    await ctx.answerCallbackQuery(ok ? `❌ Rejected` : "Already processed");
    if (ok && ctx.callbackQuery.message) {
      await updateBatchKeyboard(ctx, ctx.callbackQuery.message.message_id);
    }
  });

  // ── Reply (unified edit + talk) ──
  bot.callbackQuery(/^m:p:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    await ctx.answerCallbackQuery("Reply to edit or correct");

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sent = await ctx.reply(
      formatScheduledTelegramHtml(
        `💬 <b>Reply</b>\n\n` +
        `<i>"${escapeHtml(claim.content)}"</i>\n` +
        `→ ${escapeHtml(claim.targetFile)}.md\n\n` +
        `Reply with your corrected version to edit & approve.\n` +
        `Or reply "reject" / "delete" to discard.`
      ),
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      },
    );

    const replyCtx: PendingReply = { claimId: claim.id, originalContent: claim.content, createdAt: Date.now() };
    pendingReplies.set(sent.message_id, replyCtx);
    // Also track the original card message
    const origId = ctx.callbackQuery?.message?.message_id;
    if (origId) pendingReplies.set(origId, replyCtx);
  });

  // ── Lint: Remove (archive) ──
  bot.callbackQuery(/^m:lr:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    const db = stateManagerRef!.getDb();
    const ok = archiveClaim(db, claim.id);

    if (ok) {
      await ctx.editMessageText(
        `🗑 <b>Archived</b>\n<s>"${escapeHtml(claim.content.slice(0, 120))}"</s>`,
        { parse_mode: "HTML" },
      );
    }
    await ctx.answerCallbackQuery(ok ? "Archived" : "Already processed");
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

    pendingReplies.set(sent.message_id, { claimId: claim.id, originalContent: claim.content, createdAt: Date.now() });
  });

  // ── Lint: Keep (validate) ──
  bot.callbackQuery(/^m:lk:(.+)$/, async (ctx) => {
    const idSuffix = ctx.match?.[1];
    if (!idSuffix) { await ctx.answerCallbackQuery("Invalid"); return; }

    const claim = findClaim(idSuffix);
    if (!claim) { await ctx.answerCallbackQuery("Claim not found"); return; }

    if (claim.status !== "stale" && claim.status !== "approved") {
      await ctx.answerCallbackQuery(`Cannot validate ${claim.status} claim`);
      return;
    }

    const db = stateManagerRef!.getDb();
    const ok = markClaimValidated(db, claim.id);

    if (ok) {
      await ctx.editMessageText(
        `✅ <b>Still valid</b>\n"${escapeHtml(claim.content.slice(0, 120))}"`,
        { parse_mode: "HTML" },
      );
    }
    await ctx.answerCallbackQuery(ok ? "Marked as valid ✅" : "Already processed");
  });

  // ── Bulk: Approve All (scoped to current message batch) ──
  bot.callbackQuery(/^m:aa$/, async (ctx) => {
    const db = stateManagerRef?.getDb();
    if (!db) { await ctx.answerCallbackQuery("DB unavailable"); return; }

    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) { await ctx.answerCallbackQuery("No message context"); return; }

    const batchItems = db.prepare(
      `SELECT id, status FROM knowledge_claims
       WHERE telegram_message_id = ? AND status IN ('candidate', 'stale')
       ORDER BY batch_position ASC`
    ).all(messageId) as Array<{ id: string; status: string }>;

    if (batchItems.length === 0) {
      await ctx.answerCallbackQuery("No pending items");
      return;
    }

    const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
    let approved = 0;
    for (const c of batchItems) {
      const ok = c.status === "stale"
        ? markClaimValidated(db, c.id)
        : await approveCandidate(db, c.id, cms);
      if (ok) approved++;
    }

    await ctx.editMessageText(
      `✅ <b>Bulk approved ${approved} items</b>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCallbackQuery(`Approved ${approved} items ✅`);
  });

  // ── Bulk: Dismiss All (scoped to current message batch) ──
  bot.callbackQuery(/^m:da$/, async (ctx) => {
    const db = stateManagerRef?.getDb();
    if (!db) { await ctx.answerCallbackQuery("DB unavailable"); return; }

    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) { await ctx.answerCallbackQuery("No message context"); return; }

    const batchItems = db.prepare(
      `SELECT id, status FROM knowledge_claims
       WHERE telegram_message_id = ? AND status IN ('candidate', 'stale')
       ORDER BY batch_position ASC`
    ).all(messageId) as Array<{ id: string; status: string }>;

    if (batchItems.length === 0) {
      await ctx.answerCallbackQuery("No pending items");
      return;
    }

    let dismissed = 0;
    for (const c of batchItems) {
      const ok = c.status === "stale"
        ? archiveClaim(db, c.id)
        : rejectCandidate(db, c.id);
      if (ok) dismissed++;
    }

    await ctx.editMessageText(
      `❌ <b>Dismissed ${dismissed} items</b>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCallbackQuery(`Dismissed ${dismissed} items`);
  });

  // ── Reply capture (unified edit/reject handler) ──
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return next();

    const replyCtx = pendingReplies.get(replyTo);
    if (!replyCtx) return next();

    // Delete all map entries for this claim to prevent double-mutation
    for (const [key, val] of pendingReplies) {
      if (val.claimId === replyCtx.claimId) pendingReplies.delete(key);
    }
    const db = stateManagerRef?.getDb();
    if (!db) return next();

    const replyText = ctx.message.text.trim();
    const intent = detectReplyIntent(replyText, replyCtx.originalContent);

    if (intent === "reject") {
      // Try reject (candidate) first, fall back to archive (stale/approved)
      const ok = rejectCandidate(db, replyCtx.claimId) || archiveClaim(db, replyCtx.claimId);
      await ctx.reply(
        formatScheduledTelegramHtml(ok
          ? `❌ <b>Rejected</b>\n<s>"${escapeHtml(replyCtx.originalContent.slice(0, 120))}"</s>`
          : `⚠️ Already processed`),
        { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
      );
      return;
    }

    // Intent is "edit" — use the reply text as the corrected content, edit + approve
    const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
    const ok = await editAndApprove(db, replyCtx.claimId, replyText, cms);

    if (ok) {
      await ctx.reply(
        formatScheduledTelegramHtml(`✅ <b>Edited & approved</b>\n<i>"${escapeHtml(replyText.slice(0, 120))}"</i>`),
        { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
      );
    } else {
      await ctx.reply("❌ Edit failed — claim may have already been processed.", {
        reply_parameters: { message_id: ctx.message.message_id },
      });
    }
  });
}
