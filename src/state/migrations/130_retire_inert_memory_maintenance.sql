-- 130: Retire weekly-maintenance rows created by the removed cleanup/lint paths.
--
-- The weekly cleanup producer created replace/remove candidates with
-- user_explicit=0, but approveCandidate correctly refuses those rows and no
-- review surface can approve an existing claim by id. The unmatched lint
-- fallback stored stale canonical text as low-confidence facts. Both shapes
-- pollute passive recall without being actionable.
--
-- The live Mac-mini rows were exported before this migration to:
-- output/codex/weekly-memory-remediation-snapshot-2026-08-23.json

UPDATE knowledge_claims
SET status = 'archived',
    archived_at = datetime('now'),
    archived_reason = 'retired-inert-weekly-cleanup-2026-08-23',
    updated_at = datetime('now')
WHERE status = 'candidate'
  AND section = 'cleanup'
  AND claim_type IN ('replace', 'remove');

UPDATE knowledge_claims
SET status = 'archived',
    archived_at = datetime('now'),
    archived_reason = 'retired-synthetic-weekly-lint-2026-08-23',
    updated_at = datetime('now')
WHERE status = 'candidate'
  AND origin_channel IS NULL
  AND section IS NULL
  AND claim_type = 'fact'
  AND confidence = 0.5
  AND COALESCE(user_explicit, 0) = 0;

UPDATE knowledge_claims
SET status = 'archived',
    archived_at = datetime('now'),
    archived_reason = 'retired-legacy-stale-status-2026-08-23',
    updated_at = datetime('now')
WHERE status = 'stale';

DELETE FROM memory_embeddings
WHERE file_path LIKE 'claim:%'
  AND EXISTS (
    SELECT 1
    FROM knowledge_claims kc
    WHERE memory_embeddings.file_path = 'claim:' || kc.id
      AND kc.status = 'archived'
      AND kc.archived_reason IN (
        'retired-inert-weekly-cleanup-2026-08-23',
        'retired-synthetic-weekly-lint-2026-08-23',
        'retired-legacy-stale-status-2026-08-23'
      )
  );
