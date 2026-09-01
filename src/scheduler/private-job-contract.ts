/**
 * Contract between the public scheduler and job handlers supplied by a private
 * overlay (see src/private-overlay.ts). The overlay's handlers module exports
 * `handlers: Record<handlerName, PrivateJobHandler>`; the scheduler dispatches
 * any `handler` value it does not implement itself through this table.
 */
import type { Bot } from "grammy";
// @ts-ignore — better-sqlite3 exports the Database class as `export =`; type-only import for the field.
import type Database from "better-sqlite3";
import type { StateManager } from "../state/manager.js";
import type { NotificationIntent } from "../notifications/types.js";
import type { RegisteredJob } from "./types.js";

export interface PrivateJobContext {
  handler: string;
  job: RegisteredJob;
  startedAt: Date;
  db: Database.Database;
  stateManager: StateManager;
  bot: Bot | null;
  chatId: number;
  jobRunId?: number;
  signal?: AbortSignal;
}

export interface PrivateJobOutcome {
  success: boolean;
  output: string;
  error?: string;
  notificationIntent?: NotificationIntent;
  sideEffectDelivered?: boolean;
  /** Third disposition beside success/failure — see JobExecutionResult.outcome. */
  outcome?: "deferred" | "halted";
  retryAt?: string;
  retryReason?: string;
  resetFailureStreak?: boolean;
}

export type PrivateJobHandler = (ctx: PrivateJobContext) => Promise<PrivateJobOutcome>;
