import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { chunkMessage } from "../utils/chunker.js";
import type {
  NotificationDecision,
  NotificationIntent,
  NotificationSourceType,
} from "./types.js";

const MAX_OUTPUT_LENGTH = 4000;

export interface TelegramDeliveryResult {
  message_id?: number;
  message_ids?: number[];
}

interface NotificationAuditEntry {
  db?: Database.Database;
  sourceType: NotificationSourceType;
  sourceId: string;
  jobRunId?: number | null;
  intent: NotificationIntent;
  decision: NotificationDecision;
  title?: string;
  messageText: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  telegramMessageId?: number | null;
}

export interface RouteTelegramNotificationOptions {
  db?: Database.Database;
  sourceType: NotificationSourceType;
  sourceId: string;
  jobRunId?: number | null;
  intent: NotificationIntent;
  title?: string;
  messageText: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  deliver?: () => Promise<TelegramDeliveryResult | void>;
}

export interface RouteTelegramNotificationResult {
  decision: NotificationDecision;
  telegramMessageId?: number;
}

export interface ChunkedTelegramMessageOptions {
  bot: Bot;
  chatId: number;
  message: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  enableLinkPreview?: boolean;
}

function isDeliverableIntent(intent: NotificationIntent): boolean {
  return intent !== "operational_status";
}

function normalizeMessage(message: string): string {
  if (message.length <= MAX_OUTPUT_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_OUTPUT_LENGTH - 20)}\n\n(truncated)`;
}

const PRESERVED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "blockquote",
  "a",
];

function preserveTelegramHtmlTags(input: string): {
  text: string;
  placeholders: Map<string, string>;
} {
  const placeholders = new Map<string, string>();
  let placeholderIndex = 0;
  const pattern = new RegExp(
    `<\\/?(?:${PRESERVED_TAGS.join("|")})(?:\\s+href="[^"]*")?>`,
    "gi",
  );

  const text = input.replace(pattern, (match) => {
    const key = `@@TGHTML${placeholderIndex++}@@`;
    placeholders.set(key, match);
    return key;
  });

  return { text, placeholders };
}

function restoreTelegramHtmlTags(input: string, placeholders: Map<string, string>): string {
  let restored = input;
  for (const [key, value] of placeholders.entries()) {
    restored = restored.replaceAll(key, value);
  }
  return restored;
}

function escapeHtmlText(input: string): string {
  return input
    .replace(/&(?!#?\w+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function convertMarkdownLinks(input: string): string {
  return input.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const safeLabel = escapeHtmlText(label.trim());
    const safeUrl = escapeHtmlText(url.trim());
    return `<a href="${safeUrl}">${safeLabel}</a>`;
  });
}

function convertFencedCodeBlocks(input: string): string {
  return input.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, (_match, code: string) => {
    const trimmed = code.trim();
    if (!trimmed) {
      return "";
    }
    return `<pre>${escapeHtmlText(trimmed)}</pre>`;
  });
}

function convertInlineMarkdown(input: string): string {
  return input
    .replace(/`([^`\n]+)`/g, (_match, text: string) => `<code>${escapeHtmlText(text)}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, (_match, prefix: string, text: string) => `${prefix}<i>${text}</i>`)
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, (_match, prefix: string, text: string) => `${prefix}<i>${text}</i>`);
}

function convertMarkdownStructure(input: string): string {
  const lines = input.split("\n");
  return lines.map((line) => {
    if (/^\s*#{1,6}\s+/.test(line)) {
      return line.replace(/^\s*#{1,6}\s+/, "<b>") + "</b>";
    }
    if (/^\s*[-*]\s+/.test(line)) {
      return line.replace(/^\s*[-*]\s+/, "• ");
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      return line.replace(/^\s*(\d+\.)\s+/, "$1 ");
    }
    return line;
  }).join("\n");
}

export function formatScheduledTelegramHtml(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/\r\n/g, "\n");
  const { text: protectedText, placeholders } = preserveTelegramHtmlTags(normalized);
  const withLinks = convertMarkdownLinks(protectedText);
  const withCodeBlocks = convertFencedCodeBlocks(withLinks);
  const structured = convertMarkdownStructure(withCodeBlocks);
  const inlineFormatted = convertInlineMarkdown(structured);
  const escaped = escapeHtmlText(inlineFormatted);
  const restored = restoreTelegramHtmlTags(escaped, placeholders)
    .replace(/&lt;(\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote))&gt;/gi, "<$1>")
    .replace(/&lt;a href=(?:"([^"]*)"|&quot;([^"]*)&quot;)&gt;/gi, (_match, plainHref: string, escapedHref: string) => {
      const href = plainHref || escapedHref;
      return `<a href="${href}">`;
    })
    .replace(/&lt;\/a&gt;/gi, "</a>");

  return restored
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtmlTags(message: string): string {
  return message.replace(/<[^>]*>/g, "");
}

function fallbackPlainText(message: string, parseMode?: "HTML" | "Markdown" | "MarkdownV2"): string {
  if (parseMode === "HTML") {
    return stripHtmlTags(message);
  }
  return message;
}

function logNotificationEvent(entry: NotificationAuditEntry): void {
  if (!entry.db) {
    return;
  }

  try {
    entry.db.prepare(`
      INSERT INTO notification_events (
        channel,
        source_type,
        source_id,
        job_run_id,
        intent,
        decision,
        title,
        message_text,
        reason,
        metadata_json,
        telegram_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "telegram",
      entry.sourceType,
      entry.sourceId,
      entry.jobRunId ?? null,
      entry.intent,
      entry.decision,
      entry.title ?? null,
      entry.messageText,
      entry.reason ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.telegramMessageId ?? null,
    );
  } catch (error) {
    logger.warn(
      { error, sourceType: entry.sourceType, sourceId: entry.sourceId },
      "Failed to write notification audit event"
    );
  }
}

export async function routeTelegramNotification(
  options: RouteTelegramNotificationOptions
): Promise<RouteTelegramNotificationResult> {
  const normalizedMessage = options.messageText.trim();

  if (!normalizedMessage) {
    logNotificationEvent({
      db: options.db,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      jobRunId: options.jobRunId,
      intent: options.intent,
      decision: "suppressed",
      title: options.title,
      messageText: options.messageText,
      reason: options.reason ?? "empty_message",
      metadata: options.metadata,
    });
    return { decision: "suppressed" };
  }

  if (!isDeliverableIntent(options.intent)) {
    logNotificationEvent({
      db: options.db,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      jobRunId: options.jobRunId,
      intent: options.intent,
      decision: "suppressed",
      title: options.title,
      messageText: options.messageText,
      reason: options.reason ?? "operational_status",
      metadata: options.metadata,
    });
    return { decision: "suppressed" };
  }

  if (!options.deliver) {
    logNotificationEvent({
      db: options.db,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      jobRunId: options.jobRunId,
      intent: options.intent,
      decision: "suppressed",
      title: options.title,
      messageText: options.messageText,
      reason: options.reason ?? "telegram_delivery_unavailable",
      metadata: options.metadata,
    });
    return { decision: "suppressed" };
  }

  try {
    const deliveryResult = await options.deliver();
    const telegramMessageId = deliveryResult?.message_id;
    const messageIds = deliveryResult?.message_ids;

    logNotificationEvent({
      db: options.db,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      jobRunId: options.jobRunId,
      intent: options.intent,
      decision: "sent",
      title: options.title,
      messageText: options.messageText,
      reason: options.reason ?? null,
      metadata: {
        ...options.metadata,
        chunkCount: messageIds?.length ?? 0,
        messageIds,
      },
      telegramMessageId: telegramMessageId ?? null,
    });

    return {
      decision: "sent",
      telegramMessageId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      { error, sourceType: options.sourceType, sourceId: options.sourceId },
      "Telegram notification delivery failed"
    );

    logNotificationEvent({
      db: options.db,
      sourceType: options.sourceType,
      sourceId: options.sourceId,
      jobRunId: options.jobRunId,
      intent: options.intent,
      decision: "suppressed",
      title: options.title,
      messageText: options.messageText,
      reason: options.reason ?? "telegram_send_failed",
      metadata: {
        ...options.metadata,
        error: errorMessage,
      },
    });

    return { decision: "suppressed" };
  }
}

export async function sendChunkedTelegramMessage(
  options: ChunkedTelegramMessageOptions
): Promise<TelegramDeliveryResult> {
  const text = normalizeMessage(options.message);
  const chunks = chunkMessage(text);
  const messageIds: number[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (!chunk) {
      continue;
    }

    const showPreview = options.enableLinkPreview === true && index === chunks.length - 1;

    try {
      const message = await options.bot.api.sendMessage(options.chatId, chunk, {
        parse_mode: options.parseMode,
        link_preview_options: showPreview
          ? { is_disabled: false, prefer_large_media: true }
          : { is_disabled: true },
      });
      messageIds.push(message.message_id);
    } catch (error) {
      logger.debug({ error }, "Telegram parse mode failed, retrying plain text");

      const plainText = fallbackPlainText(chunk, options.parseMode);
      const message = await options.bot.api.sendMessage(options.chatId, plainText, {
        link_preview_options: { is_disabled: true },
      });
      messageIds.push(message.message_id);
    }
  }

  return {
    message_id: messageIds[0],
    message_ids: messageIds,
  };
}
