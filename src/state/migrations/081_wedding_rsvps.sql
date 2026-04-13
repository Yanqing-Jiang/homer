-- Migration 081: Wedding RSVP sync from Cloudflare D1 (wedding-rsvps).
-- Mirrors the rsvps table in D1 so Homer can query locally for the
-- admin dashboard and nightly totals. Source of truth remains D1.

CREATE TABLE IF NOT EXISTS wedding_rsvps (
  d1_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  group_size INTEGER NOT NULL DEFAULT 1,
  events TEXT NOT NULL CHECK (events IN ('okc', 'china', 'both', 'none')),
  dietary TEXT,
  message TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_wedding_rsvps_events ON wedding_rsvps(events);
CREATE INDEX IF NOT EXISTS idx_wedding_rsvps_created ON wedding_rsvps(created_at DESC);

CREATE TABLE IF NOT EXISTS wedding_rsvps_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_synced_d1_id INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  last_sync_count INTEGER NOT NULL DEFAULT 0,
  last_sync_error TEXT
);

INSERT OR IGNORE INTO wedding_rsvps_sync_state (id) VALUES (1);
