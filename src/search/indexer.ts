import { createClient } from "@supabase/supabase-js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";
import type { SearchConfig, MemoryDocument } from "./types.js";
import { chunkText } from "./chunker.js";
import { generateEmbeddings } from "./embeddings.js";

/**
 * Memory files to index
 */
const MEMORY_FILES = [
  { path: "/Users/yj/memory/user.md", context: "global" },
  { path: "/Users/yj/memory/facts.md", context: "global" },
  { path: "/Users/yj/memory/preferences.md", context: "global" },
  { path: "/Users/yj/work/memory.md", context: "work" },
  { path: "/Users/yj/life/memory.md", context: "life" },
];

/**
 * Hash content for change detection
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Index memory files into Supabase
 */
export async function indexMemoryFiles(config: SearchConfig): Promise<{
  indexed: number;
  skipped: number;
  errors: number;
}> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error("Supabase not configured");
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  for (const { path, context } of MEMORY_FILES) {
    if (!existsSync(path)) {
      logger.debug({ path }, "Memory file does not exist, skipping");
      skipped++;
      continue;
    }

    try {
      const content = await readFile(path, "utf-8");
      const contentHash = hashContent(content);

      // Check if already indexed with same hash
      const { data: existing } = await supabase
        .from("memory_documents")
        .select("content_hash")
        .eq("file_path", path)
        .eq("chunk_index", 0)
        .single();

      if (existing?.content_hash === contentHash) {
        logger.debug({ path }, "File unchanged, skipping");
        skipped++;
        continue;
      }

      // Delete existing chunks for this file
      await supabase.from("memory_documents").delete().eq("file_path", path);

      // Chunk the content
      const chunks = chunkText(content, config.chunkSize, config.chunkOverlap);

      if (chunks.length === 0) {
        logger.debug({ path }, "No chunks generated, skipping");
        skipped++;
        continue;
      }

      // Generate embeddings for all chunks
      const embeddings = await generateEmbeddings(
        chunks.map((c) => c.content),
        config.openaiApiKey,
        config.embeddingModel
      );

      // Prepare documents
      const documents: MemoryDocument[] = chunks.map((chunk, i) => ({
        filePath: path,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentHash: i === 0 ? contentHash : hashContent(chunk.content),
        context,
        embedding: embeddings[i],
      }));

      // Insert into Supabase
      const { error } = await supabase.from("memory_documents").insert(
        documents.map((d) => ({
          file_path: d.filePath,
          chunk_index: d.chunkIndex,
          content: d.content,
          content_hash: d.contentHash,
          context: d.context,
          embedding: d.embedding,
        }))
      );

      if (error) {
        logger.error({ error, path }, "Failed to insert documents");
        errors++;
        continue;
      }

      logger.info({ path, chunks: chunks.length }, "Indexed memory file");
      indexed++;
    } catch (error) {
      logger.error({ error, path }, "Failed to index file");
      errors++;
    }
  }

  return { indexed, skipped, errors };
}

/**
 * Get indexing status
 */
export async function getIndexStatus(config: SearchConfig): Promise<{
  totalDocuments: number;
  fileStats: Array<{ filePath: string; chunks: number; lastIndexed: string }>;
}> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return { totalDocuments: 0, fileStats: [] };
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  const { data, error } = await supabase
    .from("memory_documents")
    .select("file_path, chunk_index, created_at")
    .order("file_path");

  if (error) {
    logger.error({ error }, "Failed to get index status");
    return { totalDocuments: 0, fileStats: [] };
  }

  const stats = new Map<string, { chunks: number; lastIndexed: string }>();

  for (const row of data || []) {
    const existing = stats.get(row.file_path);
    if (!existing) {
      stats.set(row.file_path, {
        chunks: 1,
        lastIndexed: row.created_at,
      });
    } else {
      existing.chunks++;
      if (row.created_at > existing.lastIndexed) {
        existing.lastIndexed = row.created_at;
      }
    }
  }

  return {
    totalDocuments: data?.length || 0,
    fileStats: Array.from(stats.entries()).map(([filePath, stat]) => ({
      filePath,
      ...stat,
    })),
  };
}
