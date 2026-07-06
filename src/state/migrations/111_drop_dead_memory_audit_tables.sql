-- Drop orphaned canonical-memory audit tables after archiving their contents to
-- archive/dead-memory-tables-2026-07-06.sql.
DROP INDEX IF EXISTS idx_me_path_ordinal;
DROP INDEX IF EXISTS idx_me_file_active;
DROP INDEX IF EXISTS idx_me_hash;
DROP INDEX IF EXISTS idx_me_reviewed;
DROP INDEX IF EXISTS idx_me_origin_device;

DROP INDEX IF EXISTS idx_mee_entry;
DROP INDEX IF EXISTS idx_mee_type;

DROP INDEX IF EXISTS idx_was_status;
DROP INDEX IF EXISTS idx_was_week;
DROP INDEX IF EXISTS idx_was_status_created;

DROP INDEX IF EXISTS idx_wase_session_file;
DROP INDEX IF EXISTS idx_wase_entry;
DROP INDEX IF EXISTS idx_wase_status;
DROP INDEX IF EXISTS idx_wase_tg;
DROP INDEX IF EXISTS idx_wase_pending_order;

DROP TABLE IF EXISTS weekly_audit_session_entries;
DROP TABLE IF EXISTS memory_entry_events;
DROP TABLE IF EXISTS weekly_audit_sessions;
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS knowledge_claim_features;
