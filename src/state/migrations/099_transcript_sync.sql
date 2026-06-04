-- 099_transcript_sync.sql
-- Make session_transcripts safe to sync bidirectionally to Cosmos DB.
--
-- Two distinct identities now live on this table:
--   content_hash  (existing PK) — a TRUNCATED/normalized "logical conversation
--                  fingerprint" (first N messages, lowercased). Good for joining
--                  to session_summaries and suppressing duplicate summary imports,
--                  but NOT a byte-exact transcript identity: two different sessions
--                  that share an opening can collide, and a parser change re-hashes.
--   transcript_hash (new) — sha256 of the canonical messages_json bytes. This is
--                  the true content address used as the Cosmos document id so the
--                  same transcript dedups globally and merges conflict-free.
-- Kept separate deliberately: content_hash must stay stable for summary joins.
--
-- origin_device mirrors migration 098: NULL = locally authored, non-NULL = pulled
-- from another device via Cosmos and therefore excluded from this device's push.
ALTER TABLE session_transcripts ADD COLUMN transcript_hash TEXT;
ALTER TABLE session_transcripts ADD COLUMN origin_device TEXT;

-- Non-unique on purpose: content_hash (PK) already prevents true duplicates, and a
-- UNIQUE index would fail the migration if two legacy rows ever normalized alike.
-- Backfill of existing rows is a one-time JS step (SQLite has no sha256).
CREATE INDEX IF NOT EXISTS idx_session_transcripts_thash  ON session_transcripts(transcript_hash);
CREATE INDEX IF NOT EXISTS idx_session_transcripts_origin ON session_transcripts(origin_device);
