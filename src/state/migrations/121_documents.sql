-- Uploaded-document store: the searchable home for every file that lands in
-- ~/homer-upload-landing, not just the .eml/.msg subset the old
-- upload-email-ingest helper handled.
--
-- Why a new table rather than `scrapes` (Codex review Q1,
-- output/codex/memory-pipeline-review-2026-08-07-1236.md):
--   * scrapes model UNTRUSTED EXTERNAL reading material — they carry a trust
--     fence, a non-solution demotion, a head cap, and a solutionCandidates
--     partition. A contract, a payslip or a work deck is FIRST-PARTY material
--     and must not inherit any of that.
--   * documents need lifecycle state (pending/ready/error/cold), an extraction
--     method+version so a future re-extraction can target old rows, and a retry
--     ledger. `scrapes` has content and loose metadata but no state at all.
--   * scrapes' UNIQUE(url) keeps exactly one filename/session per hash. The same
--     bytes uploaded twice under two names must keep BOTH aliases.
--   * scrape-specific retention (pruneOldScrapes deletes non-YouTube rows older
--     than 30 days) must never be able to erase a personal document.
--
-- id is content-addressed: 'doc_' || sha256(bytes). Re-uploading the same bytes
-- is an alias append, never a second row.
--
-- extracted_text is deliberately UNCAPPED. The 64 KB limit in the retired email
-- ingester was a local constant of that function, never a schema or SQLite
-- limit; applying it to PDFs/decks/spreadsheets would silently make the tail of
-- every long document unsearchable.

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  title         TEXT,
  mime_type     TEXT,
  size_bytes    INTEGER,
  extracted_text TEXT,
  summary       TEXT,
  hot_path      TEXT NOT NULL,
  archive_path  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','ready','error','cold')),
  -- JSON. Shape:
  --   { "extraction": { "method": "pdftotext", "version": "26.03.0",
  --                     "attempts": 1, "error": "…"?, "chars": 12345?,
  --                     "extractedAt": "2026-08-07T…" },
  --     "aliases": [ { "sessionId": "…", "filename": "…",
  --                    "uploadId": "…", "uploadedAt": "…" } ],
  --     "email": { … }?  -- header block for .eml/.msg rows
  --   }
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The worker drains by status; the backfill walker probes by path.
CREATE INDEX IF NOT EXISTS idx_documents_status  ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_hotpath ON documents(hot_path);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);

-- External-content FTS5, `porter unicode61` to match every other FTS table in
-- the schema (migration 120 brought scrapes/claims into line).
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, extracted_text, summary,
  content='documents', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, extracted_text, summary)
  VALUES (new.rowid, new.title, new.extracted_text, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, extracted_text, summary)
  VALUES ('delete', old.rowid, old.title, old.extracted_text, old.summary);
  INSERT INTO documents_fts(rowid, title, extracted_text, summary)
  VALUES (new.rowid, new.title, new.extracted_text, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, extracted_text, summary)
  VALUES ('delete', old.rowid, old.title, old.extracted_text, old.summary);
END;
