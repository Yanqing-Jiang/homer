-- Content metrics tracking for Medium and LinkedIn posts
-- Stores engagement data scraped bi-weekly to track post performance

CREATE TABLE IF NOT EXISTS content_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('medium', 'linkedin')),
  post_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  -- Medium metrics
  claps INTEGER,
  reads INTEGER,
  responses INTEGER,
  -- LinkedIn metrics
  reactions INTEGER,
  comments INTEGER,
  -- Scraping metadata
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_content_hash TEXT,
  UNIQUE(platform, post_slug, scraped_at)
);

CREATE INDEX IF NOT EXISTS idx_content_metrics_platform
  ON content_metrics(platform, scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_metrics_post
  ON content_metrics(platform, post_slug);
