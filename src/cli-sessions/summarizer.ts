import type { ParsedSession } from "./parsers.js";
import { executeFlashViaOpenCode } from "../executors/gemini.js";
import { logger } from "../utils/logger.js";

/**
 * Smart session summarization with tiered strategy:
 * - ≤ 4 messages: template (free)
 * - 5-20 messages: Gemini Flash 3-5 bullets (~$0.001)
 * - 21+ messages: Gemini Flash 5-8 bullets, truncated (~$0.005)
 * - Sub-agent: skip (no summary)
 */
export async function summarizeSession(session: ParsedSession): Promise<string> {
  const msgCount = session.messageCount;

  // Small sessions: template summary
  if (msgCount <= 4) {
    return templateSummary(session);
  }

  // Medium/large sessions: Gemini Flash
  try {
    return await geminiSummary(session);
  } catch (error) {
    logger.warn({ error, sessionId: session.sessionId }, "Gemini summary failed, falling back to template");
    return templateSummary(session);
  }
}

/**
 * Free template summary for small sessions
 */
function templateSummary(session: ParsedSession): string {
  const firstUser = session.messages.find((m) => m.role === "user");
  const lastAssistant = session.messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant");

  const goal = firstUser?.content.slice(0, 200).trim() || "Unknown task";
  const outcome = lastAssistant?.content.slice(0, 300).trim() || "No outcome recorded";

  return `- **Goal:** ${goal}\n- **Outcome:** ${outcome}\n- Messages: ${session.messageCount}`;
}

/**
 * Gemini Flash summary for medium/large sessions
 */
async function geminiSummary(session: ParsedSession): Promise<string> {
  const isLarge = session.messageCount > 20;
  const bulletCount = isLarge ? "5-8" : "3-5";

  // Build conversation text
  let conversationText = session.messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  // Truncate large sessions
  if (conversationText.length > 50000) {
    conversationText = conversationText.slice(0, 50000) + "\n\n[...truncated]";
  }

  const prompt = `Summarize this ${session.agent} CLI session in ${bulletCount} bullet points. Focus on what was accomplished, key decisions made, and any blockers. Be specific (include file paths, function names, concrete details). Output ONLY bullet points, no preamble.

Agent: ${session.agent}
Model: ${session.model || "unknown"}
Messages: ${session.messageCount}

${conversationText}`;

  const result = await executeFlashViaOpenCode(prompt, {
    timeout: 60_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(`OpenCode Flash error: ${result.output}`);
  }

  return result.output.trim();
}

/**
 * Generate a title from the first user message
 */
export function generateTitle(session: ParsedSession): string {
  const firstUser = session.messages.find((m) => m.role === "user");
  if (!firstUser) return `${session.agent} session`;

  // Take first line, truncate to 100 chars
  const firstLine = firstUser.content.split("\n")[0] || "";
  const cleaned = firstLine.replace(/^(can you |please |help me |i need to |let's )/i, "").trim();
  return cleaned.slice(0, 100) || `${session.agent} session`;
}

/**
 * Build a raw excerpt (first ~2KB of conversation) for context
 */
export function buildRawExcerpt(session: ParsedSession, maxBytes: number = 2048): string {
  let excerpt = "";
  for (const msg of session.messages) {
    const line = `[${msg.role}]: ${msg.content}\n`;
    if (Buffer.byteLength(excerpt + line, "utf-8") > maxBytes) {
      break;
    }
    excerpt += line;
  }
  return excerpt;
}

/**
 * Determine target daily log date from session
 * Use end date if available, otherwise current date
 */
export function getLogDate(session: ParsedSession): string {
  const dateStr: string = session.endedAt || new Date().toISOString();
  const date = new Date(dateStr);
  const parts = date.toISOString().split("T");
  return parts[0] as string;
}

// Keep old function name for backward compatibility during transition
export { templateSummary as formatSessionForDailyLog };
