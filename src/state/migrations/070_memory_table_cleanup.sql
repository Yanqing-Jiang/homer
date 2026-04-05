-- 070: Memory table cleanup — kill empty tables, inline claim_sources
-- Part of the Karpathy LLM Wiki-inspired memory evolution refactor.

-- Inline claim_sources columns into knowledge_claims
ALTER TABLE knowledge_claims ADD COLUMN session_id TEXT;
ALTER TABLE knowledge_claims ADD COLUMN source_url TEXT;

-- Drop empty/dead tables
DROP TABLE IF EXISTS claim_events;
DROP TABLE IF EXISTS claim_sources;
DROP TABLE IF EXISTS knowledge_links;
DROP TABLE IF EXISTS discussion_artifacts;
DROP TABLE IF EXISTS discussion_summaries;
