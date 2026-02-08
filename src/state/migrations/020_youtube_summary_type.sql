-- ============================================
-- Migration 020: Add youtube_summary task type + metadata column
-- ============================================
-- The overnight_tasks.type column has a CHECK constraint limited to
-- ('prototype_work', 'research_dive'). SQLite can't ALTER CHECK constraints,
-- so we recreate the table with the new type and a metadata column.
-- ============================================

PRAGMA foreign_keys = OFF;

-- Create new table with updated CHECK constraint and metadata column
CREATE TABLE IF NOT EXISTS overnight_tasks_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('prototype_work', 'research_dive', 'youtube_summary')),
  subject TEXT NOT NULL,
  constraints TEXT,
  iterations INTEGER DEFAULT 3,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  status TEXT DEFAULT 'queued' CHECK(status IN (
    'queued',
    'clarifying',
    'planning',
    'executing',
    'synthesizing',
    'ready',
    'presented',
    'selected',
    'applied',
    'skipped',
    'failed',
    'expired'
  )),
  scheduled_for TEXT,
  confidence_score REAL,
  error TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

-- Copy existing data (metadata will be NULL for old rows)
INSERT OR IGNORE INTO overnight_tasks_new (
  id, type, subject, constraints, iterations,
  chat_id, message_id, status, scheduled_for,
  confidence_score, error, created_at, started_at, completed_at
)
SELECT
  id, type, subject, constraints, iterations,
  chat_id, message_id, status, scheduled_for,
  confidence_score, error, created_at, started_at, completed_at
FROM overnight_tasks;

-- Drop old table
DROP TABLE IF EXISTS overnight_tasks;

-- Rename new table
ALTER TABLE overnight_tasks_new RENAME TO overnight_tasks;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_overnight_tasks_status ON overnight_tasks(status);
CREATE INDEX IF NOT EXISTS idx_overnight_tasks_chat ON overnight_tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_overnight_tasks_scheduled ON overnight_tasks(scheduled_for)
  WHERE status = 'queued';

PRAGMA foreign_keys = ON;
