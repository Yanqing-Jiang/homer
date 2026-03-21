-- Add fail_count to scrapes and link_inbox for retry-with-backoff.
-- Scrapes: synthesizer increments on LLM failure instead of marking processed.
-- Links: processor retries failed links up to max attempts.

ALTER TABLE scrapes ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_inbox ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
