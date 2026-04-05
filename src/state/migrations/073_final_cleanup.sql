-- 073: Final cleanup — drop deprecated promoted_facts table
-- Originally deferred 2 weeks from migration 071; knowledge_claims is now sole source of truth.
DROP TABLE IF EXISTS _promoted_facts_deprecated;
