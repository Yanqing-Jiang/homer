import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { executeGeminiCLIDirect } from "../executors/gemini-cli.js";
import type { Bot } from "grammy";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

interface ConversationTurn {
  role: string;
  message: string;
  time_in_call_secs?: number;
}

interface ConversationAnalysis {
  call_successful?: string;
  transcript_summary?: string;
  call_summary_title?: string;
}

interface ConversationMetadata {
  call_duration_secs?: number;
  termination_reason?: string;
}

export interface ConversationData {
  conversation_id: string;
  agent_id?: string;
  status?: string;
  transcript: ConversationTurn[];
  analysis?: ConversationAnalysis;
  metadata?: ConversationMetadata;
}

/**
 * Fetch the full conversation transcript from ElevenLabs API.
 * Used as fallback when webhook payload doesn't include full data.
 */
export async function fetchConversationTranscript(
  conversationId: string
): Promise<ConversationData | null> {
  const apiKey = config.voice.elevenLabsApiKey;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      `${ELEVENLABS_API_BASE}/convai/conversations/${conversationId}`,
      {
        headers: { "xi-api-key": apiKey },
      }
    );

    if (!response.ok) {
      logger.error(
        { status: response.status, conversationId },
        "Failed to fetch ElevenLabs conversation"
      );
      return null;
    }

    return (await response.json()) as ConversationData;
  } catch (error) {
    logger.error({ error, conversationId }, "Error fetching conversation transcript");
    return null;
  }
}

/**
 * Get a call summary — use ElevenLabs' built-in analysis if available,
 * otherwise summarize via Gemini Flash.
 */
async function getCallSummary(conversation: ConversationData): Promise<string> {
  // Prefer ElevenLabs' built-in summary
  if (conversation.analysis?.transcript_summary) {
    return conversation.analysis.transcript_summary;
  }

  // Fallback: summarize via Gemini Flash
  const transcriptText = conversation.transcript
    .map((t) => `${t.role}: ${t.message}`)
    .join("\n");

  const duration = conversation.metadata?.call_duration_secs
    ? `${Math.floor(conversation.metadata.call_duration_secs / 60)}m ${conversation.metadata.call_duration_secs % 60}s`
    : "unknown";

  const prompt = `Summarize this phone call transcript concisely. Include:
1. Who was on the call (roles/names if mentioned)
2. Key topics discussed
3. Action items or follow-ups
4. Overall tone/outcome

Duration: ${duration}

Transcript:
${transcriptText.slice(0, 10000)}`;

  try {
    const result = await executeGeminiCLIDirect(prompt, {
      timeout: 60_000,
    });
    return result.output.trim();
  } catch (error) {
    logger.error({ error }, "Failed to summarize call transcript");
    return `Call completed (${duration}). ${conversation.transcript.length} turns. Summary unavailable.`;
  }
}

/**
 * Format call summary for Telegram (HTML).
 */
function formatCallSummaryForTelegram(
  summary: string,
  conversation: ConversationData
): string {
  const duration = conversation.metadata?.call_duration_secs
    ? `${Math.floor(conversation.metadata.call_duration_secs / 60)}m ${conversation.metadata.call_duration_secs % 60}s`
    : "unknown";
  const turns = conversation.transcript.length;
  const title = conversation.analysis?.call_summary_title || "Call Summary";
  const outcome = conversation.analysis?.call_successful
    ? ` (${conversation.analysis.call_successful})`
    : "";

  return (
    `<b>${escapeHtml(title)}</b>${outcome}\n` +
    `Duration: ${duration} | ${turns} turns\n` +
    `ID: <code>${conversation.conversation_id}</code>\n\n` +
    escapeHtml(summary)
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Process a call-complete webhook.
 * Can receive full conversation data from webhook payload, or fetch it by ID.
 */
export async function processCallComplete(
  conversationId: string,
  bot: Bot | null,
  chatId: number,
  webhookData?: ConversationData
): Promise<void> {
  if (!bot) {
    logger.warn("No bot available for call summary notification");
    return;
  }

  // Use webhook data if provided, otherwise fetch from API
  let conversation = webhookData;
  if (!conversation || !conversation.transcript?.length) {
    conversation = await fetchConversationTranscript(conversationId) ?? undefined;
  }

  if (!conversation) {
    logger.warn({ conversationId }, "Could not get conversation for summary");
    return;
  }

  if (!conversation.transcript || conversation.transcript.length === 0) {
    logger.info({ conversationId }, "Empty transcript, skipping summary");
    return;
  }

  const summary = await getCallSummary(conversation);
  const message = formatCallSummaryForTelegram(summary, conversation);

  try {
    const { sendCallSummaryWithButtons } = await import("../bot/handlers/call-followup.js");
    await sendCallSummaryWithButtons(bot, chatId, message, conversationId);
  } catch (error) {
    // Fallback: send without buttons
    logger.warn({ error }, "Failed to send with buttons, sending plain message");
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "HTML" });
    } catch (sendError) {
      logger.error({ error: sendError }, "Failed to send call summary to Telegram");
    }
  }

  logger.info({ conversationId }, "Call summary sent to Telegram");
}
