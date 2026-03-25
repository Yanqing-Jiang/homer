-- Migration 061: Idea Pipeline Refactor — staged entity model
--
-- Introduces:
--   1. source_packets — first-class evidence objects (scrape clusters with full provenance)
--   2. idea_discussions — persistent conversation threads over packets/ideas
--   3. idea_discussion_messages — individual turns in a discussion
--   4. packet_scrapes — junction table linking packets to their source scrapes
--
-- Lifecycle: scrape → source_packet → discussion → idea → plan
-- Ideas are now only created on explicit user promotion.

-- ============================================
-- 1. Source Packets
-- ============================================

CREATE TABLE IF NOT EXISTS source_packets (
  id TEXT PRIMARY KEY,
  cluster_id TEXT,                         -- optional cluster grouping
  source_type TEXT NOT NULL DEFAULT 'x-bookmark',  -- x-bookmark, github-trending, medium, manual, etc.
  primary_url TEXT,
  title TEXT,
  summary TEXT,                            -- short preview for morning review
  raw_content TEXT,                        -- full untruncated original content
  deep_fetch_content TEXT,                 -- full deep-fetch results
  metadata TEXT,                           -- JSON: { author, external_urls, extracted_topics, deep_fetch_meta }
  enrichment TEXT,                         -- JSON: { deep_dive, deep_links, homer_improvement, candidate, critique }
  status TEXT NOT NULL DEFAULT 'raw',      -- raw | queued | review | approved | promoted | archived | discarded
  promoted_idea_id TEXT,                   -- FK to ideas.id when promoted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  promoted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_packets_status ON source_packets(status);
CREATE INDEX IF NOT EXISTS idx_source_packets_cluster ON source_packets(cluster_id);
CREATE INDEX IF NOT EXISTS idx_source_packets_created ON source_packets(created_at);
CREATE INDEX IF NOT EXISTS idx_source_packets_promoted_idea ON source_packets(promoted_idea_id);

-- FTS5 for source packets
CREATE VIRTUAL TABLE IF NOT EXISTS source_packets_fts USING fts5(
  title,
  summary,
  raw_content,
  content=source_packets,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS trg_source_packets_fts_insert
AFTER INSERT ON source_packets
BEGIN
  INSERT INTO source_packets_fts(rowid, title, summary, raw_content)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.raw_content);
END;

CREATE TRIGGER IF NOT EXISTS trg_source_packets_fts_update
AFTER UPDATE OF title, summary, raw_content ON source_packets
BEGIN
  INSERT INTO source_packets_fts(source_packets_fts, rowid, title, summary, raw_content)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.raw_content);
  INSERT INTO source_packets_fts(rowid, title, summary, raw_content)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.raw_content);
END;

CREATE TRIGGER IF NOT EXISTS trg_source_packets_fts_delete
AFTER DELETE ON source_packets
BEGIN
  INSERT INTO source_packets_fts(source_packets_fts, rowid, title, summary, raw_content)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.raw_content);
END;

-- ============================================
-- 2. Packet ↔ Scrape junction
-- ============================================

CREATE TABLE IF NOT EXISTS packet_scrapes (
  packet_id TEXT NOT NULL REFERENCES source_packets(id),
  scrape_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary',    -- primary | secondary | supporting
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (packet_id, scrape_id)
);

CREATE INDEX IF NOT EXISTS idx_packet_scrapes_scrape ON packet_scrapes(scrape_id);

-- ============================================
-- 3. Discussions
-- ============================================

CREATE TABLE IF NOT EXISTS idea_discussions (
  id TEXT PRIMARY KEY,
  packet_id TEXT REFERENCES source_packets(id),   -- discussion over a packet
  idea_id TEXT,                                     -- or over a promoted idea
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',            -- active | resolved | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_idea_discussions_packet ON idea_discussions(packet_id);
CREATE INDEX IF NOT EXISTS idx_idea_discussions_idea ON idea_discussions(idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_discussions_status ON idea_discussions(status);

-- ============================================
-- 4. Discussion Messages
-- ============================================

CREATE TABLE IF NOT EXISTS idea_discussion_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id TEXT NOT NULL REFERENCES idea_discussions(id),
  role TEXT NOT NULL DEFAULT 'user',                -- user | assistant | system
  content TEXT NOT NULL,
  metadata TEXT,                                     -- JSON: { model, tokens, tool_use, etc. }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discussion_messages_discussion ON idea_discussion_messages(discussion_id);

-- ============================================
-- 5. Add source_packet_id to ideas for promoted packets
-- ============================================

-- Link ideas back to their source packet
ALTER TABLE ideas ADD COLUMN source_packet_id TEXT;

-- ============================================
-- 6. Add source_packet_id to scrapes for pipeline tracking
-- ============================================

-- Track which packet a scrape was bundled into
ALTER TABLE scrapes ADD COLUMN source_packet_id TEXT;
