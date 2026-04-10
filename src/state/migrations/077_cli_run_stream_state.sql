ALTER TABLE cli_runs ADD COLUMN stream_text TEXT;
ALTER TABLE cli_runs ADD COLUMN stream_phase TEXT;
ALTER TABLE cli_runs ADD COLUMN stream_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cli_runs ADD COLUMN stream_updated_at INTEGER;
