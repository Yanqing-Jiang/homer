-- ============================================
-- UNIFIED AGENT RUNTIME SCHEMA
-- Migration 009: Goals, Proposals, Intents, Runs
-- ============================================
-- Replaces: cron scheduler, NightSupervisor, ideas.md
-- New flow: Discovery → Proposal → Intent → Run
-- ============================================

-- ============================================
-- GOALS: What the user cares about achieving
-- ============================================
-- Goals are the highest-level outcomes. They persist across sessions
-- and provide context for why work gets done.

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,

  -- Classification
  category TEXT NOT NULL,  -- 'work' | 'side_income' | 'learning' | 'life' | 'homer'
  priority INTEGER NOT NULL DEFAULT 50,  -- 0-100, higher = more important

  -- Status
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'achieved' | 'abandoned'
  progress REAL DEFAULT 0,  -- 0.0 to 1.0

  -- Relationships
  parent_goal_id TEXT,  -- For goal hierarchies (OKR style)

  -- Metadata
  tags TEXT,  -- JSON array of tags
  metadata TEXT,  -- JSON object for extensible data

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  achieved_at TEXT,

  FOREIGN KEY (parent_goal_id) REFERENCES goals(id) ON DELETE SET NULL
);

CREATE INDEX idx_goals_status ON goals(status);
CREATE INDEX idx_goals_category ON goals(category);
CREATE INDEX idx_goals_priority ON goals(priority DESC);


-- ============================================
-- PROPOSALS: Approval artifacts with stages
-- ============================================
-- Proposals are ideas that require human approval.
-- They evolve through stages: idea → research → plan
-- Each stage may have Q&A interaction before proceeding.
-- NOTE: Must be created BEFORE intents (FK dependency)

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,  -- Brief description for Telegram

  -- Stage lifecycle: idea → research → plan → (archived | rejected)
  stage TEXT NOT NULL DEFAULT 'idea',  -- 'idea' | 'research' | 'plan' | 'archived' | 'rejected'

  -- Classification
  proposal_type TEXT NOT NULL,  -- 'feature' | 'research' | 'content' | 'improvement' | 'maintenance'
  risk_level TEXT NOT NULL DEFAULT 'low',

  -- Content (stage-dependent)
  content TEXT NOT NULL,  -- Markdown body, structure depends on stage

  -- Source tracking
  source TEXT NOT NULL,  -- 'discovery' | 'night_supervisor' | 'user' | 'agent'
  source_detail TEXT,  -- e.g., 'github-trending', 'hacker-news', 'conversation'
  source_url TEXT,  -- Link to original source

  -- Relationships
  goal_id TEXT,  -- Which goal this would serve
  parent_proposal_id TEXT,  -- Previous stage version (idea → plan creates new row)

  -- Approval state
  approval_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected' | 'needs_info'
  approved_by TEXT,  -- 'user' | 'auto' (for low-risk)
  approved_at TEXT,
  rejection_reason TEXT,

  -- Scoring (for prioritization)
  relevance_score REAL,  -- 0-100, how relevant to goals
  urgency_score REAL,  -- 0-100, time sensitivity
  effort_estimate TEXT,  -- 'trivial' | 'small' | 'medium' | 'large' | 'epic'

  -- Telegram integration
  chat_id INTEGER,  -- Where to send updates
  message_id INTEGER,  -- The proposal message (for inline buttons)

  -- Optimistic locking
  version INTEGER NOT NULL DEFAULT 1,  -- Incremented on each update

  -- Metadata
  tags TEXT,  -- JSON array
  metadata TEXT,  -- JSON object (scores breakdown, etc.)

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,  -- Auto-archive if not acted on

  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_proposal_id) REFERENCES proposals(id) ON DELETE SET NULL
);

CREATE INDEX idx_proposals_stage ON proposals(stage);
CREATE INDEX idx_proposals_status ON proposals(approval_status);
CREATE INDEX idx_proposals_source ON proposals(source);
CREATE INDEX idx_proposals_created ON proposals(created_at DESC);
CREATE INDEX idx_proposals_goal ON proposals(goal_id);
CREATE INDEX idx_proposals_pending ON proposals(stage, approval_status) WHERE approval_status = 'pending';


-- ============================================
-- PROPOSAL Q&A: Interactive refinement
-- ============================================
-- Tracks questions and answers during proposal refinement.
-- Used in Web UI's planning phase.

CREATE TABLE proposal_qa (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,

  -- Q&A content
  question TEXT NOT NULL,
  answer TEXT,

  -- Who asked/answered
  asked_by TEXT NOT NULL,  -- 'system' | 'user'
  answered_at TEXT,

  -- Order
  sequence INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
);

CREATE INDEX idx_proposal_qa_proposal ON proposal_qa(proposal_id, sequence);


-- ============================================
-- INTENTS: What the system plans to do
-- ============================================
-- Intents are approved work items ready for execution.
-- They may come from approved Proposals or direct user requests.

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,

  -- Classification
  intent_type TEXT NOT NULL,  -- 'research' | 'code' | 'content' | 'analysis' | 'maintenance' | 'notification'
  risk_level TEXT NOT NULL DEFAULT 'low',  -- 'low' | 'medium' | 'high'

  -- Scheduling
  priority INTEGER NOT NULL DEFAULT 50,  -- 0-100
  scheduled_for TEXT,  -- ISO timestamp, NULL = ASAP
  deadline TEXT,  -- ISO timestamp

  -- Execution context
  lane TEXT NOT NULL DEFAULT 'default',  -- 'work' | 'life' | 'default'
  executor_preference TEXT,  -- 'claude' | 'gemini' | 'kimi' | 'codex' | NULL (auto)

  -- Work definition
  query TEXT NOT NULL,  -- The prompt/instruction
  context_files TEXT,  -- JSON array of file paths
  working_dir TEXT,  -- CWD for execution

  -- Relationships
  goal_id TEXT,  -- Which goal this serves
  source_proposal_id TEXT,  -- If born from a proposal
  parent_intent_id TEXT,  -- For decomposed work

  -- Status
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled'

  -- Metadata
  tags TEXT,  -- JSON array
  metadata TEXT,  -- JSON object

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL,
  FOREIGN KEY (source_proposal_id) REFERENCES proposals(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_intent_id) REFERENCES intents(id) ON DELETE SET NULL
);

CREATE INDEX idx_intents_status ON intents(status);
CREATE INDEX idx_intents_priority ON intents(priority DESC);
CREATE INDEX idx_intents_scheduled ON intents(scheduled_for);
CREATE INDEX idx_intents_goal ON intents(goal_id);
CREATE INDEX idx_intents_lane ON intents(lane, status);


-- ============================================
-- RUNS: Execution records
-- ============================================
-- Runs are the actual execution of an Intent.
-- One Intent may have multiple Runs (retries, continuation).

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,

  -- Execution
  executor TEXT NOT NULL,  -- 'claude' | 'gemini' | 'kimi' | 'codex' | 'api'
  executor_account TEXT,  -- For multi-account rotation: 'gemini-1', 'gemini-2', etc.

  -- Session continuity
  session_id TEXT,  -- Claude session ID or CDP session
  context_hash TEXT,  -- Hash of context to detect drift

  -- Status
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'

  -- Results
  output TEXT,  -- The response/result
  error TEXT,
  exit_code INTEGER,

  -- Artifacts produced
  artifacts TEXT,  -- JSON array of file paths

  -- Metrics
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  duration_ms INTEGER,

  -- Token tracking (for API calls)
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_total INTEGER,
  cost_usd REAL,  -- Estimated cost

  -- Worker info
  worker_id TEXT,  -- Which worker process
  heartbeat_at TEXT,  -- For stale detection

  -- Attempt tracking
  attempt_number INTEGER NOT NULL DEFAULT 1,
  retry_of_run_id TEXT,  -- If this is a retry

  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE,
  FOREIGN KEY (retry_of_run_id) REFERENCES runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_runs_intent ON runs(intent_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_started ON runs(started_at DESC);
CREATE INDEX idx_runs_executor ON runs(executor, executor_account);
CREATE INDEX idx_runs_stale ON runs(status, heartbeat_at) WHERE status = 'running';


-- ============================================
-- EXECUTOR ACCOUNTS: Track account usage/quotas
-- ============================================
-- Manages multiple accounts per executor (Gemini 1/2/3, etc.)

CREATE TABLE executor_accounts (
  id TEXT PRIMARY KEY,  -- e.g., 'gemini-1', 'claude-api', 'kimi-nvidia'
  executor TEXT NOT NULL,  -- 'claude' | 'gemini' | 'kimi' | 'codex'

  -- Account info
  name TEXT NOT NULL,  -- Display name
  auth_method TEXT NOT NULL,  -- 'cli' | 'api_key' | 'oauth'
  home_path TEXT,  -- For CLI accounts with custom home dirs

  -- Quotas
  daily_limit INTEGER,  -- NULL = unlimited
  monthly_limit INTEGER,
  tokens_used_today INTEGER DEFAULT 0,
  tokens_used_month INTEGER DEFAULT 0,

  -- Rate limiting
  requests_per_minute INTEGER,  -- NULL = no limit
  last_request_at TEXT,
  consecutive_failures INTEGER DEFAULT 0,

  -- Status
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'rate_limited' | 'disabled' | 'quota_exceeded'
  cooldown_until TEXT,  -- If rate limited

  -- Timestamps
  quota_reset_day INTEGER DEFAULT 1,  -- Day of month
  last_quota_reset TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_executor_accounts_executor ON executor_accounts(executor, status);
CREATE INDEX idx_executor_accounts_status ON executor_accounts(status);

-- Pre-populate Gemini CLI accounts
INSERT OR IGNORE INTO executor_accounts (id, executor, name, auth_method, home_path, daily_limit)
VALUES
  ('gemini-cli-1', 'gemini', 'Gemini CLI Account 1', 'cli', '~/.gemini-account1', 50),
  ('gemini-cli-2', 'gemini', 'Gemini CLI Account 2', 'cli', '~/.gemini-account2', 50),
  ('gemini-cli-3', 'gemini', 'Gemini CLI Account 3', 'cli', '~/.gemini-account3', 50),
  ('gemini-api', 'gemini', 'Gemini API', 'api_key', NULL, NULL),
  ('kimi-nvidia', 'kimi', 'Kimi via NVIDIA NIM', 'api_key', NULL, NULL),
  ('claude-api', 'claude', 'Claude API', 'api_key', NULL, NULL),
  ('codex', 'codex', 'OpenAI Codex', 'api_key', NULL, NULL);


-- ============================================
-- EXECUTOR COSTS: Track spending per executor
-- ============================================
-- Merged from 010_executor_routing.sql

CREATE TABLE executor_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  executor TEXT NOT NULL,
  executor_account TEXT,  -- FK to executor_accounts.id
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  date_key TEXT NOT NULL,  -- YYYY-MM-DD for daily aggregation
  job_id TEXT,             -- Optional link to scheduled job
  intent_id TEXT,          -- Optional link to intent
  run_id TEXT,             -- Optional link to run
  query_hash TEXT          -- SHA256 of query for deduplication tracking
);

CREATE INDEX idx_executor_costs_date ON executor_costs(date_key);
CREATE INDEX idx_executor_costs_executor ON executor_costs(executor, date_key);
CREATE INDEX idx_executor_costs_account ON executor_costs(executor_account, date_key);


-- ============================================
-- DAILY COST SUMMARY: Materialized aggregates
-- ============================================
-- Merged from 010_executor_routing.sql

CREATE TABLE daily_cost_summary (
  date_key TEXT PRIMARY KEY,
  gemini_cli_queries INTEGER DEFAULT 0,
  gemini_api_cost REAL DEFAULT 0,
  kimi_queries INTEGER DEFAULT 0,
  claude_cost REAL DEFAULT 0,
  codex_cost REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Trigger to update daily summary on cost insert
CREATE TRIGGER update_daily_cost_summary
AFTER INSERT ON executor_costs
BEGIN
  INSERT INTO daily_cost_summary (date_key, total_cost)
  VALUES (NEW.date_key, NEW.cost_usd)
  ON CONFLICT(date_key) DO UPDATE SET
    total_cost = total_cost + NEW.cost_usd,
    gemini_api_cost = CASE WHEN NEW.executor = 'gemini-api' THEN gemini_api_cost + NEW.cost_usd ELSE gemini_api_cost END,
    claude_cost = CASE WHEN NEW.executor IN ('claude', 'claude-api') THEN claude_cost + NEW.cost_usd ELSE claude_cost END,
    codex_cost = CASE WHEN NEW.executor = 'codex' THEN codex_cost + NEW.cost_usd ELSE codex_cost END,
    gemini_cli_queries = CASE WHEN NEW.executor = 'gemini-cli' THEN gemini_cli_queries + 1 ELSE gemini_cli_queries END,
    kimi_queries = CASE WHEN NEW.executor = 'kimi' THEN kimi_queries + 1 ELSE kimi_queries END,
    updated_at = strftime('%s', 'now') * 1000;
END;


-- ============================================
-- DEFERRED TASKS: Queue for non-urgent work
-- ============================================
-- Merged from 010_executor_routing.sql

CREATE TABLE deferred_tasks (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  context TEXT,
  task_type TEXT DEFAULT 'general',
  urgency TEXT DEFAULT 'batch',
  estimated_tokens INTEGER,
  cwd TEXT,
  model TEXT,
  intent_id TEXT,  -- Optional link to intent
  decision_json TEXT NOT NULL,      -- JSON of RoutingDecision
  created_at INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL,   -- When to attempt execution
  attempts INTEGER DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT,
  status TEXT DEFAULT 'pending',    -- pending, processing, completed, failed
  result_output TEXT,
  result_exit_code INTEGER,

  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE SET NULL
);

CREATE INDEX idx_deferred_tasks_status ON deferred_tasks(status, scheduled_for);
CREATE INDEX idx_deferred_tasks_scheduled ON deferred_tasks(scheduled_for) WHERE status = 'pending';


-- ============================================
-- APPROVAL HISTORY: Learn user patterns
-- ============================================
-- Records all approval decisions for pattern learning.

CREATE TABLE approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What was approved
  entity_type TEXT NOT NULL,  -- 'proposal' | 'intent' | 'run'
  entity_id TEXT NOT NULL,

  -- Decision
  decision TEXT NOT NULL,  -- 'approved' | 'rejected' | 'deferred' | 'modified'
  reason TEXT,

  -- Context for learning
  proposal_type TEXT,
  risk_level TEXT,
  source TEXT,
  relevance_score REAL,

  -- Who decided
  decided_by TEXT NOT NULL,  -- 'user' | 'auto:low_risk' | 'auto:trusted_source'

  -- Response time
  presented_at TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  response_time_ms INTEGER,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_approval_history_type ON approval_history(entity_type, decision);
CREATE INDEX idx_approval_history_source ON approval_history(source, decision);
CREATE INDEX idx_approval_history_decided ON approval_history(decided_at DESC);


-- ============================================
-- GOAL-INTENT LINKS: Many-to-many relationships
-- ============================================
-- An intent may serve multiple goals

CREATE TABLE goal_intent_links (
  goal_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  contribution_weight REAL DEFAULT 1.0,  -- How much this intent contributes to goal
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (goal_id, intent_id),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE
);


-- ============================================
-- DISCOVERY SOURCES: Track where ideas come from
-- ============================================
-- Maintains state for discovery jobs (last check, cursor, etc.)

CREATE TABLE discovery_sources (
  id TEXT PRIMARY KEY,  -- e.g., 'github-trending', 'hacker-news', 'arxiv'
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,  -- 'feed' | 'scrape' | 'api' | 'manual'

  -- Configuration
  config TEXT,  -- JSON object with source-specific settings

  -- State
  enabled INTEGER DEFAULT 1,
  last_checked_at TEXT,
  last_cursor TEXT,  -- For pagination/incremental fetch
  items_found_total INTEGER DEFAULT 0,
  proposals_created_total INTEGER DEFAULT 0,

  -- Schedule
  check_interval_minutes INTEGER DEFAULT 60,
  next_check_at TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_discovery_sources_next ON discovery_sources(next_check_at) WHERE enabled = 1;


-- ============================================
-- VIEWS: Convenience queries
-- ============================================

-- Pending proposals needing attention
CREATE VIEW v_pending_proposals AS
SELECT
  p.*,
  g.title as goal_title,
  (SELECT COUNT(*) FROM proposal_qa WHERE proposal_id = p.id AND answer IS NULL) as unanswered_questions
FROM proposals p
LEFT JOIN goals g ON p.goal_id = g.id
WHERE p.approval_status = 'pending'
ORDER BY p.relevance_score DESC, p.created_at ASC;


-- Ready-to-run intents
CREATE VIEW v_runnable_intents AS
SELECT
  i.*,
  g.title as goal_title,
  p.title as proposal_title,
  (SELECT COUNT(*) FROM runs WHERE intent_id = i.id AND status = 'running') as active_runs
FROM intents i
LEFT JOIN goals g ON i.goal_id = g.id
LEFT JOIN proposals p ON i.source_proposal_id = p.id
WHERE i.status = 'pending'
  AND (i.scheduled_for IS NULL OR i.scheduled_for <= datetime('now'))
ORDER BY i.priority DESC, i.created_at ASC;


-- Executor account health
CREATE VIEW v_executor_health AS
SELECT
  ea.*,
  CASE
    WHEN ea.daily_limit IS NOT NULL
    THEN ROUND(100.0 * ea.tokens_used_today / ea.daily_limit, 1)
    ELSE 0
  END as daily_usage_pct,
  (SELECT COUNT(*) FROM runs WHERE executor_account = ea.id AND status = 'running') as active_runs,
  (SELECT MAX(completed_at) FROM runs WHERE executor_account = ea.id) as last_run_completed
FROM executor_accounts ea;


-- Daily cost overview
CREATE VIEW v_daily_costs AS
SELECT
  date_key,
  gemini_cli_queries,
  gemini_api_cost,
  kimi_queries,
  claude_cost,
  codex_cost,
  total_cost,
  gemini_cli_queries * 0.0 + gemini_api_cost + claude_cost + codex_cost as paid_cost
FROM daily_cost_summary
ORDER BY date_key DESC;


-- ============================================
-- MIGRATE EXISTING DATA (run once)
-- ============================================

-- Migrate pending_plans to proposals
INSERT OR IGNORE INTO proposals (id, title, summary, stage, proposal_type, risk_level, content, source, approval_status, chat_id, created_at, updated_at)
SELECT
  'migrated_' || job_id,
  'Migrated Plan: ' || job_id,
  SUBSTR(plan, 1, 200),
  'plan',
  'improvement',
  'medium',
  plan,
  'migration',
  'pending',
  NULL,
  datetime(created_at / 1000, 'unixepoch'),
  datetime(created_at / 1000, 'unixepoch')
FROM pending_plans
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_plans');


-- Migrate idea_index to proposals (ideas)
INSERT OR IGNORE INTO proposals (id, title, summary, stage, proposal_type, risk_level, content, source, source_detail, approval_status, tags, created_at, updated_at)
SELECT
  'idea_' || id,
  title,
  SUBSTR(title, 1, 200),
  CASE status
    WHEN 'draft' THEN 'idea'
    WHEN 'review' THEN 'idea'
    WHEN 'researching' THEN 'research'
    WHEN 'planning' THEN 'plan'
    ELSE 'archived'
  END,
  'feature',
  'low',
  '(Content in file: ' || file_path || ')',
  COALESCE(source, 'migration'),
  source,
  CASE status
    WHEN 'archived' THEN 'rejected'
    ELSE 'pending'
  END,
  tags,
  COALESCE(created_at, CURRENT_TIMESTAMP),
  COALESCE(updated_at, CURRENT_TIMESTAMP)
FROM idea_index
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='idea_index');
