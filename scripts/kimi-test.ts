#!/usr/bin/env tsx
/**
 * Quick Kimi CLI test
 */

import { config } from "dotenv";
import { join } from "path";

config({ path: join(import.meta.dirname, "../.env") });

import { executeKimiCLI } from "../src/executors/kimi-cli.js";

async function test() {
  console.log("🧪 Testing Kimi CLI...\n");

  const result = await executeKimiCLI(
    "In one sentence, what is 2 + 2 and why?",
    "",
    { timeout: 1_200_000, yolo: true, workDir: process.env.HOME ?? "/Users/yj" }
  );

  console.log("Response:", result.output);
  console.log("\nMetadata:");
  console.log("  Provider: cli");
  console.log(`  Model: ${result.model}`);
  console.log(`  Duration: ${result.duration}ms`);
  console.log(`  Exit code: ${result.exitCode}`);
}

test().catch(console.error);
