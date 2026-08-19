import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// @ts-ignore
import type Database from "better-sqlite3";
import { downloadBlob, getBlobProperties } from "../integrations/azure-blob.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_JSONL_BYTES = 128 * 1024 * 1024;
const MAX_SESSIONS_PER_ARCHIVE = 10_000;
const FTS_CHUNK_CHARS = 8_000;

export interface WorkTranscriptMessage {
  role: "user" | "assistant";
  timestamp: string | null;
  content: string;
}

export interface WorkTranscriptRecord {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  messages: WorkTranscriptMessage[];
}

export interface TranscriptIngestStats {
  sessions: number;
  inserted: number;
  updated: number;
  duplicates: number;
}

export interface WorkTranscriptIngestResult extends TranscriptIngestStats {
  blob: string;
  dates: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentFingerprint(messages: WorkTranscriptMessage[]): string {
  return sha256(JSON.stringify(messages.map(({ role, content }) => ({ role, content }))));
}

function validateIso(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${field}`);
  }
  return new Date(value).toISOString();
}

export function parseTranscriptJsonl(content: string): WorkTranscriptRecord[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > MAX_SESSIONS_PER_ARCHIVE) throw new Error("Archive exceeds session limit");

  const records: WorkTranscriptRecord[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on transcripts.jsonl line ${index + 1}`);
    }
    if (!raw || typeof raw !== "object") throw new Error(`Invalid transcript on line ${index + 1}`);
    const value = raw as Record<string, unknown>;
    if (typeof value.session_id !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(value.session_id)) {
      throw new Error(`Invalid session_id on line ${index + 1}`);
    }
    if (seen.has(value.session_id)) throw new Error(`Duplicate session_id in archive: ${value.session_id}`);
    seen.add(value.session_id);
    if (!Array.isArray(value.messages) || value.messages.length === 0) {
      throw new Error(`Session ${value.session_id} has no messages`);
    }

    const messages = value.messages.map((message, messageIndex) => {
      if (!message || typeof message !== "object") throw new Error(`Invalid message ${messageIndex} in ${value.session_id}`);
      const item = message as Record<string, unknown>;
      if (item.role !== "user" && item.role !== "assistant") throw new Error(`Invalid role in ${value.session_id}`);
      if (typeof item.content !== "string" || item.content.trim().length === 0) throw new Error(`Empty content in ${value.session_id}`);
      return {
        role: item.role,
        timestamp: validateIso(item.timestamp, "message timestamp"),
        content: item.content,
      } satisfies WorkTranscriptMessage;
    });

    records.push({
      session_id: value.session_id,
      started_at: validateIso(value.started_at, "started_at"),
      ended_at: validateIso(value.ended_at, "ended_at"),
      messages,
    });
  }
  return records;
}

function renderMessage(message: WorkTranscriptMessage): string {
  return `[${message.timestamp ?? "unknown"}] ${message.role}\n${message.content}`;
}

function transcriptChunks(messages: WorkTranscriptMessage[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const message of messages) {
    const rendered = renderMessage(message);
    if (rendered.length > FTS_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < rendered.length; offset += FTS_CHUNK_CHARS) {
        chunks.push(rendered.slice(offset, offset + FTS_CHUNK_CHARS));
      }
      continue;
    }
    const next = current ? `${current}\n\n${rendered}` : rendered;
    if (next.length > FTS_CHUNK_CHARS) {
      chunks.push(current);
      current = rendered;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function ingestTranscriptRecords(db: Database.Database, records: WorkTranscriptRecord[]): TranscriptIngestStats {
  const stats: TranscriptIngestStats = { sessions: records.length, inserted: 0, updated: 0, duplicates: 0 };
  const getExisting = db.prepare(
    "SELECT transcript_hash as transcriptHash FROM session_transcripts WHERE content_hash = ?",
  );
  const findSameDateTranscripts = db.prepare(`
    SELECT messages_json as messagesJson FROM session_transcripts
    WHERE date(started_at) = date(?)
  `);
  const upsertTranscript = db.prepare(`
    INSERT INTO session_transcripts (
      content_hash, agent, session_id, messages_json, native_file_path,
      source_mtime_ms, model, project, started_at, ended_at,
      message_count, uncompressed_size, transcript_hash, origin_device
    ) VALUES (?, 'opencode', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'work-laptop')
    ON CONFLICT(content_hash) DO UPDATE SET
      messages_json = excluded.messages_json,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      message_count = excluded.message_count,
      uncompressed_size = excluded.uncompressed_size,
      transcript_hash = excluded.transcript_hash,
      origin_device = 'work-laptop',
      created_at = datetime('now')
  `);
  const deleteFts = db.prepare("DELETE FROM transcript_fts WHERE content_hash = ?");
  const insertFts = db.prepare(`
    INSERT INTO transcript_fts (content, content_hash, chunk_index, agent, project, started_at)
    VALUES (?, ?, ?, 'opencode', NULL, ?)
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO transcript_index_meta (content_hash, chunk_count, indexed_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(content_hash) DO UPDATE SET
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at
  `);

  const transaction = db.transaction(() => {
    for (const record of records) {
      const messagesJson = JSON.stringify(record.messages);
      const transcriptHash = sha256(messagesJson);
      const contentHash = sha256(`work-laptop:opencode:${record.session_id}`);
      const existing = getExisting.get(contentHash) as { transcriptHash: string | null } | undefined;
      if (existing?.transcriptHash === transcriptHash) {
        stats.duplicates++;
        continue;
      }
      if (!existing && record.started_at) {
        const incomingFingerprint = contentFingerprint(record.messages);
        const sameDate = findSameDateTranscripts.all(record.started_at) as Array<{ messagesJson: string }>;
        const duplicate = sameDate.some(({ messagesJson }) => {
          try {
            return contentFingerprint(JSON.parse(messagesJson) as WorkTranscriptMessage[]) === incomingFingerprint;
          } catch {
            return false;
          }
        });
        if (duplicate) {
          stats.duplicates++;
          continue;
        }
      }

      upsertTranscript.run(
        contentHash,
        record.session_id,
        messagesJson,
        record.started_at,
        record.ended_at,
        record.messages.length,
        Buffer.byteLength(messagesJson, "utf8"),
        transcriptHash,
      );
      existing ? stats.updated++ : stats.inserted++;

      const chunks = transcriptChunks(record.messages);
      deleteFts.run(contentHash);
      chunks.forEach((chunk, index) => insertFts.run(chunk, contentHash, index, record.started_at));
      upsertMeta.run(contentHash, chunks.length);
    }
  });
  transaction();
  return stats;
}

function extractJsonl(archivePath: string): string {
  const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
    throw new Error("Unsafe archive path");
  }
  const jsonlEntry = entries.find((entry) => entry === "transcripts.jsonl" || entry === "./transcripts.jsonl");
  if (!jsonlEntry) throw new Error("Archive does not contain transcripts.jsonl");
  return execFileSync("tar", ["-xOzf", archivePath, jsonlEntry], {
    encoding: "utf8",
    maxBuffer: MAX_JSONL_BYTES,
  });
}

export async function ingestWorkOpencodeBlob(
  db: Database.Database,
  blobName: string,
): Promise<WorkTranscriptIngestResult> {
  if (!blobName.endsWith(".tar.gz")) throw new Error("Blob must be an OpenCode .tar.gz archive");

  const properties = await getBlobProperties(blobName);
  const archiveSha = properties.metadata?.sha256 ?? "";
  if (properties.size <= 0 || properties.size > MAX_ARCHIVE_BYTES) throw new Error("Blob size is invalid");
  if (!/^[a-f0-9]{64}$/.test(archiveSha)) throw new Error("Blob is missing valid SHA-256 metadata");

  const staging = mkdtempSync(join(tmpdir(), "work-opencode-ingest-"));
  const archivePath = join(staging, "archive.tar.gz");
  try {
    await downloadBlob(blobName, archivePath);
    if (!existsSync(archivePath) || statSync(archivePath).size !== properties.size) {
      throw new Error("Downloaded size mismatch");
    }
    if (sha256(readFileSync(archivePath)) !== archiveSha) throw new Error("Downloaded SHA-256 mismatch");

    const records = parseTranscriptJsonl(extractJsonl(archivePath));
    const stats = ingestTranscriptRecords(db, records);
    return {
      blob: blobName,
      dates: [...new Set(records.map((record) => record.started_at?.slice(0, 10)).filter((date): date is string => Boolean(date)))].sort(),
      ...stats,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
