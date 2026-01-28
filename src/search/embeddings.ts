import { logger } from "../utils/logger.js";

/**
 * Generate embeddings using OpenAI API
 */
export async function generateEmbedding(
  text: string,
  apiKey: string,
  model: string = "text-embedding-3-small"
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI Embeddings API error: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!result.data?.[0]?.embedding) {
    throw new Error("Invalid embedding response");
  }

  logger.debug(
    { textLength: text.length, dimensions: result.data[0].embedding.length },
    "Generated embedding"
  );

  return result.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts (batched)
 */
export async function generateEmbeddings(
  texts: string[],
  apiKey: string,
  model: string = "text-embedding-3-small"
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // OpenAI allows up to 2048 inputs per request
  const batchSize = 100;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI Embeddings API error: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = result.data.sort((a, b) => a.index - b.index);
    results.push(...sorted.map((d) => d.embedding));

    logger.debug(
      { batch: i / batchSize + 1, count: batch.length },
      "Generated embedding batch"
    );
  }

  return results;
}
