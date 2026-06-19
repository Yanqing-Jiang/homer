-- 103_todo_fts.sql
-- Adds FTS5 search over canonical to-do rows for memory_search.
-- Index only title + notes; checklist JSON stays display/state data, not search text.

CREATE VIRTUAL TABLE IF NOT EXISTS todo_index_fts USING fts5(
  title, notes,
  content='todo_index', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Backfill existing rows (status/ranking filters happen at query time via JOIN).
INSERT INTO todo_index_fts(rowid, title, notes)
SELECT rowid, title, notes FROM todo_index;

CREATE TRIGGER IF NOT EXISTS todo_index_fts_ai
AFTER INSERT ON todo_index
BEGIN
  INSERT INTO todo_index_fts(rowid, title, notes)
  VALUES (NEW.rowid, NEW.title, NEW.notes);
END;

CREATE TRIGGER IF NOT EXISTS todo_index_fts_ad
AFTER DELETE ON todo_index
BEGIN
  INSERT INTO todo_index_fts(todo_index_fts, rowid, title, notes)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.notes);
END;

CREATE TRIGGER IF NOT EXISTS todo_index_fts_au
AFTER UPDATE OF title, notes ON todo_index
BEGIN
  INSERT INTO todo_index_fts(todo_index_fts, rowid, title, notes)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.notes);
  INSERT INTO todo_index_fts(rowid, title, notes)
  VALUES (NEW.rowid, NEW.title, NEW.notes);
END;
