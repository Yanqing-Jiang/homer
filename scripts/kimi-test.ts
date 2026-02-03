#!/usr/bin/env tsx
/**
 * Quick Kimi API test
 */

import { config } from "dotenv";
import { join } from "path";

config({ path: join(import.meta.dirname, "../.env") });

import { executeKimiCommand } from "../src/executors/kimi.js";

async function test() {
  console.log("🧪 Testing Kimi API via NVIDIA NIM...\n");

  const result = await executeKimiCommand(
    "In one sentence, what is 2 + 2 and why?",
    { provider: "nvidia" } // Use NVIDIA NIM with Kimi K2
  );

  console.log("Response:", result.output);
  console.log("\nMetadata:");
  console.log(`  Provider: ${result.provider}`);
  console.log(`  Model: ${result.model}`);
  console.log(`  Duration: ${result.duration}ms`);
  console.log(`  Input tokens: ${result.inputTokens}`);
  console.log(`  Output tokens: ${result.outputTokens}`);
  console.log(`  Exit code: ${result.exitCode}`);
}

test().catch(console.error);
