-- Migration 091: Drop unused claim resurfacing schema
--
-- Migration 087 introduced active-learning / resurfacing infrastructure
-- (ask_count, skip_count, last_surfaced_at, resurfacing_due_at, knowledge_claim_reviews)
-- but no scheduler job, MCP tool, or HITL surface ever used it.
--
-- Verified usage on 2026-05-01:
--   rg "resurfacing_due_at|ask_count|skip_count|last_surfaced_at|knowledge_claim_reviews"
--     ~/homer/src --glob '!**/087_claim_scoring_and_fts.sql'   →   no matches
--   sqlite> SELECT COUNT(*) FROM knowledge_claims WHERE resurfacing_due_at IS NOT NULL;  → 0
--   sqlite> SELECT SUM(ask_count), SUM(skip_count) FROM knowledge_claims;  → 0, 0
--   sqlite> SELECT COUNT(*) FROM knowledge_claim_reviews;  → 0
--
-- Per the consolidation-only refactor: drop dead schema rather than wire a
-- daemon for a feature that was never decided to ship. If active learning is
-- revived later, prefer extending an existing surface (e.g., memory_candidates)
-- rather than reintroducing a parallel column set.

-- Drop the index first; SQLite DROP COLUMN cannot remove an indexed column.
DROP INDEX IF EXISTS idx_kc_resurfacing;

-- Drop columns. SQLite 3.35+ supports ALTER TABLE ... DROP COLUMN.
ALTER TABLE knowledge_claims DROP COLUMN ask_count;
ALTER TABLE knowledge_claims DROP COLUMN skip_count;
ALTER TABLE knowledge_claims DROP COLUMN last_surfaced_at;
ALTER TABLE knowledge_claims DROP COLUMN resurfacing_due_at;

-- Drop the empty review-tracking table.
DROP TABLE IF EXISTS knowledge_claim_reviews;
