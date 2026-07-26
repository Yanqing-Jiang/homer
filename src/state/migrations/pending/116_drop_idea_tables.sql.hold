-- ⛔ HELD — NOT REGISTERED, NOT APPLIED. Requires Yanqing's explicit go.
--
-- Phase 3 of the memory + ideas streamline: drop the retired idea subsystem.
-- Everything in these tables is already archived in
--   memory_documents / id = 'retired-ideas-2026-07-26'
-- verified 2026-07-26 at 147 ideas / 15 discussions / 34 messages / 242 packets
-- / 350 packet_scrapes links, content_hash
-- cae3cc19a61c62c7625fea4820235ca483ef25aee2fe4ae643c446fbce576566.
--
-- HOW TO APPLY (only after Yanqing confirms the archive verification counts):
--   mv src/state/migrations/pending/116_drop_idea_tables.sql.hold \
--      src/state/migrations/116_drop_idea_tables.sql
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
-- Drop order matters: triggers first (the FTS triggers reference the FTS
-- tables, so dropping ideas_fts before its triggers would make DROP TABLE
-- ideas fail), then FTS shadow tables, then children before parents.

-- ── 1. Triggers (would fire against dropped FTS tables otherwise) ──────────
DROP TRIGGER IF EXISTS ideas_fts_ai;
DROP TRIGGER IF EXISTS ideas_fts_au;
DROP TRIGGER IF EXISTS ideas_fts_ad;
DROP TRIGGER IF EXISTS trg_ideas_canonical_lowercase;
DROP TRIGGER IF EXISTS trg_ideas_canonical_lowercase_update;
DROP TRIGGER IF EXISTS trg_source_packets_fts_insert;
DROP TRIGGER IF EXISTS trg_source_packets_fts_update;
DROP TRIGGER IF EXISTS trg_source_packets_fts_delete;

-- ── 2. FTS virtual tables (drops their _data/_idx/_docsize/_config shadows) ─
DROP TABLE IF EXISTS ideas_fts;
DROP TABLE IF EXISTS source_packets_fts;

-- ── 3. Children before parents ────────────────────────────────────────────
-- packet_scrapes REFERENCES source_packets(id); idea_discussions REFERENCES ideas(id).
DROP TABLE IF EXISTS packet_scrapes;
DROP TABLE IF EXISTS idea_discussion_messages;
DROP TABLE IF EXISTS idea_discussions;

-- ── 4. Parents + standalone state tables ──────────────────────────────────
DROP TABLE IF EXISTS ideas;
DROP TABLE IF EXISTS source_packets;
DROP TABLE IF EXISTS idea_review_state;
DROP TABLE IF EXISTS idea_sync_state;

-- DEBT: scrapes.idea_id / scrapes.source_packet_id and todo_index.source_idea_id
-- become dangling references (no FK constraints, so nothing breaks). Left in
-- place deliberately — removing them means a full table rebuild on the 1,600-row
-- scrapes table for zero functional gain. Upgrade when scrapes is next rebuilt
-- for another reason.
