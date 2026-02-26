-- Migration 040: YouTube Analysis V2
-- Adds structured analysis columns, enriched FTS, and pipeline metadata.

-- New columns on youtube_videos
ALTER TABLE youtube_videos ADD COLUMN pipeline_version TEXT DEFAULT 'yt_v1';
ALTER TABLE youtube_videos ADD COLUMN analysis_status TEXT DEFAULT 'legacy';
ALTER TABLE youtube_videos ADD COLUMN primary_category TEXT;
ALTER TABLE youtube_videos ADD COLUMN primary_topic TEXT;
ALTER TABLE youtube_videos ADD COLUMN intent_primary TEXT;
ALTER TABLE youtube_videos ADD COLUMN intent_confidence REAL;
ALTER TABLE youtube_videos ADD COLUMN pass1_classification TEXT;  -- JSON blob
ALTER TABLE youtube_videos ADD COLUMN analysis_json TEXT;         -- full Pass 2 JSON
ALTER TABLE youtube_videos ADD COLUMN topics_text TEXT;           -- flat text for FTS
ALTER TABLE youtube_videos ADD COLUMN model_pass1 TEXT;
ALTER TABLE youtube_videos ADD COLUMN model_pass2 TEXT;
ALTER TABLE youtube_videos ADD COLUMN queued_at TEXT;
ALTER TABLE youtube_videos ADD COLUMN processing_ms INTEGER;

-- Indexes for efficient filtering/querying
CREATE INDEX IF NOT EXISTS idx_yt_category ON youtube_videos(primary_category);
CREATE INDEX IF NOT EXISTS idx_yt_intent    ON youtube_videos(intent_primary);
CREATE INDEX IF NOT EXISTS idx_yt_status    ON youtube_videos(analysis_status);

-- Rebuild youtube_videos_fts to include new columns
-- Drop old triggers first
DROP TRIGGER IF EXISTS youtube_videos_ai;
DROP TRIGGER IF EXISTS youtube_videos_au;
DROP TRIGGER IF EXISTS youtube_videos_ad;

-- Drop and recreate FTS table with richer columns
DROP TABLE IF EXISTS youtube_videos_fts;

CREATE VIRTUAL TABLE youtube_videos_fts USING fts5(
  title,
  summary,
  transcript,
  channel_name,
  primary_category,
  intent_primary,
  topics_text,
  content='youtube_videos',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Recreate insert trigger
CREATE TRIGGER youtube_videos_ai AFTER INSERT ON youtube_videos BEGIN
  INSERT INTO youtube_videos_fts(rowid, title, summary, transcript, channel_name, primary_category, intent_primary, topics_text)
    VALUES (new.rowid, new.title, new.summary, new.transcript, new.channel_name,
            new.primary_category, new.intent_primary, new.topics_text);
END;

-- Recreate update trigger (delete + reinsert pattern for content= FTS)
CREATE TRIGGER youtube_videos_au AFTER UPDATE ON youtube_videos BEGIN
  INSERT INTO youtube_videos_fts(youtube_videos_fts, rowid, title, summary, transcript, channel_name, primary_category, intent_primary, topics_text)
    VALUES ('delete', old.rowid, old.title, old.summary, old.transcript, old.channel_name,
            old.primary_category, old.intent_primary, old.topics_text);
  INSERT INTO youtube_videos_fts(rowid, title, summary, transcript, channel_name, primary_category, intent_primary, topics_text)
    VALUES (new.rowid, new.title, new.summary, new.transcript, new.channel_name,
            new.primary_category, new.intent_primary, new.topics_text);
END;

-- Recreate delete trigger
CREATE TRIGGER youtube_videos_ad AFTER DELETE ON youtube_videos BEGIN
  INSERT INTO youtube_videos_fts(youtube_videos_fts, rowid, title, summary, transcript, channel_name, primary_category, intent_primary, topics_text)
    VALUES ('delete', old.rowid, old.title, old.summary, old.transcript, old.channel_name,
            old.primary_category, old.intent_primary, old.topics_text);
END;

-- Backfill existing rows into FTS
INSERT INTO youtube_videos_fts(rowid, title, summary, transcript, channel_name, primary_category, intent_primary, topics_text)
  SELECT rowid, title, summary, transcript, channel_name,
         primary_category, intent_primary, topics_text
  FROM youtube_videos;
