-- 083: origin_channel — separate where each claim came from from how it was decided
-- decided_by tells you "user" / "auto-approve"; origin_channel tells you which pipeline
-- minted the candidate in the first place. Lets calibration analytics filter to
-- extractor-origin rows when measuring the model's confidence-vs-approval rate.

ALTER TABLE knowledge_claims ADD COLUMN origin_channel TEXT;

CREATE INDEX IF NOT EXISTS idx_kc_origin_channel ON knowledge_claims(origin_channel, status);

-- Backfill: best-effort labels for existing rows.
UPDATE knowledge_claims SET origin_channel = 'backfill'
  WHERE origin_channel IS NULL AND decided_by = 'backfill';

UPDATE knowledge_claims SET origin_channel = 'nightly-extractor'
  WHERE origin_channel IS NULL AND id LIKE 'kc_%' AND decided_by != 'backfill';

UPDATE knowledge_claims SET origin_channel = 'unknown'
  WHERE origin_channel IS NULL;
