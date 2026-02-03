-- Migration: Add scheduler job locking
-- Purpose: Prevent overlapping scheduled job runs
-- Date: 2026-01-31

-- Add is_running flag to prevent concurrent execution
ALTER TABLE scheduled_job_state ADD COLUMN is_running INTEGER DEFAULT 0;

-- Create index for efficient locking queries
CREATE INDEX IF NOT EXISTS idx_scheduled_job_running
  ON scheduled_job_state(job_id, is_running)
  WHERE is_running = 1;
