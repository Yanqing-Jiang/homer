-- 088: Fix knowledge_claims FTS — use external-content FTS
--
-- Migration 087 created `knowledge_claims_fts` as a CONTENTLESS FTS table
-- (`content=''`) with manual delete/update triggers keyed by claim_id. That
-- was unsound in two ways:
--   1. Contentless FTS doesn't return the metadata columns when queried
--      (they come back empty), so the intended result mapping breaks.
--   2. The trigger `DELETE ... WHERE claim_id = OLD.id` doesn't actually
--      remove rows from a contentless FTS (verified on a DB backup — the
--      FTS rowcount stayed unchanged on claim deletes/updates). Stale rows
--      would accumulate over time.
--
-- Recreate as external-content FTS keyed to `knowledge_claims.rowid`. This
-- makes `knowledge_claims` the source of truth, lets MATCH results join back
-- via rowid, and gives standard reliable trigger maintenance.
--
-- Safe to run on live DB: the FTS table isn't queried by any code path yet
-- (Step 6 wiring is a follow-up), so dropping and recreating is a no-op for
-- readers and correctly rebuilds the search index.

DROP TRIGGER IF EXISTS trg_kc_fts_ai;
DROP TRIGGER IF EXISTS trg_kc_fts_ad;
DROP TRIGGER IF EXISTS trg_kc_fts_au;

DROP TABLE IF EXISTS knowledge_claims_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_claims_fts USING fts5(
  content,
  content='knowledge_claims',
  content_rowid='rowid'
);

-- Backfill from all existing claims (status filter happens at query time via JOIN)
INSERT INTO knowledge_claims_fts (rowid, content)
SELECT rowid, content FROM knowledge_claims;

-- Standard external-content sync triggers
CREATE TRIGGER IF NOT EXISTS trg_kc_fts_ai
AFTER INSERT ON knowledge_claims
BEGIN
  INSERT INTO knowledge_claims_fts (rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_kc_fts_ad
AFTER DELETE ON knowledge_claims
BEGIN
  INSERT INTO knowledge_claims_fts (knowledge_claims_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_kc_fts_au
AFTER UPDATE OF content ON knowledge_claims
BEGIN
  INSERT INTO knowledge_claims_fts (knowledge_claims_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
  INSERT INTO knowledge_claims_fts (rowid, content) VALUES (NEW.rowid, NEW.content);
END;
