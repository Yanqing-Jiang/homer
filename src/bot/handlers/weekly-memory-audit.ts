/**
 * Weekly Memory Audit — Sunday Telegram flow for per-entry review of canonical memory.
 *
 * Flow:
 *   1. sendWeeklyMemoryAudit() — create/resume a session, send start message with file list
 *   2. User taps file button → paginated entry review for that file
 *   3. Per-entry buttons: 📌 Keep / ✏️ Edit / 🗑 Remove / ❓ Stale
 *   4. Decisions write through canonical-service.ts with atomic writes + lock
 *   5. Snapshot hash protects against mid-review file edits (marks 'conflict' instead)
 *
 * Callback namespace: wa:*
 *   wa:g:<fileKey>      — go to a file's page (uses session resume cursor)
 *   wa:n                 — next page of current file
 *   wa:h                 — home: file list
 *   wa:p                 — pause session
 *   wa:f                 — finish session (all done)
 *   wa:k:<entryId>       — keep
 *   wa:e:<entryId>       — edit (starts reply flow)
 *   wa:r:<entryId>       — remove
 *   wa:s:<entryId>       — stale
 */

import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import { getCanonicalMemoryService } from "../../memory/canonical-service.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import {
  syncMemoryEntries,
  findResumableSession,
  createWeeklyAuditSession,
  getSessionFileProgress,
  getSessionFileEntriesAfter,
  getSessionEntry,
  applyWeeklyAuditDecision,
  updateSessionStatus,
  type WeeklyAuditSessionEntryRow,
} from "../../memory/canonical-audit.js";
import { formatScheduledTelegramHtml } from "../../notifications/telegram-router.js";
import { escapeHtml } from "../../utils/telegram-format.js";
import { staleMapCleaner } from "../../utils/stale-map-cleaner.js";

// ── Local state ─────────────────────────────────────────────

interface PendingEdit {
  sessionEntryId: string;
  originalText: string;
  createdAt: number;
}
const pendingEdits = new Map<number, PendingEdit>();
staleMapCleaner.register(pendingEdits, "weekly-audit:edits", { maxAgeMs: 4 * 60 * 60 * 1000 });

interface SessionCursor {
  filePath: string;
  // Anchor = the last-rendered pending entry. Next page = strictly after this
  // entry in the (staleness_score DESC, ordinal_in_file ASC) order. Null when
  // the user hasn't rendered a page yet in this file.
  anchor: { stalenessScore: number; ordinalInFile: number } | null;
  // Page number is derived, not authoritative — display only.
  pageNumber: number;
  // Total pending count captured at the time the page was rendered; used only
  // to show "n pending" in the header without reordering the list.
  pendingAtRender: number;
}
const sessionCursors = new Map<string, SessionCursor>();
staleMapCleaner.register(sessionCursors, "weekly-audit:cursors", { maxAgeMs: 24 * 60 * 60 * 1000 });

let stateManagerRef: StateManager | null = null;

// ── Rendering constants ─────────────────────────────────────

const ENTRIES_PER_PAGE = 3;
const MAX_ENTRY_CHARS = 800;

// ── Helpers ─────────────────────────────────────────────────

function weekStartIso(now: Date = new Date()): string {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sunday
  const diff = d.getDate() - day;
  const sunday = new Date(d.setDate(diff));
  sunday.setUTCHours(0, 0, 0, 0);
  return sunday.toISOString().slice(0, 10);
}

function shortId(wase: string): string {
  // weekly audit session entry ids look like 'wase_abc123_xyz' — last 10 is unique enough
  return wase.slice(-10);
}

function findEntryByShortId(db: ReturnType<StateManager["getDb"]>, shortForm: string): WeeklyAuditSessionEntryRow | null {
  const row = db.prepare(`SELECT id FROM weekly_audit_session_entries WHERE id LIKE ? LIMIT 1`)
    .get(`%${shortForm}`) as { id: string } | undefined;
  if (!row) return null;
  return getSessionEntry(db, row.id);
}

function renderEntryBlock(entry: WeeklyAuditSessionEntryRow, ordinal: number): string {
  const body = entry.entryText.length > MAX_ENTRY_CHARS
    ? entry.entryText.slice(0, MAX_ENTRY_CHARS) + "…"
    : entry.entryText;
  const ageDays = Math.round((Date.now() - new Date(entry.lastRetrievedAt ?? entry.promotedAt ?? new Date().toISOString()).getTime()) / 86400000);
  const meta: string[] = [];
  meta.push(`<code>${escapeHtml(entry.filePath)}:${entry.lineStart}-${entry.lineEnd}</code>`);
  if (entry.sectionPath) meta.push(`<i>${escapeHtml(entry.sectionPath)}</i>`);
  meta.push(`age: ${ageDays}d`);
  meta.push(`used: ${entry.usageCount}×`);
  if (entry.stalenessScore !== null && entry.stalenessScore !== undefined) {
    meta.push(`stale: ${entry.stalenessScore.toFixed(1)}`);
  }

  return [
    `<b>${ordinal}.</b> ${meta.join(" • ")}`,
    `<blockquote>${escapeHtml(body)}</blockquote>`,
  ].join("\n");
}

// ── Main Entrypoint ─────────────────────────────────────────

/**
 * Called by the scheduler at Sunday 9 AM PT. Creates or resumes a weekly audit
 * session and sends the Telegram start message.
 */
export async function sendWeeklyMemoryAudit(
  bot: Bot,
  chatId: number,
  sm: StateManager,
): Promise<string> {
  stateManagerRef = sm;
  const db = sm.getDb();

  // Always refresh the index before creating a session
  try {
    await syncMemoryEntries(sm);
  } catch (err) {
    logger.error({ err }, "syncMemoryEntries failed in sendWeeklyMemoryAudit — continuing with stale index");
  }

  let session = findResumableSession(db);
  let isResume = false;
  if (session) {
    isResume = true;
    logger.info({ sessionId: session.id }, "Resuming weekly audit session");
  } else {
    session = createWeeklyAuditSession(sm, weekStartIso());
  }

  const progress = getSessionFileProgress(db, session.id);
  if (progress.length === 0) {
    const text = formatScheduledTelegramHtml(
      `🗂 <b>Weekly Memory Audit</b>\n<i>No entries to review this week — memory is in good shape.</i>`,
    );
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    updateSessionStatus(db, session.id, "completed");
    return "empty";
  }

  const totalEntries = progress.reduce((acc, p) => acc + p.total, 0);
  const remaining = progress.reduce((acc, p) => acc + p.pending, 0);

  const lines: string[] = [];
  lines.push(`🗂 <b>Weekly Memory Audit</b> — week of ${session.weekStart}`);
  lines.push(`Files: ${progress.length} • Entries: ${totalEntries} • Remaining: ${remaining}`);
  lines.push("");
  lines.push(isResume
    ? "<i>Resuming your paused session. Pick a file to continue.</i>"
    : "<i>Review canonical memory entries injected into LLM context. Keep, edit, remove, or flag stale.</i>");

  const keyboard = new InlineKeyboard();
  let row = 0;
  for (const p of progress) {
    const label = `${p.fileKey} (${p.pending}/${p.total})`;
    keyboard.text(label, `wa:g:${p.fileKey}`);
    row++;
    if (row % 2 === 0) keyboard.row();
  }
  if (row % 2 === 1) keyboard.row();
  keyboard.text("⏸ Pause", "wa:p");
  if (remaining === 0) keyboard.text("✅ Finish", "wa:f");

  const text = formatScheduledTelegramHtml(lines.join("\n"));

  // On resume, prefer editing the existing root message in place so taps on
  // "🏠 File list" (wa:h) don't spawn a new card each time. Fall back to
  // sendMessage if the edit fails (message deleted, too old, etc.).
  if (isResume && session.telegramSessionRootId) {
    try {
      await bot.api.editMessageText(chatId, session.telegramSessionRootId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      db.prepare(`UPDATE weekly_audit_sessions SET started_at = COALESCE(started_at, datetime('now')) WHERE id = ?`)
        .run(session.id);
      return session.id;
    } catch (err) {
      logger.debug({ err, sessionId: session.id, rootId: session.telegramSessionRootId },
        "Weekly audit: edit root message failed — falling back to new send");
    }
  }

  const sent = await bot.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
  db.prepare(`UPDATE weekly_audit_sessions SET started_at = COALESCE(started_at, datetime('now')), telegram_session_root_id = ? WHERE id = ?`)
    .run(sent.message_id, session.id);

  return session.id;
}

// ── File page renderer ──────────────────────────────────────

async function sendFilePage(
  bot: Bot,
  chatId: number,
  sessionId: string,
  fileKey: string,
  anchor: { stalenessScore: number; ordinalInFile: number } | null,
  pageNumber: number,
): Promise<void> {
  const db = stateManagerRef!.getDb();
  const session = db.prepare(`
    SELECT id, week_start as weekStart FROM weekly_audit_sessions WHERE id = ?
  `).get(sessionId) as { id: string; weekStart: string } | undefined;
  if (!session) return;

  // Find filePath for the fileKey in this session
  const filePathRow = db.prepare(`
    SELECT DISTINCT file_path FROM weekly_audit_session_entries
    WHERE session_id = ? AND file_key = ?
    LIMIT 1
  `).get(sessionId, fileKey) as { file_path: string } | undefined;
  if (!filePathRow) {
    await bot.api.sendMessage(chatId, `No entries for ${fileKey} in this session.`);
    return;
  }
  const filePath = filePathRow.file_path;

  // Fetch one extra row to detect whether another page exists.
  const rows = getSessionFileEntriesAfter(db, sessionId, filePath, anchor, ENTRIES_PER_PAGE + 1);
  const pageEntries = rows.slice(0, ENTRIES_PER_PAGE);
  const hasNext = rows.length > ENTRIES_PER_PAGE;

  const progressRow = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) as done,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM weekly_audit_session_entries WHERE session_id = ? AND file_path = ?
  `).get(sessionId, filePath) as { total: number; done: number; pending: number };

  if (pageEntries.length === 0) {
    const done = progressRow.done ?? 0;
    // If there are still pending entries but the anchor skipped past them all
    // (can only happen if the anchor references an entry that was since
    // resolved and everything after it was also resolved), restart from top.
    if ((progressRow.pending ?? 0) > 0) {
      logger.info({ sessionId, filePath }, "Weekly audit: anchor exhausted but pending remain — restarting from top");
      await sendFilePage(bot, chatId, sessionId, fileKey, null, 1);
      return;
    }
    const text = formatScheduledTelegramHtml(
      `✅ <b>${escapeHtml(filePath)} complete</b>\n` +
      `Reviewed ${done}/${progressRow.total} entries.`,
    );
    const kb = new InlineKeyboard().text("🏠 File list", "wa:h").row();
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb });
    return;
  }

  // Display ordinals: prefer a running count that reflects user progress so
  // numbering stays meaningful across pages. `done + 1` for the first entry
  // on this page, regardless of how many pending were skipped by resolution.
  const firstOrdinal = (progressRow.done ?? 0) + 1;

  const lines: string[] = [];
  lines.push(`🗂 <b>${escapeHtml(filePath)}</b> — ${progressRow.pending} pending`);
  lines.push(`<i>Page ${pageNumber} • Reviewed ${progressRow.done ?? 0}/${progressRow.total}</i>`);
  lines.push("━━━━━━━━━━━━");

  for (let i = 0; i < pageEntries.length; i++) {
    lines.push("");
    lines.push(renderEntryBlock(pageEntries[i]!, firstOrdinal + i));
  }

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < pageEntries.length; i++) {
    const e = pageEntries[i]!;
    const id = shortId(e.id);
    const label = `${firstOrdinal + i}`;
    keyboard
      .text(`📌 ${label}`, `wa:k:${id}`)
      .text(`✏️ ${label}`, `wa:e:${id}`)
      .text(`🗑 ${label}`, `wa:r:${id}`)
      .text(`❓ ${label}`, `wa:s:${id}`)
      .row();
  }
  if (hasNext) keyboard.text("➡️ Next page", "wa:n");
  keyboard.text("🏠 Files", "wa:h").text("⏸ Pause", "wa:p").row();

  // Anchor = the LAST rendered pending entry so `wa:n` resumes strictly after
  // it in the stable sort order.
  const last = pageEntries[pageEntries.length - 1]!;
  const nextAnchor = {
    stalenessScore: last.stalenessScore ?? 0,
    ordinalInFile: last.ordinalInFile,
  };

  sessionCursors.set(sessionId, {
    filePath,
    anchor: nextAnchor,
    pageNumber,
    pendingAtRender: progressRow.pending ?? 0,
  });
  db.prepare(`
    UPDATE weekly_audit_sessions
    SET resume_file_path = ?,
        resume_anchor_staleness = ?,
        resume_anchor_ordinal = ?,
        resume_entry_ordinal = ?
    WHERE id = ?
  `).run(
    filePath,
    nextAnchor.stalenessScore,
    nextAnchor.ordinalInFile,
    pageNumber,
    sessionId,
  );

  const sent = await bot.api.sendMessage(chatId, formatScheduledTelegramHtml(lines.join("\n")), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });

  // Track telegram_message_id on rendered entries
  const setMsg = db.prepare(`UPDATE weekly_audit_session_entries SET telegram_message_id = ? WHERE id = ?`);
  for (const e of pageEntries) setMsg.run(sent.message_id, e.id);
}

// ── Handler Registration ────────────────────────────────────

export function registerWeeklyMemoryAuditHandlers(bot: Bot, stateManager: StateManager): void {
  stateManagerRef = stateManager;

  bot.callbackQuery(/^wa:g:(.+)$/, async (ctx) => {
    const fileKey = ctx.match?.[1];
    if (!fileKey) { await ctx.answerCallbackQuery("Invalid"); return; }
    const db = stateManagerRef!.getDb();
    const session = findResumableSession(db);
    if (!session) { await ctx.answerCallbackQuery("No active session"); return; }
    await ctx.answerCallbackQuery();
    // Opening a file always starts from the top, regardless of any stale
    // in-memory cursor from a prior file.
    await sendFilePage(bot, ctx.chat!.id, session.id, fileKey, null, 1);
  });

  bot.callbackQuery(/^wa:n$/, async (ctx) => {
    const db = stateManagerRef!.getDb();
    const session = findResumableSession(db);
    if (!session) { await ctx.answerCallbackQuery("No active session"); return; }
    const cursor = sessionCursors.get(session.id);
    const filePath = cursor?.filePath ?? session.resumeFilePath;
    if (!filePath) { await ctx.answerCallbackQuery("No page context"); return; }

    // Prefer in-memory cursor (set at render time). Fall back to DB-persisted
    // anchor for cross-restart resume.
    const anchor = cursor?.anchor
      ?? (session.resumeAnchorStaleness !== null && session.resumeAnchorOrdinal !== null
          ? { stalenessScore: session.resumeAnchorStaleness, ordinalInFile: session.resumeAnchorOrdinal }
          : null);
    const nextPage = (cursor?.pageNumber ?? session.resumeEntryOrdinal ?? 1) + 1;

    const fileKey = filePath.replace(/\.md$/, "");
    await ctx.answerCallbackQuery();
    await sendFilePage(bot, ctx.chat!.id, session.id, fileKey, anchor, nextPage);
  });

  bot.callbackQuery(/^wa:h$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat) return;
    await sendWeeklyMemoryAudit(bot, ctx.chat.id, stateManagerRef!);
  });

  bot.callbackQuery(/^wa:p$/, async (ctx) => {
    const db = stateManagerRef!.getDb();
    const session = findResumableSession(db);
    if (session) updateSessionStatus(db, session.id, "paused");
    await ctx.answerCallbackQuery({ text: "⏸ Paused — resume next Sunday" });
  });

  bot.callbackQuery(/^wa:f$/, async (ctx) => {
    const db = stateManagerRef!.getDb();
    const session = findResumableSession(db);
    if (session) updateSessionStatus(db, session.id, "completed");
    await ctx.answerCallbackQuery({ text: "✅ Audit complete" });
  });

  // Decisions: keep / remove / stale (no-reply actions)
  async function applyDecisionCb(shortForm: string, action: "keep" | "remove" | "stale"): Promise<{ ok: boolean; text: string }> {
    const db = stateManagerRef!.getDb();
    const entry = findEntryByShortId(db, shortForm);
    if (!entry) return { ok: false, text: "Entry not found" };
    const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
    const result = await applyWeeklyAuditDecision(stateManagerRef!, cms, {
      sessionEntryId: entry.id,
      action,
    });
    if (!result.ok) return { ok: false, text: `⚠️ ${result.reason ?? result.status}` };
    const label = action === "keep" ? "📌 Kept" : action === "remove" ? "🗑 Removed" : "❓ Flagged stale";
    return { ok: true, text: label };
  }

  bot.callbackQuery(/^wa:k:(.+)$/, async (ctx) => {
    const shortForm = ctx.match?.[1];
    if (!shortForm) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }
    const r = await applyDecisionCb(shortForm, "keep");
    await ctx.answerCallbackQuery({ text: r.text });
  });
  bot.callbackQuery(/^wa:r:(.+)$/, async (ctx) => {
    const shortForm = ctx.match?.[1];
    if (!shortForm) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }
    const r = await applyDecisionCb(shortForm, "remove");
    await ctx.answerCallbackQuery({ text: r.text });
  });
  bot.callbackQuery(/^wa:s:(.+)$/, async (ctx) => {
    const shortForm = ctx.match?.[1];
    if (!shortForm) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }
    const r = await applyDecisionCb(shortForm, "stale");
    await ctx.answerCallbackQuery({ text: r.text });
  });

  // Edit: start reply flow
  bot.callbackQuery(/^wa:e:(.+)$/, async (ctx) => {
    const shortForm = ctx.match?.[1];
    if (!shortForm) { await ctx.answerCallbackQuery("Invalid"); return; }
    const db = stateManagerRef!.getDb();
    const entry = findEntryByShortId(db, shortForm);
    if (!entry) { await ctx.answerCallbackQuery("Entry not found"); return; }

    await ctx.answerCallbackQuery("Reply with the corrected version");
    const sent = await ctx.reply(
      formatScheduledTelegramHtml(
        `✏️ <b>Edit entry</b>\n` +
        `<code>${escapeHtml(entry.filePath)}:${entry.lineStart}-${entry.lineEnd}</code>\n\n` +
        `Current:\n<blockquote>${escapeHtml(entry.entryText.slice(0, 500))}</blockquote>\n\n` +
        `Reply with the corrected text to replace in ${escapeHtml(entry.filePath)}.\n` +
        `Or reply "cancel" / "keep" to abort.`,
      ),
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
      },
    );
    pendingEdits.set(sent.message_id, {
      sessionEntryId: entry.id,
      originalText: entry.entryText,
      createdAt: Date.now(),
    });
  });

  // Capture edit replies
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return next();
    const pending = pendingEdits.get(replyTo);
    if (!pending) return next();
    pendingEdits.delete(replyTo);

    const replyText = ctx.message.text.trim();
    if (/^(cancel|keep|abort|no)$/i.test(replyText)) {
      await ctx.reply("Edit cancelled.", { reply_parameters: { message_id: ctx.message.message_id } });
      return;
    }

    const cms = getCanonicalMemoryService(stateManagerRef!, getMemoryIndexer());
    const result = await applyWeeklyAuditDecision(stateManagerRef!, cms, {
      sessionEntryId: pending.sessionEntryId,
      action: "edit",
      newText: replyText,
    });
    if (result.ok) {
      await ctx.reply(
        formatScheduledTelegramHtml(
          `✏️ <b>Edited</b>\n<blockquote>${escapeHtml(replyText.slice(0, 500))}</blockquote>`,
        ),
        { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
      );
    } else {
      await ctx.reply(
        formatScheduledTelegramHtml(`⚠️ Edit failed: ${escapeHtml(result.reason ?? result.status)}`),
        { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
      );
    }
  });

  logger.info("Weekly memory audit handlers registered");
}
