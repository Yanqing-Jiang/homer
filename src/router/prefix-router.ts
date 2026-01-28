import { existsSync } from "fs";
import type { LaneId } from "./types.js";
import { detectContext, contextTypeToMemoryContext, type DetectedContext } from "../context/detector.js";

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
  detectedContext?: DetectedContext; // Context detection result
}

/**
 * Parse a message into routing information
 *
 * Supported formats:
 *   /new [query]             - Start fresh session
 *   /g [query]               - Use Gemini subagent
 *   /x [query]               - Use Codex subagent
 *   [query]                  - Auto-detect context from query
 *
 * Removed: /work, /life prefixes (now auto-detected)
 */
export function parseRoute(message: string): ParsedRoute | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const defaultCwd = CONTEXT_PATHS.default ?? "/Users/yj";

  // Check for /new command (start fresh session)
  if (trimmed.startsWith("/new")) {
    const query = trimmed.slice(4).trim();

    // Detect context from the query
    const detected = query ? detectContext(query) : null;

    return {
      context: detected ? contextTypeToMemoryContext(detected.type) : "default",
      subcontext: detected?.project || detected?.area,
      query,
      cwd: detected?.suggestedCwd ?? defaultCwd,
      newSession: true,
      prefix: "/new",
      detectedContext: detected ?? undefined,
    };
  }

  // Check for /g command (Gemini subagent)
  if (trimmed.startsWith("/g ") || trimmed === "/g") {
    const query = trimmed.slice(2).trim();
    const detected = query ? detectContext(query) : null;

    return {
      context: detected ? contextTypeToMemoryContext(detected.type) : "default",
      subcontext: detected?.project || detected?.area,
      query,
      cwd: detected?.suggestedCwd ?? defaultCwd,
      subagent: "gemini",
      newSession: false,
      prefix: "/g",
      detectedContext: detected ?? undefined,
    };
  }

  // Check for /x command (Codex subagent)
  if (trimmed.startsWith("/x ") || trimmed === "/x") {
    const query = trimmed.slice(2).trim();
    const detected = query ? detectContext(query) : null;

    return {
      context: detected ? contextTypeToMemoryContext(detected.type) : "default",
      subcontext: detected?.project || detected?.area,
      query,
      cwd: detected?.suggestedCwd ?? defaultCwd,
      subagent: "codex",
      newSession: false,
      prefix: "/x",
      detectedContext: detected ?? undefined,
    };
  }

  // Legacy support: /work and /life still work but are deprecated
  // They now just use context detection with a hint
  if (trimmed.startsWith("/work")) {
    const rest = trimmed.slice(5).trim();
    const { subcontext, query } = parseSubcontextAndQuery(rest, "work");
    return {
      context: "work",
      subcontext,
      query,
      cwd: buildCwd("work", subcontext),
      newSession: false,
      prefix: "/work",
    };
  }

  if (trimmed.startsWith("/life")) {
    const rest = trimmed.slice(5).trim();
    const { subcontext, query } = parseSubcontextAndQuery(rest, "life");
    return {
      context: "life",
      subcontext,
      query,
      cwd: buildCwd("life", subcontext),
      newSession: false,
      prefix: "/life",
    };
  }

  // No prefix - auto-detect context from query content
  const detected = detectContext(trimmed);

  return {
    context: contextTypeToMemoryContext(detected.type),
    subcontext: detected.project || detected.area,
    query: trimmed,
    cwd: detected.suggestedCwd,
    newSession: false,
    prefix: "",
    detectedContext: detected,
  };
}

/**
 * Parse "[subcontext] [query]" or just "[query]"
 * Subcontext is detected if first word matches an existing directory
 */
function parseSubcontextAndQuery(text: string, context?: string): { subcontext?: string; query: string } {
  if (!text) return { query: "" };

  const parts = text.split(/\s+/);
  const firstWord = parts[0];

  // Only treat first word as subcontext if:
  // 1. It's alphanumeric with dashes/underscores and reasonable length
  // 2. The corresponding directory actually exists
  if (firstWord && /^[a-zA-Z0-9_-]+$/.test(firstWord) && firstWord.length <= 30) {
    if (parts.length > 1) {
      // Check if the directory exists before treating as subcontext
      const basePath = CONTEXT_PATHS[context ?? "default"] ?? "/Users/yj";
      const subPath = `${basePath}/${firstWord}`;
      if (existsSync(subPath)) {
        return {
          subcontext: firstWord,
          query: parts.slice(1).join(" "),
        };
      }
    }
    // Directory doesn't exist or single word - treat as query
    return { query: text };
  }

  return { query: text };
}

/**
 * Build the cwd path for a context and optional subcontext
 * Falls back to base path if subcontext directory doesn't exist
 */
function buildCwd(context: string, subcontext?: string): string {
  const basePath = CONTEXT_PATHS[context] ?? CONTEXT_PATHS.default ?? "/Users/yj";
  if (subcontext) {
    const subPath = `${basePath}/${subcontext}`;
    // Only use subcontext path if the directory actually exists
    if (existsSync(subPath)) {
      return subPath;
    }
    // Directory doesn't exist - fall back to base path
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
  return ["/new", "/g", "/x", "/work", "/life"]; // /work /life kept for legacy
}
