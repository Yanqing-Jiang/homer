-- Migration 043: Fix duplicate FTS triggers on youtube_videos
-- Migration 037 created triggers named youtube_videos_fts_ai/au/ad.
-- Migration 040 intended to replace them but only dropped youtube_videos_ai/au/ad
-- (which didn't exist yet), leaving the old 037 triggers active alongside new ones.
-- This caused duplicate FTS index entries on every insert/update/delete.

-- Drop the old 037-era triggers
DROP TRIGGER IF EXISTS youtube_videos_fts_ai;
DROP TRIGGER IF EXISTS youtube_videos_fts_au;
DROP TRIGGER IF EXISTS youtube_videos_fts_ad;

-- Rebuild FTS index to fix any duplicate/stale entries
INSERT INTO youtube_videos_fts(youtube_videos_fts) VALUES('rebuild');
