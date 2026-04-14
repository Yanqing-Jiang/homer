-- 085_remove_life_context.sql
-- Purge all residue for the retired `life` memory file / context / lane.
--
-- Preconditions (must be done BEFORE this migration runs):
--   * knowledge_claims rows with target_file='life' have been re-homed.
--     The two voice-mode rows were moved to target_file='tools' (dated) and
--     target_file='me' (undated) on 2026-04-14. If any rows remain, this
--     migration FAILS LOUDLY via the guard below rather than silently remapping.
--
-- This migration is idempotent — safe to re-run.

-- 0. Fail-fast guard: knowledge_claims must be clean of target_file='life'.
--    We insert COUNT(*) into a temp table with CHECK(n = 0); nonzero trips
--    the CHECK and aborts the migration so nothing below runs on dirty state.
CREATE TEMP TABLE __life_guard (n INTEGER CHECK(n = 0));
INSERT INTO __life_guard (n)
  SELECT COUNT(*) FROM knowledge_claims WHERE target_file='life';
DROP TABLE __life_guard;

-- 1. Memory entries for life.md (10 rows expected 2026-04-14)
DELETE FROM memory_entries           WHERE file_key = 'life';
DELETE FROM weekly_audit_session_entries WHERE file_key = 'life';

-- 2. FTS residue (path-based)
DELETE FROM memory_fts WHERE file_path LIKE '%life.md%';

-- 3. Indexer bookkeeping (missing-core-file purge is daily-only in code)
DELETE FROM memory_index_meta WHERE file_path LIKE '%life.md%';
DELETE FROM memory_embeddings WHERE file_path LIKE '%life.md%';

-- 4. Scheduler / router lane residue
--    executor_sessions PK is `lane` itself — deleting abandons the Claude
--    session_id but removes the dead lane row.
DELETE FROM executor_sessions WHERE lane = 'life';

-- Other tables with `lane` columns: cli_runs, executor_session_map,
-- executor_state, intents, job_queue, lane_messages, pending_context,
-- sessions, swarm_handoffs. All verified 0 rows at 2026-04-14; defensively
-- clean them here so future data collected during the freeze is removed too.
DELETE FROM cli_runs              WHERE lane = 'life';
DELETE FROM executor_session_map  WHERE lane = 'life';
DELETE FROM executor_state        WHERE lane = 'life';
DELETE FROM intents               WHERE lane = 'life';
DELETE FROM job_queue             WHERE lane = 'life';
DELETE FROM lane_messages         WHERE lane = 'life';
DELETE FROM pending_context       WHERE lane = 'life';
DELETE FROM sessions              WHERE lane = 'life';
DELETE FROM swarm_handoffs        WHERE lane = 'life';

-- 5. Goals — GoalCategory 'life' (0 rows expected; safety net)
DELETE FROM goals WHERE category = 'life';
