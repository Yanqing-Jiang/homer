-- Migration: 024_applications_updated_at.sql
-- Purpose: Add updated_at column to applications table for stalled-check and followup handlers.

ALTER TABLE applications ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));
UPDATE applications SET updated_at = applied_at WHERE updated_at IS NULL;
