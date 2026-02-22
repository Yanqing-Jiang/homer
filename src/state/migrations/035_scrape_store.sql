-- Scrape store: persistent raw content archive for all scraping pipelines.
-- Enables: provenance tracking, dedup, synthesizer input, FTS search.

CREATE TABLE scrapes (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT,
  title TEXT,
  author TEXT,
  raw_content TEXT NOT NULL,
  metadata TEXT,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  idea_id TEXT,
  quality_score REAL,
  UNIQUE(url)
);

CREATE INDEX idx_scrapes_source ON scrapes(source);
CREATE INDEX idx_scrapes_scraped_at ON scrapes(scraped_at);
CREATE INDEX idx_scrapes_processed ON scrapes(processed_at);

CREATE VIRTUAL TABLE scrapes_fts USING fts5(
  title, raw_content, author,
  content=scrapes, content_rowid=rowid
);

CREATE TRIGGER scrapes_fts_ai AFTER INSERT ON scrapes BEGIN
  INSERT INTO scrapes_fts(rowid, title, raw_content, author)
  VALUES (new.rowid, new.title, new.raw_content, new.author);
END;

CREATE TRIGGER scrapes_fts_au AFTER UPDATE ON scrapes BEGIN
  INSERT INTO scrapes_fts(scrapes_fts, rowid, title, raw_content, author)
  VALUES ('delete', old.rowid, old.title, old.raw_content, old.author);
  INSERT INTO scrapes_fts(rowid, title, raw_content, author)
  VALUES (new.rowid, new.title, new.raw_content, new.author);
END;

CREATE TRIGGER scrapes_fts_ad AFTER DELETE ON scrapes BEGIN
  INSERT INTO scrapes_fts(scrapes_fts, rowid, title, raw_content, author)
  VALUES ('delete', old.rowid, old.title, old.raw_content, old.author);
END;
