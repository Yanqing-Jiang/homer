-- 071: Deprecate promoted_facts — subsumed by knowledge_claims
-- Rename to _deprecated so it's still recoverable. Drop in migration 073 after 2 weeks.
ALTER TABLE promoted_facts RENAME TO _promoted_facts_deprecated;
