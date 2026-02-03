/**
 * Commands Module
 *
 * Public exports for the unified command system.
 */

// Registry exports
export {
  COMMANDS,
  EXECUTOR_MODELS,
  getCommand,
  getExecutorCommands,
  getCommandsByCategory,
  isDeprecated,
  getExecutorModel,
  getAvailableCommands,
  type ExecutorType,
  type CommandCategory,
  type CommandDefinition,
} from "./registry.js";

// Parser exports
export {
  parseCommand,
  isPureExecutorSwitch,
  isExecutorSwitchWithQuery,
  toLegacyRoute,
  parseLegacy,
  type ParsedCommand,
  type LegacyParsedRoute,
} from "./parser.js";
