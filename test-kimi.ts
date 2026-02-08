#!/usr/bin/env tsx
/**
 * Kimi K2.5 Integration Test
 *
 * Run: tsx test-kimi.ts
 */

import { kimiResearch, kimiDesign } from "./src/executors/kimi-agent.js";
import { researchSwarm } from "./src/executors/parallel.js";
import { combineOutputs } from "./src/executors/parallel.js";

console.log("🧪 Testing Kimi K2.5 Integration\n");

// Test 1: Direct Kimi Research
console.log("📊 Test 1: Kimi Research Agent (NVIDIA NIM)");
console.log("Query: Top 5 Claude Code skills for productivity\n");

try {
  const result1 = await kimiResearch(
    "Research the top 5 most useful Claude Code skills for developer productivity. Return as JSON list with name, description, and GitHub stars."
  );

  console.log("✅ Test 1 Complete");
  console.log(`Duration: ${(result1.duration / 1000).toFixed(2)}s`);
  console.log(`Provider: ${result1.provider}`);
  console.log(`Model: ${result1.model}`);
  console.log(`Tokens: ${result1.inputTokens} in / ${result1.outputTokens} out`);
  console.log(`Cost: $${result1.cost?.toFixed(4) || "0.0000"} (free tier)`);
  console.log(`Output preview: ${result1.output.slice(0, 200)}...\n`);
} catch (error) {
  console.error("❌ Test 1 Failed:", error);
}

// Test 2: Kimi Design Agent
console.log("\n🎨 Test 2: Kimi Design Agent");
console.log("Query: Modern React dashboard component patterns\n");

try {
  const result2 = await kimiDesign(
    "Research modern React dashboard component libraries (Shadcn, Radix, MUI). Compare styling approaches and TypeScript support."
  );

  console.log("✅ Test 2 Complete");
  console.log(`Duration: ${(result2.duration / 1000).toFixed(2)}s`);
  console.log(`Provider: ${result2.provider}`);
  console.log(`Tokens: ${result2.inputTokens} in / ${result2.outputTokens} out`);
  console.log(`Output preview: ${result2.output.slice(0, 200)}...\n`);
} catch (error) {
  console.error("❌ Test 2 Failed:", error);
}

// Test 3: Parallel Execution (Research Swarm)
console.log("\n🔄 Test 3: Parallel Research Swarm (Kimi + Gemini + Claude)");
console.log("Query: Vancouver trip planning\n");

try {
  const result3 = await researchSwarm(
    "Vancouver trip: Best Chinese restaurants in Richmond, top shopping areas, must-see sightseeing spots. Return structured recommendations."
  );

  console.log("✅ Test 3 Complete");
  console.log(`Total Duration: ${(result3.duration / 1000).toFixed(2)}s (parallel)`);
  console.log(`Success: ${result3.successCount}/${result3.successCount + result3.failureCount}`);
  console.log("\nAgent Results:");

  for (const [agent, agentResult] of Object.entries(result3.results)) {
    const status = agentResult.exitCode === 0 ? "✓" : "✗";
    console.log(`  ${status} ${agent}: ${(agentResult.duration / 1000).toFixed(2)}s`);
  }

  // Save combined output
  const combined = combineOutputs(result3);
  const fs = await import("fs/promises");
  await fs.writeFile("/Users/yj/Desktop/kimi-test-output.md", combined);
  console.log("\n📄 Combined output saved to ~/Desktop/kimi-test-output.md");
} catch (error) {
  console.error("❌ Test 3 Failed:", error);
}

console.log("\n✨ All tests complete!");
console.log("\nNext steps:");
console.log("1. Check ~/Desktop/kimi-test-output.md for parallel execution results");
console.log("2. Try the /k command in Telegram: '/k Research topic here'");
console.log("3. Monitor NVIDIA NIM usage (40 RPM free tier)");
console.log("4. Review docs at ~/homer/docs/kimi-integration.md");
