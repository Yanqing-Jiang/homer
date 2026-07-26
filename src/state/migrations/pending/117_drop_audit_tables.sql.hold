-- ⛔ HELD — NOT REGISTERED, NOT APPLIED. Requires Yanqing's explicit go.
--
-- Phase 4 of the memory + ideas streamline: drop the four memory-audit tables
-- that backed the deleted HITL review feature (decision D4, approved
-- 2026-07-26). Supersedes the ownership guard in migration 112: those tables
-- were owned by homer-web `src/memory/canonical-audit.ts` + the
-- /api/review/canonical "Existing" tab, and that entire feature was deleted in
-- homer-web commit 3b1123a (ReviewTab.svelte + api/review.ts +
-- api/canonical-review.ts + canonical-audit.ts). Nothing reads these tables in
-- either repo any more — verified 2026-07-26 by grep across homer/src and
-- homer-web/src: only migration files 079/080/085/098/102/111/112 mention them.
--
-- Row counts at hold time (2026-07-26):
--   memory_entries                773
--   memory_entry_events            13
--   weekly_audit_sessions           4
--   weekly_audit_session_entries 1646
--
-- BEFORE APPLYING — archive the contents (same pattern as the 2026-07-06
-- archive that saved us when migration 111 dropped these by mistake):
--   sqlite3 ~/homer/data/homer.db \
--     ".dump memory_entries memory_entry_events weekly_audit_sessions weekly_audit_session_entries" \
--     > ~/homer/archive/memory-audit-tables-2026-07-26.sql
--
-- HOW TO APPLY (only after Yanqing confirms, and after the archive above):
--   mv src/state/migrations/pending/117_drop_audit_tables.sql.hold \
--      src/state/migrations/117_drop_audit_tables.sql
--   npm run migrate && npm run build && npm run restart
--
-- WHY THIS PATH CANNOT AUTO-APPLY (two independent guards):
--   1. Discovery is readdirSync(migrationsDir).filter(f => f.endsWith(".sql"))
--      — non-recursive, so the `pending/` subdirectory is never scanned, and
--      the entry `pending` itself fails the .sql suffix test.
--   2. The `.sql.hold` extension fails that same suffix test, and the build
--      step `cp src/state/migrations/*.sql dist/state/migrations/` does not
--      match it either. A daemon restart cannot pick this file up.
--
-- Replay note: on a fresh DB, migrations 111 (drop) → 112 (restore) → 117
-- (drop) run in order, so the end state is correct either way. No FTS tables
-- and no triggers reference these four; only the indexes below.
--
-- Drop order: indexes, then children before parents —
-- weekly_audit_session_entries references both weekly_audit_sessions and
-- memory_entries; memory_entry_events references memory_entries.

-- ── 1. Indexes ────────────────────────────────────────────────────────────
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

-- ── 2. Children before parents ────────────────────────────────────────────
DROP TABLE IF EXISTS weekly_audit_session_entries;
DROP TABLE IF EXISTS memory_entry_events;
DROP TABLE IF EXISTS weekly_audit_sessions;
DROP TABLE IF EXISTS memory_entries;
