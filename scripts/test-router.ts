#!/usr/bin/env npx tsx
/**
 * Test the router initialization with database
 */

import Database from "better-sqlite3";
import { initializeRouter, getRouterStatus, makeRoutingDecision } from "../src/executors/router.js";

const DB_PATH = process.env.HOMER_DB_PATH || `${process.env.HOME}/homer/data/homer.db`;

console.log(`Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);

console.log("\nInitializing router...");
initializeRouter(db);

console.log("\nRouter Status:");
const status = getRouterStatus();
console.log(`  DB Connected: ${status.dbConnected}`);
console.log(`  Gemini CLI: ${status.geminiCLI.availableAccounts}/${status.geminiCLI.totalAccounts} available`);
console.log(`  All Exhausted: ${status.geminiCLI.allExhausted}`);
console.log(`  Daily Cost: $${status.dailyCost.toFixed(4)}`);
console.log(`  Deferred Tasks: ${status.deferredTasks}`);
console.log(`  Pending Deferrals: ${status.pendingDeferrals}`);

console.log("\nRouting Decisions:");

// Test general task routing
const generalDecision = makeRoutingDecision({
  query: "What is the weather?",
  taskType: "general",
});
console.log(`  General task: ${generalDecision.executor} (${generalDecision.reason})`);

// Test code change routing
const codeDecision = makeRoutingDecision({
  query: "Fix the bug",
  taskType: "code-change",
});
console.log(`  Code change: ${codeDecision.executor} (${codeDecision.reason})`);

// Test long context routing
const longContextDecision = makeRoutingDecision({
  query: "Analyze this document",
  taskType: "long-context",
  estimatedTokens: 100000,
});
console.log(`  Long context: ${longContextDecision.executor} (${longContextDecision.reason})`);

db.close();
console.log("\n✓ Router test passed!");
