/**
 * Simple prefix router - just handles /new, /g, /x commands
 * Context detection is handled by Claude using memory files
 */

export interface ParsedRoute {
  query: string;
  cwd: string;
  subagent?: "gemini" | "codex" | "kimi";
  newSession: boolean;
  prefix: string;
}

// Subagent hints for prompt injection
const SUBAGENT_HINTS: Record<string, string> = {
  gemini: "[Use the gemini subagent for this task] ",
  codex: "[Use the codex subagent for this task] ",
  kimi: "[Use the kimi subagent for this task - specialized in parallel research, front-end design, and visual analysis] ",
};

const HOME = process.env.HOME || "/Users/yj";

/**
 * Parse a message into routing information
 *
 * Supported formats:
 *   /new [query]  - Start fresh session
 *   /g [query]    - Use Gemini subagent (research, front-end)
 *   /x [query]    - Use Codex subagent (backend, reasoning)
 *   /k [query]    - Use Kimi subagent (parallel research, design, vision)
 *   [query]       - Normal message
 */
export function parseRoute(message: string): ParsedRoute | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // Check for /new command (start fresh session)
  if (trimmed.startsWith("/new")) {
    return {
      query: trimmed.slice(4).trim(),
      cwd: HOME,
      newSession: true,
      prefix: "/new",
    };
  }

  // Check for /g command (Gemini subagent)
  if (trimmed.startsWith("/g ") || trimmed === "/g") {
    return {
      query: trimmed.slice(2).trim(),
      cwd: HOME,
      subagent: "gemini",
      newSession: false,
      prefix: "/g",
    };
  }

  // Check for /x command (Codex subagent)
  if (trimmed.startsWith("/x ") || trimmed === "/x") {
    return {
      query: trimmed.slice(2).trim(),
      cwd: HOME,
      subagent: "codex",
      newSession: false,
      prefix: "/x",
    };
  }

  // Check for /k command (Kimi subagent)
  if (trimmed.startsWith("/k ") || trimmed === "/k") {
    return {
      query: trimmed.slice(2).trim(),
      cwd: HOME,
      subagent: "kimi",
      newSession: false,
      prefix: "/k",
    };
  }

  // No prefix - normal message
  return {
    query: trimmed,
    cwd: HOME,
    newSession: false,
    prefix: "",
  };
}

/**
 * Get the subagent prompt prefix if applicable
 */
export function getSubagentPrefix(subagent?: "gemini" | "codex" | "kimi"): string {
  if (subagent && SUBAGENT_HINTS[subagent]) {
    return SUBAGENT_HINTS[subagent];
  }
  return "";
}
