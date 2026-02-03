-- Migration 002: Ideas & Plans Index Tables
-- Created: 2026-01-30
-- Purpose: SQLite index for ideas/plans stored as YAML frontmatter files

-- Ideas index (source of truth is ~/memory/ideas/*.md files)
CREATE TABLE IF NOT EXISTS idea_index (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'draft'|'review'|'researching'|'planning'|'execution'|'archived'
  source TEXT,                      -- Where idea came from
  tags TEXT,                        -- JSON array of tags
  linked_thread_id TEXT,            -- Thread where idea is being researched
  linked_plan_id TEXT,              -- Plan created from this idea
  file_path TEXT NOT NULL,          -- Path to the .md file
  content_hash TEXT,                -- For detecting file changes
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (linked_thread_id) REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_idea_status ON idea_index(status);
CREATE INDEX IF NOT EXISTS idx_idea_updated ON idea_index(updated_at);

-- Plans index (source of truth is ~/memory/plans/*.md files)
CREATE TABLE IF NOT EXISTS plan_index (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'planning'|'execution'|'completed'|'archived'
  current_phase TEXT,
  progress REAL DEFAULT 0,          -- 0.0 to 1.0
  total_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  file_path TEXT NOT NULL,          -- Path to the .md file
  content_hash TEXT,                -- For detecting file changes
  source_idea_id TEXT,              -- Idea this plan came from
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (source_idea_id) REFERENCES idea_index(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_status ON plan_index(status);
CREATE INDEX IF NOT EXISTS idx_plan_updated ON plan_index(updated_at);

-- Thread links (for many-to-many relationships)
CREATE TABLE IF NOT EXISTS thread_links (
  thread_id TEXT NOT NULL,
  link_type TEXT NOT NULL,          -- 'idea'|'plan'
  link_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, link_type, link_id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_links_type ON thread_links(link_type, link_id);
