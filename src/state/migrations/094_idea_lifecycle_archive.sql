-- 094: idea lifecycle archive metadata
--
-- Adds soft-archive audit trail to ideas. Required by expireStaleIdeas() in
-- ideas/dedup.ts so the auto-expirer can record WHY a row was archived (e.g.,
-- `expired:70d`, `quality_decay:18`, `human_kill`) and WHEN, without polluting
-- updated_at semantics.
--
-- Non-destructive ALTER, existing rows get NULL. Migration runner is lenient
-- to "duplicate column name" if these were partially applied before.

ALTER TABLE ideas ADD COLUMN archived_at TEXT;
ALTER TABLE ideas ADD COLUMN archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_ideas_archive_reason
  ON ideas(archive_reason, archived_at);
