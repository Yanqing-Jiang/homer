-- Migration 111 misclassified live memory audit tables as dead; homer-web's canonical review API (/api/review/canonical) still depends on them for the Existing tab. This migration restores schema only for fresh DB replay; live data was replayed from archive/dead-memory-tables-2026-07-06.sql on 2026-07-06.

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  file_key TEXT NOT NULL,              -- 'me', 'work', 'life', 'preferences', 'tools', ...
  relative_path TEXT NOT NULL,         -- 'me.md', 'skills/foo.md'
  section_path TEXT,                   -- joined heading path, e.g. 'Career / Positioning'
  entry_kind TEXT NOT NULL
    CHECK(entry_kind IN ('bullet','numbered','paragraph','label','table','code')),
  entry_text TEXT NOT NULL,            -- exact canonical block text
  entry_hash TEXT NOT NULL,            -- sha256 of normalized block text
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  ordinal_in_file INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  promoted_at TEXT,                    -- best-effort from source mapping
  last_reviewed_at TEXT,               -- last Keep/Edit/Remove action
  last_retrieved_at TEXT,              -- last retrieval surface (optional)
  usage_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT
);

CREATE TABLE IF NOT EXISTS memory_entry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  event_type TEXT NOT NULL
    CHECK(event_type IN ('indexed','retrieved','kept','edited','removed','stale','conflict')),
  session_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weekly_audit_sessions (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','paused','completed','abandoned')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  resume_file_path TEXT,
  resume_entry_ordinal INTEGER,
  entry_snapshot_count INTEGER NOT NULL DEFAULT 0,
  source_memory_version TEXT NOT NULL,
  telegram_session_root_id INTEGER,    -- message id of the start message
  resume_anchor_staleness REAL,
  resume_anchor_ordinal INTEGER
);

CREATE TABLE IF NOT EXISTS weekly_audit_session_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES weekly_audit_sessions(id),
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  file_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  section_path TEXT,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  entry_text TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT,
  promoted_at TEXT,
  ordinal_in_file INTEGER NOT NULL,
  staleness_score REAL,                -- higher = more stale; drives review order
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','kept','edited','removed','stale','skipped','conflict')),
  decision_note TEXT,
  decided_at TEXT,
  telegram_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_me_path_ordinal ON memory_entries(relative_path, ordinal_in_file);
CREATE INDEX IF NOT EXISTS idx_me_file_active ON memory_entries(file_key, is_active);
CREATE INDEX IF NOT EXISTS idx_me_hash ON memory_entries(entry_hash);
CREATE INDEX IF NOT EXISTS idx_me_reviewed ON memory_entries(last_reviewed_at);
CREATE INDEX IF NOT EXISTS idx_me_origin_device ON memory_entries(origin_device);

CREATE INDEX IF NOT EXISTS idx_mee_entry ON memory_entry_events(memory_entry_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mee_type ON memory_entry_events(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_was_status ON weekly_audit_sessions(status);
CREATE INDEX IF NOT EXISTS idx_was_week ON weekly_audit_sessions(week_start);
CREATE INDEX IF NOT EXISTS idx_was_status_created
  ON weekly_audit_sessions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wase_session_file ON weekly_audit_session_entries(session_id, file_key, ordinal_in_file);
CREATE INDEX IF NOT EXISTS idx_wase_entry ON weekly_audit_session_entries(memory_entry_id);
CREATE INDEX IF NOT EXISTS idx_wase_status ON weekly_audit_session_entries(session_id, status);
CREATE INDEX IF NOT EXISTS idx_wase_tg ON weekly_audit_session_entries(telegram_message_id);
CREATE INDEX IF NOT EXISTS idx_wase_pending_order
  ON weekly_audit_session_entries(session_id, file_path, status, staleness_score DESC, ordinal_in_file ASC);
