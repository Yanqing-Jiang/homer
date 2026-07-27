-- Tokenizer parity + claim-embedding residue.
--
-- (1) `scrapes_fts` and `knowledge_claims_fts` were created with the default
-- unicode61 tokenizer while every other FTS table in the schema (memory_fts,
-- session_summaries_fts, todo_index_fts, youtube_videos_fts, transcript_fts)
-- uses `porter unicode61`. Without the stemmer, `library` does not match
-- "libraries" and `embedding` does not match "embeddings" in exactly the two
-- corpora solution-seeking queries hit hardest. Both are external-content
-- tables, so the rebuild reads straight from the source rows; the AFTER
-- INSERT/UPDATE/DELETE triggers live on the base tables and survive the DROP.
-- `integrity-check` is the count verification: it fails the migration if the
-- rebuilt index does not match the content table row-for-row.
--
-- (2) generateEmbeddings deletes non-approved `claim:*` embeddings, but only
-- when the embeddings job runs, so 213 rows demoted by migration 119 kept
-- vector recall they are no longer entitled to. Claim status transitions now
-- drop the embedding inline (claims.ts dropClaimEmbedding); this clears the
-- backlog once.

DROP TABLE IF EXISTS scrapes_fts;
CREATE VIRTUAL TABLE scrapes_fts USING fts5(
  title, raw_content, author,
  content=scrapes, content_rowid=rowid,
  tokenize='porter unicode61'
);
INSERT INTO scrapes_fts(scrapes_fts) VALUES('rebuild');
INSERT INTO scrapes_fts(scrapes_fts) VALUES('integrity-check');

DROP TABLE IF EXISTS knowledge_claims_fts;
CREATE VIRTUAL TABLE knowledge_claims_fts USING fts5(
  content,
  content='knowledge_claims', content_rowid='rowid',
  tokenize='porter unicode61'
);
INSERT INTO knowledge_claims_fts(knowledge_claims_fts) VALUES('rebuild');
INSERT INTO knowledge_claims_fts(knowledge_claims_fts) VALUES('integrity-check');

DELETE FROM memory_embeddings
WHERE file_path LIKE 'claim:%'
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_claims kc
    WHERE memory_embeddings.file_path = 'claim:' || kc.id
      AND kc.status = 'approved'
  );
