-- 098_cosmos_origin_device.sql
-- Provenance for cross-device Cosmos sync. NULL = locally authored on this device.
-- Non-NULL = imported from another device via the Cosmos pull; such rows MUST be
-- excluded from this device's push so we never re-publish foreign rows under our
-- own device_id (which would duplicate/corrupt the other device's Cosmos corpus).
ALTER TABLE knowledge_claims  ADD COLUMN origin_device TEXT;
ALTER TABLE memory_entries    ADD COLUMN origin_device TEXT;
ALTER TABLE session_summaries ADD COLUMN origin_device TEXT;

CREATE INDEX IF NOT EXISTS idx_kc_origin_device ON knowledge_claims(origin_device);
CREATE INDEX IF NOT EXISTS idx_me_origin_device ON memory_entries(origin_device);
CREATE INDEX IF NOT EXISTS idx_ss_origin_device ON session_summaries(origin_device);
