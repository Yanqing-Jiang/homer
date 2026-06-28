-- 107_harness_selection.sql
-- Normalize harness SELECTION into one symmetric, scope-keyed table, replacing the asymmetric
-- pair (harness_default one-row global + job_harness_override per-job). One precedence query now
-- serves global / job / lane / conversation / turn. switchHarness() (StateManager) becomes the
-- ONLY writer and records every change in harness_audit.
--
-- Reversibility/safety:
--   * Old physical tables are renamed to *_legacy_107 (lossless snapshot), NOT dropped.
--   * Read-only VIEWs recreate the old names over harness_selection so any unconverted reader
--     (e.g. scheduler lazy readers until routed through the resolver) keeps working unchanged.
--   * All migrated rows are also written to harness_audit with action='migrate'.
-- Timestamps are ms (matching migrations 104/106: strftime('%s','now') * 1000).

-- Executor-agnostic infra a job carries regardless of which harness runs it.
CREATE TABLE IF NOT EXISTS harness_profile (
  profile_id TEXT PRIMARY KEY,
  cwd TEXT,
  timeout_ms INTEGER,
  options_json TEXT,
  required_capabilities_json TEXT,
  fallback_policy_json TEXT,
  invocation_profile_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The one selection table. PRIMARY KEY (scope_type, scope_id) = at most one live row per scope.
CREATE TABLE IF NOT EXISTS harness_selection (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global','job','lane','conversation','turn')),
  scope_id TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL CHECK (harness IN ('claude','codex','opencode','gemini','kimi')),
  model TEXT,
  profile_id TEXT REFERENCES harness_profile(profile_id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  source TEXT NOT NULL DEFAULT 'system'
    CHECK (source IN ('web','bulk','migration','system','telegram','runtime')),
  updated_by TEXT NOT NULL DEFAULT 'system',
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_selection_scope
  ON harness_selection(scope_type, enabled, updated_at);
CREATE INDEX IF NOT EXISTS idx_harness_selection_profile
  ON harness_selection(profile_id);

-- Append-only audit of every selection change (switch/clear) and the migration itself.
CREATE TABLE IF NOT EXISTS harness_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('switch','clear','migrate')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global','job','lane','conversation','turn')),
  scope_id TEXT NOT NULL DEFAULT '',
  old_harness TEXT,
  old_model TEXT,
  old_profile_id TEXT,
  new_harness TEXT,
  new_model TEXT,
  new_profile_id TEXT,
  source TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_harness_audit_scope_time
  ON harness_audit(scope_type, scope_id, created_at);

-- Backfill global selection from the existing one-row harness_default.
INSERT OR IGNORE INTO harness_selection (
  scope_type, scope_id, harness, model, profile_id, enabled, source, updated_by, reason, updated_at
)
SELECT 'global', '', executor, model, NULL, 1, 'migration', 'migration:107',
       'migrated from harness_default', updated_at
FROM harness_default
WHERE id = 1;

-- Backfill job selections from the existing per-job overrides (preserves source/updated_by).
INSERT OR IGNORE INTO harness_selection (
  scope_type, scope_id, harness, model, profile_id, enabled, source, updated_by, reason, updated_at
)
SELECT 'job', job_id, executor, model, NULL, 1, source, updated_by,
       'migrated from job_harness_override', updated_at
FROM job_harness_override;

-- Fail-safe global row if harness_default was missing/corrupt (keeps the system selectable).
INSERT OR IGNORE INTO harness_selection (
  scope_type, scope_id, harness, model, profile_id, enabled, source, updated_by, reason, updated_at
)
VALUES ('global', '', 'claude', 'opus[1m]', NULL, 1, 'system', 'migration:107',
        'seeded fallback global because harness_default was missing', strftime('%s','now') * 1000);

-- Audit the migrated global row.
INSERT OR IGNORE INTO harness_audit (
  event_id, action, scope_type, scope_id,
  old_harness, old_model, old_profile_id, new_harness, new_model, new_profile_id,
  source, updated_by, reason, created_at
)
SELECT 'migration-107-global', 'migrate', 'global', '',
       NULL, NULL, NULL, harness, model, profile_id,
       'migration', 'migration:107', 'migrated from harness_default', updated_at
FROM harness_selection
WHERE scope_type = 'global' AND scope_id = '';

-- Audit every migrated job row.
INSERT OR IGNORE INTO harness_audit (
  event_id, action, scope_type, scope_id,
  old_harness, old_model, old_profile_id, new_harness, new_model, new_profile_id,
  source, updated_by, reason, created_at
)
SELECT 'migration-107-job-' || scope_id, 'migrate', 'job', scope_id,
       NULL, NULL, NULL, harness, model, profile_id,
       source, updated_by, 'migrated from job_harness_override', updated_at
FROM harness_selection
WHERE scope_type = 'job';

-- Snapshot old physical tables (lossless) and replace their names with read-only views.
ALTER TABLE harness_default RENAME TO harness_default_legacy_107;
ALTER TABLE job_harness_override RENAME TO job_harness_override_legacy_107;

CREATE VIEW harness_default AS
SELECT 1 AS id, harness AS executor, model, updated_at
FROM harness_selection
WHERE scope_type = 'global' AND scope_id = '' AND enabled = 1;

CREATE VIEW job_harness_override AS
SELECT scope_id AS job_id, harness AS executor, model, updated_at, updated_by, source
FROM harness_selection
WHERE scope_type = 'job' AND enabled = 1;
