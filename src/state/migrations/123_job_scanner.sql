-- Migration: 123_job_scanner.sql
-- Purpose: Fresh tables for the job-scanner subsystem (discover → verify →
--          filter → rank → email digest). Independent of the retired job-hunt
--          schema (022/024/025/033) — no auto-apply, no approval queue.

CREATE TABLE IF NOT EXISTS job_scan_postings (
  id               TEXT PRIMARY KEY,          -- source posting id (e.g. hiring.cafe objectID)
  discovery_source TEXT NOT NULL,             -- hiring_cafe | linkedin_alert | ...
  ats_source       TEXT,                      -- grnhse | lever | ashby | smartrecruiters | workday | ...
  board_token      TEXT,
  requisition_id   TEXT,
  external_id      TEXT,                      -- ATS-side job id (last segment of source id)
  title            TEXT NOT NULL,
  company          TEXT NOT NULL,
  apply_url        TEXT,
  location         TEXT,
  workplace_type   TEXT,                      -- Remote | Hybrid | Onsite | Field
  role_type        TEXT,                      -- People Manager | Individual Contributor
  seniority        TEXT,
  category         TEXT,                      -- taxonomy family key
  category_weight  REAL,
  yearly_min_comp  INTEGER,
  yearly_max_comp  INTEGER,
  comp_transparent INTEGER DEFAULT 0,
  publish_date     TEXT,                      -- source-claimed publish date (not trusted for ranking)
  first_seen_at    TEXT DEFAULT (datetime('now')),
  last_seen_at     TEXT DEFAULT (datetime('now')),
  fingerprint      TEXT,
  repost_count     INTEGER DEFAULT 0,
  status           TEXT DEFAULT 'new',        -- new | filtered_out | scored | emailed | expired
  filter_reason    TEXT,
  ats_verified_at  TEXT,
  ats_live         INTEGER,                   -- 1 = confirmed on employer feed, 0 = confirmed gone, NULL = unchecked
  verify_method    TEXT,                      -- feed | url_probe | none
  fit_score        REAL,                      -- LLM fit 0-10
  fit_rationale    TEXT,
  rank_score       REAL,                      -- composite 0-100
  emailed_at       TEXT,
  raw_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_jsp_status ON job_scan_postings(status);
CREATE INDEX IF NOT EXISTS idx_jsp_fingerprint ON job_scan_postings(fingerprint);
CREATE INDEX IF NOT EXISTS idx_jsp_company ON job_scan_postings(company);
CREATE INDEX IF NOT EXISTS idx_jsp_first_seen ON job_scan_postings(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_jsp_rank ON job_scan_postings(rank_score DESC);

-- Repost / ghost-job fingerprint history: one row per normalized
-- company|title|state; times_seen counts DISTINCT posting ids that shared it.
CREATE TABLE IF NOT EXISTS job_scan_fingerprints (
  fingerprint   TEXT PRIMARY KEY,
  company       TEXT,
  title         TEXT,
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_seen_at  TEXT DEFAULT (datetime('now')),
  times_seen    INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS job_scan_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at        TEXT DEFAULT (datetime('now')),
  discovered    INTEGER DEFAULT 0,
  new_jobs      INTEGER DEFAULT 0,
  rules_passed  INTEGER DEFAULT 0,
  verified_live INTEGER DEFAULT 0,
  scored        INTEGER DEFAULT 0,
  emailed       INTEGER DEFAULT 0,
  email_status  TEXT,
  errors        TEXT,
  duration_ms   INTEGER
);

CREATE TABLE IF NOT EXISTS job_scan_emails (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at          TEXT DEFAULT (datetime('now')),
  recipient        TEXT,
  subject          TEXT,
  job_ids          TEXT,                      -- JSON array of posting ids included
  gmail_message_id TEXT,
  status           TEXT                       -- sent | failed:<reason>
);
