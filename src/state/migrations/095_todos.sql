-- 095_todos.sql
-- Replaces the file-first Plans feature with a DB-first To-Dos surface.
-- See ~/homer/output/claude/todos-synthesis-2026-05-12.md and
-- ~/homer/output/codex/todos-simplification-review-2026-05-12.md for design context.
--
-- todo_index is canonical. ~/memory/todos/{id}.md is a slim write-through mirror.
-- The mirror is not round-tripped; the file path is derived from id at runtime
-- (no file_path column needed).
--
-- Closing notes append into the `notes` body — no separate column.
-- FTS, stale-notification cooldown, and content_hash are intentionally omitted
-- in v1 — re-add only when there's evidence they're needed.

CREATE TABLE IF NOT EXISTS todo_index (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'archived')),

  category TEXT NOT NULL DEFAULT 'W'
    CHECK (category IN ('W', 'L')),

  priority TEXT NOT NULL DEFAULT 'P3'
    CHECK (priority IN ('P1', 'P2', 'P3')),

  notes TEXT NOT NULL DEFAULT '',

  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'web', 'mcp', 'idea', 'migration')),

  source_idea_id TEXT,
  linked_thread_id TEXT,
  legacy_plan_id TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  archived_at TEXT
);

-- One composite partial index for the only non-trivial query shape:
-- mentor-layer "stalled open todos by priority + recency".
CREATE INDEX IF NOT EXISTS idx_todo_open_priority_updated
  ON todo_index(priority, updated_at)
  WHERE status = 'open';

-- Idea ↔ Todo lineage. Mirrors linked_plan_id for one release.
ALTER TABLE ideas       ADD COLUMN linked_todo_id TEXT;
ALTER TABLE idea_index  ADD COLUMN linked_todo_id TEXT;

-- One-shot migration of existing plans. Idempotent via legacy_plan_id (PK
-- collision on retried migrations falls through INSERT OR IGNORE). Phases /
-- tasks are not preserved as a checklist — old plan markdown stays in
-- ~/memory/plans/ for reference, and the handful of migrated todos can be
-- hand-split later.
INSERT OR IGNORE INTO todo_index (
  id, title, status, category, priority, notes,
  source, legacy_plan_id,
  created_at, updated_at, completed_at, archived_at
)
SELECT
  'todo_migrated_' || id,
  title,
  CASE
    WHEN status IN ('completed','done')   THEN 'done'
    WHEN status = 'archived'              THEN 'archived'
    ELSE 'open'
  END,
  'W',
  'P2',
  'Migrated from legacy plan: ' || id || char(10) ||
  'Legacy status: ' || COALESCE(status, 'unknown') || char(10) ||
  COALESCE('Progress: ' || completed_tasks || '/' || total_tasks || char(10), ''),
  'migration',
  id,
  COALESCE(created_at, datetime('now')),
  COALESCE(updated_at, datetime('now')),
  CASE WHEN status IN ('completed','done') THEN COALESCE(updated_at, datetime('now')) END,
  CASE WHEN status = 'archived'            THEN COALESCE(updated_at, datetime('now')) END
FROM plan_index
WHERE NOT EXISTS (SELECT 1 FROM todo_index WHERE legacy_plan_id = plan_index.id);
