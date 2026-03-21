-- Procedural skill system: catalog of learned skills
CREATE TABLE IF NOT EXISTS skills_catalog (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft, observation, active, archived
  trigger_pattern TEXT,                   -- when to activate this skill
  category TEXT,                          -- e.g., deploy, debug, research, code-gen
  source TEXT DEFAULT 'auto',             -- auto, manual, synthesized
  content_hash TEXT,                      -- SHA256 of the skill markdown file
  file_path TEXT,                         -- path to ~/memory/skills/<id>.md
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  requires_approval INTEGER DEFAULT 0,  -- 1 for deploy/migration skills needing manual approval
  last_promoted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_skills_status ON skills_catalog(status);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills_catalog(category);
CREATE INDEX IF NOT EXISTS idx_skills_last_used ON skills_catalog(last_used_at);
