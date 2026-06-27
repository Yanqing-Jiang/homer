-- 106_job_harness_override.sql
-- Control plane for the job/Telegram harness switcher.
--
-- (1) New per-job override layer. One row per scheduled job that has a LIVE harness/model
--     override set from the web Harness tab or Telegram. Absence of a row = fall through to
--     schedule.json executor/model -> baseline registry -> global harness_default -> fallback
--     chain. Switches NEVER mutate the git-tracked schedule.json files.
--
-- (2) Relax harness_default. Migration 104 capped executor to ('claude','opencode) and made
--     model NOT NULL. The switcher needs all five CLI harnesses selectable globally, and
--     model must be nullable because Codex is CLI-managed (no model arg). SQLite cannot ALTER
--     a CHECK constraint in place, so we rebuild the one-row table preserving the live row.

CREATE TABLE IF NOT EXISTS job_harness_override (
  job_id TEXT PRIMARY KEY,
  executor TEXT NOT NULL CHECK (executor IN ('claude','codex','opencode','gemini','kimi')),
  model TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'web',
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','bulk','migration','system'))
);

CREATE INDEX IF NOT EXISTS idx_job_harness_override_updated_at
  ON job_harness_override(updated_at);

-- Rebuild harness_default with the widened CHECK + nullable model, preserving the live row.
CREATE TABLE IF NOT EXISTS harness_default_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  executor TEXT NOT NULL DEFAULT 'opencode'
    CHECK (executor IN ('claude','codex','opencode','gemini','kimi')),
  model TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO harness_default_new (id, executor, model, updated_at)
SELECT
  id,
  CASE
    WHEN executor IN ('claude','codex','opencode','gemini','kimi') THEN executor
    ELSE 'claude'
  END AS executor,
  model,
  updated_at
FROM harness_default
WHERE id = 1;

-- Fail-safe seed if the source table was empty.
INSERT OR IGNORE INTO harness_default_new (id, executor, model, updated_at)
VALUES (1, 'opencode', 'opencode-go/glm-5.2', strftime('%s','now') * 1000);

DROP TABLE harness_default;
ALTER TABLE harness_default_new RENAME TO harness_default;
