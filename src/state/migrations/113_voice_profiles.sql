-- Persistent voice embeddings (voiceprints) for cross-meeting speaker identification.
CREATE TABLE IF NOT EXISTS voice_profiles (
  person_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  voiceprint TEXT NOT NULL,
  source_meeting_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_meeting_ids)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_profiles_display_name
  ON voice_profiles(display_name COLLATE NOCASE);
