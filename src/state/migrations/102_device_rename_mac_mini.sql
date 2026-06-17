-- 102_device_rename_mac_mini.sql
--
-- Cosmos decommission follow-up (2026-06-16). origin_device was introduced
-- (migrations 098/099) as a cross-device provenance tag for Cosmos sync:
-- NULL = locally authored on this Mac mini, non-NULL = pulled from another
-- device. With Cosmos push/pull removed, the ONLY remaining foreign-row writer
-- is the work-laptop session dead-drop drain (origin_device='work-laptop').
-- Every other row — and every future locally-authored row in claims/entries/
-- transcripts — is this Mac mini's. Relabel NULL -> 'mac-mini' so this machine
-- is explicitly identified rather than implied by absence.
--
-- Idempotent: only touches rows still NULL.

UPDATE session_summaries   SET origin_device = 'mac-mini' WHERE origin_device IS NULL;
UPDATE knowledge_claims    SET origin_device = 'mac-mini' WHERE origin_device IS NULL;
UPDATE memory_entries      SET origin_device = 'mac-mini' WHERE origin_device IS NULL;
UPDATE session_transcripts SET origin_device = 'mac-mini' WHERE origin_device IS NULL;
