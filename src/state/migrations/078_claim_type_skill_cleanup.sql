-- Migration 078: Add 'skill', 'cleanup', 'replace', 'remove' to claim_type CHECK constraint.
-- Required for HITL-gated skill extraction and cleanup staging.
--
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.

CREATE TABLE IF NOT EXISTS knowledge_claims_new (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  target_file TEXT NOT NULL,
  section TEXT,
  claim_type TEXT NOT NULL DEFAULT 'fact'
    CHECK(claim_type IN ('fact','decision','preference','hypothesis','insight','commitment','question','lesson','skill','cleanup','replace','remove')),
  confidence REAL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK(status IN ('candidate','applying','approved','rejected','expired','stale','archived')),
  review_at TEXT,
  telegram_message_id INTEGER,
  batch_position INTEGER,
  session_id TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT,
  updated_at TEXT
);

-- Copy existing data
INSERT OR IGNORE INTO knowledge_claims_new
  SELECT id, content, content_hash, target_file, section, claim_type, confidence,
         status, review_at, telegram_message_id, batch_position, session_id, source_url,
         created_at, decided_at, decided_by, updated_at
  FROM knowledge_claims;

-- Swap tables
DROP TABLE IF EXISTS knowledge_claims;
ALTER TABLE knowledge_claims_new RENAME TO knowledge_claims;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_kc_status ON knowledge_claims(status);
CREATE INDEX IF NOT EXISTS idx_kc_content_hash ON knowledge_claims(content_hash);
CREATE INDEX IF NOT EXISTS idx_kc_target_file ON knowledge_claims(target_file);
CREATE INDEX IF NOT EXISTS idx_kc_telegram_msg ON knowledge_claims(telegram_message_id);
