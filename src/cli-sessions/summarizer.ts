import type { ParsedSession } from "./parsers.js";

/**
 * Format session for daily log with maximum detail preservation
 *
 * IMPORTANT: Do NOT compact content. Preserve as much detail as possible
 * for Yanqing to understand what was achieved in each session.
 */
export function formatSessionForDailyLog(session: ParsedSession): string {
  const startTime = session.startedAt ? new Date(session.startedAt) : null;
  const endTime = session.endedAt ? new Date(session.endedAt) : null;

  // Format time range
  let timeRange = "";
  if (startTime && endTime) {
    const startStr = startTime.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const endStr = endTime.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    timeRange = `${startStr}–${endStr}`;
  }

  // Build session block
  let block = `\n## [cli-session: ${session.agent}]\n`;
  block += `- **Time:** ${timeRange || "unknown"}\n`;
  block += `- **Session ID:** ${session.sessionId}\n`;
  block += `- **Model:** ${session.model || "unknown"}\n`;
  block += `- **Messages:** ${session.messageCount}\n`;
  if (session.tokenEstimate) {
    block += `- **Tokens:** ${session.tokenEstimate.toLocaleString()}\n`;
  }
  block += `- **File:** \`${session.nativeFilePath}\`\n`;
  block += `- **Hash:** \`${session.contentHash.slice(0, 12)}...\`\n\n`;

  // Add full conversation with detail preservation
  block += `### Conversation\n\n`;

  for (const msg of session.messages) {
    // User messages - preserve full content
    if (msg.role === "user") {
      block += `**User:**\n${msg.content}\n\n`;
    }
    // Assistant messages - preserve full content with structure
    else if (msg.role === "assistant") {
      block += `**${session.agent}:**\n${msg.content}\n\n`;

      // For Gemini, include thoughts if present
      if (msg.metadata?.thoughts && Array.isArray(msg.metadata.thoughts)) {
        const thoughts = msg.metadata.thoughts as Array<{
          subject?: string;
          description?: string;
        }>;
        if (thoughts.length > 0) {
          block += `<details><summary>Reasoning Process</summary>\n\n`;
          for (const thought of thoughts) {
            if (thought.subject) {
              block += `- **${thought.subject}:** ${thought.description || ""}\n`;
            }
          }
          block += `\n</details>\n\n`;
        }
      }
    }
    // System messages
    else if (msg.role === "system") {
      block += `<details><summary>System</summary>\n${msg.content}\n</details>\n\n`;
    }
  }

  block += `---\n\n`;

  return block;
}

/**
 * Generate a concise summary for the session (optional, for overview)
 * This is a SHORT summary, the full conversation is in the daily log
 */
export function generateSessionSummary(session: ParsedSession): {
  goal: string;
  outcome: string;
  topics: string[];
} {
  // Extract first user message as goal
  const firstUserMsg = session.messages.find((m) => m.role === "user");
  const goal: string = firstUserMsg?.content.slice(0, 200) || "Unknown goal";

  // Extract last assistant message as outcome
  const lastAssistantMsg = session.messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant");
  const outcome: string = lastAssistantMsg?.content.slice(0, 200) || "No outcome recorded";

  // Extract topics from all messages (simple keyword extraction)
  const allContent = session.messages
    .map((m) => m.content)
    .join(" ")
    .toLowerCase();

  const commonTopics = [
    "database",
    "schema",
    "logging",
    "memory",
    "session",
    "parser",
    "cli",
    "telegram",
    "web ui",
    "nightly job",
    "summarization",
    "dedup",
    "index",
    "search",
  ];

  const topics = commonTopics.filter((topic) => allContent.includes(topic));

  return {
    goal,
    outcome,
    topics,
  };
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
