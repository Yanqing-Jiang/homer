/**
 * Command Parser
 *
 * Parses user input into structured commands with support for:
 * - Executor switching commands (/gemini, /codex, etc.)
 * - Session commands (/new)
 * - Legacy commands (/g, /x, /k) with deprecation warnings
 */

import { getCommand, isDeprecated, type ExecutorType, type CommandDefinition } from "./registry.js";

const HOME = process.env.HOME || "/Users/yj";

export interface ParsedCommand {
  /**
   * The raw command name (e.g., "/gemini", "/new")
   */
  command: string | null;

  /**
   * The query/message content after the command
   */
  query: string;

  /**
   * Working directory for execution
   */
  cwd: string;

  /**
   * True if this is an executor switch command
   */
  isExecutorSwitch: boolean;

  /**
   * The executor to switch to (if isExecutorSwitch is true)
   */
  newExecutor?: ExecutorType;

  /**
   * Model to use with the executor
   */
  model?: string;

  /**
   * True if this is a /new session command
   */
  isNewSession: boolean;

  /**
   * Deprecation warning message (if command is deprecated)
   */
  deprecationWarning?: string;

  /**
   * The full command definition (if matched)
   */
  commandDef?: CommandDefinition;
}

/**
 * Parse a message into a structured command
 */
export function parseCommand(message: string): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // Default result
  const result: ParsedCommand = {
    command: null,
    query: trimmed,
    cwd: HOME,
    isExecutorSwitch: false,
    isNewSession: false,
  };

  // Check if message starts with a command
  if (!trimmed.startsWith("/")) {
    return result;
  }

  // Extract command and remaining query
  const spaceIndex = trimmed.indexOf(" ");
  const commandPart = spaceIndex > 0 ? trimmed.slice(0, spaceIndex) : trimmed;
  const queryPart = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1).trim() : "";

  // Look up command in registry
  const cmdDef = getCommand(commandPart);

  if (!cmdDef) {
    // Unknown command - treat as regular message
    return result;
  }

  result.command = commandPart;
  result.query = queryPart;
  result.commandDef = cmdDef;

  // Check for deprecation
  const deprecation = isDeprecated(commandPart);
  if (deprecation.deprecated && deprecation.message) {
    result.deprecationWarning = deprecation.message;
  }

  // Handle command based on category
  switch (cmdDef.category) {
    case "executor":
    case "deprecated":
      if (cmdDef.executor) {
        result.isExecutorSwitch = true;
        result.newExecutor = cmdDef.executor;
        result.model = cmdDef.model;
      }
      break;

    case "session":
      if (cmdDef.name === "/new") {
        result.isNewSession = true;
      }
      break;

    // Other categories don't need special handling here
    default:
      break;
  }

  return result;
}

/**
 * Check if a message is a pure executor switch (command only, no query)
 *
 * Examples:
 * - "/gemini" -> true (pure switch)
 * - "/gemini what's the weather" -> false (has query)
 */
export function isPureExecutorSwitch(parsed: ParsedCommand): boolean {
  return parsed.isExecutorSwitch && !parsed.query;
}

/**
 * Check if a message has both an executor switch and a query
 *
 * Examples:
 * - "/gemini what's the weather" -> true
 * - "/gemini" -> false
 */
export function isExecutorSwitchWithQuery(parsed: ParsedCommand): boolean {
  return parsed.isExecutorSwitch && !!parsed.query;
}

/**
 * Legacy parsing function for backwards compatibility
 * Maps to the old ParsedRoute interface
 */
export interface LegacyParsedRoute {
  query: string;
  cwd: string;
  subagent?: "gemini" | "codex";
  newSession: boolean;
  prefix: string;
}

/**
 * Convert a ParsedCommand to the legacy ParsedRoute format
 */
export function toLegacyRoute(parsed: ParsedCommand): LegacyParsedRoute {
  let subagent: "gemini" | "codex" | undefined;

  if (parsed.newExecutor === "gemini") {
    subagent = "gemini";
  } else if (parsed.newExecutor === "codex") {
    subagent = "codex";
  }

  return {
    query: parsed.query,
    cwd: parsed.cwd,
    subagent,
    newSession: parsed.isNewSession,
    prefix: parsed.command || "",
  };
}

/**
 * Parse and convert to legacy format in one step
 */
export function parseLegacy(message: string): LegacyParsedRoute | null {
  const parsed = parseCommand(message);
  if (!parsed) return null;
  return toLegacyRoute(parsed);
}
