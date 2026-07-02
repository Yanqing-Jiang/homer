/**
 * Selection store — read side of harness_selection / harness_profile. The resolver depends
 * on this interface, not on better-sqlite3, so it is trivially unit-testable with an
 * in-memory map. The sqlite implementation reads the normalized tables from migration 107.
 */

import type { HarnessId } from "../types.js";
import type {
  HarnessProfile,
  HarnessScopeRef,
  HarnessScopeType,
} from "./types.js";
import { isScheduledHarnessExecutor } from "../../commands/harness-catalog.js";

interface SqliteStatementLike {
  get(...params: unknown[]): unknown;
}

export interface SqliteHarnessDatabase {
  prepare(sql: string): SqliteStatementLike;
}

export interface HarnessSelectionRow {
  scopeType: HarnessScopeType;
  scopeId: string;
  harness: HarnessId;
  model: string | null;
  profileId: string | null;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
  source: string;
  reason: string | null;
}

export interface HarnessSelectionStore {
  getSelection(scope: HarnessScopeRef): HarnessSelectionRow | null;
  getProfile(profileId: string): HarnessProfile | null;
}

interface RawSelectionRow {
  scope_type: HarnessScopeType;
  scope_id: string;
  harness: string;
  model: string | null;
  profile_id: string | null;
  enabled: number;
  updated_at: number;
  updated_by: string;
  source: string;
  reason: string | null;
}

interface RawProfileRow {
  profile_id: string;
  cwd: string | null;
  timeout_ms: number | null;
  options_json: string | null;
  required_capabilities_json: string | null;
  fallback_policy_json: string | null;
  invocation_profile_json: string | null;
}

/** SQLite-backed store over the migration-107 tables. */
export function createSqliteHarnessSelectionStore(db: SqliteHarnessDatabase): HarnessSelectionStore {
  const selectStmt = db.prepare(`
    SELECT scope_type, scope_id, harness, model, profile_id, enabled,
           updated_at, updated_by, source, reason
    FROM harness_selection
    WHERE scope_type = ? AND scope_id = ? AND enabled = 1
  `);
  const profileStmt = db.prepare(`
    SELECT profile_id, cwd, timeout_ms, options_json,
           required_capabilities_json, fallback_policy_json, invocation_profile_json
    FROM harness_profile
    WHERE profile_id = ?
  `);

  return {
    getSelection(scope: HarnessScopeRef): HarnessSelectionRow | null {
      const row = selectStmt.get(scope.type, scope.id) as RawSelectionRow | undefined;
      if (!row || !isScheduledHarnessExecutor(row.harness)) return null;
      return {
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        harness: row.harness,
        model: row.model,
        profileId: row.profile_id,
        enabled: row.enabled === 1,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        source: row.source,
        reason: row.reason,
      };
    },
    getProfile(profileId: string): HarnessProfile | null {
      const row = profileStmt.get(profileId) as RawProfileRow | undefined;
      if (!row) return null;
      return {
        profileId: row.profile_id,
        cwdOverride: row.cwd ?? undefined,
        timeoutOverride: row.timeout_ms ?? undefined,
        executorOptions: row.options_json ? JSON.parse(row.options_json) : undefined,
        requiredCapabilities: row.required_capabilities_json
          ? JSON.parse(row.required_capabilities_json)
          : undefined,
        fallbackPolicy: row.fallback_policy_json ? JSON.parse(row.fallback_policy_json) : undefined,
        invocation: row.invocation_profile_json ? JSON.parse(row.invocation_profile_json) : undefined,
      };
    },
  };
}

/** In-memory store for unit tests and dry-runs (no DB). */
export function createInMemoryHarnessSelectionStore(
  selections: HarnessSelectionRow[],
  profiles: Record<string, HarnessProfile> = {},
): HarnessSelectionStore {
  const key = (s: HarnessScopeRef) => `${s.type}:${s.id}`;
  const map = new Map(selections.filter((s) => s.enabled).map((s) => [key({ type: s.scopeType, id: s.scopeId }), s]));
  return {
    getSelection: (scope) => map.get(key(scope)) ?? null,
    getProfile: (profileId) => profiles[profileId] ?? null,
  };
}
