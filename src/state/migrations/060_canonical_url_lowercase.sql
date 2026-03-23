-- Migration 060: Ensure canonical_url and scrape URLs are consistently lowercased
-- Root cause: case-mismatched X/Twitter URLs caused UNIQUE constraint violations
-- blocking idea review and daily review jobs.

-- 1. Lowercase all existing canonical_urls in ideas
UPDATE ideas SET canonical_url = LOWER(canonical_url)
WHERE canonical_url IS NOT NULL AND canonical_url != LOWER(canonical_url);

-- 2. Lowercase all existing scrape URLs
UPDATE scrapes SET url = LOWER(url)
WHERE url IS NOT NULL AND url != LOWER(url);

-- 3. Lowercase all existing link_inbox URLs
UPDATE link_inbox SET url = LOWER(url)
WHERE url IS NOT NULL AND url != LOWER(url);

-- 4. Add CHECK constraint trigger for ideas.canonical_url
-- SQLite can't ALTER ADD CHECK, so we use a trigger
CREATE TRIGGER IF NOT EXISTS trg_ideas_canonical_lowercase
BEFORE INSERT ON ideas
WHEN NEW.canonical_url IS NOT NULL AND NEW.canonical_url != LOWER(NEW.canonical_url)
BEGIN
  SELECT RAISE(ABORT, 'canonical_url must be lowercase');
END;

CREATE TRIGGER IF NOT EXISTS trg_ideas_canonical_lowercase_update
BEFORE UPDATE OF canonical_url ON ideas
WHEN NEW.canonical_url IS NOT NULL AND NEW.canonical_url != LOWER(NEW.canonical_url)
BEGIN
  SELECT RAISE(ABORT, 'canonical_url must be lowercase');
END;
