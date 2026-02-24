#!/usr/bin/env npx tsx
/**
 * One-time backfill: populate session_transcripts + memory_file_snapshots
 *
 * 1. Scan all Claude Code sessions → INSERT into session_transcripts (archive fidelity)
 * 2. Scan Codex/Kimi/OpenCode sessions → INSERT (already full fidelity)
 * 3. Snapshot all current ~/memory/*.md files as baseline memory_file_snapshots
 *
 * Run: npx tsx scripts/backfill-transcripts.ts
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { runMigrations } from "../src/state/migrations/index.js";

const DB_PATH = "/Users/yj/homer/data/homer.db";
const HOME_DIR = "/Users/yj";
const MEMORY_DIR = "/Users/yj/memory";

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Ensure migration 036 has been applied
  runMigrations(db);

  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_transcripts'"
  ).get();
  if (!hasTable) {
    console.error("session_transcripts table not found. Run migrations first.");
    process.exit(1);
  }

  // --- 1. Backfill Claude Code sessions ---
  console.log("\n=== Backfilling Claude Code sessions ===");
  let claudeCount = 0;
  let claudeSkipped = 0;

  const claudeProjectsDir = join(HOME_DIR, ".claude", "projects", "-Users-yj");
  if (existsSync(claudeProjectsDir)) {
    const files = readdirSync(claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    console.log(`Found ${files.length} Claude session files`);

    for (const file of files) {
      const filePath = join(claudeProjectsDir, file);

      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());

        // Quick parse for content hash and messages
        const messages: Array<{ role: string; content: string; timestamp?: string }> = [];
        let sessionId = "";
        let model = "";
        let startTime = "";
        let endTime = "";
        let project = "";

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
            if (!startTime && entry.timestamp) startTime = entry.timestamp;
            if (entry.timestamp) endTime = entry.timestamp;

            if (entry.type === "user" && entry.message) {
              let msgContent = "";
              const msgObj = entry.message;
              if (typeof msgObj.content === "string") {
                msgContent = msgObj.content;
              } else if (Array.isArray(msgObj.content)) {
                msgContent = msgObj.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n");
              }
              if (!project && entry.cwd) project = entry.cwd;
              if (msgContent) {
                messages.push({ role: "user", content: msgContent, timestamp: entry.timestamp });
              }
            } else if (entry.type === "assistant" && entry.message) {
              let msgContent = "";
              const msgObj = entry.message;
              if (Array.isArray(msgObj.content)) {
                msgContent = msgObj.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n");
              } else if (typeof msgObj.content === "string") {
                msgContent = msgObj.content;
              }
              if (msgObj.model && !model) model = msgObj.model;
              if (msgContent) {
                messages.push({ role: "assistant", content: msgContent, timestamp: entry.timestamp });
              }
            }
          } catch { /* skip malformed */ }
        }

        if (messages.length === 0) continue;

        // Generate content hash (truncated version for compatibility)
        const MAX_U = 20, MAX_A = 10, MAX_UC = 300, MAX_AC = 400;
        let uC = 0, aC = 0;
        const truncated = messages.filter(m => {
          if (m.role === "user" && uC < MAX_U) { uC++; return true; }
          if (m.role === "assistant" && aC < MAX_A) { aC++; return true; }
          return false;
        }).map(m => ({
          ...m,
          content: m.role === "user" ? m.content.slice(0, MAX_UC) : m.content.slice(0, MAX_AC),
        }));

        const normalizedContent = truncated
          .map(m => `${m.role}:${m.content.trim().toLowerCase()}`)
          .join("\n");
        const contentHash = createHash("sha256").update(normalizedContent).digest("hex");

        // Check if already exists
        const exists = db.prepare(
          "SELECT 1 FROM session_transcripts WHERE content_hash = ?"
        ).get(contentHash);
        if (exists) {
          claudeSkipped++;
          continue;
        }

        const messagesJson = JSON.stringify(messages);
        const mtime = statSync(filePath).mtimeMs;

        db.prepare(
          `INSERT INTO session_transcripts (
            content_hash, agent, session_id, messages_json, native_file_path,
            source_mtime_ms, model, project, started_at, ended_at,
            message_count, uncompressed_size
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(content_hash) DO NOTHING`
        ).run(
          contentHash, "claude", sessionId || file.replace(".jsonl", ""),
          messagesJson, filePath, mtime,
          model || null, project || null,
          startTime || null, endTime || null,
          messages.length, Buffer.byteLength(messagesJson, "utf-8")
        );
        claudeCount++;
      } catch (err) {
        console.error(`Error processing ${file}:`, err);
      }
    }
  }
  console.log(`Claude: ${claudeCount} imported, ${claudeSkipped} skipped (already exists)`);

  // --- 2. Snapshot ~/memory/*.md files ---
  console.log("\n=== Snapshotting memory files ===");
  let snapshotCount = 0;

  const memoryFiles = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md"));
  const date = new Date().toISOString().slice(0, 10);

  for (const fileName of memoryFiles) {
    const filePath = join(MEMORY_DIR, fileName);
    try {
      const content = readFileSync(filePath, "utf-8");
      const contentHash = createHash("sha256").update(content).digest("hex");
      const sizeBytes = Buffer.byteLength(content, "utf-8");

      db.prepare(
        `INSERT INTO memory_file_snapshots (file_name, snapshot_date, content, content_hash, size_bytes, reason)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_name, snapshot_date, reason) DO NOTHING`
      ).run(fileName, date, content, contentHash, sizeBytes, "baseline-backfill");
      snapshotCount++;
    } catch (err) {
      console.error(`Error snapshotting ${fileName}:`, err);
    }
  }
  console.log(`Snapshots: ${snapshotCount} memory files baseline`);

  // --- Summary ---
  const transcriptCount = (db.prepare("SELECT COUNT(*) as c FROM session_transcripts").get() as { c: number }).c;
  const snapshotTotal = (db.prepare("SELECT COUNT(*) as c FROM memory_file_snapshots").get() as { c: number }).c;

  console.log(`\n=== Backfill Complete ===`);
  console.log(`Total session_transcripts: ${transcriptCount}`);
  console.log(`Total memory_file_snapshots: ${snapshotTotal}`);

  db.close();
}

main();
