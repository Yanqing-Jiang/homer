-- Add batch_position to preserve keyboard ordering within a Telegram message batch
ALTER TABLE knowledge_claims ADD COLUMN batch_position INTEGER;
