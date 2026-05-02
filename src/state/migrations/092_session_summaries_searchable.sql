-- Migration 092: Gate noisy session summaries from retrieval.
--
-- Today every active session summary is embedded and surfaced by FTS,
-- including 1-message "Say hello" sessions, system-prompt scaffolding rows,
-- flush/checkpoint records, and meta sessions whose titles are
-- `<permissions instructions>` / `<local-command-caveat>` / `CRITICAL CONSTRAINTS:`.
-- These rows form a dense semantic gravity well that drowns real matches
-- (the Darshan failure on 2026-05-01 is the canonical example).
--
-- Strategy: keep all rows in the DB (auditability, memory_context still uses
-- existence), but mark them non-searchable. Indexer + MCP search both gate on
-- searchable=1 going forward.

ALTER TABLE session_summaries ADD COLUMN searchable INTEGER NOT NULL DEFAULT 1;

-- Backfill known noise patterns. Conservative — only patterns we've directly
-- observed polluting search. Title patterns first (cheaper, more specific),
-- then summary patterns for trivial 1-message sessions.

UPDATE session_summaries
SET searchable = 0
WHERE
  -- Greetings / one-word interactions
  (LOWER(TRIM(COALESCE(title, ''))) IN ('say hello', 'hello', 'hi', 'say hi'))
  OR (LOWER(COALESCE(title, '')) LIKE 'say hello%')
  OR (LOWER(COALESCE(title, '')) LIKE '"say hello%')
  -- System-prompt / harness scaffolding leaked into title
  OR (COALESCE(title, '') LIKE '<permissions%')
  OR (COALESCE(title, '') LIKE '<local-command-caveat%')
  OR (COALESCE(title, '') LIKE 'CRITICAL CONSTRAINTS%')
  OR (COALESCE(title, '') LIKE '"CRITICAL CONSTRAINTS%')
  -- One-line / no-content summaries
  OR (LENGTH(TRIM(COALESCE(summary, ''))) < 40)
  -- Flush / checkpoint daemon artifacts
  OR (LOWER(COALESCE(title, '')) LIKE '%flush%checkpoint%')
  OR (LOWER(COALESCE(title, '')) LIKE 'checkpoint%');

-- Optional partial index — most queries will filter searchable=1.
CREATE INDEX IF NOT EXISTS idx_session_summaries_searchable
  ON session_summaries(status, searchable);
