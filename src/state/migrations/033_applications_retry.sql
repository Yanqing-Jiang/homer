-- Add retry tracking columns to applications table

ALTER TABLE applications ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE applications ADD COLUMN next_retry_at DATETIME;
ALTER TABLE applications ADD COLUMN last_failure_code TEXT;
