import type { ChunkResult } from "./types.js";

/**
 * Estimate token count (rough approximation: ~4 chars per token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk text into overlapping segments
 * @param content - Full text content
 * @param chunkSize - Target tokens per chunk
 * @param overlap - Overlap tokens between chunks
 */
export function chunkText(
  content: string,
  chunkSize: number = 512,
  overlap: number = 50
): ChunkResult[] {
  const lines = content.split("\n");
  const chunks: ChunkResult[] = [];

  let currentChunk: string[] = [];
  let currentTokens = 0;
  let startLine = 0;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineTokens = estimateTokens(line);

    // If single line exceeds chunk size, split it
    if (lineTokens > chunkSize) {
      // Flush current chunk first
      if (currentChunk.length > 0) {
        chunks.push({
          content: currentChunk.join("\n"),
          chunkIndex: chunkIndex++,
          startLine,
          endLine: i - 1,
        });
        currentChunk = [];
        currentTokens = 0;
      }

      // Split long line into multiple chunks
      const words = line.split(/\s+/);
      let wordChunk: string[] = [];
      let wordTokens = 0;

      for (const word of words) {
        const wt = estimateTokens(word + " ");
        if (wordTokens + wt > chunkSize && wordChunk.length > 0) {
          chunks.push({
            content: wordChunk.join(" "),
            chunkIndex: chunkIndex++,
            startLine: i,
            endLine: i,
          });
          wordChunk = [];
          wordTokens = 0;
        }
        wordChunk.push(word);
        wordTokens += wt;
      }

      if (wordChunk.length > 0) {
        chunks.push({
          content: wordChunk.join(" "),
          chunkIndex: chunkIndex++,
          startLine: i,
          endLine: i,
        });
      }

      startLine = i + 1;
      continue;
    }

    // Check if adding this line exceeds chunk size
    if (currentTokens + lineTokens > chunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        content: currentChunk.join("\n"),
        chunkIndex: chunkIndex++,
        startLine,
        endLine: i - 1,
      });

      // Start new chunk with overlap
      const overlapLines = getOverlapLines(currentChunk, overlap);
      currentChunk = overlapLines;
      currentTokens = estimateTokens(overlapLines.join("\n"));
      startLine = Math.max(0, i - overlapLines.length);
    }

    currentChunk.push(line);
    currentTokens += lineTokens;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk.join("\n"),
      chunkIndex: chunkIndex,
      startLine,
      endLine: lines.length - 1,
    });
  }

  return chunks;
}

/**
 * Get overlap lines from the end of a chunk
 */
function getOverlapLines(lines: string[], overlapTokens: number): string[] {
  const result: string[] = [];
  let tokens = 0;

  for (let i = lines.length - 1; i >= 0 && tokens < overlapTokens; i--) {
    const line = lines[i] ?? "";
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens <= overlapTokens * 1.5) {
      result.unshift(line);
      tokens += lineTokens;
    } else {
      break;
    }
  }

  return result;
}
