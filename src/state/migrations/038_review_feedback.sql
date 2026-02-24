-- Review Sessions — each morning batch or YouTube presentation
CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL CHECK(session_type IN (
    'idea_review', 'youtube_review', 'overnight_review', 'plan_review'
  )),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  item_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  metadata TEXT  -- JSON
);
CREATE INDEX IF NOT EXISTS idx_review_sessions_type
  ON review_sessions(session_type, started_at DESC);

-- Review Impressions — each item shown to user
CREATE TABLE IF NOT EXISTS review_impressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES review_sessions(id),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'idea', 'youtube', 'overnight', 'plan'
  )),
  content_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  score_at_display REAL,
  displayed_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT  -- JSON: confidence, freshness, primary_tag
);
CREATE INDEX IF NOT EXISTS idx_review_impressions_content
  ON review_impressions(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_review_impressions_session
  ON review_impressions(session_id);

-- Feedback Events — every explicit signal
CREATE TABLE IF NOT EXISTS feedback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  impression_id INTEGER REFERENCES review_impressions(id),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'idea', 'youtube', 'overnight', 'plan'
  )),
  content_id TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('telegram', 'web_ui', 'api', 'scheduler')),
  delta REAL,
  response_time_ms INTEGER,
  metadata TEXT,  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_events_content
  ON feedback_events(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_feedback_events_action
  ON feedback_events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_events_impression
  ON feedback_events(impression_id);
CREATE INDEX IF NOT EXISTS idx_feedback_events_created
  ON feedback_events(created_at DESC);
