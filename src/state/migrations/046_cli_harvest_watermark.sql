-- Watermark-based CLI session harvesting.
-- Tracks the last scan epoch (mtime) per agent to prevent session loss
-- when daemon downtime exceeds the fixed sinceDays window.

CREATE TABLE IF NOT EXISTS cli_harvest_watermark (
  agent TEXT PRIMARY KEY,
  last_scan_epoch_ms INTEGER NOT NULL,
  last_scan_at TEXT NOT NULL DEFAULT (datetime('now'))
);
