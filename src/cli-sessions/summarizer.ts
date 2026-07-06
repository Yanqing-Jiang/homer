import { stripSessionScaffolding, type ParsedMessage, type ParsedSession } from "./parsers.js";
import { executeResolvedHarness } from "../harness/dispatch.js";
import { logger } from "../utils/logger.js";

/**
 * Smart session summarization with tiered strategy:
 * - ≤ 4 messages: template (free)
 * - 5+ messages: global-harness retrieval summary, capped at 50k chars
 * - Sub-agent: skip (no summary)
 * Model/harness is controlled by the `global` harness_selection row, not pinned here.
 */
export async function summarizeSession(session: ParsedSession, signal?: AbortSignal): Promise<string> {
  const msgCount = session.messageCount;

  // Small sessions: template summary
  if (msgCount <= 4) {
    return templateSummary(session);
  }

  // Medium/large sessions: global harness
  try {
    return await harnessSummary(session, signal);
  } catch (error) {
    logger.warn({ error, sessionId: session.sessionId }, "Session summary failed, falling back to template");
    return templateSummary(session);
  }
}

/**
 * Free template summary for small sessions
 */
function templateSummary(session: ParsedSession): string {
  const firstUser = findFirstSubstantiveUser(session);
  const lastAssistant = session.messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant");

  const goal = firstUser?.content.slice(0, 200).trim() || "Unknown task";
  const outcome = lastAssistant?.content.slice(0, 300).trim() || "No outcome recorded";

  return `- **Goal:** ${goal}\n- **Outcome:** ${outcome}\n- Messages: ${session.messageCount}`;
}

/**
 * Global-harness summary for medium/large sessions
 */
async function harnessSummary(session: ParsedSession, signal?: AbortSignal): Promise<string> {
  const targetTokens = session.messageCount > 50
    ? "250-300"
    : session.messageCount > 20
    ? "200-250"
    : "150-200";

  // Build conversation text
  let conversationText = session.messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  // Truncate large sessions
  if (conversationText.length > 50000) {
    conversationText = conversationText.slice(0, 50000) + "\n\n[...truncated]";
  }

  const prompt = `Create a retrieval-optimized summary of this ${session.agent} CLI session.
Target length: ~${targetTokens} tokens, scaled to the session length.
Preserve proper nouns, file paths, table/project names, decisions, and numbers VERBATIM; these are retrieval keys for FTS and entity boosting.
Use exactly these Markdown sections and keep each concise:

**Accomplished**
**Decisions**
**Entities touched**
**Open items**

If a section has nothing concrete, write "None recorded." Output only the summary, no preamble.

Agent: ${session.agent}
Model: ${session.model || "unknown"}
Messages: ${session.messageCount}

${conversationText}`;

  // Follows the global harness switcher (no pin) — controlled by the `global` harness_selection row.
  const result = await executeResolvedHarness({
    source: "runtime",
    mode: "runtime-turn",
    prompt,
    timeoutMs: 900_000,
    signal,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Session summary harness error: ${result.output}`);
  }

  return result.output.trim();
}

/**
 * Generate a title from the first user message
 */
export function generateTitle(session: ParsedSession): string {
  const firstUser = findFirstSubstantiveUser(session);
  if (!firstUser) return `${session.agent} session`;

  // Take first non-empty line, truncate to 100 chars
  const firstLine = firstUser.content.split("\n").find((line) => line.trim()) || "";
  const cleaned = firstLine.replace(/^(can you |please |help me |i need to |let's )/i, "").trim();
  return cleaned.slice(0, 100) || `${session.agent} session`;
}

/**
 * Build a raw excerpt from the first substantive user request and final outcome.
 */
export function buildRawExcerpt(session: ParsedSession, maxBytes: number = 2048): string {
  const firstUser = findFirstSubstantiveUser(session);
  const lastAssistant = session.messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant" && m.content.trim());

  const userPart = firstUser ? truncateUtf8(firstUser.content, 1200) : "";
  const assistantPart = lastAssistant ? truncateUtf8(lastAssistant.content, 800, true) : "";
  const separator = userPart && assistantPart ? " … " : "";
  return truncateUtf8(`${userPart}${separator}${assistantPart}`, maxBytes);
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

function findFirstSubstantiveUser(session: ParsedSession): ParsedMessage | undefined {
  for (const msg of session.messages) {
    if (msg.role !== "user") continue;
    const content = stripSessionScaffolding(msg.content);
    if (content) {
      return { ...msg, content };
    }
  }
  return undefined;
}

function truncateUtf8(text: string, maxBytes: number, fromEnd = false): string {
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, "utf-8") <= maxBytes) {
    return trimmed;
  }

  let result = fromEnd ? trimmed.slice(-maxBytes) : trimmed.slice(0, maxBytes);
  while (Buffer.byteLength(result, "utf-8") > maxBytes) {
    result = fromEnd ? result.slice(1) : result.slice(0, -1);
  }
  return result.trim();
}
