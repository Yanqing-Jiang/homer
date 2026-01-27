import type { LaneId } from "./types.js";

// Context paths
const CONTEXT_PATHS: Record<string, string> = {
  work: "/Users/yj/work",
  life: "/Users/yj/life",
  default: "/Users/yj",
};

// Subagent hints for prompt injection
const SUBAGENT_HINTS: Record<string, string> = {
  gemini: "[Use the gemini subagent for this task] ",
  codex: "[Use the codex subagent for this task] ",
};

export interface ParsedRoute {
  context: string;           // work, life, or default
  subcontext?: string;       // project name or life area
  query: string;
  cwd: string;               // Full path to run Claude in
  subagent?: "gemini" | "codex";
  newSession: boolean;       // Start fresh session
  prefix: string;
}

/**
 * Parse a message into routing information
 *
 * Supported formats:
 *   /new [context] [query]     - Start fresh session
 *   /work [project] [query]    - Work context, optional project subfolder
 *   /life [area] [query]       - Life context, optional area subfolder
 *   /g [query]                 - Use Gemini subagent
 *   /x [query]                 - Use Codex subagent
 *   [query]                    - Continue in current context
 */
export function parseRoute(message: string): ParsedRoute | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const defaultCwd = CONTEXT_PATHS.default ?? "/Users/yj";

  // Check for /new command (start fresh session)
  if (trimmed.startsWith("/new")) {
    const rest = trimmed.slice(4).trim();

    // /new work [project] [query]
    if (rest.startsWith("work")) {
      const afterWork = rest.slice(4).trim();
      const { subcontext, query } = parseSubcontextAndQuery(afterWork);
      return {
        context: "work",
        subcontext,
        query,
        cwd: buildCwd("work", subcontext),
        newSession: true,
        prefix: "/new work",
      };
    }

    // /new life [area] [query]
    if (rest.startsWith("life")) {
      const afterLife = rest.slice(4).trim();
      const { subcontext, query } = parseSubcontextAndQuery(afterLife);
      return {
        context: "life",
        subcontext,
        query,
        cwd: buildCwd("life", subcontext),
        newSession: true,
        prefix: "/new life",
      };
    }

    // /new [query] - fresh session in default context
    return {
      context: "default",
      query: rest,
      cwd: defaultCwd,
      newSession: true,
      prefix: "/new",
    };
  }

  // Check for /work command
  if (trimmed.startsWith("/work")) {
    const rest = trimmed.slice(5).trim();
    const { subcontext, query } = parseSubcontextAndQuery(rest);
    return {
      context: "work",
      subcontext,
      query,
      cwd: buildCwd("work", subcontext),
      newSession: false,
      prefix: "/work",
    };
  }

  // Check for /life command
  if (trimmed.startsWith("/life")) {
    const rest = trimmed.slice(5).trim();
    const { subcontext, query } = parseSubcontextAndQuery(rest);
    return {
      context: "life",
      subcontext,
      query,
      cwd: buildCwd("life", subcontext),
      newSession: false,
      prefix: "/life",
    };
  }

  // Check for /g command (Gemini subagent)
  if (trimmed.startsWith("/g ") || trimmed === "/g") {
    const query = trimmed.slice(2).trim();
    return {
      context: "default",
      query,
      cwd: defaultCwd,
      subagent: "gemini",
      newSession: false,
      prefix: "/g",
    };
  }

  // Check for /x command (Codex subagent)
  if (trimmed.startsWith("/x ") || trimmed === "/x") {
    const query = trimmed.slice(2).trim();
    return {
      context: "default",
      query,
      cwd: defaultCwd,
      subagent: "codex",
      newSession: false,
      prefix: "/x",
    };
  }

  // No prefix - continue in current context (will use most recent session)
  return null;
}

/**
 * Parse "[subcontext] [query]" or just "[query]"
 * Subcontext is detected if first word looks like a folder name (no spaces, reasonable length)
 */
function parseSubcontextAndQuery(text: string): { subcontext?: string; query: string } {
  if (!text) return { query: "" };

  const parts = text.split(/\s+/);
  const firstWord = parts[0];

  // Heuristic: if first word is short, alphanumeric with dashes/underscores, treat as subcontext
  if (firstWord && /^[a-zA-Z0-9_-]+$/.test(firstWord) && firstWord.length <= 30) {
    // Check if it could be a project/area name
    // If there's more text after, treat first word as subcontext
    if (parts.length > 1) {
      return {
        subcontext: firstWord,
        query: parts.slice(1).join(" "),
      };
    }
    // Single word - could be subcontext with empty query, or just a query
    // Treat as query to be safe (user can send another message)
    return { query: text };
  }

  return { query: text };
}

/**
 * Build the cwd path for a context and optional subcontext
 */
function buildCwd(context: string, subcontext?: string): string {
  const basePath = CONTEXT_PATHS[context] ?? CONTEXT_PATHS.default ?? "/Users/yj";
  if (subcontext) {
    return `${basePath}/${subcontext}`;
  }
  return basePath;
}

/**
 * Get the subagent prompt prefix if applicable
 */
export function getSubagentPrefix(subagent?: "gemini" | "codex"): string {
  if (subagent && SUBAGENT_HINTS[subagent]) {
    return SUBAGENT_HINTS[subagent];
  }
  return "";
}

/**
 * Get all context names
 */
export function getAllContexts(): string[] {
  return Object.keys(CONTEXT_PATHS);
}

// Legacy exports for compatibility
export function getLanePath(lane: LaneId): string {
  const workPath = CONTEXT_PATHS.work ?? "/Users/yj/work";
  const lifePath = CONTEXT_PATHS.life ?? "/Users/yj/life";
  const defaultPath = CONTEXT_PATHS.default ?? "/Users/yj";

  const mapping: Record<string, string> = {
    work: workPath,
    invest: workPath,
    personal: lifePath,
    learning: lifePath,
    life: lifePath,
    default: defaultPath,
  };
  return mapping[lane] ?? defaultPath;
}

export function getAllLanes(): LaneId[] {
  return ["work", "life"] as LaneId[];
}

export function getAllPrefixes(): string[] {
  return ["/new", "/work", "/life", "/g", "/x"];
}
