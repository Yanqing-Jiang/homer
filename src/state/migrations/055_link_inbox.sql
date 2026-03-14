-- Link Inbox: queue URLs for nightly scraping + idea processing
CREATE TABLE IF NOT EXISTS link_inbox (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual, telegram, web-ui
  link_type   TEXT,                             -- youtube, medium, twitter, github, website (auto-detected)
  title       TEXT,                             -- optional user-provided or auto-detected title
  notes       TEXT,                             -- optional user context
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, done, failed
  scrape_id   TEXT,                             -- FK to scrapes.id once processed
  error       TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  submitted_by TEXT DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_link_inbox_status ON link_inbox(status);
CREATE INDEX IF NOT EXISTS idx_link_inbox_submitted_at ON link_inbox(submitted_at);
