/**
 * Search types for hybrid vector + keyword search
 */

export interface SearchConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  openaiApiKey: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
}

export interface MemoryDocument {
  id?: string;
  filePath: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  context: string;
  embedding?: number[];
  createdAt?: string;
}

export interface SearchResult {
  filePath: string;
  chunkIndex: number;
  content: string;
  context: string;
  score: number;
  source: "vector" | "keyword" | "hybrid";
}

export interface ChunkResult {
  content: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
}
