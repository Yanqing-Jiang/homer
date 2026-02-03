-- ============================================
-- OVERNIGHT WORK SESSIONS
-- Migration 011: Ad-hoc overnight task processing
-- ============================================
-- Enables "work on xyz tonight" and "research xyz for me tonight"
-- user requests via Telegram, with parallel iteration execution
-- and morning choice presentation.
-- ============================================

-- Main overnight tasks table
-- Stores user requests for overnight processing
CREATE TABLE IF NOT EXISTS overnight_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('prototype_work', 'research_dive')),
  subject TEXT NOT NULL,
  constraints TEXT,                    -- JSON array of constraints
  iterations INTEGER DEFAULT 3,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  status TEXT DEFAULT 'queued' CHECK(status IN (
    'queued',           -- Waiting for overnight execution
    'clarifying',       -- Awaiting user clarification
    'planning',         -- Generating approaches
    'executing',        -- Running iterations
    'synthesizing',     -- Cross-validation and ranking
    'ready',            -- Morning choices prepared
    'presented',        -- Choices shown to user
    'selected',         -- User made a selection
    'applied',          -- Selection applied (PR created)
    'skipped',          -- User skipped
    'failed',           -- Execution failed
    'expired'           -- Not reviewed in time
  )),
  scheduled_for TEXT,                  -- ISO timestamp, when to start
  confidence_score REAL,               -- Intent parser confidence (0-1)
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_overnight_tasks_status ON overnight_tasks(status);
CREATE INDEX IF NOT EXISTS idx_overnight_tasks_chat ON overnight_tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_overnight_tasks_scheduled ON overnight_tasks(scheduled_for)
  WHERE status = 'queued';

-- Individual iteration attempts within a task
-- Each task spawns multiple parallel approaches
CREATE TABLE IF NOT EXISTS overnight_iterations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES overnight_tasks(id) ON DELETE CASCADE,
  approach_label TEXT NOT NULL,        -- 'A', 'B', 'C'
  approach_name TEXT NOT NULL,         -- 'Conservative', 'Innovative', 'Pragmatic'
  approach_description TEXT,           -- Brief description of strategy
  status TEXT DEFAULT 'pending' CHECK(status IN (
    'pending',
    'running',
    'completed',
    'failed',
    'skipped'
  )),
  workspace_path TEXT,                 -- Git worktree path for prototypes
  git_branch TEXT,                     -- Branch name for this iteration
  output TEXT,                         -- Execution output/summary
  artifacts TEXT,                      -- JSON array of artifact paths
  validation_score REAL,               -- Codex validation score (0-100)
  validation_notes TEXT,               -- Validation feedback
  executor TEXT,                       -- 'codex', 'gemini', 'claude', 'kimi'
  token_usage INTEGER,                 -- Estimated tokens consumed
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_overnight_iterations_task ON overnight_iterations(task_id);
CREATE INDEX IF NOT EXISTS idx_overnight_iterations_status ON overnight_iterations(status);

-- Morning choices prepared for user review
CREATE TABLE IF NOT EXISTS morning_choices (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES overnight_tasks(id) ON DELETE CASCADE,
  options TEXT NOT NULL,               -- JSON array of ranked options
  comparison_matrix TEXT,              -- JSON comparison table
  recommendation TEXT,                 -- Recommended option label
  recommendation_reason TEXT,          -- Why this option is recommended
  message_id INTEGER,                  -- Telegram message with buttons
  selected_option TEXT,                -- User's selection (A/B/C/skip)
  selected_at TEXT,
  pr_url TEXT,                         -- Created PR URL
  pr_number INTEGER,
  expires_at TEXT,                     -- When choices expire
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_morning_choices_task ON morning_choices(task_id);
CREATE INDEX IF NOT EXISTS idx_morning_choices_expires ON morning_choices(expires_at)
  WHERE selected_option IS NULL;

-- Milestone notifications sent during execution
CREATE TABLE IF NOT EXISTS overnight_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES overnight_tasks(id) ON DELETE CASCADE,
  milestone TEXT NOT NULL,             -- 'planning', 'iteration_start', 'iteration_complete', 'synthesis', 'ready'
  message TEXT NOT NULL,
  message_id INTEGER,                  -- Telegram message ID
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_overnight_milestones_task ON overnight_milestones(task_id);
