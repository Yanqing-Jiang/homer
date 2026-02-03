-- ============================================
-- PROPOSAL COLUMNS EXTENSION
-- Migration 010: Add snooze_until and content_hash
-- ============================================
-- Adds columns for:
-- 1. snooze_until: Simple snooze mechanism (ISO timestamp)
-- 2. content_hash: SHA256 prefix for deduplication
-- ============================================

-- Add snooze_until column for snoozed proposals
-- When set, proposal is hidden until this timestamp passes
ALTER TABLE proposals ADD COLUMN snooze_until TEXT;

-- Add content_hash for deduplication
-- SHA256 hash of source URL (first 16 chars)
ALTER TABLE proposals ADD COLUMN content_hash TEXT;

-- Create unique index on content_hash for deduplication
-- Prevents inserting duplicate discoveries
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_hash ON proposals(content_hash);

-- Create index on snooze_until for efficient queries
CREATE INDEX IF NOT EXISTS idx_proposals_snooze ON proposals(snooze_until)
WHERE snooze_until IS NOT NULL;
