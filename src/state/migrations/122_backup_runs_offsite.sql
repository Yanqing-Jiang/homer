-- 122_backup_runs_offsite.sql
-- Offsite leg of the daily DB backup (Phase 4, codex memory-pipeline review 1.6).
--
-- backup_runs already is the audit trail for the local GFS backup. The offsite
-- copy is the same artifact taken one hop further (age-encrypted -> Azure Blob),
-- so it belongs on the same row rather than in a second table: one row per
-- backup run, carrying whether that run also made it off the machine.
--
-- Nullable on purpose — rows written before this migration, and runs where the
-- upload is skipped by the config guard, legitimately have no offsite state.

ALTER TABLE backup_runs ADD COLUMN offsite_status TEXT;
