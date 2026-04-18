import { Bot, type Context } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  parseCommand,
  isPureExecutorSwitch,
  isExecutorSwitchWithQuery,
  getExecutorModel,
  type ParsedCommand,
} from "../commands/index.js";
import { registerApprovalHandlers, registerPlanApprovalHandlers, registerPlanApprovalCallbacks, registerPlanReviewCallbacks } from "./handlers/approval.js";
import { registerIdeaCommands, registerIdeaCallbacks } from "./handlers/idea.js";
import { registerQuickCommands, registerProposalCallbacks } from "./handlers/proposal-approval.js";
import { registerOvernightCommands, handleOvernightMessage } from "./handlers/overnight.js";
import { handleYouTubeUrl, initializeYouTubeHandler } from "./handlers/youtube.js";
import { registerJobApprovalHandlers } from "./handlers/job-approval.js";
import { registerJobCommands, setJobScheduler } from "./handlers/job-commands.js";
import { handleCallRequest } from "./handlers/phone-call.js";
import { handleSmsRequest } from "./handlers/sms.js";
import { registerCallFollowupHandlers } from "./handlers/call-followup.js";
import { registerSmsReplyHandlers } from "./handlers/sms-reply.js";
import { registerMemoryReviewHandlers } from "./handlers/memory-review.js";
import { registerMorningReviewCallbacks } from "./handlers/morning-review.js";
import { registerWeeklyMemoryAuditHandlers } from "./handlers/weekly-memory-audit.js";
import { registerCodePushApprovalHandlers } from "./handlers/code-push-approval.js";
import { chunkMessage } from "../utils/chunker.js";
import { StateManager } from "../state/manager.js";
import { sendThinkingIndicator, editWithResponse, TelegramDraftStream, sendFinalResponse, TelegramTypingLoop } from "./streaming.js";
import { loadBootstrapFiles } from "../memory/loader.js";
import { searchMemory, formatSearchResults } from "../memory/search.js";
import { hybridSearch, formatHybridResults } from "../search/index.js";
import type { SearchConfig } from "../search/types.js";
import { transcribeAudio, synthesizeSpeech, truncateForTTS } from "../voice/index.js";
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
import { buildConversationContext } from "../executors/context-builder.js";
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

export function setScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
  setJobScheduler(scheduler);
}

export function setReminderManager(reminderManager: ReminderManager): void {
  reminderManagerRef = reminderManager;
}

export function setMeetingManager(meetingManager: MeetingManager): void {
  meetingManagerRef = meetingManager;
}

export function createBot(stateManager: StateManager, runManager: CLIRunManager): Bot {
  const bot = new Bot(config.telegram.botToken);

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

  // Register /idea command and inline button callbacks
  registerIdeaCommands(bot, stateManager);
  registerIdeaCallbacks(bot);

  // Register overnight work commands (/overnight) and inline button callbacks
  registerOvernightCommands(bot, stateManager);

  // Register job hunt approval callbacks and commands
  registerJobApprovalHandlers(bot, stateManager);
  registerJobCommands(bot, stateManager);

  // Register call follow-up and SMS reply inline button callbacks
  registerCallFollowupHandlers(bot);
  registerSmsReplyHandlers(bot);

  // Register memory review handlers (human-gated memory curation)
  registerMemoryReviewHandlers(bot, stateManager);

  // Register morning review callbacks (consolidated 9 AM approval session)
  registerMorningReviewCallbacks(bot, config.telegram.allowedChatId, stateManager);

  // Register weekly memory audit handlers (Sunday 9 AM canonical memory review)
  registerWeeklyMemoryAuditHandlers(bot, stateManager);

  // Register nightly-code-push approval handlers (Phase 1.4)
  registerCodePushApprovalHandlers(bot, stateManager);

  // Initialize YouTube URL handler
  initializeYouTubeHandler(stateManager);

  // /start - help
  bot.command("start", async (ctx) => {
    // Get current executor state
    const lane = telegramLane(ctx.chat.id);
    const executorState = stateManager.getCurrentExecutor(lane);
    const currentExecutor = executorState?.executor || "claude";

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
        "*Ideas:*\n" +
        "/idea - List/add/update/archive ideas\n\n" +
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
      statusText += "Executor: *claude* (default)\n\n";
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
            runManager.cancelRun(lane, "executor switch");
            stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);
            addPendingAttachment(lane, filePath);
            await ctx.reply(`Switched to ${parsed.newExecutor}. Attachment saved.`);
            return;
          }

          // Handle /new in caption
          if (parsed.isNewSession) {
            runManager.cancelRun(lane, "new session");
            stateManager.clearExecutor(lane);
            stateManager.clearStoredExecutorSessions(lane);
            if (!parsed.query) {
              addPendingAttachment(lane, filePath);
              await ctx.reply("Fresh session started. Attachment saved.");
              return;
            }
          }

          // Handle executor switch with query
          if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
            const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
            runManager.cancelRun(lane, "executor switch with query");
            stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);
          }

          const attachments = [...pending, filePath];
          pendingAttachments.delete(lane);
          await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
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
          runManager.cancelRun(lane, "executor switch");
          stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);
          addPendingAttachment(lane, filePath);
          await ctx.reply(`Switched to ${parsed.newExecutor}. Photo saved.`);
          return;
        }

        if (parsed.isNewSession) {
          runManager.cancelRun(lane, "new session");
          stateManager.clearExecutor(lane);
          stateManager.clearStoredExecutorSessions(lane);
          if (!parsed.query) {
            addPendingAttachment(lane, filePath);
            await ctx.reply("Fresh session started. Photo saved.");
            return;
          }
        }

        if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
          const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
          runManager.cancelRun(lane, "executor switch with query");
          stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);
        }

        const attachments = [...pending, filePath];
        pendingAttachments.delete(lane);
        await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
        return;
      }

      addPendingAttachment(lane, filePath);
      await ctx.reply("Photo saved. Send a message to process it.");
    } catch (error) {
      logger.error({ error }, "Failed to save photo attachment");
      await ctx.reply(`Photo error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // /search
  bot.command("search", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>");
      return;
    }
    const searchConfig: SearchConfig = {
      supabaseUrl: config.search.supabaseUrl,
      supabaseAnonKey: config.search.supabaseAnonKey,
      openaiApiKey: config.voice.openaiApiKey,
      embeddingModel: config.search.embeddingModel,
      chunkSize: config.search.chunkSize,
      chunkOverlap: config.search.chunkOverlap,
    };

    try {
      const results = await hybridSearch(query, searchConfig);
      const formatted = formatHybridResults(results, query);
      try {
        await ctx.reply(formatted, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(formatted.replace(/[*_`]/g, ""));
      }
    } catch (error) {
      logger.warn({ error, query }, "Hybrid search failed, using grep");
      try {
        const results = await searchMemory(query);
        const formatted = formatSearchResults(results, query);
        await ctx.reply(formatted);
      } catch (grepError) {
        logger.error({ error: grepError, query }, "Search failed");
        await ctx.reply(`Search failed: ${error instanceof Error ? error.message : "Unknown"}`);
      }
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

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      await ctx.replyWithChatAction("typing");
      const transcription = await transcribeAudio(audioBuffer, voiceConfig);

      if (!transcription.text.trim()) {
        await ctx.reply("Could not transcribe audio.");
        return;
      }

      logger.info({ text: transcription.text.slice(0, 50) }, "Voice transcribed");

      const parsed = parseCommand(transcription.text);
      if (!parsed) {
        await ctx.reply("Could not parse voice message.");
        return;
      }

      // Handle executor switches via voice
      if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
        const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
        const lane = telegramLane(ctx.chat.id);
        runManager.cancelRun(lane, "voice executor switch");
        stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);
        await ctx.reply(`Switched to ${parsed.newExecutor}`);
        return;
      }

      if (!parsed.query) {
        await ctx.reply("Could not parse voice message.");
        return;
      }

      const responseText = await handleNewExecution(ctx, parsed, stateManager, runManager, true, [], true);

      // Voice in = voice out: always reply with voice
      if (voiceConfig.elevenLabsApiKey && responseText) {
        // Parse spoken and summary sections from response
        const spokenMatch = responseText.match(/<spoken>([\s\S]*?)<\/spoken>/);
        const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/);
        const spokenText = spokenMatch?.[1]?.trim() || responseText.replace(/<\/?(?:spoken|summary)>/g, "").trim();
        const summaryText = summaryMatch?.[1]?.trim() || null;

        // Log transcription + response locally for future DB indexing
        logger.info(
          { transcription: transcription.text, response: spokenText.slice(0, 500) },
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
    } catch (error) {
      logger.error({ error }, "Voice processing failed");
      await ctx.reply(`Voice error: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // Text messages - unified command handling
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const lane = telegramLane(ctx.chat.id);

    // Check for bare YouTube URLs first — queue for overnight summary
    try {
      const wasYouTubeUrl = await handleYouTubeUrl(ctx, text);
      if (wasYouTubeUrl) return;
    } catch (error) {
      logger.warn({ error }, "YouTube URL handling failed, falling back to normal flow");
    }

    // Check for phone call requests (e.g., "call 2709789240 and introduce yourself")
    try {
      const wasCallRequest = await handleCallRequest(ctx, text);
      if (wasCallRequest) return;
    } catch (error) {
      logger.warn({ error }, "Phone call handling failed, falling back to normal flow");
    }

    // Check for SMS requests (e.g., "text 2709789240 hey what's up")
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

    // Handle pure executor switch (no query)
    if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
      const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
      const currentState = stateManager.getCurrentExecutor(lane);
      const previousExecutor = currentState?.executor ?? "claude";

      runManager.cancelRun(lane, "executor switch");

      // Build and store conversation context for handoff (if switching to different executor)
      let contextCarried = false;
      if (previousExecutor !== parsed.newExecutor) {
        try {
          const context = await buildConversationContext(
            stateManager,
            { type: "lane", id: lane },
            { maxMessages: 8, maxTokens: 1500 }
          );
          if (context.messageCount > 0) {
            stateManager.setPendingContext(lane, context.formatted, previousExecutor);
            contextCarried = true;
            logger.debug({ lane, messageCount: context.messageCount }, "Built pending context for Telegram executor switch");
          }
        } catch (err) {
          logger.warn({ err, lane }, "Failed to build context for Telegram executor switch");
        }
      }

      stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);

      const contextNote = contextCarried ? "\n_(Conversation context carried over)_" : "";
      await ctx.reply(
        `Switched to *${parsed.newExecutor}*${model ? ` (${model})` : ""}${contextNote}\n\n` +
          `All messages will now use ${parsed.newExecutor} until you switch or use /new.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Handle /new command
    if (parsed.isNewSession) {
      // Clear executor state
      runManager.cancelRun(lane, "new session");
      stateManager.clearExecutor(lane);
      stateManager.clearStoredExecutorSessions(lane);

      // If there's a query with /new, execute it fresh
      if (parsed.query) {
        const attachments = consumePendingAttachments(lane);
        await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
      } else {
        await ctx.reply("Fresh session started. Executor reset to Claude.");
      }
      return;
    }

    // Handle executor switch with query (e.g., "/gemini what's the weather")
    if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
      const model = parsed.model ?? getExecutorModel(parsed.newExecutor);
      const currentState = stateManager.getCurrentExecutor(lane);
      const previousExecutor = currentState?.executor ?? "claude";

      runManager.cancelRun(lane, "executor switch with query");

      // Build and store conversation context for handoff (if switching to different executor)
      if (previousExecutor !== parsed.newExecutor) {
        try {
          const context = await buildConversationContext(
            stateManager,
            { type: "lane", id: lane },
            { maxMessages: 8, maxTokens: 1500 }
          );
          if (context.messageCount > 0) {
            stateManager.setPendingContext(lane, context.formatted, previousExecutor);
            logger.debug({ lane, messageCount: context.messageCount }, "Built pending context for Telegram executor switch with query");
          }
        } catch (err) {
          logger.warn({ err, lane }, "Failed to build context for Telegram executor switch");
        }
      }

      stateManager.setCurrentExecutor(lane, parsed.newExecutor, model);

      // Execute the query with the new executor
      const attachments = consumePendingAttachments(lane);
      await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
      return;
    }

    // Regular message - use current executor state
    if (!parsed.query && !parsed.command) {
      await ctx.reply("Send a message to continue.");
      return;
    }

    const attachments = consumePendingAttachments(lane);
    await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
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

async function handleNewExecution(
  ctx: Context,
  parsed: ParsedCommand,
  stateManager: StateManager,
  runManager: CLIRunManager,
  returnResponse: boolean,
  attachments: string[] = [],
  voiceMode: boolean = false
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

  if (!returnResponse) {
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

    // Check BEFORE persisting to avoid orphaned thread messages
    if (runManager.getActiveRun(lane)) {
      await ctx.reply("A run is already in progress for this chat. Please wait.");
      return;
    }

    let userMessageId: string | null = null;
    if (parsed.query && parsed.query.trim()) {
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

    const { result } = await runManager.startRun({
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

    const runResult = await result;

    // Await in-flight draft before sending final message
    if (draftStream) await draftStream.stop();
    if (typingLoop) typingLoop.stop();

    // Update session activity
    stateManager.updateSessionActivity(session.id);

    if (returnResponse) {
      return runResult.output;
    }

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

      await editWithResponse(ctx, streamingMsg, finalText, stepsHtml);
    } else {
      await sendFinalResponse(ctx, runResult.output);
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

export async function startBot(bot: Bot): Promise<void> {
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
  await bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, "Bot started");
    },
  });
}

export function getReminderManager(): ReminderManager | null {
  return reminderManagerRef;
}

export function getMeetingManager(): MeetingManager | null {
  return meetingManagerRef;
}
