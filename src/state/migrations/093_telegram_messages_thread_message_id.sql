-- 093: backfill thread_message_id column on telegram_messages
--
-- Migration 090 declared `thread_message_id TEXT` inside a
-- `CREATE TABLE IF NOT EXISTS telegram_messages (...)` block. On the production
-- DB the table already existed (created by an earlier draft of 090 without the
-- column), so the CREATE was a no-op and the column was never added. The
-- migration was still marked applied, so the runner won't retry 090.
--
-- Result: every call to StateManager.recordTelegramMessage logs
--   SqliteError: table telegram_messages has no column named thread_message_id
-- and reply-thread metadata is silently dropped (insert is wrapped in catch).
--
-- Fix: add the missing column. Non-destructive ALTER, existing rows get NULL,
-- which matches the `row.threadMessageId ?? null` insert path.

ALTER TABLE telegram_messages ADD COLUMN thread_message_id TEXT;
