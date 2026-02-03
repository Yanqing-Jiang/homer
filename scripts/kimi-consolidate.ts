#!/usr/bin/env tsx
/**
 * Kimi Memory Consolidation Script
 *
 * Uses Kimi's 128k context to analyze large daily logs and:
 * 1. Generate a weekly summary
 * 2. Extract facts worth promoting to permanent memory
 * 3. Identify patterns and insights
 *
 * Usage: tsx scripts/kimi-consolidate.ts [--days=7] [--dry-run]
 */

import { config } from "dotenv";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

// Load env before importing modules that need it
config({ path: join(import.meta.dirname, "../.env") });

import { summarizeWithKimi, extractMemoryFacts } from "../src/executors/kimi.js";

const MEMORY_DIR = process.env.HOME + "/memory";
const DAILY_DIR = join(MEMORY_DIR, "daily");

interface ConsolidationResult {
  period: { start: string; end: string };
  summary: string;
  promotions: Array<{
    content: string;
    file: string;
    section?: string;
  }>;
  totalTokensUsed: number;
  cost: number;
}

async function consolidateMemory(days: number, dryRun: boolean): Promise<void> {
  console.log(`\n🧠 Kimi Memory Consolidation`);
  console.log(`   Analyzing last ${days} days of daily logs...\n`);

  // Get daily log files sorted by date
  const files = readdirSync(DAILY_DIR)
    .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
    .sort()
    .slice(-days);

  if (files.length === 0) {
    console.log("No daily logs found.");
    return;
  }

  console.log(`📁 Found ${files.length} daily logs:`);
  files.forEach((f) => console.log(`   - ${f}`));

  // Read and combine all logs
  let combinedContent = "";
  let totalBytes = 0;

  for (const file of files) {
    const path = join(DAILY_DIR, file);
    const content = readFileSync(path, "utf-8");
    combinedContent += `\n\n## ${file.replace(".md", "")}\n\n${content}`;
    totalBytes += content.length;
  }

  console.log(`\n📊 Total content: ${(totalBytes / 1024).toFixed(1)} KB (~${Math.ceil(totalBytes / 4)} tokens)`);

  // Step 1: Generate weekly summary
  console.log("\n🔄 Generating summary with Kimi...");

  const summaryPrompt = `Create a concise weekly summary of these daily logs. Focus on:
- Key accomplishments and progress
- Important decisions made
- Blockers or challenges encountered
- Patterns or themes across days
- Notable learnings or insights

Keep it actionable and forward-looking.`;

  let summary: string;
  try {
    summary = await summarizeWithKimi(combinedContent, summaryPrompt);
    console.log("\n✅ Summary generated:");
    console.log("─".repeat(60));
    console.log(summary);
    console.log("─".repeat(60));
  } catch (error) {
    console.error("❌ Failed to generate summary:", error);
    return;
  }

  // Step 2: Extract memory promotions
  console.log("\n🔄 Extracting facts for permanent memory...");

  let extracted: Awaited<ReturnType<typeof extractMemoryFacts>>;
  try {
    extracted = await extractMemoryFacts(combinedContent);
    console.log(`\n✅ Found ${extracted.promotions.length} facts to potentially promote:`);

    for (const p of extracted.promotions) {
      console.log(`\n   📌 [${p.file}${p.section ? ` > ${p.section}` : ""}]`);
      console.log(`      ${p.content}`);
    }
  } catch (error) {
    console.error("❌ Failed to extract facts:", error);
    return;
  }

  // Step 3: Apply promotions (if not dry run)
  if (!dryRun && extracted.promotions.length > 0) {
    console.log("\n📝 Applying promotions to memory files...");

    for (const p of extracted.promotions) {
      const targetFile = join(MEMORY_DIR, `${p.file}.md`);

      if (!existsSync(targetFile)) {
        console.log(`   ⚠️ Skipping ${p.file}.md (file doesn't exist)`);
        continue;
      }

      const existingContent = readFileSync(targetFile, "utf-8");

      // Check if content already exists (avoid duplicates)
      if (existingContent.includes(p.content)) {
        console.log(`   ⏭️ Skipping duplicate in ${p.file}.md`);
        continue;
      }

      // Append to file (or under section if specified)
      let newContent: string;
      if (p.section && existingContent.includes(`## ${p.section}`)) {
        // Insert under existing section
        newContent = existingContent.replace(
          `## ${p.section}`,
          `## ${p.section}\n\n- ${p.content}`
        );
      } else if (p.section) {
        // Create new section
        newContent = existingContent + `\n\n## ${p.section}\n\n- ${p.content}`;
      } else {
        // Append at end
        newContent = existingContent + `\n\n- ${p.content}`;
      }

      writeFileSync(targetFile, newContent);
      console.log(`   ✅ Added to ${p.file}.md`);
    }
  } else if (dryRun) {
    console.log("\n🔍 Dry run - no changes made");
  }

  // Save the weekly summary
  const today = new Date().toISOString().split("T")[0];
  const summaryFile = join(DAILY_DIR, `${today}-weekly-summary.md`);

  if (!dryRun) {
    writeFileSync(summaryFile, `# Weekly Summary (${files[0]} to ${files[files.length - 1]})\n\n${summary}\n\n---\n*Generated by Kimi (moonshot-v1-128k)*`);
    console.log(`\n📄 Saved summary to ${summaryFile}`);
  }

  // Estimate cost (moonshot-v1-128k is ~$0.012/1k input, $0.012/1k output)
  const estimatedInputTokens = Math.ceil(totalBytes / 4);
  const estimatedOutputTokens = Math.ceil((summary.length + JSON.stringify(extracted).length) / 4);
  const estimatedCost = (estimatedInputTokens * 0.012 + estimatedOutputTokens * 0.012) / 1000;

  console.log(`\n💰 Estimated cost: $${estimatedCost.toFixed(4)} (~${estimatedInputTokens + estimatedOutputTokens} tokens)`);
  console.log(`   Remaining budget: ~$${(5 - estimatedCost).toFixed(2)}`);
}

// Parse args
const args = process.argv.slice(2);
const days = parseInt(args.find((a) => a.startsWith("--days="))?.split("=")[1] || "7");
const dryRun = args.includes("--dry-run");

consolidateMemory(days, dryRun).catch(console.error);
