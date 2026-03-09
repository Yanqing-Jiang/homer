-- Migration 051: Idea enrichment JSON + Homer improvement tasks
-- enrichment stores {deep_dive, deep_links, homer_improvement} per idea
-- homer_tasks stores auto-created improvement tasks from high-priority enrichments

ALTER TABLE ideas ADD COLUMN enrichment TEXT;

CREATE TABLE IF NOT EXISTS homer_tasks (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'idea_enrichment',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_homer_tasks_idea ON homer_tasks(idea_id);
CREATE INDEX IF NOT EXISTS idx_homer_tasks_status ON homer_tasks(status, created_at);
