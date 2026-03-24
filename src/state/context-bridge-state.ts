// @ts-ignore
// @ts-ignore
import type Database from "better-sqlite3";
import { createHash } from "crypto";

export interface ContextBridgeState {
  sourceHash: string | null;
  outputHash: string | null;
  dirty: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastTriggerSource: string | null;
  lastMethod: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

interface ContextBridgeStateRow extends ContextBridgeState {}

interface ContextBridgeStateUpdate {
  sourceHash?: string | null;
  outputHash?: string | null;
  dirty?: boolean;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastTriggerSource?: string | null;
  lastMethod?: string | null;
  lastError?: string | null;
}

const DEFAULT_CONTEXT_BRIDGE_STATE: ContextBridgeState = {
  sourceHash: null,
  outputHash: null,
  dirty: 1,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastTriggerSource: null,
  lastMethod: null,
  lastError: null,
  updatedAt: null,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }

  return value;
}

function saveContextBridgeState(
  db: Database.Database,
  patch: ContextBridgeStateUpdate,
): void {
  const prev = getContextBridgeState(db);
  const next: ContextBridgeState = {
    sourceHash: patch.sourceHash === undefined ? prev.sourceHash : patch.sourceHash,
    outputHash: patch.outputHash === undefined ? prev.outputHash : patch.outputHash,
    dirty: patch.dirty === undefined ? prev.dirty : (patch.dirty ? 1 : 0),
    lastStartedAt: patch.lastStartedAt === undefined ? prev.lastStartedAt : patch.lastStartedAt,
    lastCompletedAt: patch.lastCompletedAt === undefined ? prev.lastCompletedAt : patch.lastCompletedAt,
    lastTriggerSource: patch.lastTriggerSource === undefined ? prev.lastTriggerSource : patch.lastTriggerSource,
    lastMethod: patch.lastMethod === undefined ? prev.lastMethod : patch.lastMethod,
    lastError: patch.lastError === undefined ? prev.lastError : patch.lastError,
    updatedAt: prev.updatedAt,
  };

  db.prepare(`
    INSERT INTO context_bridge_state (
      id,
      source_hash,
      output_hash,
      dirty,
      last_started_at,
      last_completed_at,
      last_trigger_source,
      last_method,
      last_error,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      source_hash = excluded.source_hash,
      output_hash = excluded.output_hash,
      dirty = excluded.dirty,
      last_started_at = excluded.last_started_at,
      last_completed_at = excluded.last_completed_at,
      last_trigger_source = excluded.last_trigger_source,
      last_method = excluded.last_method,
      last_error = excluded.last_error,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    next.sourceHash,
    next.outputHash,
    next.dirty,
    next.lastStartedAt,
    next.lastCompletedAt,
    next.lastTriggerSource,
    next.lastMethod,
    next.lastError,
  );
}

export function ensureContextBridgeStateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_bridge_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_hash TEXT,
      output_hash TEXT,
      dirty INTEGER NOT NULL DEFAULT 1,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_trigger_source TEXT,
      last_method TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function hashContextBridgeValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function getContextBridgeState(db: Database.Database): ContextBridgeState {
  const row = db.prepare(`
    SELECT
      source_hash as sourceHash,
      output_hash as outputHash,
      dirty,
      last_started_at as lastStartedAt,
      last_completed_at as lastCompletedAt,
      last_trigger_source as lastTriggerSource,
      last_method as lastMethod,
      last_error as lastError,
      updated_at as updatedAt
    FROM context_bridge_state
    WHERE id = 1
  `).get() as ContextBridgeStateRow | undefined;

  return row ?? DEFAULT_CONTEXT_BRIDGE_STATE;
}

export function markContextBridgeDirty(
  db: Database.Database,
  triggerSource: string,
): void {
  saveContextBridgeState(db, {
    dirty: true,
    lastTriggerSource: triggerSource,
  });
}

export function recordContextBridgeStart(
  db: Database.Database,
  triggerSource: string,
  startedAt: string = new Date().toISOString(),
): void {
  saveContextBridgeState(db, {
    lastStartedAt: startedAt,
    lastTriggerSource: triggerSource,
    lastError: null,
  });
}

export function recordContextBridgeResult(
  db: Database.Database,
  result: {
    triggerSource: string;
    sourceHash?: string | null;
    outputHash?: string | null;
    dirty: boolean;
    method?: string | null;
    error?: string | null;
    completedAt?: string;
  },
): void {
  saveContextBridgeState(db, {
    sourceHash: result.sourceHash,
    outputHash: result.outputHash,
    dirty: result.dirty,
    lastCompletedAt: result.completedAt ?? new Date().toISOString(),
    lastTriggerSource: result.triggerSource,
    lastMethod: result.method ?? null,
    lastError: result.error ?? null,
  });
}
