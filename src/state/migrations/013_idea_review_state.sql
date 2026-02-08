-- ============================================
-- IDEA REVIEW STATE
-- Migration 013: Track daily idea review count
-- ============================================

CREATE TABLE IF NOT EXISTS idea_review_state (
  date TEXT PRIMARY KEY,
  sent_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
