import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  parseCommand,
  isPureExecutorSwitch,
  isExecutorSwitchWithQuery,
  getExecutorModel,
  getCatalogEntry,
  isScheduledHarnessExecutor,
  validateHarnessSelection,
  type ParsedCommand,
} from "../commands/index.js";
import { registerApprovalHandlers, registerPlanApprovalHandlers, registerPlanApprovalCallbacks, registerPlanReviewCallbacks } from "./handlers/approval.js";
import { registerQuickCommands, registerProposalCallbacks } from "./handlers/proposal-approval.js";
import { registerOvernightCommands, handleOvernightMessage } from "./handlers/overnight.js";
import { handleYouTubeUrl, initializeYouTubeHandler } from "./handlers/youtube.js";
import { handleCallRequest } from "./handlers/phone-call.js";
import { handleSmsRequest } from "./handlers/sms.js";
import { registerCallFollowupHandlers } from "./handlers/call-followup.js";
import { registerSmsReplyHandlers } from "./handlers/sms-reply.js";
import { registerMorningReviewCallbacks } from "./handlers/morning-review.js";
import { registerCodePushApprovalHandlers } from "./handlers/code-push-approval.js";
import { chunkMessage } from "../utils/chunker.js";
import { StateManager } from "../state/manager.js";
import { saveTodo } from "../todos/dao.js";
import { sendThinkingIndicator, editWithResponse, TelegramDraftStream, sendFinalResponse, TelegramTypingLoop } from "./streaming.js";
import { loadBootstrapFiles } from "../memory/loader.js";
import { receiveInboundTelegramText } from "./relay-inbox.js";
import { claimLaneAdmission, type LaneAdmission } from "./lane-admission.js";
import {
  describeTelegramError,
  getTelegramPollingStatus,
  isTelegramConflict,
  shouldAnnouncePollingRecovery,
  setTelegramPollingStatus,
  telegramPollBackoffMs,
  telegramPollingWanted,
} from "./polling-health.js";
import { BROWSER_STATUS_PATH } from "../scraping/browser-control.js";
import { readFileSync } from "node:fs";
import { getMemoryIndexer } from "../memory/indexer.js";
import { transcribeWithFallback, synthesizeSpeech, truncateForTTS } from "../voice/index.js";
import type { VoiceConfig, SynthesisOptions } from "../voice/types.js";
import { InputFile } from "grammy";
import type { Scheduler } from "../scheduler/index.js";
import {
  ReminderManager,
  parseReminder,
  formatRelativeTime as reminderRelativeTime,
  formatDateTime,
} from "../reminders/index.js";
import { MeetingManager, formatDuration } from "../meetings/index.js";
import { CLIRunManager } from "../executors/cli-runner.js";
import type { StreamStepEvent } from "../executors/claude.js";
import { telegramLane } from "../utils/lanes.js";
import { escapeHtml } from "../utils/telegram-format.js";
import { mkdirSync, existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join, extname } from "path";
import { randomUUID } from "crypto";

const ENABLE_STREAMING = true;
// Telegram now uses per-chat lanes (tg:<chatId>)

let schedulerRef: Scheduler | null = null;
let reminderManagerRef: ReminderManager | null = null;
let meetingManagerRef: MeetingManager | null = null;

const pendingAttachments: Map<string, string[]> = new Map();

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

async function saveTelegramFile(
  ctx: Context,
  fileId: string,
  filename: string,
  chatId: number
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const baseDir = join(config.paths.uploadLanding, "tg", String(chatId));
  ensureDir(baseDir);

  const ext = extname(filename) || "";
  const safeName = filename.replace(/[^\w.\-]/g, "_");
  const targetPath = join(baseDir, safeName || `${fileId}${ext}`);
  await writeFile(targetPath, buffer);

  return targetPath;
}

function addPendingAttachment(lane: string, path: string): void {
  const existing = pendingAttachments.get(lane) ?? [];
  existing.push(path);
  pendingAttachments.set(lane, existing);
}

function consumePendingAttachments(lane: string): string[] {
  const pending = pendingAttachments.get(lane) ?? [];
  if (pending.length > 0) {
    pendingAttachments.delete(lane);
  }
  return pending;
}

function resetExecutorSessionForLane(
  lane: string,
  stateManager: StateManager,
  runManager: CLIRunManager,
  reason = "new session"
): void {
  runManager.closeLaneSession(lane, reason);
  stateManager.clearExecutor(lane);
  stateManager.clearStoredExecutorSessions(lane);
  stateManager.clearPendingContext(lane);
}

export function setScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

export function setReminderManager(reminderManager: ReminderManager): void {
  reminderManagerRef = reminderManager;
}

export function setMeetingManager(meetingManager: MeetingManager): void {
  meetingManagerRef = meetingManager;
}

export function createBot(stateManager: StateManager, runManager: CLIRunManager): Bot {
  // timeoutSeconds bounds every Bot API call. grammy's default is 500s (8m20s),
  // so a black-holed api.telegram.org would hang handlers/scheduler/startup for
  // 8+ minutes. 45s is well under that yet exceeds the 30s long-poll getUpdates
  // timeout (must be > poll timeout or long polling self-aborts).
  const bot = new Bot(config.telegram.botToken, {
    client: { timeoutSeconds: 45 },
  });

  // Outbound resilience (order matters — throttler outermost, then auto-retry):
  //  - apiThrottler: queues requests under Telegram's rate limits (avoids 429s).
  //  - autoRetry: rides out 429 (retry_after), 5xx (502/503), and transport
  //    errors with exponential backoff. maxDelaySeconds caps the per-call wait
  //    so a long flood/outage fails fast instead of blocking for an hour.
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  const reminderManager = new ReminderManager(stateManager);
  reminderManagerRef = reminderManager;

  bot.use(authMiddleware);

  // Register approval callback handlers for idea review buttons
  registerApprovalHandlers(bot, stateManager);

  // Register plan approval handlers (/approve, /reject, /plans) + structured review cards
  registerPlanApprovalHandlers(bot, stateManager);
  registerPlanApprovalCallbacks(bot, stateManager);
  registerPlanReviewCallbacks(bot, stateManager);

  // Register proposal quick commands (/a, /r, /s, /aa, /proposals) and inline button callbacks
  registerQuickCommands(bot, stateManager);
  registerProposalCallbacks(bot, stateManager);

  // Register overnight work commands (/overnight) and inline button callbacks
  registerOvernightCommands(bot, stateManager);

  // Register call follow-up and SMS reply inline button callbacks
  registerCallFollowupHandlers(bot);
  registerSmsReplyHandlers(bot);

  // Register morning review callbacks (consolidated 9 AM approval session)
  registerMorningReviewCallbacks(bot, config.telegram.allowedChatId, stateManager);

  // Register nightly-code-push approval handlers (Phase 1.4)
  registerCodePushApprovalHandlers(bot, stateManager);

  // Initialize YouTube URL handler
  initializeYouTubeHandler(stateManager);

  // /start - help
  bot.command("start", async (ctx) => {
    // Get current executor state
    const lane = telegramLane(ctx.chat.id);
    const executorState = stateManager.getCurrentExecutor(lane);
    const currentExecutor = executorState?.executor || stateManager.resolveDefaultExecutor();

    await ctx.reply(
      "H.O.M.E.R ready.\n\n" +
        `*Current executor:* ${currentExecutor}\n\n` +
        "*Executor Commands:* (persistent)\n" +
        "/claude - Claude (default)\n" +
        "/open_flash - OpenCode + Gemini Flash\n" +
        "/open_opus - OpenCode + Claude Opus\n" +
        "/codex - Codex (deep reasoning)\n" +
        "/kimi - Kimi K2.5 (long-context)\n\n" +
        "*Session:*\n" +
        "/new - Fresh session (resets executor)\n" +
        "/status - Active session\n\n" +
        "*Jobs:*\n" +
        "/jobs - Scheduled jobs\n" +
        "/trigger <id> - Run job\n\n" +
        "*Meetings:*\n" +
        "/meeting <title> with <attendees>\n" +
        "/meetings - List recent\n\n" +
        "*Reminders:*\n" +
        "/remind <time> <msg>\n" +
        "/reminders - List\n" +
        "/cancel <id>\n\n" +
        "*Search:*\n" +
        "/search <query>\n\n" +
        "*Overnight Work:*\n" +
        "/overnight - View queued tasks\n" +
        '"work on xyz tonight" - Queue prototype\n' +
        '"research xyz for me tonight" - Queue research\n\n' +
        "Just type - I'll handle context.",
      { parse_mode: "Markdown" }
    );
  });

  // /status
  bot.command("status", async (ctx) => {
    const sessions = stateManager.getActiveSessions();
    const jobStats = stateManager.getJobStats();
    const lane = telegramLane(ctx.chat.id);
    const executorState = stateManager.getCurrentExecutor(lane);

    let statusText = "*Status*\n\n";

    // Executor state
    if (executorState) {
      const age = Math.round((Date.now() - executorState.switchedAt) / 1000 / 60);
      statusText += `Executor: *${executorState.executor}*`;
      if (executorState.model) statusText += ` (${executorState.model})`;
      statusText += `\nSwitched: ${age}m ago (${executorState.messageCount} msgs)\n\n`;
    } else {
      statusText += `Executor: *${stateManager.resolveDefaultExecutor()}* (global default)\n\n`;
    }

    // Session state
    if (sessions.length === 0) {
      statusText += "No active sessions.\n";
    } else {
      for (const s of sessions) {
        const age = Math.round((Date.now() - s.lastActivityAt) / 1000 / 60);
        statusText += `Session: ${age}m ago (${s.messageCount} msgs)\n`;
      }
    }
    statusText += `\nJobs: ${jobStats.pending} pending, ${jobStats.running} running`;

    // M4: both degraded modes the hardening introduced are otherwise invisible — the
    // daemon survives them silently, which is worse for detection than crashing did.
    const polling = getTelegramPollingStatus();
    const pollingLine = polling.state === "degraded"
      ? `DEGRADED — ${polling.reason ?? "unknown"} (${polling.consecutiveFailures} failures)`
      : polling.state === "healthy" ? "healthy"
      : polling.state === "stopped" ? "stopped (shutting down)"
      : polling.reason ?? "starting";
    statusText += `\nTelegram polling: ${pollingLine}`;
    try {
      const browser = JSON.parse(readFileSync(BROWSER_STATUS_PATH, "utf8")) as {
        cdp?: { state?: string }; ownership?: string; degradedReason?: string | null;
      };
      statusText += `\nBrowser: CDP ${browser.cdp?.state ?? "unknown"}, ownership ${browser.ownership ?? "unknown"}`;
      if (browser.degradedReason) statusText += `\nAgent-browser: DEGRADED — ${browser.degradedReason}`;
    } catch {
      statusText += "\nBrowser: status.json unreadable";
    }

    try {
      await ctx.reply(statusText, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(statusText.replace(/[*_`]/g, ""));
    }
  });

  // /jobs
  bot.command("jobs", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }
    const jobs = schedulerRef.getJobs();
    if (jobs.length === 0) {
      await ctx.reply("No scheduled jobs configured.");
      return;
    }

    let response = "*Scheduled Jobs*\n\n";
    for (const job of jobs) {
      const status = job.config.enabled ? "✅" : "⏸️";
      const lastRun = job.lastRun ? formatRelativeTime(job.lastRun) : "never";
      const failures = job.consecutiveFailures > 0 ? ` (${job.consecutiveFailures} failures)` : "";
      response += `${status} *${job.config.id}*\n`;
      response += `  └ ${job.config.name}\n`;
      response += `  └ \`${job.config.cron}\`\n`;
      response += `  └ Last: ${lastRun}${failures}\n\n`;
    }
    response += "_Use /trigger <id> to run manually_";

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // /trigger
  bot.command("trigger", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }
    const jobId = ctx.match?.trim();
    if (!jobId) {
      await ctx.reply("Usage: /trigger <job-id>");
      return;
    }
    const job = schedulerRef.getJob(jobId);
    if (!job) {
      await ctx.reply(`Job not found: ${jobId}`);
      return;
    }
    const triggered = schedulerRef.triggerJob(jobId);
    if (triggered) {
      await ctx.reply(`⏳ Triggered: *${job.config.name}*`, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(`Failed to trigger job: ${jobId}`);
    }
  });

  // /remind
  bot.command("remind", async (ctx) => {
    const input = ctx.match?.trim() || "";
    if (!input) {
      await ctx.reply("Usage: /remind <time> <message>\n\nExample: /remind in 30 minutes check oven");
      return;
    }
    const parsed = parseReminder(input);
    if (!parsed.time) {
      await ctx.reply("Could not parse time. Try: /remind in 30 minutes <message>");
      return;
    }
    if (parsed.time.getTime() <= Date.now()) {
      await ctx.reply("The reminder time must be in the future.");
      return;
    }
    const id = reminderManager.create({
      chatId: ctx.chat.id,
      message: parsed.message,
      dueAt: parsed.time,
      context: "default",
    });
    await ctx.reply(
      `⏰ Reminder set for ${formatDateTime(parsed.time)} (${reminderRelativeTime(parsed.time)})\n\n"${parsed.message}"\n\nID: \`${id.slice(0, 8)}\``,
      { parse_mode: "Markdown" }
    );
  });

  // /reminders
  bot.command("reminders", async (ctx) => {
    const pending = reminderManager.getPendingByChat(ctx.chat.id);
    if (pending.length === 0) {
      await ctx.reply("No pending reminders.");
      return;
    }
    let response = "*Pending Reminders*\n\n";
    for (const r of pending) {
      const preview = r.message.length > 40 ? r.message.slice(0, 40) + "..." : r.message;
      response += `⏰ *${reminderRelativeTime(r.dueAt)}* (${formatDateTime(r.dueAt)})\n`;
      response += `   ${preview}\n`;
      response += `   ID: \`${r.id.slice(0, 8)}\`\n\n`;
    }
    response += "_Use /cancel <id> to cancel_";
    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // /cancel
  bot.command("cancel", async (ctx) => {
    const idPrefix = ctx.match?.trim();
    if (!idPrefix) {
      await ctx.reply("Usage: /cancel <reminder-id>");
      return;
    }
    const pending = reminderManager.getPendingByChat(ctx.chat.id);
    const match = pending.find((r) => r.id.startsWith(idPrefix));
    if (!match) {
      await ctx.reply(`Reminder not found: ${idPrefix}`);
      return;
    }
    const cancelled = reminderManager.cancel(match.id);
    if (cancelled) {
      await ctx.reply(`✅ Cancelled: "${match.message.slice(0, 50)}..."`);
    } else {
      await ctx.reply(`Failed to cancel: ${idPrefix}`);
    }
  });

  // /todo <title> [P1|P2|P3] [W|L]
  // Trailing P1/P2/P3 and W/L tokens are extracted; everything else is the title.
  // Defaults: priority=P3, category=W. Writes directly via the todos DAO.
  bot.command("todo", async (ctx) => {
    const raw = ctx.match?.trim() || "";
    if (!raw) {
      await ctx.reply(
        "Usage: `/todo <title> [P1|P2|P3] [W|L]`\n\nExample: `/todo Pick up groceries P2 L`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    let priority: "P1" | "P2" | "P3" = "P3";
    let category: "W" | "L" = "W";
    const tokens = raw.split(/\s+/);
    while (tokens.length > 1) {
      const last = tokens[tokens.length - 1]?.toUpperCase() ?? "";
      if (last === "P1" || last === "P2" || last === "P3") {
        priority = last;
        tokens.pop();
      } else if (last === "W" || last === "L") {
        category = last;
        tokens.pop();
      } else {
        break;
      }
    }
    const title = tokens.join(" ").trim();
    if (!title) {
      await ctx.reply("Title required. Usage: `/todo <title> [P1|P2|P3] [W|L]`", {
        parse_mode: "Markdown",
      });
      return;
    }

    try {
      const todo = saveTodo(stateManager.getDb(), {
        title,
        priority,
        category,
        source: "manual",
      });
      if (!todo) {
        await ctx.reply("Failed to create todo.");
        return;
      }
      const catLabel = todo.category === "W" ? "Work" : "Life";
      await ctx.reply(
        `✅ Added ${catLabel} ${todo.priority} todo: *${todo.title}*\nID: \`${todo.id.slice(0, 32)}\``,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      logger.error({ error: e, title }, "Telegram /todo failed");
      await ctx.reply(`Failed to create todo: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  });

  // /debug - system status for remote diagnosis
  bot.command("memory", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = args[0]?.toLowerCase();

    if (sub === "undo") {
      const target = args[1];
      if (!target) {
        await ctx.reply("Usage: /memory undo <claim-id-or-suffix>");
        return;
      }
      const db = stateManager.getDb();
      const row = db.prepare(`SELECT id, claim_type, status FROM knowledge_claims WHERE id = ? OR id LIKE ? LIMIT 1`)
        .get(target, `%${target}`) as { id: string; claim_type: string; status: string } | undefined;
      if (!row) {
        await ctx.reply(`No claim matches "${target}"`);
        return;
      }
      const { undoLatestForClaim } = await import("../memory/undo.js");
      const result = await undoLatestForClaim(stateManager, row.id);
      if (result.ok) {
        await ctx.reply(`✅ ${result.reason} (claim ${row.id})`);
        return;
      }
      // No file-backed mutation. For operational DB-native claims (post-bridge),
      // the approval never wrote to markdown — undo means archiving the DB row.
      const durableMarkdownTypes = new Set(["preference"]);
      const isOperational = !durableMarkdownTypes.has(row.claim_type);
      const isApproved = row.status === "approved";
      if (result.reason.startsWith("No mutation found") && isOperational && isApproved) {
        db.prepare(`
          UPDATE knowledge_claims
          SET status = 'archived', archived_at = datetime('now'),
              archived_reason = 'undo-request', updated_at = datetime('now')
          WHERE id = ? AND status = 'approved'
        `).run(row.id);
        await ctx.reply(`✅ Archived DB-native claim ${row.id} (no markdown mirror existed; status → archived)`);
        return;
      }
      const conflict = result.conflict
        ? `\n\nExpected post_hash: ${result.conflict.expectedHash.slice(0, 12)}…\nActual file hash: ${result.conflict.actualHash.slice(0, 12)}…`
        : "";
      await ctx.reply(`⚠️ Undo refused: ${result.reason}${conflict}`);
      return;
    }

    if (sub === "pending") {
      const db = stateManager.getDb();
      const counts = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN created_at < datetime('now', '-7 days') THEN 1 ELSE 0 END) as old
        FROM knowledge_claims WHERE status = 'candidate'
      `).get() as { total: number; old: number };
      const oldest = db.prepare(`
        SELECT created_at FROM knowledge_claims WHERE status = 'candidate'
        ORDER BY created_at ASC LIMIT 1
      `).get() as { created_at: string } | undefined;
      const oldestAge = oldest
        ? Math.round((Date.now() - new Date(oldest.created_at).getTime()) / 86400000)
        : 0;
      await ctx.reply(`📋 ${counts.total} pending claims (${counts.old} > 7 days). Oldest: ${oldestAge}d.`);
      return;
    }

    if (sub === "list") {
      // /memory list [target-file] — counts of approved claims, grouped by target_file
      const db = stateManager.getDb();
      const targetFilter = args[1]?.toLowerCase();
      try {
        const rows = targetFilter
          ? db.prepare(`
              SELECT target_file, claim_type, COUNT(*) as n
              FROM knowledge_claims
              WHERE status = 'approved' AND target_file = ?
              GROUP BY target_file, claim_type
              ORDER BY n DESC
            `).all(targetFilter) as Array<{ target_file: string; claim_type: string; n: number }>
          : db.prepare(`
              SELECT target_file, claim_type, COUNT(*) as n
              FROM knowledge_claims
              WHERE status = 'approved'
              GROUP BY target_file, claim_type
              ORDER BY target_file, n DESC
            `).all() as Array<{ target_file: string; claim_type: string; n: number }>;
        if (rows.length === 0) {
          await ctx.reply(targetFilter ? `No approved claims in ${targetFilter}` : "No approved claims yet");
          return;
        }
        const totals = new Map<string, number>();
        for (const r of rows) totals.set(r.target_file, (totals.get(r.target_file) ?? 0) + r.n);
        const lines: string[] = ["📚 <b>Approved claims</b>"];
        let lastFile = "";
        for (const r of rows) {
          if (r.target_file !== lastFile) {
            lines.push(`\n<b>${escapeHtml(r.target_file)}</b> (${totals.get(r.target_file)}):`);
            lastFile = r.target_file;
          }
          lines.push(`  • ${escapeHtml(r.claim_type)}: ${r.n}`);
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      } catch (err) {
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (sub === "show") {
      // /memory show <query> — FTS search across approved + candidate claims
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        await ctx.reply("Usage: /memory show <query>");
        return;
      }
      const db = stateManager.getDb();
      try {
        const escaped = query.replace(/[*()\^$":]/g, "").split(/\s+/).filter(Boolean).join(" ");
        if (!escaped) {
          await ctx.reply("Empty search query after sanitization");
          return;
        }
        const rows = db.prepare(`
          SELECT kc.id, kc.content, kc.target_file, kc.claim_type, kc.status,
                 kc.domain, kc.event_date, kc.decided_at,
                 bm25(knowledge_claims_fts) as rank
          FROM knowledge_claims_fts fts
          JOIN knowledge_claims kc ON fts.rowid = kc.rowid
          WHERE knowledge_claims_fts MATCH ?
            AND kc.status IN ('approved', 'candidate')
          ORDER BY rank
          LIMIT 8
        `).all(escaped) as Array<{ id: string; content: string; target_file: string; claim_type: string; status: string; domain: string | null; event_date: string | null; decided_at: string | null; rank: number }>;
        if (rows.length === 0) {
          await ctx.reply(`No matches for "${query}"`);
          return;
        }
        const lines: string[] = [`🔍 <b>${rows.length} matches</b> for "${escapeHtml(query)}"`];
        for (const r of rows) {
          const badge = r.status === "approved" ? "✓" : "·";
          const when = r.event_date ? ` [${escapeHtml(r.event_date)}]` : r.decided_at ? ` [${r.decided_at.slice(0, 10)}]` : "";
          const dom = r.domain ? `${escapeHtml(r.domain)}/` : "";
          const snippet = r.content.length > 180 ? r.content.slice(0, 180).trim() + "…" : r.content.trim();
          lines.push(`\n${badge} <code>${escapeHtml(r.id.slice(-8))}</code> ${dom}${escapeHtml(r.target_file)}:${escapeHtml(r.claim_type)}${when}\n${escapeHtml(snippet)}`);
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      } catch (err) {
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (sub === "recent") {
      // /memory recent [days=7] — approved claims from the last N days
      const days = Math.max(1, Math.min(30, Number.parseInt(args[1] ?? "7", 10) || 7));
      const db = stateManager.getDb();
      try {
        const rows = db.prepare(`
          SELECT id, content, target_file, claim_type, domain, event_date, decided_at
          FROM knowledge_claims
          WHERE status = 'approved'
            AND decided_at >= datetime('now', ?)
          ORDER BY decided_at DESC
          LIMIT 15
        `).all(`-${days} days`) as Array<{ id: string; content: string; target_file: string; claim_type: string; domain: string | null; event_date: string | null; decided_at: string | null }>;
        if (rows.length === 0) {
          await ctx.reply(`No approved claims in the last ${days} days`);
          return;
        }
        const lines: string[] = [`🕐 <b>${rows.length} approved</b> in last ${days}d`];
        for (const r of rows) {
          const when = r.decided_at?.slice(0, 10) ?? "?";
          const dom = r.domain ? `${escapeHtml(r.domain)}/` : "";
          const snippet = r.content.length > 140 ? r.content.slice(0, 140).trim() + "…" : r.content.trim();
          lines.push(`\n• [${when}] <code>${escapeHtml(r.id.slice(-8))}</code> ${dom}${escapeHtml(r.target_file)}:${escapeHtml(r.claim_type)}\n${escapeHtml(snippet)}`);
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      } catch (err) {
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    await ctx.reply(
      "Usage:\n" +
      "  /memory list [target-file]   — approved claim counts by file/type\n" +
      "  /memory show <query>         — FTS search on approved + candidate claims\n" +
      "  /memory recent [days=7]      — approved claims from last N days\n" +
      "  /memory pending              — pending-candidate queue stats\n" +
      "  /memory undo <claim-id>      — revert the latest write for a claim",
    );
  });

  bot.command("debug", async (ctx) => {
    try {
      const healthRes = await fetch("http://127.0.0.1:3000/health");
      const health = await healthRes.json() as {
        status: string;
        checks: Record<string, boolean>;
      };
      const uptime = Math.round(process.uptime() / 60);
      const mem = process.memoryUsage();
      const sessions = stateManager.getActiveSessions();
      const jobStats = stateManager.getJobStats();

      const checksStr = Object.entries(health.checks)
        .map(([k, v]) => `${k}: ${v ? "✓" : "✗"}`)
        .join("\n");

      const debugInfo = `*Homer Debug*
Uptime: ${uptime}m
Status: ${health.status}
Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB
Sessions: ${sessions.length}
Jobs: ${jobStats.pending} pending, ${jobStats.running} running

*Checks:*
${checksStr}`;

      await ctx.reply(debugInfo, { parse_mode: "Markdown" });
    } catch (error) {
      await ctx.reply(`Debug failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // /meeting - process audio document
  bot.command("meeting", async (ctx) => {
    if (!meetingManagerRef) {
      await ctx.reply("Meeting system not initialized.");
      return;
    }

    const input = ctx.match?.trim() || "";

    // Parse: "title with attendee1, attendee2" or just "title"
    let title = "Meeting";
    let attendees: string[] = [];

    const withMatch = input.match(/^(.+?)\s+with\s+(.+)$/i);
    if (withMatch) {
      title = (withMatch[1] || "").trim();
      attendees = (withMatch[2] || "").split(/[,;]/).map((a) => a.trim()).filter(Boolean);
    } else if (input) {
      title = input;
    }

    // Check if there's a reply to a document
    const replyMsg = ctx.message?.reply_to_message;
    if (replyMsg && "document" in replyMsg && replyMsg.document) {
      const doc = replyMsg.document;
      const mimeType = doc.mime_type || "";

      // Check if it's an audio file
      if (!mimeType.startsWith("audio/") && !mimeType.includes("ogg") && !mimeType.includes("mpeg")) {
        await ctx.reply("Please reply to an audio file (MP3, M4A, OGG, WAV).");
        return;
      }

      // Check file size (20MB limit for bot API)
      if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
        await ctx.reply("Audio file too large. Maximum 20MB (~80 minutes of audio).");
        return;
      }

      try {
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const audioBuffer = Buffer.from(await response.arrayBuffer());

        const fileName = doc.file_name || "audio.m4a";

        // Start background processing
        const meetingId = await meetingManagerRef.startMeetingProcessing({
          title,
          audioBuffer,
          audioFileName: fileName,
          attendees,
          chatId: ctx.chat.id,
        });

        await ctx.reply(
          `*Processing Meeting*\n\n` +
            `Title: ${title}\n` +
            `Attendees: ${attendees.length > 0 ? attendees.join(", ") : "(none specified)"}\n` +
            `File: ${fileName}\n` +
            `Size: ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB\n\n` +
            `ID: \`${meetingId}\`\n\n` +
            `_Processing in background. You'll be notified when complete._`,
          { parse_mode: "Markdown" }
        );

        logger.info({ meetingId, title, attendees }, "Meeting processing started");
      } catch (error) {
        logger.error({ error }, "Failed to process meeting document");
        await ctx.reply(`Error: ${error instanceof Error ? error.message : "Failed to download file"}`);
      }
      return;
    }

    // No document - show usage
    await ctx.reply(
      "*Meeting Recording*\n\n" +
        "To transcribe a meeting:\n" +
        "1. Send an audio file (MP3, M4A, OGG, WAV)\n" +
        "2. Reply to it with: `/meeting Title with Attendee1, Attendee2`\n\n" +
        "Example:\n" +
        "`/meeting Weekly Standup with Sarah, Mike, Alex`\n\n" +
        "_Attendees help identify speakers in the transcript._",
      { parse_mode: "Markdown" }
    );
  });

  // /meetings - list recent meetings
  bot.command("meetings", async (ctx) => {
    if (!meetingManagerRef) {
      await ctx.reply("Meeting system not initialized.");
      return;
    }

    const meetings = meetingManagerRef.listMeetings({ limit: 10 });

    if (meetings.length === 0) {
      await ctx.reply("No meetings recorded yet.\n\nSend an audio file and reply with `/meeting Title with Attendees`");
      return;
    }

    let response = "*Recent Meetings*\n\n";
    for (const m of meetings) {
      const date = new Date(m.date).toLocaleDateString();
      const duration = formatDuration(m.durationSeconds);
      const statusIcon = m.status === "complete" ? "✅" : m.status === "error" ? "❌" : "⏳";

      response += `${statusIcon} *${m.title}*\n`;
      response += `   ${date} • ${duration}\n`;
      response += `   Attendees: ${m.attendees.join(", ") || "—"}\n`;
      response += `   ID: \`${m.id}\`\n\n`;
    }

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // Handle audio documents (alternative trigger)
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type || "";
    const caption = ctx.message.caption || "";

    // Check if it's an audio file
    if (!mimeType.startsWith("audio/") && !mimeType.includes("ogg") && !mimeType.includes("mpeg")) {
      // Treat as general attachment
      try {
        const lane = telegramLane(ctx.chat.id);
        const filePath = await saveTelegramFile(ctx, doc.file_id, doc.file_name || doc.file_unique_id, ctx.chat.id);
        const pending = pendingAttachments.get(lane) ?? [];

        if (caption.trim()) {
          const parsed = parseCommand(caption.trim());
          if (!parsed) {
            addPendingAttachment(lane, filePath);
            await ctx.reply("Attachment saved. Send a message to process it.");
            return;
          }

          // Handle executor switch in caption
          if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
            const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
            await runManager.switchThreadHarness(
              lane,
              { harness: parsed.newExecutor, model },
              "telegram",
            );
            addPendingAttachment(lane, filePath);
            await ctx.reply(`Switched to ${parsed.newExecutor}. Attachment saved.`);
            return;
          }

          // Handle /new in caption
          if (parsed.isNewSession) {
            resetExecutorSessionForLane(lane, stateManager, runManager);
            if (!parsed.query) {
              addPendingAttachment(lane, filePath);
              await ctx.reply("Fresh session started. Attachment saved.");
              return;
            }
          }

          // Handle executor switch with query
          if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
            const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
            await runManager.switchThreadHarness(
              lane,
              { harness: parsed.newExecutor, model },
              "telegram",
            );
          }

          const attachments = [...pending, filePath];
          pendingAttachments.delete(lane);
          dispatchExecution(ctx, parsed, stateManager, runManager, false, attachments);
          return;
        }

        addPendingAttachment(lane, filePath);
        await ctx.reply("Attachment saved. Send a message to process it.");
      } catch (error) {
        logger.error({ error }, "Failed to save attachment");
        await ctx.reply(`Attachment error: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
      return;
    }

    // Check if caption has /meeting command
    if (!caption.toLowerCase().startsWith("/meeting")) {
      // Prompt user
      await ctx.reply(
        `Audio file detected: *${doc.file_name || "audio"}*\n\n` +
          `To transcribe, reply to this message with:\n` +
          `/meeting Title with Attendee1, Attendee2`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Process the /meeting command with this document
    if (!meetingManagerRef) {
      await ctx.reply("Meeting system not initialized.");
      return;
    }

    // Parse caption: "/meeting title with attendees"
    const input = caption.slice(8).trim(); // Remove "/meeting"
    let title = "Meeting";
    let attendees: string[] = [];

    const withMatch = input.match(/^(.+?)\s+with\s+(.+)$/i);
    if (withMatch) {
      title = (withMatch[1] || "").trim();
      attendees = (withMatch[2] || "").split(/[,;]/).map((a) => a.trim()).filter(Boolean);
    } else if (input) {
      title = input;
    }

    // Check file size
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await ctx.reply("Audio file too large. Maximum 20MB (~80 minutes of audio).");
      return;
    }

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      const fileName = doc.file_name || "audio.m4a";

      const meetingId = await meetingManagerRef.startMeetingProcessing({
        title,
        audioBuffer,
        audioFileName: fileName,
        attendees,
        chatId: ctx.chat.id,
      });

      await ctx.reply(
        `*Processing Meeting*\n\n` +
          `Title: ${title}\n` +
          `Attendees: ${attendees.length > 0 ? attendees.join(", ") : "(none specified)"}\n` +
          `File: ${fileName}\n\n` +
          `ID: \`${meetingId}\`\n\n` +
          `_Processing in background. You'll be notified when complete._`,
        { parse_mode: "Markdown" }
      );

      logger.info({ meetingId, title, attendees }, "Meeting processing started from caption");
    } catch (error) {
      logger.error({ error }, "Failed to process meeting document");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Failed to download file"}`);
    }
  });

  // Handle photo attachments
  bot.on("message:photo", async (ctx) => {
    try {
      if (!ctx.chat) return;
      const lane = telegramLane(ctx.chat.id);
      const caption = ctx.message.caption || "";
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) return;

      // Use the highest resolution photo
      const photo = photos[photos.length - 1];
      if (!photo) return;
      const filePath = await saveTelegramFile(ctx, photo.file_id, `${photo.file_id}.jpg`, ctx.chat.id);
      const pending = pendingAttachments.get(lane) ?? [];

      if (caption.trim()) {
        const parsed = parseCommand(caption.trim());
        if (!parsed) {
          addPendingAttachment(lane, filePath);
          await ctx.reply("Photo saved. Send a message to process it.");
          return;
        }

        if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
          const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
          await runManager.switchThreadHarness(
            lane,
            { harness: parsed.newExecutor, model },
            "telegram",
          );
          addPendingAttachment(lane, filePath);
          await ctx.reply(`Switched to ${parsed.newExecutor}. Photo saved.`);
          return;
        }

        if (parsed.isNewSession) {
          resetExecutorSessionForLane(lane, stateManager, runManager);
          if (!parsed.query) {
            addPendingAttachment(lane, filePath);
            await ctx.reply("Fresh session started. Photo saved.");
            return;
          }
        }

        if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
          const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
          await runManager.switchThreadHarness(
            lane,
            { harness: parsed.newExecutor, model },
            "telegram",
          );
        }

        const attachments = [...pending, filePath];
        pendingAttachments.delete(lane);
        dispatchExecution(ctx, parsed, stateManager, runManager, false, attachments);
        return;
      }

      addPendingAttachment(lane, filePath);
      await ctx.reply("Photo saved. Send a message to process it.");
    } catch (error) {
      logger.error({ error }, "Failed to save photo attachment");
      await ctx.reply(`Photo error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // /search — local SQLite-backed hybrid (vector + FTS5) search via MemoryIndexer.
  // Replaces the legacy Supabase hybrid + grep fallback (deleted with src/search/).
  bot.command("search", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>");
      return;
    }

    const formatHits = (
      hits: Array<{ filePath: string; content: string; score?: number; source?: string }>,
      q: string
    ): string => {
      if (hits.length === 0) return `No results for *${q}*.`;
      const lines = [`*Search results for* \`${q}\`:`, ""];
      for (const h of hits.slice(0, 5)) {
        const file = h.filePath.replace(/^.*\//, "");
        const snippet = h.content.length > 240 ? h.content.slice(0, 240) + "…" : h.content;
        const score = typeof h.score === "number" ? ` (${h.score.toFixed(3)})` : "";
        const src = h.source ? ` [${h.source}]` : "";
        lines.push(`*${file}*${src}${score}\n${snippet}\n`);
      }
      return lines.join("\n");
    };

    try {
      const indexer = getMemoryIndexer();
      let hits: Array<{ filePath: string; content: string; score?: number; source?: string }>;
      try {
        hits = await indexer.hybridSearch(query, 10);
      } catch (hybridErr) {
        logger.warn({ error: hybridErr, query }, "Hybrid search failed, falling back to FTS-only");
        hits = indexer.search(query, 10);
      }
      const formatted = formatHits(hits, query);
      try {
        await ctx.reply(formatted, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(formatted.replace(/[*_`]/g, ""));
      }
    } catch (error) {
      logger.error({ error, query }, "Search failed");
      await ctx.reply(`Search failed: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // Voice messages
  bot.on("message:voice", async (ctx) => {
    if (!config.voice.enabled) {
      await ctx.reply("Voice messages disabled.");
      return;
    }
    const voiceConfig: VoiceConfig = {
      elevenLabsApiKey: config.voice.elevenLabsApiKey,
      elevenLabsVoiceId: config.voice.elevenLabsVoiceId,
      elevenLabsModel: config.voice.elevenLabsModel,
    };
    if (!voiceConfig.elevenLabsApiKey) {
      await ctx.reply("ElevenLabs API key not configured.");
      return;
    }

    // Keep a live "typing" indicator from the moment the voice note arrives,
    // through download → transcription → execution → TTS synthesis. A one-shot
    // chat action expires after ~5s, and handleNewExecution shows no indicator
    // when called with returnResponse=true (the voice path), so without this the
    // user sees no feedback while the (often multi-second) pipeline runs.
    const typingLoop = new TelegramTypingLoop(ctx.chat.id, ctx.api);
    typingLoop.start();
    let handedOff = false;

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      const transcription = await transcribeWithFallback(audioBuffer, {
        elevenLabsApiKey: voiceConfig.elevenLabsApiKey,
      });

      if (!transcription.text.trim()) {
        await ctx.reply("Could not transcribe audio.");
        return;
      }

      logger.info(
        { text: transcription.text.slice(0, 50), engine: transcription.engine },
        "Voice transcribed",
      );

      const parsed = parseCommand(transcription.text);
      if (!parsed) {
        await ctx.reply("Could not parse voice message.");
        return;
      }

      // Handle executor switches via voice
      if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
        const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
        const lane = telegramLane(ctx.chat.id);
        await runManager.switchThreadHarness(
          lane,
          { harness: parsed.newExecutor, model },
          "telegram",
        );
        await ctx.reply(`Switched to ${parsed.newExecutor}`);
        return;
      }

      // Handle /new via voice — reset before execution so the fresh run
      // doesn't inherit pooled session, executor state, or pending context.
      if (parsed.isNewSession) {
        const lane = telegramLane(ctx.chat.id);
        resetExecutorSessionForLane(lane, stateManager, runManager);
        if (!parsed.query) {
          await ctx.reply(`Fresh session started. Executor reset to the default (${stateManager.resolveDefaultExecutor()}).`);
          return;
        }
      }

      if (!parsed.query) {
        await ctx.reply("Could not parse voice message.");
        return;
      }

      // The turn is dispatched WITHOUT awaiting, like text: an awaited turn froze the poller
      // for its whole length, so an MFA code sent during a running /vc-login could not even
      // be fetched. The typing loop is handed to the continuation, which stops it.
      handedOff = true;
      void dispatchExecution(ctx, parsed, stateManager, runManager, true, [], true)
        .then((responseText) => deliverVoiceResponse(ctx, typeof responseText === "string" ? responseText : "", voiceConfig, transcription.text))
        .catch(async (error) => {
          logger.error({ error }, "Voice processing failed");
          await ctx.reply(`Voice error: ${error instanceof Error ? error.message : "Unknown"}`).catch(() => undefined);
        })
        .finally(() => typingLoop.stop());
    } catch (error) {
      logger.error({ error }, "Voice processing failed");
      await ctx.reply(`Voice error: ${error instanceof Error ? error.message : "Unknown"}`);
    } finally {
      if (!handedOff) typingLoop.stop();
    }
  });

  // Text messages - unified command handling
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const lane = telegramLane(ctx.chat.id);

    // ---- Receipt. Persist FIRST, decide anything else after.
    //
    // An external MFA relay (private overlay, homer_db source) polls thread_messages
    // every 3s for the operator's answer and never touches getUpdates, so the
    // daemon's write is the whole transport. It used to happen inside handleNewExecution,
    // after the thinking indicator, the bootstrap read and the "queued" reply. It happens
    // here now, before any queueing decision, so a code lands in the table within one
    // relay poll even while a session turn is running.
    const replyWrapper = buildReplyWrapper(ctx, stateManager);
    let preRecordedMessageId: string | null = null;
    // Slash commands keep their previous behaviour (persisted only if they reach an
    // execution) so /status, /jobs and friends do not become conversation history.
    let inbound: ReturnType<typeof receiveInboundTelegramText> | null = null;
    if (!text.trim().startsWith("/")) {
      try {
        inbound = receiveInboundTelegramText(stateManager, {
          lane,
          chatId: ctx.chat.id,
          text,
          wrappedContent: replyWrapper ? replyWrapper.wrapper + text : null,
          replyToText: replyWrapper?.quoted ?? null,
          replyToDateSeconds: ctx.message.reply_to_message?.date ?? null,
        });
        preRecordedMessageId = inbound.threadMessageId;
      } catch (error) {
        logger.warn({ error }, "Inbound Telegram message persistence failed (continuing)");
      }
    }
    // M2: the acknowledgement is sent OUTSIDE the persistence try. Sending it from inside
    // meant a Telegram 5xx on ctx.reply skipped the `return`, was swallowed as a
    // "persistence" warning, and let the OTP fall through into the Claude session — the
    // exact leak this branch exists to close. A failed ack is logged and we still return.
    if (inbound?.relay) {
      // The relay consumes the row we just wrote and overwrites it afterwards. Feeding the
      // same code to the Claude session would copy a live OTP into a transcript the relay
      // cannot redact, so acknowledge and stop here instead of queueing it.
      const nonceSuffix = inbound.relay.nonce ? ` (relay [#${inbound.relay.nonce}])` : "";
      // N10: a code that quotes a different prompt than the one waiting will be ignored by
      // the relay, so say that rather than claiming it was delivered.
      const ackText = inbound.relay.mismatched
        ? "code received and withheld from the session, but it quotes an older prompt — the waiting login may not accept it; send the code as a new message if it stalls"
        : `code received — handing it to the login${nonceSuffix}`;
      logger.info(
        { nonce: inbound.relay.nonce, digits: inbound.relay.digits, source: inbound.relay.source, mismatched: inbound.relay.mismatched },
        "MFA relay code received from Telegram — acknowledged, not forwarded to the session",
      );
      try {
        await ctx.reply(ackText);
      } catch (error) {
        logger.error({ error }, "Failed to acknowledge an MFA relay code (still withheld from the session)");
      }
      return;
    }

    // Check for bare YouTube URLs first — queue for overnight summary
    try {
      const wasYouTubeUrl = await handleYouTubeUrl(ctx, text);
      if (wasYouTubeUrl) return;
    } catch (error) {
      logger.warn({ error }, "YouTube URL handling failed, falling back to normal flow");
    }

    // Check for phone call requests (e.g., "call +15550100 and tell him dinner's at 5:30")
    try {
      const wasCallRequest = await handleCallRequest(ctx, text, stateManager);
      if (wasCallRequest) return;
    } catch (error) {
      logger.warn({ error }, "Phone call handling failed, falling back to normal flow");
    }

    // Check for SMS requests (e.g., "text +15550100 hey what's up")
    try {
      const wasSmsRequest = await handleSmsRequest(ctx, text);
      if (wasSmsRequest) return;
    } catch (error) {
      logger.warn({ error }, "SMS handling failed, falling back to normal flow");
    }

    // Check for overnight work requests (e.g., "work on xyz tonight")
    // This handles special patterns before regular command parsing
    try {
      const wasOvernightRequest = await handleOvernightMessage(ctx, text);
      if (wasOvernightRequest) {
        return; // Overnight handler took care of it
      }
    } catch (error) {
      logger.warn({ error }, "Overnight message handling failed, falling back to normal flow");
    }

    // Global harness kill-switch (admin): /harness [claude|opencode|glm|codex|gemini|kimi|status].
    // Flips the GLOBAL default for every lane without an explicit per-lane override.
    const harnessMatch = text.trim().match(/^\/harness(?:@\w+)?(?:\s+(\S+))?\s*$/i);
    if (harnessMatch) {
      const arg = (harnessMatch[1] ?? "").toLowerCase();
      const usage = "`/harness claude` | `/harness opencode` | `/harness codex` | `/harness gemini` | `/harness kimi`";
      if (!arg || arg === "status") {
        const cur = stateManager.getHarnessDefault();
        await ctx.reply(`Harness default: *${cur.executor}*${cur.model ? ` (${cur.model})` : ""}\nUsage: ${usage}`, { parse_mode: "Markdown" });
      } else {
        const executor = arg === "glm" ? "opencode" : arg;
        const validated = validateHarnessSelection({ executor, model: null, scope: "telegram-global" });
        if (!validated.ok || !isScheduledHarnessExecutor(validated.executor)) {
          await ctx.reply(`Invalid harness "${arg}". Usage: ${usage}`, { parse_mode: "Markdown" });
          return;
        }

        stateManager.setHarnessDefault(validated.executor, validated.model);
        const entry = getCatalogEntry(validated.executor);
        await ctx.reply(
          `🔁 Global harness default → *${entry?.label ?? validated.executor}*${validated.model ? ` (${validated.model})` : ""}. Lanes without an explicit override now use ${entry?.label ?? validated.executor}.`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    const parsed = parseCommand(text);

    if (!parsed) {
      await ctx.reply("Could not parse message.");
      return;
    }

    // Reject unknown slash commands
    if (parsed.unknownCommand) {
      await ctx.reply("Unknown command. Type /start for help.");
      return;
    }

    // Handle deprecation warnings
    if (parsed.deprecationWarning) {
      await ctx.reply(`⚠️ ${parsed.deprecationWarning}`);
    }

    // Handle /new BEFORE reply injection — otherwise quote-replying with /new
    // would smuggle the quoted prior assistant text into the "fresh" session.
    if (parsed.isNewSession) {
      resetExecutorSessionForLane(lane, stateManager, runManager);
      if (parsed.query) {
        const attachments = consumePendingAttachments(lane);
        void dispatchExecution(ctx, parsed, stateManager, runManager, false, attachments, false, preRecordedMessageId);
      } else {
        await ctx.reply(`Fresh session started. Executor reset to the default (${stateManager.resolveDefaultExecutor()}).`);
      }
      return;
    }

    // If the user quote-replied to a Homer message, inject the quoted content as
    // explicit reply context. Earlier handlers (approval.ts reply dispatch for
    // plan revisions / discussions / instruction requests) already ran and
    // `return`'d for their matches; we only reach here for generic conversation.
    // Wrapper computed at receipt (buildReplyWrapper) so the persisted row and the query
    // handed to the executor carry the same quoted block.
    if (replyWrapper && parsed.query && parsed.query.trim()) {
      parsed.query = replyWrapper.wrapper + parsed.query;
      logger.info(
        { telegramMessageId: ctx.message.reply_to_message?.message_id },
        "Injected Telegram reply context"
      );
    }

    // Handle pure executor switch (no query)
    if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
      const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
      const { handoffBuilt: contextCarried } = await runManager.switchThreadHarness(
        lane,
        { harness: parsed.newExecutor, model },
        "telegram",
      );

      const contextNote = contextCarried ? "\n_(Conversation context carried over)_" : "";
      await ctx.reply(
        `Switched to *${parsed.newExecutor}*${model ? ` (${model})` : ""}${contextNote}\n\n` +
          `All messages will now use ${parsed.newExecutor} until you switch or use /new.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Handle executor switch with query (e.g., "/gemini what's the weather")
    if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
      const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
      await runManager.switchThreadHarness(
        lane,
        { harness: parsed.newExecutor, model },
        "telegram",
      );

      // Execute the query with the new executor
      const attachments = consumePendingAttachments(lane);
      void dispatchExecution(ctx, parsed, stateManager, runManager, false, attachments, false, preRecordedMessageId);
      return;
    }

    // Regular message - use current executor state
    if (!parsed.query && !parsed.command) {
      await ctx.reply("Send a message to continue.");
      return;
    }

    const attachments = consumePendingAttachments(lane);
    void dispatchExecution(ctx, parsed, stateManager, runManager, false, attachments, false, preRecordedMessageId);
  });

  return bot;
}

/**
 * Get subagent prefix for prompt injection (legacy support)
 */
/**
 * Handle execution with the new command system
 */
const VOICE_MODE_INSTRUCTION = `<voice-mode>
You MUST structure your response in exactly two sections using these XML tags:

<spoken>
Your full spoken response here. Natural spoken language suitable for text-to-speech. No markdown, no bullet lists, no code blocks. Use conversational transitions. Cover all key points thoroughly but concisely.
</spoken>

<summary>
A bullet-point summary (using • or -) of the key takeaways. This is a separate written summary for reading, NOT a transcript of the spoken part. Keep it concise — max 5-8 bullets. Use markdown formatting.
</summary>

IMPORTANT: You MUST include both <spoken> and <summary> tags. The spoken section is for audio playback. The summary is a complementary text reference with the main points.
</voice-mode>`;

const MAX_QUOTE = 1800;

/**
 * Build the `<replying-to …>` prefix for a quote-reply, or null when the message is not
 * a usable quote-reply. Computed at RECEIPT so the exact text we persist to
 * thread_messages is the wrapped form the MFA relay's split_reply() expects — the nonce
 * check that stops a late answer being typed into a new login depends on it.
 */
function buildReplyWrapper(ctx: Context, stateManager: StateManager): { wrapper: string; quoted: string } | null {
  const replyMsg = ctx.message?.reply_to_message;
  if (!replyMsg || !ctx.chat) return null;
  const registryRow = stateManager.isOpen ? stateManager.getTelegramMessage(ctx.chat.id, replyMsg.message_id) : null;
  const quotedText = registryRow?.messageText
    ?? ("text" in replyMsg ? replyMsg.text : undefined)
    ?? ("caption" in replyMsg ? replyMsg.caption : undefined);
  const fromBot = replyMsg.from?.is_bot === true;
  if (!quotedText || !(registryRow || fromBot)) return null;
  const clipped = quotedText.length > MAX_QUOTE ? quotedText.slice(0, MAX_QUOTE) + "\n…[truncated]" : quotedText;
  const attrs = [`source="telegram"`, `message_id="${replyMsg.message_id}"`];
  if (registryRow?.threadId) attrs.push(`thread_id="${registryRow.threadId}"`);
  if (registryRow?.runId) attrs.push(`run_id="${registryRow.runId}"`);
  return { wrapper: `<replying-to ${attrs.join(" ")}>\n${clipped}\n</replying-to>\n\n`, quoted: clipped };
}

/**
 * Run a turn WITHOUT blocking grammy's update loop.
 *
 * grammy's built-in long polling handles updates strictly sequentially
 * (`Bot.handleUpdates`: "handle updates sequentially (!)") and does not issue the next
 * getUpdates until the current batch's middleware has settled. Awaiting a full executor
 * turn inside the handler therefore froze the entire chat for the length of the turn:
 * the "queued — will reply after current turn" branch had never once fired in the daemon
 * log, and an MFA code sent during a running /vc-login session was not even fetched from
 * Telegram — let alone written to thread_messages — until that session had finished, so
 * the relay always timed out.
 *
 * Per-lane ordering is still guaranteed downstream: CLIRunManager.startRun chains runs on
 * the lane, and the user turn is already persisted at receipt, in arrival order.
 *
 * The media handlers (document / photo / voice) dispatch the same way since round 4; voice
 * chains its TTS delivery onto the returned promise. Rejections are logged here and the
 * returned promise resolves to undefined, so callers chain `.then` without their own catch.
 */
function dispatchExecution(
  ctx: Context,
  parsed: ParsedCommand,
  stateManager: StateManager,
  runManager: CLIRunManager,
  returnResponse: boolean,
  attachments: string[] = [],
  voiceMode = false,
  preRecordedMessageId: string | null = null,
): Promise<string | void> {
  const lane = ctx.chat ? telegramLane(ctx.chat.id) : "tg:unknown";
  // N13: getActiveRun reads `activeRuns`, which _executeRun populates — a run sitting in the
  // lane CHAIN is not there yet, so a message arriving between one turn ending and the next
  // chained turn starting saw an idle lane and opened a draft it should not have.
  const admission = claimLaneAdmission(
    lane,
    (l) => runManager.getActiveRun(l) !== null || runManager.getQueueDepth(l) > 0,
  );
  return handleNewExecution(
    ctx, parsed, stateManager, runManager, returnResponse, attachments, voiceMode, preRecordedMessageId, admission,
  )
    .catch((error) => { logger.error({ error }, "Telegram execution dispatch failed"); })
    .finally(() => admission.release());
}

/** Voice in = voice out: the TTS reply (with text fallback) for a dispatched voice turn. */
async function deliverVoiceResponse(ctx: Context, responseText: string, voiceConfig: VoiceConfig, transcriptionText: string): Promise<void> {
  // Voice in = voice out: always reply with voice
  if (voiceConfig.elevenLabsApiKey && responseText) {
    // Parse spoken and summary sections from response
    const spokenMatch = responseText.match(/<spoken>([\s\S]*?)<\/spoken>/);
    const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/);
    const spokenText = spokenMatch?.[1]?.trim() || responseText.replace(/<\/?(?:spoken|summary)>/g, "").trim();
    const summaryText = summaryMatch?.[1]?.trim() || null;

    // Log transcription + response locally for future DB indexing
    logger.info(
      { transcription: transcriptionText, response: spokenText.slice(0, 500) },
      "Voice exchange logged"
    );

    try {
      const ttsText = truncateForTTS(spokenText);
      // Use DG Instant Clone voice for spoken output
      const ttsVoiceConfig: VoiceConfig = {
        ...voiceConfig,
        elevenLabsVoiceId: "TqZYQPtYO1r4L4de7HwG",
        elevenLabsModel: "eleven_turbo_v2",
      };
      const ttsOptions: SynthesisOptions = { format: "ogg_opus" };
      const synthesis = await synthesizeSpeech(ttsText, ttsVoiceConfig, ttsOptions);
      await ctx.replyWithVoice(new InputFile(synthesis.audio, "response.ogg"));

      // Send the bullet-point summary after the voice reply
      if (summaryText) {
        try {
          await ctx.reply(summaryText, { parse_mode: "Markdown" });
        } catch {
          try { await ctx.reply(summaryText); } catch { /* non-critical */ }
        }
      }
    } catch (ttsError) {
      logger.warn({ error: ttsError }, "TTS failed, falling back to text");
      for (const chunk of chunkMessage(responseText)) {
        await ctx.reply(chunk);
      }
    }
  } else if (responseText) {
    for (const chunk of chunkMessage(responseText)) {
      await ctx.reply(chunk);
    }
  }
}

async function handleNewExecution(
  ctx: Context,
  parsed: ParsedCommand,
  stateManager: StateManager,
  runManager: CLIRunManager,
  returnResponse: boolean,
  attachments: string[] = [],
  voiceMode: boolean = false,
  /**
   * Row already written to thread_messages by receiveInboundTelegramText at receipt.
   * When set we reuse it instead of writing a second copy of the same user turn.
   */
  preRecordedMessageId: string | null = null,
  /** Per-lane admission claimed by dispatchExecution; absent for awaited callers. */
  admission: LaneAdmission | null = null,
): Promise<string | void> {
  if (!ctx.chat) {
    if (returnResponse) return "Error: chat context unavailable.";
    return;
  }
  if (!stateManager.isOpen) {
    logger.warn("handleNewExecution called after DB closed (shutdown race), ignoring");
    if (returnResponse) return "Error: system is shutting down.";
    return;
  }
  const lane = telegramLane(ctx.chat.id);
  const session = stateManager.getOrCreateSession(lane);

  // Get current executor state
  const executorState = stateManager.getCurrentExecutor(lane);
  const currentExecutor = executorState?.executor || "claude";

  // Determine if this is a new session
  const isNewSession = parsed.isNewSession;

  logger.info(
    {
      cwd: parsed.cwd,
      executor: currentExecutor,
      newSession: isNewSession,
      queryPreview: parsed.query.slice(0, 50),
    },
    "Executing command"
  );

  let streamingMsg = null;
  let draftStream: TelegramDraftStream | null = null;
  let typingLoop: TelegramTypingLoop | null = null;

  // Track streamed content with step markers to preserve multi-turn context.
  // onPartial receives monotonically growing cumulative text; we extract deltas
  // and interleave step markers so the final message preserves all turns.
  let lastPartialLen = 0;
  let compositeStreamContent = "";
  const toolSteps: Array<{ label: string; labelDone: string; id?: string; completed: boolean }> = [];

  // Now that the poller no longer blocks on a turn (see dispatchExecution), a second
  // message really can arrive mid-turn — so this branch is reachable for the first time.
  // Do NOT open a streaming draft and a typing loop for a turn that will sit in the lane
  // queue for minutes; the final answer goes out via sendFinalResponse instead.
  // DEBT (N12): `admission.queued` is decided synchronously at dispatch — which is the whole
  // point — but read here after several awaits, so a message whose predecessor finished in
  // the meantime still gets "queued — will reply after current turn" and no streaming draft.
  // Cosmetic only. Upgrade by re-checking `runManager.getActiveRun(lane)` here once the
  // admission wait has resolved, if the stale notice ever confuses anyone.
  const queuedBehindActiveRun = !returnResponse
    && (admission ? admission.queued : runManager.getActiveRun(lane) !== null);

  if (!returnResponse && !queuedBehindActiveRun) {
    if (ENABLE_STREAMING) {
      streamingMsg = await sendThinkingIndicator(ctx);
      if (streamingMsg) {
        draftStream = new TelegramDraftStream(
          streamingMsg.chatId,
          ctx.api,
          streamingMsg.messageId
        );
        typingLoop = new TelegramTypingLoop(streamingMsg.chatId, ctx.api);
        typingLoop.start();
      }
    } else {
      await ctx.replyWithChatAction("typing");
    }
  }

  try {
    // Load memory context only on the first message of a non-/new session.
    // /new = explicit clean slate: no bootstrap, no me.md/work.md/preferences.md.
    let memoryContext = "";
    if (!isNewSession && !executorState?.sessionId) {
      const bootstrap = await loadBootstrapFiles();
      if (bootstrap) {
        memoryContext = `<context>\n${bootstrap}\n</context>\n\n`;
        logger.debug({ length: bootstrap.length }, "Loaded memory context");
      }
    }

    const thread = stateManager.ensureThreadForLane(lane, {
      title: `Telegram ${ctx.chat.id}`,
      provider: currentExecutor,
      model: executorState?.model ?? null,
    });

    // Queue behind any in-flight run on this lane (CLIRunManager chains turns
    // per lane; new message is injected into the same Claude process via stdin).
    if (queuedBehindActiveRun) {
      await ctx.reply("queued — will reply after current turn");
    }

    // The row is normally written at RECEIPT (receiveInboundTelegramText), before the
    // queueing decision above, so the MFA relay can read it while a turn is still
    // running. Only paths that did not pre-record (media captions, /search) write here.
    let userMessageId: string | null = preRecordedMessageId;
    // L7: the pre-recorded row was written before attachments were consumed, so carry the
    // attachment metadata onto it rather than losing it for pre-recorded text turns.
    if (userMessageId && attachments.length > 0) {
      stateManager.setThreadMessageMetadata(userMessageId, { attachments });
    }
    if (!userMessageId && parsed.query && parsed.query.trim()) {
      userMessageId = randomUUID();
      stateManager.createThreadMessage({
        id: userMessageId,
        threadId: thread.id,
        role: "user",
        content: parsed.query,
        metadata: attachments.length > 0 ? { attachments } : undefined,
      });
    }

    const finalQuery = memoryContext + (voiceMode ? `${VOICE_MODE_INSTRUCTION}\n\n${parsed.query}` : parsed.query);

    // Enter the lane chain in arrival order (see claimLaneAdmission), then release the
    // next dispatch as soon as startRun has claimed the lane — not when the turn ends.
    if (admission) await admission.wait;
    const { runId, result } = await runManager.startRun({
      lane,
      query: finalQuery,
      cwd: parsed.cwd,
      attachments,
      threadId: thread.id,
      contextBeforeMessageId: userMessageId ?? undefined,
      suppressContext: parsed.isNewSession,
      onPartial: draftStream
        ? (cumulativeText: string) => {
            // Extract delta and append to composite (which includes step markers)
            const delta = cumulativeText.slice(lastPartialLen);
            lastPartialLen = cumulativeText.length;
            if (delta) {
              compositeStreamContent += delta;
              draftStream!.update(compositeStreamContent);
            }
          }
        : undefined,
      onEvent: draftStream
        ? (event: StreamStepEvent) => {
            if (event.type === "tool_use") {
              toolSteps.push({
                label: event.label,
                labelDone: event.labelDone,
                id: event.id,
                completed: false,
              });
              // Inject step marker into streaming display between turns
              compositeStreamContent += `\n\n🔧 ${event.label}`;
              draftStream!.update(compositeStreamContent);
            } else if (event.type === "tool_result" && event.id) {
              const step = toolSteps.find((s) => s.id === event.id);
              if (step) {
                step.completed = true;
                // Update inline marker from spinning to done
                compositeStreamContent = compositeStreamContent.replace(
                  `🔧 ${step.label}`,
                  `✓ ${step.labelDone}`
                );
                compositeStreamContent += "\n\n";
                draftStream!.update(compositeStreamContent);
              }
            }
          }
        : undefined,
    });
    admission?.release();

    const runResult = await result;

    // Await in-flight draft before sending final message
    if (draftStream) await draftStream.stop();
    if (typingLoop) typingLoop.stop();

    // Update session activity
    stateManager.updateSessionActivity(session.id);

    if (returnResponse) {
      return runResult.output;
    }

    let sentMessages: Array<{ chatId: number; messageId: number; text: string }> = [];

    if (ENABLE_STREAMING && streamingMsg) {
      // Build expandable blockquote with tool steps (if any)
      let stepsHtml: string | undefined;
      if (toolSteps.length > 0) {
        const stepsText = toolSteps
          .map((s) => `${s.completed ? "✓" : "…"} ${s.completed ? s.labelDone : s.label}`)
          .join("\n");
        stepsHtml = `<blockquote expandable>${escapeHtml(stepsText)}</blockquote>`;
      }

      // Use composite streamed content (preserves all turns) if tool steps
      // were present, otherwise fall back to runResult.output
      const finalText = toolSteps.length > 0 && compositeStreamContent.trim()
        ? compositeStreamContent
            .replace(/^(?:🔧|✓) [^\n]+$/gm, "")  // Strip inline step marker lines
            .replace(/\n{3,}/g, "\n\n")                // Collapse excessive newlines
            .trim()
        : runResult.output;

      sentMessages = await editWithResponse(ctx, streamingMsg, finalText, stepsHtml);
    } else {
      sentMessages = await sendFinalResponse(ctx, runResult.output);
    }

    // Register outgoing message(s) in replyable registry so quote-replies
    // can resolve back to this turn. Each chunk stores its own visible text
    // so replies to chunk N inject chunk N's content, not the full reply.
    for (const sent of sentMessages) {
      stateManager.recordTelegramMessage({
        chatId: sent.chatId,
        telegramMessageId: sent.messageId,
        lane,
        role: "assistant",
        messageKind: "conversation",
        threadId: thread.id,
        threadMessageId: runResult.assistantThreadMessageId ?? null,
        runId,
        sessionId: session.id,
        messageText: sent.text,
      });
    }
  } catch (error) {
    if (draftStream) await draftStream.stop();
    if (typingLoop) typingLoop.stop();

    logger.error({ error, query: parsed.query }, "Execution failed");

    // Don't attempt Telegram responses if DB/bot is shutting down
    if (!stateManager.isOpen) {
      logger.info("Suppressing error response — DB closed during shutdown");
      return;
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (returnResponse) {
      return `Error: ${errorMessage}`;
    }

    if (ENABLE_STREAMING && streamingMsg) {
      await editWithResponse(ctx, streamingMsg, `Error: ${errorMessage}`);
    } else {
      await ctx.reply(`Error: ${errorMessage}`);
    }
  }
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 1000 / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

/** Last polling error, for the recovery notice. Never contains message content. */
let lastPollingError: unknown = null;

export async function startBot(bot: Bot): Promise<void> {
  // Long-polling is exclusive: a second getUpdates consumer makes Telegram return 409 and
  // the live daemon crash-loops. On 2026-09-01 a test/build run under the live daemon did
  // exactly that. Nothing that is not the daemon may ever touch this bot token, so refuse
  // under the node:test runner (NODE_TEST_CONTEXT is set by it) or an explicit opt-out.
  //
  // This MUST be the first statement: it used to sit after `deleteWebhook`, which is a live
  // Bot API call against the production token, so a test that reached startBot already
  // mutated the real bot's webhook state before being refused.
  if (process.env.NODE_TEST_CONTEXT || process.env.HOMER_NO_TELEGRAM === "1") {
    throw new Error(
      "refusing to start Telegram polling: running under a test runner (NODE_TEST_CONTEXT=" +
        `${process.env.NODE_TEST_CONTEXT ?? ""} HOMER_NO_TELEGRAM=${process.env.HOMER_NO_TELEGRAM ?? ""}). ` +
        "A second poller would 409 the live daemon.",
    );
  }

  logger.info("Starting H.O.M.E.R bot...");

  // Clear any existing webhooks to prevent 409 conflicts after restart
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    logger.info("Webhook cleared for clean polling start");
  } catch (error) {
    logger.warn({ error }, "Failed to clear webhook (may not exist)");
  }

  bot.catch((err) => {
    logger.error({ error: err }, "Bot error");
  });

  // Polling failures degrade the BOT, never the daemon.
  //
  // 2026-09-01 19:41Z: a second getUpdates consumer appeared, Telegram answered the live
  // daemon's poll with 409 Conflict, grammy rejected bot.start(), and because this was the
  // last awaited statement in main() the rejection reached `main().catch` → process.exit(1).
  // That killed the scheduler, memory, telephony and every job — and, because that exit path
  // runs no shutdown tasks, orphaned the resident Chrome, which then made all 63 supervisor
  // restarts fail. A 409 is a recoverable, self-clearing condition (the other poller stops):
  // log it, publish the flag, back off, try again. Only a deliberate stop ends the loop.
  let attempt = 0;
  let degradedSince: number | null = null;
  // M7: the ping is the RESTART signal. onStart runs on every iteration of the supervised
  // loop, so without this flag a 409 that clears after one 5 s backoff would announce a
  // restart that never happened — a lie in exactly the situation this loop exists to make
  // survivable. Fires once per process, on the first successful start.
  let announcedProcessStart = false;
  for (;;) {
    try {
      await bot.start({
        onStart: (botInfo) => {
          const failures = attempt;
          const downMs = degradedSince === null ? 0 : Date.now() - degradedSince;
          const recovered = failures > 0;
          // A single 409 that clears on the first 5 s retry (the MFA relay's `auto` probe does
          // exactly that once per ask) is logged but not announced — see polling-health.
          const announce = recovered && shouldAnnouncePollingRecovery({ failures, downMs });
          attempt = 0;
          degradedSince = null;
          setTelegramPollingStatus({ healthy: true, reason: null, consecutiveFailures: 0 });
          logger.info({ username: botInfo.username, recovered, failures, downMs, announced: announce }, recovered ? "Telegram polling recovered" : "Bot started");
          // Startup ping — replaces watchdog escalation alerts. Non-circular: bot
          // is alive by the time this fires, so delivery succeeds.
          const chatId = process.env.ALLOWED_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
          if (chatId && !announcedProcessStart) {
            announcedProcessStart = true;
            bot.api
              .sendMessage(chatId, `🟢 Homer restarted at ${new Date().toISOString()}`)
              .catch((err) => logger.warn({ error: err }, "Startup ping failed"));
          } else if (chatId && announce) {
            bot.api
              .sendMessage(chatId, `🟡 Telegram polling recovered after ${failures} failure(s) over ${Math.round(downMs / 1000)}s: ${describeTelegramError(lastPollingError)}`)
              .catch((err) => logger.warn({ error: err }, "Polling-recovery ping failed"));
          }
        },
      });
      // bot.start() resolves only when polling stops — i.e. a deliberate bot.stop().
      setTelegramPollingStatus({ healthy: false, reason: "polling stopped", consecutiveFailures: 0, state: "stopped" });
      logger.info("Telegram polling stopped");
      return;
    } catch (error) {
      const reason = describeTelegramError(error);
      lastPollingError = error;
      attempt++;
      if (degradedSince === null) degradedSince = Date.now();
      setTelegramPollingStatus({ healthy: false, reason, consecutiveFailures: attempt });
      const delayMs = telegramPollBackoffMs(attempt);
      logger.error(
        { err: reason, attempt, delayMs, conflict: isTelegramConflict(error) },
        "Telegram polling failed — bot degraded, daemon continues; retrying",
      );
      // M4: Telegram is the alert channel, so a Telegram outage cannot alert through
      // Telegram. One SMS at the third consecutive failure — that is ~20 s of downtime,
      // well past a transient blip and well before the 5 min backoff plateau.
      if (attempt === 3) {
        void import("../telephony/emergency-sms.js")
          .then(({ sendEmergencySms }) => sendEmergencySms(`Homer Telegram polling down: ${reason}`))
          .catch(() => { /* best effort — the daemon is still up */ });
      }
      if (!telegramPollingWanted()) return;
      // L12: unref'd so a stray path where main() returns cannot be held open for up to
      // five minutes by a pending backoff.
      await new Promise<void>((resolve) => { setTimeout(resolve, delayMs).unref?.(); });
      if (!telegramPollingWanted()) return;
    }
  }
}



export function getReminderManager(): ReminderManager | null {
  return reminderManagerRef;
}

export function getMeetingManager(): MeetingManager | null {
  return meetingManagerRef;
}
