-- Add account_id column to executor_session_map
-- Needed for multi-account CLI support (e.g., multiple Gemini accounts)

ALTER TABLE executor_session_map ADD COLUMN account_id INTEGER;
