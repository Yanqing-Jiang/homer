-- Relax the review_sessions/review_impressions type enums.
--
-- The original CHECKs only knew idea/youtube/overnight/plan. Every other
-- writer failed silently behind a try/catch: the packet review flow has been
-- inserting session_type='packet_review' + content_type='packet' since it
-- shipped and not one row ever landed. morning-reads now records the scrapes
-- it showed, so the enum has to go. Type values are owned by the writer.
--
-- Runs via FK_REBUILD_MIGRATIONS (foreign keys disabled): review_impressions
-- is both a child of review_sessions and a parent of feedback_events, so the
-- table rebuild cannot satisfy immediate or deferred FK enforcement. All row
-- ids are preserved, so every existing reference stays valid.

CREATE TABLE review_sessions_new (
  id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  item_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  metadata TEXT
);

INSERT INTO review_sessions_new (id, session_type, started_at, item_count, completed_at, metadata)
  SELECT id, session_type, started_at, item_count, completed_at, metadata FROM review_sessions;

DROP TABLE review_sessions;

ALTER TABLE review_sessions_new RENAME TO review_sessions;

CREATE TABLE review_impressions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES review_sessions(id),
  content_type TEXT NOT NULL,
  content_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  score_at_display REAL,
  displayed_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

INSERT INTO review_impressions_new (id, session_id, content_type, content_id, position, score_at_display, displayed_at, metadata)
  SELECT id, session_id, content_type, content_id, position, score_at_display, displayed_at, metadata FROM review_impressions;

DROP TABLE review_impressions;

ALTER TABLE review_impressions_new RENAME TO review_impressions;

CREATE INDEX IF NOT EXISTS idx_review_sessions_type
  ON review_sessions(session_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_impressions_content
  ON review_impressions(content_type, content_id);

CREATE INDEX IF NOT EXISTS idx_review_impressions_session
  ON review_impressions(session_id);
