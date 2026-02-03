-- Meetings table for storing meeting recordings and transcripts
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  audio_path TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  speaker_mappings TEXT DEFAULT '[]',
  attendees TEXT DEFAULT '[]',
  confidence REAL,
  language TEXT,
  chat_id INTEGER NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Index for listing meetings by date
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date DESC);

-- Index for filtering by status
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

-- Index for chat notifications
CREATE INDEX IF NOT EXISTS idx_meetings_chat ON meetings(chat_id);

-- Meeting processing jobs queue
-- Using existing job_queue table with executor='meeting'
-- No additional table needed

-- Note: Meeting transcripts are stored as markdown files in ~/memory/meetings/
-- The SQLite table provides metadata and status tracking
