-- Migration 064: Structured plan review cards with revision history
-- Replaces raw text storage with structured plan data for Telegram card rendering

CREATE TABLE IF NOT EXISTS plan_reviews (
  id TEXT PRIMARY KEY,
  parent_plan_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  revision_number INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  source TEXT,
  chat_id INTEGER,
  card_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decision_feedback TEXT
);

CREATE INDEX IF NOT EXISTS idx_plan_reviews_status ON plan_reviews(status);
CREATE INDEX IF NOT EXISTS idx_plan_reviews_created ON plan_reviews(created_at DESC);

CREATE TABLE IF NOT EXISTS plan_revision_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  feedback_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_revision_feedback_plan ON plan_revision_feedback(plan_id);
