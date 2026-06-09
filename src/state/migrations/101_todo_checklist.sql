-- 101_todo_checklist.sql
-- Adds optional subtask checklists to to-dos.
--
-- Stored as a JSON array of {id, text, done} on the canonical todo_index row
-- (array order = display order; reorder is intentionally not a feature).
-- Chosen over a child table: subtasks are read/written whole with their parent,
-- never queried per-item, so one additive column keeps the existing single-row
-- read/write path and avoids a join + new DAO surface. Matches the v1 ethos of
-- 095_todos.sql (notes-in-body, no FTS until evidence demands it).
--
-- Additive: legacy rows default to '[]'. The progress badge and auto-complete
-- rule treat an empty array as "no checklist" (never auto-completes). Note: raw
-- ADD COLUMN is NOT SQL-idempotent; re-run safety comes from the migration runner,
-- which tracks applied filenames and tolerates duplicate-column errors.

ALTER TABLE todo_index ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]';
