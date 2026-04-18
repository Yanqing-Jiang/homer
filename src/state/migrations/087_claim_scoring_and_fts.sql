-- 087: Claim scoring + FTS — post-bridge-death memory infrastructure
--
-- After retiring context-bridge (2026-04-17), operational facts live only in
-- knowledge_claims (no more bridge-generated markdown). This migration:
--
--   1. Adds an FTS5 virtual table over claim content so memory_search +
--      memory_hybrid_search can retrieve approved DB-native claims (Step 6).
--   2. Adds scoring / temporal / HITL-review columns to knowledge_claims
--      (Step 9 — smallest viable active-learning schema).
--   3. Adds knowledge_claim_reviews for HITL action history.
--   4. Adds knowledge_claim_features for scorer feature logging.
--
-- Schema is deliberately additive. Callers that don't know about these fields
-- keep working. Morning/Sunday review sessions (parallel work) can wire them
-- in without further migrations.

-- ── 1. Scoring / temporal / HITL columns on knowledge_claims ──

-- Domain + canonical path (for retrieval routing and archive resolution)
ALTER TABLE knowledge_claims ADD COLUMN domain TEXT;
ALTER TABLE knowledge_claims ADD COLUMN canonical_path TEXT;

-- Event-date anchoring (valid_from/valid_to were dropped in 074, reintroducing
-- the minimal temporal set: event_date is sufficient for dated facts; if a future
-- job needs ranges, add valid_from/valid_to back at that time).
ALTER TABLE knowledge_claims ADD COLUMN event_date TEXT;  -- YYYY-MM-DD, for dated facts
ALTER TABLE knowledge_claims ADD COLUMN user_explicit INTEGER NOT NULL DEFAULT 0;

-- Scoring
ALTER TABLE knowledge_claims ADD COLUMN base_priority REAL NOT NULL DEFAULT 1.0;
ALTER TABLE knowledge_claims ADD COLUMN promote_score REAL;
ALTER TABLE knowledge_claims ADD COLUMN utility_score REAL;
ALTER TABLE knowledge_claims ADD COLUMN retrieval_weight REAL NOT NULL DEFAULT 1.0;

-- HITL review bookkeeping
ALTER TABLE knowledge_claims ADD COLUMN ask_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_claims ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_claims ADD COLUMN last_asked_at TEXT;
ALTER TABLE knowledge_claims ADD COLUMN last_surfaced_at TEXT;
ALTER TABLE knowledge_claims ADD COLUMN resurfacing_due_at TEXT;

-- Clustering (so Sunday batch can group by topic)
ALTER TABLE knowledge_claims ADD COLUMN cluster_key TEXT;

-- Archive bookkeeping
ALTER TABLE knowledge_claims ADD COLUMN archived_at TEXT;
ALTER TABLE knowledge_claims ADD COLUMN archived_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_kc_temporal_active
  ON knowledge_claims(status, event_date);
CREATE INDEX IF NOT EXISTS idx_kc_domain_status
  ON knowledge_claims(domain, status);
CREATE INDEX IF NOT EXISTS idx_kc_promote_score
  ON knowledge_claims(status, promote_score);
CREATE INDEX IF NOT EXISTS idx_kc_resurfacing
  ON knowledge_claims(status, resurfacing_due_at);
CREATE INDEX IF NOT EXISTS idx_kc_cluster
  ON knowledge_claims(cluster_key, status);

-- ── 2. Review action history (HITL feedback capture) ──

CREATE TABLE IF NOT EXISTS knowledge_claim_reviews (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  action TEXT NOT NULL
    CHECK(action IN ('promote','demote','archive','skip','edit','defer')),
  actor TEXT NOT NULL DEFAULT 'yanqing',
  surface TEXT NOT NULL
    CHECK(surface IN ('morning','sunday','manual','auto','telegram')),
  reason TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kcr_claim
  ON knowledge_claim_reviews(claim_id, created_at);
CREATE INDEX IF NOT EXISTS idx_kcr_action
  ON knowledge_claim_reviews(action, created_at);
CREATE INDEX IF NOT EXISTS idx_kcr_surface
  ON knowledge_claim_reviews(surface, created_at);

-- ── 3. Scorer feature store (one row per claim, mutable) ──

CREATE TABLE IF NOT EXISTS knowledge_claim_features (
  claim_id TEXT PRIMARY KEY REFERENCES knowledge_claims(id),
  extractor_confidence REAL,
  recency_hours REAL,
  novelty_score REAL,
  source_reliability REAL,
  strategic_weight REAL,
  similarity_to_approved REAL,
  user_affinity REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 4. FTS5 over claim content (so memory_search reaches DB-native facts) ──

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_claims_fts USING fts5(
  content,
  domain UNINDEXED,
  target_file UNINDEXED,
  section UNINDEXED,
  claim_type UNINDEXED,
  status UNINDEXED,
  claim_id UNINDEXED,
  content=''
);

-- Backfill FTS from existing approved claims
INSERT INTO knowledge_claims_fts (content, domain, target_file, section, claim_type, status, claim_id)
SELECT content, domain, target_file, section, claim_type, status, id
FROM knowledge_claims
WHERE status IN ('approved', 'candidate');

-- Keep FTS in sync with claim mutations
CREATE TRIGGER IF NOT EXISTS trg_kc_fts_ai
AFTER INSERT ON knowledge_claims
WHEN NEW.status IN ('approved', 'candidate')
BEGIN
  INSERT INTO knowledge_claims_fts (content, domain, target_file, section, claim_type, status, claim_id)
  VALUES (NEW.content, NEW.domain, NEW.target_file, NEW.section, NEW.claim_type, NEW.status, NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_kc_fts_ad
AFTER DELETE ON knowledge_claims
BEGIN
  DELETE FROM knowledge_claims_fts WHERE claim_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_kc_fts_au
AFTER UPDATE OF content, domain, target_file, section, claim_type, status ON knowledge_claims
BEGIN
  DELETE FROM knowledge_claims_fts WHERE claim_id = OLD.id;
  INSERT INTO knowledge_claims_fts (content, domain, target_file, section, claim_type, status, claim_id)
  SELECT NEW.content, NEW.domain, NEW.target_file, NEW.section, NEW.claim_type, NEW.status, NEW.id
  WHERE NEW.status IN ('approved', 'candidate');
END;
