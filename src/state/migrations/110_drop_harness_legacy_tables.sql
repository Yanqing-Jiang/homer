-- Drop migration-107 compatibility snapshots now that harness_selection is the
-- single writer and the compatibility views cover remaining reads.
DROP INDEX IF EXISTS idx_job_harness_override_updated_at;
DROP TABLE IF EXISTS harness_default_legacy_107;
DROP TABLE IF EXISTS job_harness_override_legacy_107;
