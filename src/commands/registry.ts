/**
 * Unified Command Registry
 *
 * Shared command definitions for Telegram and Web UI.
 * Supports persistent executor switching across conversation sessions.
 */

export type ExecutorType = "claude" | "gemini" | "codex";

export type CommandCategory =
  | "session"    // Session management (new, etc.)
  | "executor"   // Executor switching
  | "search"     // Search commands
  | "system"     // System commands (status, debug, etc.)
  | "deprecated" // Deprecated commands with migration messages
  | "utility";   // Other utilities

export interface CommandDefinition {
  name: string;
  category: CommandCategory;
  description: string;
  executor?: ExecutorType;
  deprecated?: boolean;
  deprecatedMessage?: string;
  aliases?: string[];
  model?: string; // Default model for this executor
}

/**
 * Model configurations for each executor
 */
export const EXECUTOR_MODELS: Record<ExecutorType, string | undefined> = {
  claude: "sonnet",              // Cost-effective default
  codex: "opus",                 // Deep reasoning
  gemini: "gemini-3-flash-preview", // Fast, cheap
};

/**
 * Unified command registry
 */
export const COMMANDS: CommandDefinition[] = [
  // Session commands
  {
    name: "/new",
    category: "session",
    description: "Start a fresh conversation session",
  },

  // Executor switching commands (persistent)
  {
    name: "/claude",
    category: "executor",
    description: "Switch to Claude (default, tool use)",
    executor: "claude",
    model: "sonnet",
  },
  {
    name: "/gemini",
    category: "executor",
    description: "Switch to Gemini CLI (research, front-end)",
    executor: "gemini",
    model: "gemini-3-flash-preview",
  },
  {
    name: "/codex",
    category: "executor",
    description: "Switch to Codex (deep reasoning, backend)",
    executor: "codex",
    model: "opus",
  },

  // Deprecated commands (with migration)
  {
    name: "/g",
    category: "deprecated",
    deprecated: true,
    deprecatedMessage: "Use /gemini instead. /g will be removed soon.",
    description: "Deprecated: Use /gemini",
    executor: "gemini",
    aliases: [],
  },
  {
    name: "/x",
    category: "deprecated",
    deprecated: true,
    deprecatedMessage: "Use /codex instead. /x will be removed soon.",
    description: "Deprecated: Use /codex",
    executor: "codex",
    aliases: [],
  },

  // Search commands
  {
    name: "/search",
    category: "search",
    description: "Hybrid search across memory",
  },

  // System commands
  {
    name: "/status",
    category: "system",
    description: "Show active session status",
  },
  {
    name: "/voice",
    category: "system",
    description: "Toggle voice output",
  },
  {
    name: "/debug",
    category: "system",
    description: "Show system debug info",
  },
  {
    name: "/restart",
    category: "system",
    description: "Restart the daemon",
  },
  {
    name: "/jobs",
    category: "system",
    description: "List scheduled jobs",
  },
  {
    name: "/trigger",
    category: "system",
    description: "Manually trigger a job",
  },

  // Utility commands
  {
    name: "/remind",
    category: "utility",
    description: "Set a reminder",
  },
  {
    name: "/reminders",
    category: "utility",
    description: "List pending reminders",
  },
  {
    name: "/cancel",
    category: "utility",
    description: "Cancel a reminder",
  },
  {
    name: "/meeting",
    category: "utility",
    description: "Process meeting audio",
  },
  {
    name: "/meetings",
    category: "utility",
    description: "List recent meetings",
  },
];

/**
 * Get command by name (including aliases)
 */
export function getCommand(name: string): CommandDefinition | undefined {
  const normalized = name.toLowerCase().trim();

  // First check direct name match
  const direct = COMMANDS.find((c) => c.name === normalized);
  if (direct) return direct;

  // Check aliases
  return COMMANDS.find((c) => c.aliases?.includes(normalized));
}

/**
 * Get all executor commands (for UI display)
 */
export function getExecutorCommands(): CommandDefinition[] {
  return COMMANDS.filter((c) => c.category === "executor" && !c.deprecated);
}

/**
 * Get all commands for a category
 */
export function getCommandsByCategory(category: CommandCategory): CommandDefinition[] {
  return COMMANDS.filter((c) => c.category === category);
}

/**
 * Check if a command is deprecated
 */
export function isDeprecated(name: string): { deprecated: boolean; message?: string } {
  const cmd = getCommand(name);
  if (!cmd) return { deprecated: false };
  return {
    deprecated: cmd.deprecated ?? false,
    message: cmd.deprecatedMessage,
  };
}

/**
 * Get the default model for an executor
 */
export function getExecutorModel(executor: ExecutorType): string | undefined {
  return EXECUTOR_MODELS[executor];
}

/**
 * Get all available commands (excluding deprecated)
 */
export function getAvailableCommands(): CommandDefinition[] {
  return COMMANDS.filter((c) => !c.deprecated);
}
