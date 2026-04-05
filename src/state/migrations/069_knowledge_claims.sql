-- 069: Knowledge Claims — human-gated memory evolution
-- Unified claim lifecycle: candidate → applying → approved / rejected / expired / superseded / stale / archived

CREATE TABLE IF NOT EXISTS knowledge_claims (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  target_file TEXT NOT NULL CHECK(target_file IN ('me','work','life','preferences','tools')),
  section TEXT,
  claim_type TEXT NOT NULL DEFAULT 'fact'
    CHECK(claim_type IN ('fact','decision','preference','hypothesis','insight','commitment','question','lesson')),
  confidence REAL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK(status IN ('candidate','applying','approved','rejected','expired','superseded','stale','archived')),
  review_at TEXT,
  valid_from TEXT DEFAULT (datetime('now')),
  valid_to TEXT,
  supersedes_claim_id TEXT REFERENCES knowledge_claims(id),
  promoted_fact_hash TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  decided_at TEXT,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_kc_status_created ON knowledge_claims(status, created_at);
CREATE INDEX IF NOT EXISTS idx_kc_type_status ON knowledge_claims(claim_type, status);
CREATE INDEX IF NOT EXISTS idx_kc_target_section ON knowledge_claims(target_file, section);
CREATE INDEX IF NOT EXISTS idx_kc_hash_target ON knowledge_claims(content_hash, target_file);
CREATE INDEX IF NOT EXISTS idx_kc_telegram ON knowledge_claims(telegram_message_id);

-- Provenance join table: links claims to source sessions and URLs
CREATE TABLE IF NOT EXISTS claim_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  session_id TEXT REFERENCES session_summaries(id),
  source_url TEXT,
  evidence_snippet TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cs_claim ON claim_sources(claim_id);
CREATE INDEX IF NOT EXISTS idx_cs_session ON claim_sources(session_id);

-- Event log: all lifecycle actions on claims
CREATE TABLE IF NOT EXISTS claim_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  event_type TEXT NOT NULL
    CHECK(event_type IN ('created','approved','rejected','edited','expired','lint_flagged','lint_resolved','reviewed','disputed')),
  actor TEXT NOT NULL DEFAULT 'system',
  content TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ce_claim ON claim_events(claim_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ce_type ON claim_events(event_type, created_at);

-- Backfill: existing promoted_facts → approved knowledge_claims
INSERT OR IGNORE INTO knowledge_claims (
  id, content, content_hash, target_file, section,
  claim_type, confidence, status, valid_from,
  promoted_fact_hash, created_at, decided_at, decided_by
)
SELECT
  'kc_bf_' || fact_hash,
  content,
  fact_hash,
  REPLACE(target_file, '.md', ''),
  section,
  'fact',
  1.0,
  'approved',
  promoted_at,
  fact_hash,
  promoted_at,
  'backfill'
FROM promoted_facts;
