-- Migration 037: Unified Knowledge Store
-- Created: 2026-02-23
-- Purpose: Move YouTube videos and ideas into SQLite as source of truth,
--          with FTS5 full-text search and .md files as write-through mirrors.
--
-- NOTE: idea_index table is NOT renamed/dropped — it stays for backward compat
-- until all callers are migrated to the DAO layer (which uses this new 'ideas' table).

-- ============================================
-- YouTube Videos
-- ============================================

CREATE TABLE IF NOT EXISTS youtube_videos (
  video_id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  channel_name TEXT,
  transcript TEXT,                     -- raw transcript (8K-50K chars)
  summary TEXT,                        -- full summary markdown
  relevance_score REAL,
  metadata TEXT,                       -- JSON: method, charCount, extractedAt, etc.
  transcript_method TEXT,              -- youtube-transcript-api | yt-dlp | elevenlabs
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,                    -- set when user reviews in morning
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_youtube_videos_processed ON youtube_videos(processed_at);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_reviewed ON youtube_videos(reviewed_at);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_relevance ON youtube_videos(relevance_score);

CREATE VIRTUAL TABLE IF NOT EXISTS youtube_videos_fts USING fts5(
  title, summary, transcript, channel_name,
  content='youtube_videos', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER youtube_videos_fts_ai AFTER INSERT ON youtube_videos BEGIN
  INSERT INTO youtube_videos_fts(rowid, title, summary, transcript, channel_name)
  VALUES (new.rowid, new.title, new.summary, new.transcript, new.channel_name);
END;

CREATE TRIGGER youtube_videos_fts_au AFTER UPDATE ON youtube_videos BEGIN
  INSERT INTO youtube_videos_fts(youtube_videos_fts, rowid, title, summary, transcript, channel_name)
  VALUES ('delete', old.rowid, old.title, old.summary, old.transcript, old.channel_name);
  INSERT INTO youtube_videos_fts(rowid, title, summary, transcript, channel_name)
  VALUES (new.rowid, new.title, new.summary, new.transcript, new.channel_name);
END;

CREATE TRIGGER youtube_videos_fts_ad AFTER DELETE ON youtube_videos BEGIN
  INSERT INTO youtube_videos_fts(youtube_videos_fts, rowid, title, summary, transcript, channel_name)
  VALUES ('delete', old.rowid, old.title, old.summary, old.transcript, old.channel_name);
END;

-- ============================================
-- Ideas (new table — coexists with idea_index until migration complete)
-- ============================================

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT,
  tags TEXT,                            -- JSON array
  raw_content TEXT,                     -- full markdown body (all sections)
  link TEXT,
  canonical_url TEXT,
  notes TEXT,                           -- ## Notes section
  context TEXT,                         -- ## Context section
  exploration TEXT,                     -- ## Exploration section
  fingerprint TEXT,                     -- for dedup (Jaccard)
  linked_exploration_thread_id TEXT,    -- used by Web UI explore flow
  linked_plan_id TEXT,                  -- used by Web UI plan flow
  file_path TEXT UNIQUE,
  content_hash TEXT,
  created_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_updated ON ideas(updated_at);
CREATE INDEX IF NOT EXISTS idx_ideas_source ON ideas(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_canonical_url ON ideas(canonical_url) WHERE canonical_url IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(
  title, raw_content, notes, tags,
  content='ideas', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER ideas_fts_ai AFTER INSERT ON ideas BEGIN
  INSERT INTO ideas_fts(rowid, title, raw_content, notes, tags)
  VALUES (new.rowid, new.title, new.raw_content, new.notes, new.tags);
END;

CREATE TRIGGER ideas_fts_au AFTER UPDATE ON ideas BEGIN
  INSERT INTO ideas_fts(ideas_fts, rowid, title, raw_content, notes, tags)
  VALUES ('delete', old.rowid, old.title, old.raw_content, old.notes, old.tags);
  INSERT INTO ideas_fts(rowid, title, raw_content, notes, tags)
  VALUES (new.rowid, new.title, new.raw_content, new.notes, new.tags);
END;

CREATE TRIGGER ideas_fts_ad AFTER DELETE ON ideas BEGIN
  INSERT INTO ideas_fts(ideas_fts, rowid, title, raw_content, notes, tags)
  VALUES ('delete', old.rowid, old.title, old.raw_content, old.notes, old.tags);
END;

-- Seed from idea_index (metadata only — raw_content backfilled by scripts/backfill-ideas.ts)
-- NOTE: idea_index is guaranteed to exist here — created in migration 002, and migrations
-- run sequentially. The WHERE EXISTS guard is belt-and-suspenders for manual recovery.
INSERT OR IGNORE INTO ideas (id, title, status, source, tags, linked_exploration_thread_id, linked_plan_id, file_path, content_hash, created_at, updated_at)
SELECT id, title, status, source, tags, linked_thread_id, linked_plan_id, file_path, content_hash, created_at, updated_at
FROM idea_index
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='idea_index');
