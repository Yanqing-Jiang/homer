-- Migration: 022_job_hunt_lifecycle.sql
-- Purpose: Add application lifecycle, credential management, step tracking,
--          approval queue, and password recovery to job hunt system.

-- 1. Career Accounts (credential storage for career portals)
CREATE TABLE IF NOT EXISTS career_accounts (
  id                  TEXT PRIMARY KEY,
  company             TEXT NOT NULL,
  login_url           TEXT NOT NULL,
  username            TEXT,
  password_encrypted  TEXT,
  encryption_key_id   TEXT,
  auth_method         TEXT DEFAULT 'password',
  cookies             TEXT,
  cookies_expires_at  TEXT,
  mfa_method          TEXT DEFAULT 'none',
  last_login          TEXT,
  account_status      TEXT DEFAULT 'active',
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  notes               TEXT,
  UNIQUE(company, login_url)
);

CREATE INDEX IF NOT EXISTS idx_career_acct_company ON career_accounts(company);
CREATE INDEX IF NOT EXISTS idx_career_acct_status ON career_accounts(account_status);

-- 2. Application Steps (audit trail for each agent action)
CREATE TABLE IF NOT EXISTS application_steps (
  id                    TEXT PRIMARY KEY,
  application_id        TEXT NOT NULL REFERENCES applications(id),
  account_id            TEXT REFERENCES career_accounts(id),
  step_number           INTEGER NOT NULL,
  step_type             TEXT NOT NULL,
  step_status           TEXT DEFAULT 'pending',
  started_at            TEXT,
  completed_at          TEXT,
  duration_ms           INTEGER,
  page_url              TEXT,
  screenshot_path       TEXT,
  form_data_submitted   TEXT,
  response_received     TEXT,
  error_message         TEXT,
  error_screenshot_path TEXT,
  retry_count           INTEGER DEFAULT 0,
  max_retries           INTEGER DEFAULT 3,
  parent_step_id        TEXT REFERENCES application_steps(id),
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_step_application ON application_steps(application_id);
CREATE INDEX IF NOT EXISTS idx_step_type ON application_steps(step_type);
CREATE INDEX IF NOT EXISTS idx_step_status ON application_steps(step_status);
CREATE INDEX IF NOT EXISTS idx_step_app_order ON application_steps(application_id, step_number);

-- 3. Approval Queue (Telegram-integrated job approval flow)
CREATE TABLE IF NOT EXISTS approval_queue (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL REFERENCES job_postings(id),
  match_score           REAL,
  match_summary         TEXT,
  salary_range          TEXT,
  queued_at             TEXT DEFAULT (datetime('now')),
  telegram_message_id   INTEGER,
  telegram_chat_id      INTEGER,
  decision              TEXT DEFAULT 'pending',
  decided_at            TEXT,
  decision_reason       TEXT,
  auto_expired          INTEGER DEFAULT 0,
  expiry_hours          INTEGER DEFAULT 72,
  priority_rank         INTEGER,
  batch_id              TEXT,
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_job ON approval_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_approval_decision ON approval_queue(decision);
CREATE INDEX IF NOT EXISTS idx_approval_pending ON approval_queue(decision, queued_at)
  WHERE decision = 'pending';
CREATE INDEX IF NOT EXISTS idx_approval_telegram ON approval_queue(telegram_message_id);

-- 4. Password Recovery Log
CREATE TABLE IF NOT EXISTS password_recovery_log (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES career_accounts(id),
  application_id        TEXT REFERENCES applications(id),
  recovery_method       TEXT NOT NULL,
  recovery_url          TEXT,
  gmail_message_id      TEXT,
  gmail_thread_id       TEXT,
  new_password_encrypted TEXT,
  encryption_key_id     TEXT,
  recovery_status       TEXT DEFAULT 'initiated',
  initiated_at          TEXT DEFAULT (datetime('now')),
  completed_at          TEXT,
  error_message         TEXT,
  retry_count           INTEGER DEFAULT 0,
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_account ON password_recovery_log(account_id);
CREATE INDEX IF NOT EXISTS idx_recovery_status ON password_recovery_log(recovery_status);

-- 5. ALTER existing tables — add new columns
ALTER TABLE applications ADD COLUMN account_id TEXT REFERENCES career_accounts(id);
ALTER TABLE applications ADD COLUMN confirmation_number TEXT;
ALTER TABLE applications ADD COLUMN confirmation_screenshot TEXT;
ALTER TABLE applications ADD COLUMN application_url TEXT;
ALTER TABLE applications ADD COLUMN portal_status TEXT;
ALTER TABLE applications ADD COLUMN last_portal_check TEXT;
ALTER TABLE applications ADD COLUMN phone_screen_at TEXT;
ALTER TABLE applications ADD COLUMN onsite_at TEXT;
ALTER TABLE applications ADD COLUMN offer_amount TEXT;
ALTER TABLE applications ADD COLUMN rejection_reason TEXT;
ALTER TABLE applications ADD COLUMN withdrawn_reason TEXT;

ALTER TABLE job_postings ADD COLUMN approval_id TEXT REFERENCES approval_queue(id);

-- 6. Additional indexes
CREATE INDEX IF NOT EXISTS idx_app_account ON applications(account_id);
CREATE INDEX IF NOT EXISTS idx_job_approval ON job_postings(approval_id);
