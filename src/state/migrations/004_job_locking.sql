-- Migration: Add job locking and heartbeat tracking
-- Purpose: Enable atomic job claiming and stale job recovery
-- Date: 2026-01-31

-- Add job locking columns
ALTER TABLE job_queue ADD COLUMN locked_by TEXT DEFAULT NULL;
ALTER TABLE job_queue ADD COLUMN locked_at INTEGER DEFAULT NULL;
ALTER TABLE job_queue ADD COLUMN heartbeat_at INTEGER DEFAULT NULL;

-- Create index for stale job queries
-- (status, heartbeat_at) for finding stale running jobs
CREATE INDEX IF NOT EXISTS idx_queue_stale
  ON job_queue(status, heartbeat_at)
  WHERE status = 'running';

-- Create index for lock cleanup
-- (locked_by) for finding jobs locked by a specific worker
CREATE INDEX IF NOT EXISTS idx_queue_locked_by
  ON job_queue(locked_by)
  WHERE locked_by IS NOT NULL;

-- Migrate existing running jobs to failed state
-- (Clean slate on migration - assume any running jobs are stale)
UPDATE job_queue
SET
  status = 'failed',
  error = 'Daemon restarted during job execution (migration cleanup)',
  completed_at = strftime('%s', 'now') * 1000
WHERE status = 'running';
