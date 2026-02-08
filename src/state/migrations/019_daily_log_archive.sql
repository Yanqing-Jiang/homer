-- Archive raw daily log content to SQLite before stripping .md to summary-only
CREATE TABLE IF NOT EXISTS daily_log_archive (
  date TEXT PRIMARY KEY,                              -- YYYY-MM-DD
  raw_content TEXT NOT NULL,                          -- Full .md before summary
  raw_size_bytes INTEGER NOT NULL,
  summary_content TEXT,                               -- Extracted summary text
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stripped_at TEXT                                     -- NULL until .md is stripped
);

CREATE INDEX IF NOT EXISTS idx_daily_log_archive_archived_at ON daily_log_archive(archived_at);
