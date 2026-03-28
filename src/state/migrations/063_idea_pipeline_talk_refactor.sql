-- Migration 063: Idea Pipeline Talk Refactor
--
-- Introduces:
--   1. content_hooks — Medium/LinkedIn copywriting patterns (separate from idea pipeline)
--   2. discussion_summaries — rolling conversation summaries for EXPLORE loop
--   3. discussion_artifacts — structured outputs from discussions (experiments, connections)
--   4. New columns on existing tables for engagement tracking and EXPLORE stages
--
-- Also:
--   - Backfills existing medium-trending scrapes as processed (stops pipeline pollution)

-- ============================================
-- 1. Content Hooks
-- ============================================

CREATE TABLE IF NOT EXISTS content_hooks (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,                    -- 'medium' | 'linkedin'
  source_url TEXT,
  title TEXT,
  hook_type TEXT NOT NULL,                   -- 'title-pattern' | 'opening-hook' | 'structure-template'
  content TEXT NOT NULL,                     -- the actual hook/pattern text
  analysis TEXT,                             -- JSON: why the hook works, extracted by Claude
  metadata TEXT,                             -- JSON: { author, claps, topic, scrape_id, score }
  status TEXT NOT NULL DEFAULT 'active',     -- active | used | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT                               -- when Yanqing used this hook in his own content
);

CREATE INDEX IF NOT EXISTS idx_content_hooks_platform ON content_hooks(platform);
CREATE INDEX IF NOT EXISTS idx_content_hooks_type ON content_hooks(hook_type);
CREATE INDEX IF NOT EXISTS idx_content_hooks_status ON content_hooks(status, created_at DESC);

-- ============================================
-- 2. Discussion Summaries (for EXPLORE loop)
-- ============================================

CREATE TABLE IF NOT EXISTS discussion_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id TEXT NOT NULL REFERENCES idea_discussions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  open_questions TEXT,                       -- JSON array of unresolved questions
  turn_range TEXT,                           -- e.g. "1-6", "7-12"
  metadata TEXT,                             -- JSON: { model, tokens }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discussion_summaries_disc ON discussion_summaries(discussion_id, created_at DESC);

-- ============================================
-- 3. Discussion Artifacts
-- ============================================

CREATE TABLE IF NOT EXISTS discussion_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id TEXT NOT NULL REFERENCES idea_discussions(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,               -- 'suggestion' | 'experiment' | 'connection' | 'insight'
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | accepted | closed
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discussion_artifacts_disc ON discussion_artifacts(discussion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discussion_artifacts_status ON discussion_artifacts(status, artifact_type);

-- ============================================
-- 4. Extend existing tables
-- ============================================

-- EXPLORE stage tracking on discussions
ALTER TABLE idea_discussions ADD COLUMN stage TEXT DEFAULT 'examine';

-- Engagement depth for auto-promote logic
ALTER TABLE source_packets ADD COLUMN engagement_depth INTEGER NOT NULL DEFAULT 0;

-- Track last discussion time on packets
ALTER TABLE source_packets ADD COLUMN last_discussed_at TEXT;

-- ============================================
-- 5. Backfill: stop medium-trending from leaking into idea-synthesizer
-- ============================================

UPDATE scrapes SET processed_at = datetime('now')
WHERE source = 'medium-trending' AND processed_at IS NULL;

-- ============================================
-- 6. Backfill: extract existing medium-trending into content_hooks
-- ============================================

INSERT OR IGNORE INTO content_hooks (id, platform, source_url, title, hook_type, content, analysis, metadata, created_at)
SELECT
  'hook_title_' || id,
  'medium',
  url,
  title,
  'title-pattern',
  COALESCE(title, url, '(untitled)'),
  json_extract(metadata, '$.hook_analysis'),
  json_object(
    'author', author,
    'claps', json_extract(metadata, '$.claps'),
    'topic', json_extract(metadata, '$.topic'),
    'score', json_extract(metadata, '$.score'),
    'scrape_id', id
  ),
  COALESCE(scraped_at, datetime('now'))
FROM scrapes
WHERE source = 'medium-trending';
