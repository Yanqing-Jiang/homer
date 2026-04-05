-- 074: Drop vestigial columns from knowledge_claims
-- valid_from: duplicates created_at (only DEFAULT-filled, never read)
-- valid_to: never written, never read
-- supersedes_claim_id: never written, never read
-- promoted_fact_hash: backfill artifact, replaced by content_hash

-- SQLite doesn't support DROP COLUMN before 3.35.0, and ALTER TABLE DROP
-- was added in 3.35.0 (2021-03-12). macOS ships 3.39+, so this is safe.
ALTER TABLE knowledge_claims DROP COLUMN valid_from;
ALTER TABLE knowledge_claims DROP COLUMN valid_to;
ALTER TABLE knowledge_claims DROP COLUMN supersedes_claim_id;
ALTER TABLE knowledge_claims DROP COLUMN promoted_fact_hash;
