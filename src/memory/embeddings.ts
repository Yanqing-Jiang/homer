/**
 * Memory Embeddings Module
 *
 * Uses Google Gemini embedding-001 for semantic search.
 * Default dimensions: 3072 (model native, truncate to 768 for storage with MRL)
 */

import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import { logger } from "../utils/logger.js";

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not set in environment");
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

export interface EmbeddingResult {
  embedding: Float32Array;
  dimensions: number;
  model: string;
}

/**
 * Generate embedding for text using Gemini embedding-001
 * Uses MRL: truncates 3072-dim output to 768 for storage efficiency
 *
 * @param text - Text to embed (max 2048 tokens)
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: "gemini-embedding-001" });

  try {
    const result = await model.embedContent({
      content: { parts: [{ text }], role: "user" },
      taskType: TaskType.RETRIEVAL_DOCUMENT,
    });

    const fullValues = result.embedding.values;
    // Truncate to 768 dims using MRL property (first N dims are valid prefix)
    const truncatedValues = fullValues.slice(0, 768);

    logger.debug(
      { textLength: text.length, fullDims: fullValues.length, storedDims: truncatedValues.length },
      "Generated embedding"
    );

    return {
      embedding: new Float32Array(truncatedValues),
      dimensions: truncatedValues.length,
      model: "gemini-embedding-001",
    };
  } catch (error) {
    logger.error({ error, textLength: text.length }, "Failed to generate embedding");
    throw error;
  }
}

/**
 * Generate embedding for a search query
 * Uses RETRIEVAL_QUERY task type for better query matching
 */
export async function generateQueryEmbedding(query: string): Promise<Float32Array> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: "gemini-embedding-001" });

  const result = await model.embedContent({
    content: { parts: [{ text: query }], role: "user" },
    taskType: TaskType.RETRIEVAL_QUERY,
  });

  // Truncate to match stored embeddings (768 dims)
  return new Float32Array(result.embedding.values.slice(0, 768));
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dot += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Batch generate embeddings for multiple texts
 * Note: Gemini API may have rate limits, so we process sequentially
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<Float32Array[]> {
  const embeddings: Float32Array[] = [];

  for (const text of texts) {
    const result = await generateEmbedding(text);
    embeddings.push(result.embedding);
  }

  return embeddings;
}

/**
 * Reciprocal Rank Fusion (RRF) merge for hybrid search
 * Combines vector similarity scores with FTS5 ranks
 *
 * @param vectorResults - Results from vector search (already sorted by similarity)
 * @param ftsResults - Results from FTS5 (already sorted by rank)
 * @param k - RRF constant (default 60)
 * @param limit - Max results to return
 */
export function mergeRRF<T extends { filePath: string; chunkIndex: number }>(
  vectorResults: T[],
  ftsResults: T[],
  k: number = 60,
  limit: number = 10
): Array<T & { rrfScore: number; source: "vector" | "fts" | "both" }> {
  const scoreMap = new Map<string, { item: T; vectorRank?: number; ftsRank?: number }>();

  // Process vector results (position in array = rank)
  vectorResults.forEach((item, idx) => {
    const key = `${item.filePath}:${item.chunkIndex}`;
    scoreMap.set(key, { item, vectorRank: idx + 1 });
  });

  // Process FTS results (position in array = rank)
  ftsResults.forEach((item, idx) => {
    const key = `${item.filePath}:${item.chunkIndex}`;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.ftsRank = idx + 1;
    } else {
      scoreMap.set(key, { item, ftsRank: idx + 1 });
    }
  });

  // Calculate RRF scores
  const results: Array<T & { rrfScore: number; source: "vector" | "fts" | "both" }> = [];

  for (const { item, vectorRank, ftsRank } of scoreMap.values()) {
    const vectorScore = vectorRank ? 1 / (k + vectorRank) : 0;
    const ftsScore = ftsRank ? 1 / (k + ftsRank) : 0;
    const rrfScore = vectorScore + ftsScore;

    let source: "vector" | "fts" | "both";
    if (vectorRank && ftsRank) source = "both";
    else if (vectorRank) source = "vector";
    else source = "fts";

    results.push({ ...item, rrfScore, source });
  }

  // Sort by RRF score and limit
  return results
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);
}
