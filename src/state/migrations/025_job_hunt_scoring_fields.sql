-- Migration: 025_job_hunt_scoring_fields.sql
-- Purpose: Add work_arrangement, application_type, rejection_reason to job_postings
-- for simplified scoring and auto-apply routing.

ALTER TABLE job_postings ADD COLUMN work_arrangement TEXT;
ALTER TABLE job_postings ADD COLUMN application_type TEXT;
ALTER TABLE job_postings ADD COLUMN rejection_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_job_work_arrangement ON job_postings(work_arrangement);
