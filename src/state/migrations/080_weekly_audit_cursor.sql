-- Migration 080: Stable cursor + composite indexes for the weekly memory audit.
--
-- Context: migration 079 stored `resume_entry_ordinal` as an offset into the
-- filtered pending list. As entries resolve, that list shrinks and reorders
-- under the saved offset, so `Next page` could skip pending entries (or land
-- on empty). Switch to an anchor pair (staleness_score, ordinal_in_file) that
-- identifies the last rendered entry; next-page queries fetch rows strictly
-- after the anchor in the fixed (staleness DESC, ordinal ASC) order.

ALTER TABLE weekly_audit_sessions ADD COLUMN resume_anchor_staleness REAL;
ALTER TABLE weekly_audit_sessions ADD COLUMN resume_anchor_ordinal INTEGER;

-- Query-plan coverage noted by Codex completeness review:
--   findResumableSession scans on (status IN (...), ORDER BY created_at DESC)
--   getSessionFileEntriesAfter scans on
--     (session_id, file_path, status, staleness_score DESC, ordinal_in_file ASC)
CREATE INDEX IF NOT EXISTS idx_was_status_created
  ON weekly_audit_sessions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wase_pending_order
  ON weekly_audit_session_entries(session_id, file_path, status, staleness_score DESC, ordinal_in_file ASC);
