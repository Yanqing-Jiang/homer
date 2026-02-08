import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import pg from "pg";

const { Client } = pg;

// Load .env
dotenvConfig({ path: resolve(import.meta.dirname, ".env") });

async function setup() {
  console.log("=== Setting up Supabase pgvector ===\n");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set in .env");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    console.log("Connected to Supabase PostgreSQL\n");

    // Execute each statement separately
    const statements = [
      // Extensions
      `CREATE EXTENSION IF NOT EXISTS vector`,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,

      // Table
      `CREATE TABLE IF NOT EXISTS memory_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_path TEXT NOT NULL,
        chunk_index INTEGER DEFAULT 0,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        context TEXT NOT NULL,
        embedding vector(1536),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(file_path, chunk_index)
      )`,

      // Indexes
      `CREATE INDEX IF NOT EXISTS idx_memory_docs_embedding
        ON memory_documents USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)`,

      `CREATE INDEX IF NOT EXISTS idx_memory_docs_content_trgm
        ON memory_documents USING gin (content gin_trgm_ops)`,

      `CREATE INDEX IF NOT EXISTS idx_memory_docs_file_path
        ON memory_documents (file_path)`,

      // Vector search function
      `CREATE OR REPLACE FUNCTION match_memory_documents(
        query_embedding vector(1536),
        match_threshold float DEFAULT 0.3,
        match_count int DEFAULT 10
      )
      RETURNS TABLE (
        id UUID,
        file_path TEXT,
        chunk_index INTEGER,
        content TEXT,
        context TEXT,
        similarity float
      )
      LANGUAGE plpgsql
      AS $func$
      BEGIN
        RETURN QUERY
        SELECT
          md.id,
          md.file_path,
          md.chunk_index,
          md.content,
          md.context,
          1 - (md.embedding <=> query_embedding) AS similarity
        FROM memory_documents md
        WHERE 1 - (md.embedding <=> query_embedding) > match_threshold
        ORDER BY md.embedding <=> query_embedding
        LIMIT match_count;
      END;
      $func$`,

      // Full-text search function
      `CREATE OR REPLACE FUNCTION search_memory_fulltext(
        search_query TEXT,
        match_count INT DEFAULT 10
      )
      RETURNS TABLE (
        id UUID,
        file_path TEXT,
        chunk_index INTEGER,
        content TEXT,
        context TEXT,
        rank float
      )
      LANGUAGE plpgsql
      AS $func$
      BEGIN
        RETURN QUERY
        SELECT
          md.id,
          md.file_path,
          md.chunk_index,
          md.content,
          md.context,
          ts_rank(to_tsvector('english', md.content), plainto_tsquery('english', search_query)) AS rank
        FROM memory_documents md
        WHERE to_tsvector('english', md.content) @@ plainto_tsquery('english', search_query)
        ORDER BY rank DESC
        LIMIT match_count;
      END;
      $func$`,
    ];

    for (const statement of statements) {
      try {
        await client.query(statement);
        const preview = statement.replace(/\s+/g, " ").slice(0, 50);
        console.log(`✅ ${preview}...`);
      } catch (error) {
        const err = error as Error;
        if (err.message.includes("already exists")) {
          const preview = statement.replace(/\s+/g, " ").slice(0, 50);
          console.log(`⏭️  ${preview}... (already exists)`);
        } else {
          console.error(`❌ Error: ${err.message}`);
          console.error(`   Statement preview: ${statement.slice(0, 80)}...`);
        }
      }
    }

    console.log("\n=== Setup complete ===");

    // Verify
    const result = await client.query(`
      SELECT COUNT(*) as count FROM memory_documents
    `);
    console.log(`\nTable 'memory_documents' exists with ${result.rows[0].count} rows`);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.end();
  }
}

setup().catch(console.error);
