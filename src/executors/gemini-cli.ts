/**
 * Gemini CLI Executor
 *
 * Calls the `gemini` CLI binary (OAuth, Google account) directly via Code Assist backend.
 * Model: gemini-3-flash-preview (latest Flash available via subscription OAuth)
 * System prompt: ~/.gemini/GEMINI.md
 *
 * This version persists account health and cooldown state in SQLite and performs
 * proactive account selection (least used account, skip cooling/disabled accounts).
 *
 * Credential flow:
 * - Canonical creds: ~/homer/config/auth/gemini-creds/{email}.json
 * - Runtime homes:   ~/homer/config/auth/gemini-runtime-homes/{email}/.gemini/*
 *
 * Each account uses an isolated HOME at runtime so multiple accounts can execute
 * concurrently without racing on ~/.gemini/oauth_creds.json.
 */

import Database from "better-sqlite3";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { config } from "../config/index.js";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";

export const GEMINI_CLI_FLASH_MODEL = "gemini-3-flash-preview";
export const GEMINI_CLI_PRO_MODEL = "gemini-3.1-pro-preview";

const runtimePaths = getRuntimePaths();
const HOME = runtimePaths.homeDir;
const GEMINI_CREDS_DIR = path.join(HOME, "homer/config/auth/gemini-creds");
const GEMINI_RUNTIME_HOMES_DIR = path.join(
  HOME,
  "homer/config/auth/gemini-runtime-homes",
);
const GEMINI_GLOBAL_DIR = path.join(HOME, ".gemini");
const GEMINI_GLOBAL_ACCOUNTS_FILE = path.join(
  GEMINI_GLOBAL_DIR,
  "google_accounts.json",
);
const GEMINI_SYSTEM_PROMPT_FILE = path.join(GEMINI_GLOBAL_DIR, "GEMINI.md");
const AGENT_FILES: Record<string, string> = {
  research: path.join(GEMINI_GLOBAL_DIR, "agents", "homer-researcher.md"),
  scraper: path.join(GEMINI_GLOBAL_DIR, "agents", "homer-scraper.md"),
  general: path.join(GEMINI_GLOBAL_DIR, "agents", "homer-general.md"),
};
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type FailureKind = "rate_limit" | "auth" | "runtime" | "timeout" | "spawn";

interface GeminiAccountRow {
  email: string;
  creds_path: string;
  is_enabled: number;
  disabled_reason: string | null;
  disabled_at: number | null;
  reenable_after: number | null;
  cooldown_until: number | null;
  cooldown_reason: string | null;
  consecutive_failures: number;
  last_failure_at: number | null;
  last_failure_reason: string | null;
  last_success_at: number | null;
  last_selected_at: number | null;
  last_used_at: number | null;
  hour_window_start: number;
  hour_usage_count: number;
  day_window_start: number;
  day_usage_count: number;
  total_requests: number;
  total_successes: number;
  total_failures: number;
  total_rate_limits: number;
}

interface AccountSelection {
  account: GeminiAccountRow | null;
  waitMs: number;
  reason:
    | "available"
    | "all_cooldown"
    | "disabled_probe"
    | "disabled_wait"
    | "no_accounts";
}

interface GeminiProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

interface ExecuteAttemptResult extends GeminiCLIDirectResult {
  retryable: boolean;
}

export interface GeminiCLIDirectOptions {
  model?: string;
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
  outputFormat?: "text" | "json" | "stream-json";
  role?: "research" | "scraper" | "general";
}

export interface GeminiCLIDirectResult extends ExecutorResult {
  model: string;
  accountEmail?: string;
}

type ScheduledGeminiResearchOptions = Omit<GeminiCLIDirectOptions, "model">;

export interface GeminiAccountManagerOptions {
  rateLimitCooldownMs?: number;
  authFailureCooldownMs?: number;
  runtimeFailureCooldownMs?: number;
  disableAfterFailures?: number;
  disabledRecheckMs?: number;
  lockAcquireTimeoutMs?: number;
  syncIntervalMs?: number;
  maxConcurrentPerAccount?: number;
  minInterSpawnMs?: number;
}

const DEFAULT_MANAGER_OPTIONS: Required<GeminiAccountManagerOptions> = {
  rateLimitCooldownMs: 60_000, // Code Assist: 120 RPM, wait for minute window reset
  authFailureCooldownMs: 300_000,
  runtimeFailureCooldownMs: 10_000,
  disableAfterFailures: 5,
  disabledRecheckMs: 10 * 60 * 1000, // Re-probe disabled accounts after 10min
  lockAcquireTimeoutMs: 30_000, // More time before semaphore timeout
  syncIntervalMs: 5_000,
  maxConcurrentPerAccount: 2, // Code Assist: 1-2 concurrent per session
  minInterSpawnMs: 5_000, // Modest stagger to avoid burst detection
};

function sanitizeGeminiOutput(text: string): string {
  return text
    .replace(/^YOLO mode is enabled\.\s*/gm, "")
    .replace(/^Loaded cached credentials\.\s*/gm, "")
    .trim();
}

function isRateLimitError(text: string): boolean {
  return /(?:\b429\b|quota|rate.?limit|resource_exhausted|exhausted)/i.test(
    text,
  );
}

function sanitizeFailureReason(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("[WARN] Skipping unreadable") &&
        !line.startsWith("All tool calls will be automatically approved"),
    )
    .join("\n")
    .trim();
}

function isAuthError(text: string): boolean {
  return /(?:\b401\b|\b403\b|unauthorized|forbidden|invalid.?credential|auth)/i.test(
    text,
  );
}

function failureKindToExitCode(kind: FailureKind): number {
  switch (kind) {
    case "timeout":
      return 4;
    case "auth":
      return 3;
    case "rate_limit":
      return 2;
    default:
      return 1;
  }
}

function detectFailureKind(
  run: GeminiProcessResult,
  cleanedOutput: string,
  cleanedErr: string,
  durationMs: number,
): FailureKind | null {
  if (run.spawnError) return "spawn";

  // Gemini CLI 0.32.x can hang after a quota 429 because the SSE reader drops
  // the plain JSON event body and stdout stays empty until our outer timeout fires.
  const silent429Timeout =
    run.timedOut && run.stdout.trim().length === 0 && durationMs > 8_000;

  if (silent429Timeout) return "rate_limit";
  if (run.timedOut) return "timeout";

  const combined = `${cleanedOutput}\n${cleanedErr}`;
  if (isRateLimitError(combined)) return "rate_limit";
  if (isAuthError(combined)) return "auth";
  if ((run.code ?? 1) !== 0 || !cleanedOutput) return "runtime";
  return null;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new Error("Aborted"));
    };
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function waitWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  await Promise.race([
    promise,
    new Promise<void>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error(message));
      }, timeoutMs);
    }),
  ]);
}

export function initGeminiAccounts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_accounts (
      email TEXT PRIMARY KEY,
      creds_path TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      disabled_reason TEXT,
      disabled_at INTEGER,
      reenable_after INTEGER,
      cooldown_until INTEGER,
      cooldown_reason TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER,
      last_failure_reason TEXT,
      last_success_at INTEGER,
      last_selected_at INTEGER,
      last_used_at INTEGER,
      hour_window_start INTEGER NOT NULL DEFAULT 0,
      hour_usage_count INTEGER NOT NULL DEFAULT 0,
      day_window_start INTEGER NOT NULL DEFAULT 0,
      day_usage_count INTEGER NOT NULL DEFAULT 0,
      total_requests INTEGER NOT NULL DEFAULT 0,
      total_successes INTEGER NOT NULL DEFAULT 0,
      total_failures INTEGER NOT NULL DEFAULT 0,
      total_rate_limits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gemini_accounts_enabled
      ON gemini_accounts(is_enabled, cooldown_until, reenable_after);
    CREATE INDEX IF NOT EXISTS idx_gemini_accounts_usage
      ON gemini_accounts(hour_usage_count, day_usage_count, last_used_at);
    CREATE INDEX IF NOT EXISTS idx_gemini_accounts_cooldown
      ON gemini_accounts(cooldown_until);
  `);
}

function getRuntimeHomeForEmail(email: string): string {
  return path.join(GEMINI_RUNTIME_HOMES_DIR, encodeURIComponent(email));
}

function ensureWindow(
  start: number,
  count: number,
  now: number,
  windowMs: number,
): { start: number; count: number } {
  if (!start || now - start >= windowMs) {
    return { start: now, count: 0 };
  }
  return { start, count };
}

export class GeminiAccountManager {
  private db: Database.Database;
  private options: Required<GeminiAccountManagerOptions>;
  private accountLocks = new Map<string, Promise<void>>();
  private accountSemaphores = new Map<
    string,
    {
      active: number;
      waiting: Array<{ resolve: () => void; timer: NodeJS.Timeout }>;
    }
  >();
  private lastDiskSyncAt = 0;
  private stmts: {
    listAccounts: Database.Statement;
    getAccount: Database.Statement;
    upsertAccount: Database.Statement;
    disableMissingCreds: Database.Statement;
    recordUsage: Database.Statement;
    markSuccess: Database.Statement;
    markFailure: Database.Statement;
    scheduleDisabledProbe: Database.Statement;
  };

  constructor(
    db: Database.Database,
    options: GeminiAccountManagerOptions = {},
  ) {
    this.db = db;
    this.options = { ...DEFAULT_MANAGER_OPTIONS, ...options };
    initGeminiAccounts(this.db);
    this.stmts = {
      listAccounts: this.db.prepare(`
        SELECT
          email, creds_path, is_enabled, disabled_reason, disabled_at, reenable_after,
          cooldown_until, cooldown_reason, consecutive_failures, last_failure_at,
          last_failure_reason, last_success_at, last_selected_at, last_used_at,
          hour_window_start, hour_usage_count, day_window_start, day_usage_count,
          total_requests, total_successes, total_failures, total_rate_limits
        FROM gemini_accounts
        ORDER BY email
      `),
      getAccount: this.db.prepare(`
        SELECT
          email, creds_path, is_enabled, disabled_reason, disabled_at, reenable_after,
          cooldown_until, cooldown_reason, consecutive_failures, last_failure_at,
          last_failure_reason, last_success_at, last_selected_at, last_used_at,
          hour_window_start, hour_usage_count, day_window_start, day_usage_count,
          total_requests, total_successes, total_failures, total_rate_limits
        FROM gemini_accounts
        WHERE email = ?
      `),
      upsertAccount: this.db.prepare(`
        INSERT INTO gemini_accounts (
          email, creds_path, is_enabled, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          creds_path = excluded.creds_path,
          is_enabled = CASE
            WHEN gemini_accounts.disabled_reason = 'missing_creds' THEN 1
            ELSE gemini_accounts.is_enabled
          END,
          disabled_reason = CASE
            WHEN gemini_accounts.disabled_reason = 'missing_creds' THEN NULL
            ELSE gemini_accounts.disabled_reason
          END,
          disabled_at = CASE
            WHEN gemini_accounts.disabled_reason = 'missing_creds' THEN NULL
            ELSE gemini_accounts.disabled_at
          END,
          reenable_after = CASE
            WHEN gemini_accounts.disabled_reason = 'missing_creds' THEN NULL
            ELSE gemini_accounts.reenable_after
          END,
          updated_at = excluded.updated_at
      `),
      disableMissingCreds: this.db.prepare(`
        UPDATE gemini_accounts
        SET
          is_enabled = 0,
          disabled_reason = 'missing_creds',
          disabled_at = ?,
          reenable_after = ?,
          updated_at = ?
        WHERE email = ?
      `),
      recordUsage: this.db.prepare(`
        UPDATE gemini_accounts
        SET
          hour_window_start = ?,
          hour_usage_count = ?,
          day_window_start = ?,
          day_usage_count = ?,
          total_requests = total_requests + 1,
          last_selected_at = ?,
          last_used_at = ?,
          updated_at = ?
        WHERE email = ?
      `),
      markSuccess: this.db.prepare(`
        UPDATE gemini_accounts
        SET
          consecutive_failures = 0,
          cooldown_until = NULL,
          cooldown_reason = NULL,
          last_success_at = ?,
          last_used_at = ?,
          total_successes = total_successes + 1,
          is_enabled = 1,
          disabled_reason = NULL,
          disabled_at = NULL,
          reenable_after = NULL,
          updated_at = ?
        WHERE email = ?
      `),
      markFailure: this.db.prepare(`
        UPDATE gemini_accounts
        SET
          consecutive_failures = consecutive_failures + 1,
          cooldown_until = ?,
          cooldown_reason = ?,
          last_failure_at = ?,
          last_failure_reason = ?,
          total_failures = total_failures + 1,
          total_rate_limits = total_rate_limits + ?,
          is_enabled = CASE
            WHEN consecutive_failures + 1 >= ? THEN 0
            ELSE is_enabled
          END,
          disabled_reason = CASE
            WHEN consecutive_failures + 1 >= ? THEN ?
            ELSE disabled_reason
          END,
          disabled_at = CASE
            WHEN consecutive_failures + 1 >= ? THEN ?
            ELSE disabled_at
          END,
          reenable_after = CASE
            WHEN consecutive_failures + 1 >= ? THEN ?
            ELSE reenable_after
          END,
          updated_at = ?
        WHERE email = ?
      `),
      scheduleDisabledProbe: this.db.prepare(`
        UPDATE gemini_accounts
        SET
          reenable_after = ?,
          updated_at = ?
        WHERE email = ?
      `),
    };
  }

  async syncAccountsFromDisk(force: boolean = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastDiskSyncAt < this.options.syncIntervalMs) {
      return;
    }

    this.lastDiskSyncAt = now;
    let files: string[] = [];
    try {
      files = await fs.readdir(GEMINI_CREDS_DIR);
    } catch {
      files = [];
    }

    const emails = files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/i, ""));

    for (const email of emails) {
      const credsPath = path.join(GEMINI_CREDS_DIR, `${email}.json`);
      this.stmts.upsertAccount.run(email, credsPath, now, now);
    }

    const knownSet = new Set(emails);
    const existing = this.stmts.listAccounts.all() as GeminiAccountRow[];
    for (const row of existing) {
      if (!knownSet.has(row.email)) {
        this.stmts.disableMissingCreds.run(
          now,
          now + this.options.disabledRecheckMs,
          now,
          row.email,
        );
      }
    }
  }

  listAccounts(): GeminiAccountRow[] {
    return this.stmts.listAccounts.all() as GeminiAccountRow[];
  }

  getAccountCount(): number {
    const rows = this.stmts.listAccounts.all() as GeminiAccountRow[];
    return rows.length;
  }

  selectBestAccount(now: number): AccountSelection {
    const rows = this.listAccounts();
    if (rows.length === 0) {
      return { account: null, waitMs: 0, reason: "no_accounts" };
    }

    type ScoredRow = GeminiAccountRow & {
      _hourUsage: number;
      _dayUsage: number;
      _activeCount: number;
    };

    const available: ScoredRow[] = [];
    const cooldownRows: Array<{ row: GeminiAccountRow; waitMs: number }> = [];
    const disabledDue: ScoredRow[] = [];
    const disabledWaiting: Array<{ row: GeminiAccountRow; waitMs: number }> =
      [];

    for (const row of rows) {
      const cooldownUntil = row.cooldown_until ?? 0;
      const reenableAfter = row.reenable_after ?? 0;
      const sem = this.accountSemaphores.get(row.email);
      const activeCount = sem?.active ?? 0;
      const hour = ensureWindow(
        row.hour_window_start,
        row.hour_usage_count,
        now,
        ONE_HOUR_MS,
      );
      const day = ensureWindow(
        row.day_window_start,
        row.day_usage_count,
        now,
        ONE_DAY_MS,
      );
      const scored: ScoredRow = {
        ...row,
        _hourUsage: hour.count,
        _dayUsage: day.count,
        _activeCount: activeCount,
      };

      if (row.is_enabled === 1) {
        if (cooldownUntil > now) {
          cooldownRows.push({ row, waitMs: cooldownUntil - now });
          continue;
        }
        available.push(scored);
        continue;
      }

      if (row.disabled_reason === "missing_creds") {
        continue;
      }

      if (reenableAfter <= now) {
        disabledDue.push(scored);
      } else {
        disabledWaiting.push({ row, waitMs: reenableAfter - now });
      }
    }

    const scoreSort = (a: ScoredRow, b: ScoredRow): number =>
      a._activeCount - b._activeCount ||
      a._hourUsage - b._hourUsage ||
      a._dayUsage - b._dayUsage ||
      (a.last_used_at ?? 0) - (b.last_used_at ?? 0) ||
      a.email.localeCompare(b.email);

    if (available.length > 0) {
      available.sort(scoreSort);
      return { account: available[0] ?? null, waitMs: 0, reason: "available" };
    }

    if (disabledDue.length > 0) {
      disabledDue.sort(scoreSort);
      return {
        account: disabledDue[0] ?? null,
        waitMs: 0,
        reason: "disabled_probe",
      };
    }

    if (cooldownRows.length > 0) {
      cooldownRows.sort((a, b) => a.waitMs - b.waitMs);
      const best = cooldownRows[0];
      return {
        account: best?.row ?? null,
        waitMs: best?.waitMs ?? 0,
        reason: "all_cooldown",
      };
    }

    if (disabledWaiting.length > 0) {
      disabledWaiting.sort((a, b) => a.waitMs - b.waitMs);
      const best = disabledWaiting[0];
      return {
        account: best?.row ?? null,
        waitMs: best?.waitMs ?? 0,
        reason: "disabled_wait",
      };
    }

    return { account: null, waitMs: 0, reason: "no_accounts" };
  }

  async withAccountLock<T>(
    email: string,
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const previous = this.accountLocks.get(email) ?? Promise.resolve();
    let releaseCurrent: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queueTail = previous.catch(() => undefined).then(() => current);
    this.accountLocks.set(email, queueTail);

    try {
      await waitWithTimeout(
        previous.catch(() => undefined),
        timeoutMs ?? this.options.lockAcquireTimeoutMs,
        `Timed out waiting for Gemini account lock: ${email}`,
      );
      return await fn();
    } finally {
      releaseCurrent();
      if (this.accountLocks.get(email) === queueTail) {
        this.accountLocks.delete(email);
      }
    }
  }

  getActiveCount(email: string): number {
    return this.accountSemaphores.get(email)?.active ?? 0;
  }

  async withAccountSemaphore<T>(
    email: string,
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const limit = this.options.maxConcurrentPerAccount;
    let sem = this.accountSemaphores.get(email);
    if (!sem) {
      sem = { active: 0, waiting: [] };
      this.accountSemaphores.set(email, sem);
    }

    if (sem.active >= limit) {
      // Queue and wait
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = sem!.waiting.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) sem!.waiting.splice(idx, 1);
          reject(
            new Error(
              `Timed out waiting for Gemini account semaphore: ${email}`,
            ),
          );
        }, timeoutMs ?? this.options.lockAcquireTimeoutMs);
        sem!.waiting.push({ resolve, timer });
      });
    }

    sem.active += 1;
    try {
      return await fn();
    } finally {
      sem.active -= 1;
      const next = sem.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
      if (sem.active === 0 && sem.waiting.length === 0) {
        this.accountSemaphores.delete(email);
      }
    }
  }

  private getCooldownMsForFailure(kind: FailureKind): number {
    switch (kind) {
      case "rate_limit":
        return this.options.rateLimitCooldownMs;
      case "auth":
        return this.options.authFailureCooldownMs;
      default:
        return this.options.runtimeFailureCooldownMs;
    }
  }

  recordSelection(email: string, now: number): void {
    const row = this.stmts.getAccount.get(email) as
      | GeminiAccountRow
      | undefined;
    if (!row) return;
    const hour = ensureWindow(
      row.hour_window_start,
      row.hour_usage_count,
      now,
      ONE_HOUR_MS,
    );
    const day = ensureWindow(
      row.day_window_start,
      row.day_usage_count,
      now,
      ONE_DAY_MS,
    );
    this.stmts.recordUsage.run(
      hour.start,
      hour.count + 1,
      day.start,
      day.count + 1,
      now,
      now,
      now,
      email,
    );
  }

  recordSuccess(email: string, now: number): void {
    this.stmts.markSuccess.run(now, now, now, email);
  }

  recordFailure(
    email: string,
    kind: FailureKind,
    now: number,
    message: string,
  ): void {
    const cooldownMs = this.getCooldownMsForFailure(kind);
    const cooldownUntil = cooldownMs > 0 ? now + cooldownMs : null;
    const isRateLimit = kind === "rate_limit" ? 1 : 0;
    const disabledReason = `auto_disabled:${kind}`;
    const reenableAt = now + this.options.disabledRecheckMs;
    this.stmts.markFailure.run(
      cooldownUntil,
      kind,
      now,
      message.slice(0, 500),
      isRateLimit,
      this.options.disableAfterFailures,
      this.options.disableAfterFailures,
      disabledReason,
      this.options.disableAfterFailures,
      now,
      this.options.disableAfterFailures,
      reenableAt,
      now,
      email,
    );
  }

  scheduleDisabledProbe(email: string, now: number): void {
    this.stmts.scheduleDisabledProbe.run(
      now + this.options.disabledRecheckMs,
      now,
      email,
    );
  }

  async prepareRuntimeHome(
    email: string,
    role?: "research" | "scraper" | "general",
  ): Promise<string> {
    const runtimeHome = getRuntimeHomeForEmail(email);
    const runtimeGeminiDir = path.join(runtimeHome, ".gemini");
    const runtimeCredsFile = path.join(runtimeGeminiDir, "oauth_creds.json");
    const runtimeAccountsFile = path.join(
      runtimeGeminiDir,
      "google_accounts.json",
    );
    const runtimeSystemPromptFile = path.join(runtimeGeminiDir, "GEMINI.md");
    const runtimeSettingsFile = path.join(runtimeGeminiDir, "settings.json");
    const sourceCredsFile = path.join(GEMINI_CREDS_DIR, `${email}.json`);

    await fs.mkdir(runtimeGeminiDir, { recursive: true });
    const creds = await fs.readFile(sourceCredsFile, "utf-8");
    await fs.writeFile(runtimeCredsFile, creds, "utf-8");
    await fs.writeFile(
      runtimeAccountsFile,
      JSON.stringify({ active: email }, null, 2),
      "utf-8",
    );

    // Deep-merge required auth and billing fields, preserving sibling keys
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(
        await fs.readFile(runtimeSettingsFile, "utf-8"),
      ) as Record<string, unknown>;
    } catch {
      // Missing or corrupt — start fresh
    }
    const sec = (settings.security ?? {}) as Record<string, unknown>;
    const secAuth = (sec.auth ?? {}) as Record<string, unknown>;
    secAuth.selectedType = "oauth-personal";
    sec.auth = secAuth;
    settings.security = sec;
    const billing = (settings.billing ?? {}) as Record<string, unknown>;
    billing.overageStrategy = "never";
    settings.billing = billing;
    await fs.writeFile(
      runtimeSettingsFile,
      JSON.stringify(settings, null, 2),
      "utf-8",
    );

    // Load system prompt: prefer role-specific agent file, fall back to global GEMINI.md
    try {
      let promptSource = GEMINI_SYSTEM_PROMPT_FILE;
      if (role && AGENT_FILES[role]) {
        try {
          await fs.access(AGENT_FILES[role]);
          promptSource = AGENT_FILES[role];
        } catch {
          // Agent file missing, fall back to global
        }
      }
      const promptText = await fs.readFile(promptSource, "utf-8");
      await fs.writeFile(runtimeSystemPromptFile, promptText, "utf-8");
    } catch {
      // Non-fatal: Gemini CLI can run without GEMINI.md.
    }

    // Best effort: keep global active account visible for observability.
    try {
      await fs.mkdir(GEMINI_GLOBAL_DIR, { recursive: true });
      let globalAccounts: Record<string, unknown> = {};
      try {
        globalAccounts = JSON.parse(
          await fs.readFile(GEMINI_GLOBAL_ACCOUNTS_FILE, "utf-8"),
        ) as Record<string, unknown>;
      } catch {
        globalAccounts = {};
      }
      globalAccounts.active = email;
      await fs.writeFile(
        GEMINI_GLOBAL_ACCOUNTS_FILE,
        JSON.stringify(globalAccounts, null, 2),
        "utf-8",
      );
    } catch {
      // Non-fatal.
    }

    return runtimeHome;
  }

  async persistRefreshedCreds(
    email: string,
    runtimeHome: string,
  ): Promise<void> {
    const runtimeCredsFile = path.join(runtimeHome, ".gemini/oauth_creds.json");
    const targetCredsFile = path.join(GEMINI_CREDS_DIR, `${email}.json`);
    try {
      const refreshed = await fs.readFile(runtimeCredsFile, "utf-8");
      await fs.writeFile(targetCredsFile, refreshed, "utf-8");
    } catch {
      // Non-fatal.
    }
  }
}

let accountManager: GeminiAccountManager | null = null;
let ownedDb: Database.Database | null = null;

export function initializeGeminiCLIAccountManager(
  db: Database.Database,
  options: GeminiAccountManagerOptions = {},
): GeminiAccountManager {
  accountManager = new GeminiAccountManager(db, options);
  return accountManager;
}

function getGeminiAccountManager(): GeminiAccountManager {
  if (accountManager) return accountManager;
  const db = new Database(config.paths.database);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  ownedDb = db;
  accountManager = new GeminiAccountManager(db);
  logger.warn(
    { dbPath: config.paths.database, hasSharedDb: false },
    "Gemini account manager auto-initialized with standalone DB connection",
  );
  return accountManager;
}

export function closeGeminiCLIAccountManager(): void {
  if (ownedDb) {
    ownedDb.close();
    ownedDb = null;
  }
  accountManager = null;
}

export async function rotateGeminiAccount(): Promise<string | null> {
  const manager = getGeminiAccountManager();
  await manager.syncAccountsFromDisk(true);
  const pick = manager.selectBestAccount(Date.now());
  if (!pick.account || pick.waitMs > 0) return null;
  return pick.account.email;
}

async function runGeminiProcess(
  prompt: string,
  model: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  runtimeHome: string,
  outputFormat?: "text" | "json" | "stream-json",
): Promise<GeminiProcessResult> {
  return new Promise((resolve) => {
    const args = [
      "-m",
      model,
      "-y",
      ...(outputFormat ? ["-o", outputFormat] : []),
      "-p",
      prompt,
    ];
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: runtimeHome,
      // Skip keychain probe — daemon has no login keychain, causes macOS notifications
      GEMINI_FORCE_FILE_STORAGE: "true",
    };
    // Remove all API key env vars to force OAuth auth via runtime home credentials
    for (const key of Object.keys(childEnv)) {
      if (
        /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|GEMINI_CLI_OAUTH_CLIENT)/i.test(
          key,
        )
      ) {
        delete childEnv[key];
      }
    }

    const child = spawn("gemini", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let abortListener: (() => void) | null = null;

    const finish = (result: GeminiProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    if (signal) {
      abortListener = () => {
        aborted = true;
        child.kill("SIGTERM");
      };
      if (signal.aborted) {
        aborted = true;
        child.kill("SIGTERM");
      } else {
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      finish({
        code,
        stdout,
        stderr,
        timedOut,
        aborted,
      });
    });

    child.on("error", (err) => {
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError: err.message,
      });
    });
  });
}

export async function executeGeminiCLIDirect(
  prompt: string,
  options: GeminiCLIDirectOptions = {},
): Promise<GeminiCLIDirectResult> {
  const {
    model = GEMINI_CLI_FLASH_MODEL,
    timeout = 120_000,
    signal,
    cwd = "/tmp",
    outputFormat,
    role,
  } = options;

  // Auto-elevate timeout for Pro model (needs more time for deep analysis)
  const effectiveTimeout =
    model === GEMINI_CLI_PRO_MODEL ? Math.max(timeout, 300_000) : timeout;

  const startTime = Date.now();
  const deadline = startTime + effectiveTimeout;
  const manager = getGeminiAccountManager();
  await manager.syncAccountsFromDisk(true);

  const knownAccounts = manager.getAccountCount();
  if (knownAccounts === 0) {
    return {
      output: `Error: No Gemini account credentials found in ${GEMINI_CREDS_DIR}`,
      exitCode: 1,
      duration: Date.now() - startTime,
      executor: "gemini-cli",
      model,
    };
  }

  const maxAttempts = Math.max(knownAccounts, 2);
  let attempts = 0;
  let lastFailure: GeminiCLIDirectResult | null = null;

  while (attempts < maxAttempts && Date.now() < deadline) {
    await manager.syncAccountsFromDisk();

    const pick = manager.selectBestAccount(Date.now());
    if (!pick.account) {
      break;
    }

    if (pick.reason === "disabled_probe") {
      manager.scheduleDisabledProbe(pick.account.email, Date.now());
    }

    if (pick.waitMs > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= pick.waitMs) {
        const duration = Date.now() - startTime;
        return {
          output: `Error: All Gemini accounts unavailable (next in ${pick.waitMs}ms, timeout remaining ${remaining}ms)`,
          exitCode: 1,
          duration,
          executor: "gemini-cli",
          model,
          accountEmail: pick.account.email,
        };
      }
      logger.debug(
        {
          waitMs: pick.waitMs,
          reason: pick.reason,
          accountEmail: pick.account.email,
        },
        "Waiting for Gemini account availability",
      );
      try {
        await delay(pick.waitMs, signal);
      } catch {
        return {
          output: "Cancelled",
          exitCode: 130,
          duration: Date.now() - startTime,
          executor: "gemini-cli",
          model,
          accountEmail: pick.account.email,
        };
      }
      continue;
    }

    const email = pick.account.email;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    attempts += 1;

    // Inter-spawn stagger: avoid hammering the same account when multiple sessions are active
    const now = Date.now();
    if (
      manager.getActiveCount(email) > 0 &&
      pick.account.last_used_at &&
      now - pick.account.last_used_at < manager["options"].minInterSpawnMs
    ) {
      const staggerMs =
        manager["options"].minInterSpawnMs - (now - pick.account.last_used_at);
      logger.debug(
        { staggerMs, accountEmail: email },
        "Staggering Gemini spawn",
      );
      try {
        await delay(staggerMs, signal);
      } catch {
        return {
          output: "Cancelled",
          exitCode: 130,
          duration: Date.now() - startTime,
          executor: "gemini-cli",
          model,
          accountEmail: email,
        };
      }
    }

    logger.debug(
      {
        model,
        accountEmail: email,
        attempt: attempts,
        maxAttempts,
        promptLength: prompt.length,
      },
      "Executing Gemini CLI with selected account",
    );

    let attemptResult: ExecuteAttemptResult;
    try {
      attemptResult = await manager.withAccountSemaphore(
        email,
        async () => {
          const attemptStart = Date.now();
          manager.recordSelection(email, attemptStart);
          let runtimeHome: string;

          try {
            runtimeHome = await manager.prepareRuntimeHome(email, role);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            manager.recordFailure(
              email,
              "runtime",
              Date.now(),
              `prepare_home_failed: ${msg}`,
            );
            return {
              output: `Error: failed preparing runtime home for ${email}: ${msg}`,
              exitCode: 1,
              duration: Date.now() - startTime,
              executor: "gemini-cli",
              model,
              accountEmail: email,
              retryable: true,
            };
          }

          const run = await runGeminiProcess(
            prompt,
            model,
            cwd,
            Math.max(1_000, remaining),
            signal,
            runtimeHome,
            outputFormat,
          );
          const cleanedOutput = sanitizeGeminiOutput(run.stdout);
          const cleanedErr = sanitizeGeminiOutput(run.stderr);
          const duration = Date.now() - startTime;
          const attemptDuration = Date.now() - attemptStart;

          if (run.aborted) {
            return {
              output: "Cancelled",
              exitCode: 130,
              duration,
              executor: "gemini-cli",
              model,
              accountEmail: email,
              retryable: false,
            };
          }

          const failureKind = detectFailureKind(
            run,
            cleanedOutput,
            cleanedErr,
            attemptDuration,
          );
          if (!failureKind) {
            manager.recordSuccess(email, Date.now());
            await manager.persistRefreshedCreds(email, runtimeHome);
            logger.debug(
              {
                model,
                accountEmail: email,
                duration,
                outputLength: cleanedOutput.length,
              },
              "Gemini CLI completed",
            );
            return {
              output: cleanedOutput,
              exitCode: 0,
              duration,
              executor: "gemini-cli",
              model,
              accountEmail: email,
              retryable: false,
            };
          }

          const filteredErr = sanitizeFailureReason(cleanedErr);
          const errorSnippet = (
            filteredErr ||
            cleanedOutput ||
            run.spawnError ||
            ""
          ).slice(0, 400);
          manager.recordFailure(email, failureKind, Date.now(), errorSnippet);

          const retryable =
            failureKind === "rate_limit" ||
            failureKind === "auth" ||
            failureKind === "runtime";
          const failExitCode = run.code ?? failureKindToExitCode(failureKind);
          logger.warn(
            {
              model,
              accountEmail: email,
              failureKind,
              retryable,
              exitCode: failExitCode,
              stderr: errorSnippet.slice(0, 200),
            },
            "Gemini CLI attempt failed",
          );

          return {
            output: `Error [${failureKind}] exit ${failExitCode}: ${errorSnippet}`,
            exitCode: failExitCode,
            duration,
            executor: "gemini-cli",
            model,
            accountEmail: email,
            retryable,
          };
        },
        Math.min(remaining, 30_000),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastFailure = {
        output: `Error: ${msg}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        model,
        accountEmail: email,
      };
      logger.warn(
        { accountEmail: email, err: msg },
        "Gemini account lock acquisition failed",
      );
      continue;
    }

    if (attemptResult.exitCode === 0) {
      return attemptResult;
    }

    lastFailure = attemptResult;
    if (!attemptResult.retryable) {
      return attemptResult;
    }
  }

  if (lastFailure) {
    return lastFailure;
  }

  return {
    output: "Error: Gemini CLI exhausted all available accounts",
    exitCode: 1,
    duration: Date.now() - startTime,
    executor: "gemini-cli",
    model,
  };
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
export const PRO_TOKEN_SOFT_LIMIT = 800_000;

export async function executeGeminiFlashResearch(
  prompt: string,
  options: ScheduledGeminiResearchOptions = {},
): Promise<GeminiCLIDirectResult> {
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: GEMINI_CLI_FLASH_MODEL,
    role: options.role ?? "research",
  });
}

export async function executeGeminiProResearch(
  prompt: string,
  options: ScheduledGeminiResearchOptions = {},
): Promise<GeminiCLIDirectResult> {
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: GEMINI_CLI_PRO_MODEL,
    role: options.role ?? "research",
  });
}
