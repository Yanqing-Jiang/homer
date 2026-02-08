import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load .env
dotenvConfig({ path: resolve(import.meta.dirname, ".env") });

import { indexMemoryFiles, getIndexStatus } from "./src/search/index.js";
import type { SearchConfig } from "./src/search/types.js";

async function main() {
  console.log("=== Indexing Memory Files ===\n");

  const searchConfig: SearchConfig = {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    embeddingModel: "text-embedding-3-small",
    chunkSize: 512,
    chunkOverlap: 50,
  };

  if (!searchConfig.supabaseUrl || !searchConfig.supabaseAnonKey) {
    console.error("SUPABASE_URL and SUPABASE_ANON_KEY required");
    process.exit(1);
  }

  if (!searchConfig.openaiApiKey) {
    console.error("OPENAI_API_KEY required for embeddings");
    process.exit(1);
  }

  console.log("Configuration:");
  console.log(`  Embedding model: ${searchConfig.embeddingModel}`);
  console.log(`  Chunk size: ${searchConfig.chunkSize} tokens`);
  console.log(`  Overlap: ${searchConfig.chunkOverlap} tokens\n`);

  try {
    const result = await indexMemoryFiles(searchConfig);

    console.log("\n=== Indexing Complete ===");
    console.log(`  Indexed: ${result.indexed} files`);
    console.log(`  Skipped: ${result.skipped} files (unchanged or missing)`);
    console.log(`  Errors: ${result.errors} files`);

    // Show status
    console.log("\n=== Index Status ===");
    const status = await getIndexStatus(searchConfig);
    console.log(`  Total chunks: ${status.totalDocuments}`);
    for (const stat of status.fileStats) {
      const fileName = stat.filePath.split("/").pop();
      console.log(`  - ${fileName}: ${stat.chunks} chunks`);
    }
  } catch (error) {
    console.error("Indexing failed:", error);
  }
}

main().catch(console.error);
