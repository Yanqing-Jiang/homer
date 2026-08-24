import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// @ts-ignore
import type Database from "better-sqlite3";
import { downloadBlob, getBlobProperties } from "../integrations/azure-blob.js";
import type { ParsedSession } from "./parsers.js";
import { buildRawExcerpt, generateTitle, getLogDate, summarizeSession, templateSummary } from "./summarizer.js";
import { logger } from "../utils/logger.js";

/**
 * Work-laptop OpenCode session ingest.
 *
 * Accepts two extract shapes:
 *   v1 — `{session_id, started_at, ended_at, messages:[{role,timestamp,content}]}` (transcripts.jsonl inside a .tar.gz)
 *   v2 — `{schema_version:2, session:{id,parent_id,title,model,agent,...}, rounds:[{input,output}]}` (plain .jsonl)
 *
 * Dedup tiers, in order:
 *   1. Exact session id → session_transcripts.content_hash = sha256("work-laptop:opencode:<id>").
 *      Same transcript_hash = duplicate; different = the session grew, update in place.
 *   2. Legacy session_summaries rows (id "work-laptop:session:<id>") — reused, never duplicated;
 *      re-summarised only when the incoming message count is higher.
 *   3. Same-UTC-date role+text fingerprint against every existing transcript — catches
 *      re-exports of the same conversation under a different session id.
 *
 * Writes: session_transcripts (+transcript_fts, transcript_index_meta), session_summaries,
 * cli_session_index. origin_device is always 'work-laptop'.
 */

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_JSONL_BYTES = 128 * 1024 * 1024;
const MAX_SESSIONS_PER_ARCHIVE = 10_000;
const FTS_CHUNK_CHARS = 8_000;
const ORIGIN = "work-laptop";
const AGENT = "opencode";

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
  /** v2 metadata; absent for v1 archives. */
  title?: string | null;
  model?: string | null;
  opencode_agent?: string | null;
  parent_id?: string | null;
  directory?: string | null;
  cost?: number | null;
}

export interface TranscriptIngestStats {
  sessions: number;
  inserted: number;
  updated: number;
  duplicates: number;
  /** Sessions with zero user/assistant text (e.g. cleared sessions); nothing to store. */
  skipped_empty: number;
  summaries_created: number;
  summaries_updated: number;
  summaries_reused: number;
  summary_failures: number;
}

export interface WorkTranscriptIngestResult extends TranscriptIngestStats {
  source: string;
  schema: "v1" | "v2" | "mixed";
  dates: string[];
  dry_run: boolean;
}

export interface IngestOptions {
  /**
   * "raw" (default): summary column holds the full transcript text (## user / ## assistant), no LLM.
   * "template": free goal/outcome stub. "llm": global-harness summary for >4-message sessions.
   */
  summaryMode?: "raw" | "template" | "llm";
  /** Rewrite the summary of sessions that already have one (e.g. to switch modes). */
  rewriteSummaries?: boolean;
  /** Compute stats without writing. */
  dryRun?: boolean;
  /** Label recorded in cli_session_index.native_file_path (e.g. "blob:<name>"). */
  sourceLabel?: string;
  signal?: AbortSignal;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/;

function parseV1(value: Record<string, unknown>, line: number): WorkTranscriptRecord {
  if (typeof value.session_id !== "string" || !SESSION_ID_RE.test(value.session_id)) {
    throw new Error(`Invalid session_id on line ${line}`);
  }
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
  return {
    session_id: value.session_id,
    started_at: validateIso(value.started_at, "started_at"),
    ended_at: validateIso(value.ended_at, "ended_at"),
    messages,
  };
}

function parseV2(value: Record<string, unknown>, line: number): WorkTranscriptRecord {
  const session = value.session as Record<string, unknown> | undefined;
  if (!session || typeof session !== "object") throw new Error(`Missing session on line ${line}`);
  if (typeof session.id !== "string" || !SESSION_ID_RE.test(session.id)) {
    throw new Error(`Invalid session.id on line ${line}`);
  }
  const rounds = Array.isArray(value.rounds) ? value.rounds : [];
  const messages: WorkTranscriptMessage[] = [];
  for (const [roundIndex, round] of rounds.entries()) {
    if (!round || typeof round !== "object") throw new Error(`Invalid round ${roundIndex} in ${session.id}`);
    const item = round as Record<string, unknown>;
    const input = item.input as Record<string, unknown> | undefined;
    const output = item.output as Record<string, unknown> | undefined;
    const userText = optionalString(input?.content);
    if (userText) {
      messages.push({ role: "user", timestamp: validateIso(input?.timestamp, "input.timestamp"), content: userText });
    }
    const assistantText = optionalString(output?.content);
    if (assistantText) {
      messages.push({
        role: "assistant",
        timestamp: validateIso(output?.completed_at ?? output?.started_at, "output.completed_at"),
        content: assistantText,
      });
    }
  }
  const model = session.model && typeof session.model === "object"
    ? optionalString((session.model as Record<string, unknown>).id)
    : optionalString(session.model);
  return {
    session_id: session.id,
    started_at: validateIso(session.created_at, "session.created_at"),
    ended_at: validateIso(session.updated_at, "session.updated_at"),
    messages,
    title: optionalString(session.title),
    model,
    opencode_agent: optionalString(session.agent),
    parent_id: optionalString(session.parent_id),
    directory: optionalString(session.directory),
    cost: typeof session.cost === "number" ? session.cost : null,
  };
}

export function parseTranscriptJsonl(content: string): { records: WorkTranscriptRecord[]; schema: "v1" | "v2" | "mixed" } {
  const lines = content.replace(/^﻿/, "").split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > MAX_SESSIONS_PER_ARCHIVE) throw new Error("Archive exceeds session limit");

  const records: WorkTranscriptRecord[] = [];
  const seen = new Set<string>();
  const shapes = new Set<"v1" | "v2">();
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on line ${index + 1}`);
    }
    if (!raw || typeof raw !== "object") throw new Error(`Invalid transcript on line ${index + 1}`);
    const value = raw as Record<string, unknown>;
    let record: WorkTranscriptRecord;
    if (value.schema_version === 2 || (value.session && Array.isArray(value.rounds))) {
      record = parseV2(value, index + 1);
      shapes.add("v2");
    } else {
      record = parseV1(value, index + 1);
      shapes.add("v1");
    }
    if (seen.has(record.session_id)) throw new Error(`Duplicate session_id in archive: ${record.session_id}`);
    seen.add(record.session_id);
    records.push(record);
  }
  const schema = shapes.size === 2 ? "mixed" : shapes.has("v2") ? "v2" : "v1";
  return { records, schema };
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

export function workContentHash(sessionId: string): string {
  return sha256(`${ORIGIN}:${AGENT}:${sessionId}`);
}

/**
 * Raw transcript rendering, matching the legacy work-laptop rows. Untruncated on purpose:
 * the extract already excludes reasoning, tool calls, and step markers, so this is the
 * complete user/assistant conversation and doubles as the dedup-visible text.
 */
export function rawSummary(messages: WorkTranscriptMessage[]): string {
  return messages.map((m) => `## ${m.role}\n${m.content}`).join("\n\n");
}

function toParsedSession(record: WorkTranscriptRecord, contentHash: string, sourceLabel: string): ParsedSession {
  return {
    sessionId: record.session_id,
    agent: AGENT,
    nativeFilePath: sourceLabel,
    messages: record.messages.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp ?? undefined })),
    model: record.model ?? undefined,
    project: record.directory ?? undefined,
    startedAt: record.started_at ?? undefined,
    endedAt: record.ended_at ?? undefined,
    messageCount: record.messages.length,
    contentHash,
  };
}

type Plan = {
  record: WorkTranscriptRecord;
  contentHash: string;
  transcriptHash: string;
  messagesJson: string;
  transcriptAction: "insert" | "update" | "duplicate";
  summaryAction: "create" | "update" | "reuse";
  existingSummaryId: string | null;
};

/**
 * Decide what to do with each record without writing anything.
 * Exposed so a dry run and the real run share exactly one decision path.
 */
export function planIngest(db: Database.Database, records: WorkTranscriptRecord[], rewriteSummaries = false): { plans: Plan[]; skipped_empty: number } {
  const getExisting = db.prepare(
    "SELECT transcript_hash AS transcriptHash FROM session_transcripts WHERE content_hash = ?",
  );
  const findSameDateTranscripts = db.prepare(
    "SELECT messages_json AS messagesJson FROM session_transcripts WHERE substr(started_at, 1, 10) = substr(?, 1, 10)",
  );
  const getSummary = db.prepare(
    "SELECT id, message_count AS messageCount FROM session_summaries WHERE origin_device = ? AND native_session_id = ? LIMIT 1",
  );

  const plans: Plan[] = [];
  let skipped_empty = 0;
  for (const record of records) {
    if (record.messages.length === 0) {
      skipped_empty++;
      continue;
    }
    const messagesJson = JSON.stringify(record.messages);
    const transcriptHash = sha256(messagesJson);
    const contentHash = workContentHash(record.session_id);
    const existing = getExisting.get(contentHash) as { transcriptHash: string | null } | undefined;

    let transcriptAction: Plan["transcriptAction"];
    if (existing) {
      transcriptAction = existing.transcriptHash === transcriptHash ? "duplicate" : "update";
    } else {
      transcriptAction = "insert";
      if (record.started_at) {
        const incomingFingerprint = contentFingerprint(record.messages);
        const sameDate = findSameDateTranscripts.all(record.started_at) as Array<{ messagesJson: string }>;
        const duplicate = sameDate.some(({ messagesJson: existingJson }) => {
          try {
            return contentFingerprint(JSON.parse(existingJson) as WorkTranscriptMessage[]) === incomingFingerprint;
          } catch {
            return false;
          }
        });
        if (duplicate) transcriptAction = "duplicate";
      }
    }

    const summary = getSummary.get(ORIGIN, record.session_id) as { id: string; messageCount: number | null } | undefined;
    let summaryAction: Plan["summaryAction"];
    if (!summary) {
      // A cross-id content duplicate (dedup via fingerprint, no row of its own) gets no summary.
      summaryAction = transcriptAction === "duplicate" && !existing ? "reuse" : "create";
    } else if (rewriteSummaries || record.messages.length > (summary.messageCount ?? 0)) {
      summaryAction = "update";
    } else {
      summaryAction = "reuse";
    }

    plans.push({
      record,
      contentHash,
      transcriptHash,
      messagesJson,
      transcriptAction,
      summaryAction,
      existingSummaryId: summary?.id ?? null,
    });
  }
  return { plans, skipped_empty };
}

export async function ingestTranscriptRecords(
  db: Database.Database,
  records: WorkTranscriptRecord[],
  options: IngestOptions = {},
): Promise<TranscriptIngestStats> {
  const summaryMode = options.summaryMode ?? "raw";
  const sourceLabel = options.sourceLabel ?? "blob:unknown";
  const { plans, skipped_empty } = planIngest(db, records, options.rewriteSummaries);
  const stats: TranscriptIngestStats = {
    sessions: records.length,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    skipped_empty,
    summaries_created: 0,
    summaries_updated: 0,
    summaries_reused: 0,
    summary_failures: 0,
  };

  if (options.dryRun) {
    for (const plan of plans) {
      if (plan.transcriptAction === "insert") stats.inserted++;
      else if (plan.transcriptAction === "update") stats.updated++;
      else stats.duplicates++;
      if (plan.summaryAction === "create") stats.summaries_created++;
      else if (plan.summaryAction === "update") stats.summaries_updated++;
      else stats.summaries_reused++;
    }
    return stats;
  }

  const upsertTranscript = db.prepare(`
    INSERT INTO session_transcripts (
      content_hash, agent, session_id, messages_json, native_file_path,
      source_mtime_ms, model, project, started_at, ended_at,
      message_count, uncompressed_size, transcript_hash, origin_device
    ) VALUES (?, '${AGENT}', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '${ORIGIN}')
    ON CONFLICT(content_hash) DO UPDATE SET
      messages_json = excluded.messages_json,
      native_file_path = excluded.native_file_path,
      model = COALESCE(excluded.model, session_transcripts.model),
      project = COALESCE(excluded.project, session_transcripts.project),
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      message_count = excluded.message_count,
      uncompressed_size = excluded.uncompressed_size,
      transcript_hash = excluded.transcript_hash,
      origin_device = '${ORIGIN}',
      created_at = datetime('now')
  `);
  const deleteFts = db.prepare("DELETE FROM transcript_fts WHERE content_hash = ?");
  const insertFts = db.prepare(`
    INSERT INTO transcript_fts (content, content_hash, chunk_index, agent, project, started_at)
    VALUES (?, ?, ?, '${AGENT}', ?, ?)
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO transcript_index_meta (content_hash, chunk_count, indexed_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(content_hash) DO UPDATE SET
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at
  `);
  const insertSummary = db.prepare(`
    INSERT INTO session_summaries (
      id, agent, native_session_id, started_at, ended_at,
      model, project, title, message_count, summary,
      raw_excerpt, is_sub_agent, content_hash, origin_device,
      processed_for_promotion, searchable
    ) VALUES (?, '${AGENT}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${ORIGIN}', 1, 1)
  `);
  const updateSummary = db.prepare(`
    UPDATE session_summaries
    SET ended_at = ?, model = ?, project = ?, title = ?, message_count = ?,
        summary = ?, raw_excerpt = ?, is_sub_agent = ?, content_hash = ?
    WHERE id = ?
  `);
  const upsertIndex = db.prepare(`
    INSERT INTO cli_session_index (
      id, agent, native_session_id, native_file_path,
      started_at, ended_at, imported_at,
      content_hash, log_date, message_count, token_estimate,
      status, is_sub_agent, project, title, model
    ) VALUES (?, '${AGENT}', ?, ?, ?, ?, datetime('now'), ?, ?, ?, NULL, 'imported', ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      native_file_path = excluded.native_file_path,
      ended_at = excluded.ended_at,
      imported_at = excluded.imported_at,
      log_date = excluded.log_date,
      message_count = excluded.message_count,
      status = 'imported',
      error = NULL,
      is_sub_agent = excluded.is_sub_agent,
      project = excluded.project,
      title = excluded.title,
      model = excluded.model
  `);

  const writeTranscript = db.transaction((plan: Plan) => {
    const { record } = plan;
    upsertTranscript.run(
      plan.contentHash,
      record.session_id,
      plan.messagesJson,
      sourceLabel,
      record.model ?? null,
      record.directory ?? null,
      record.started_at,
      record.ended_at,
      record.messages.length,
      Buffer.byteLength(plan.messagesJson, "utf8"),
      plan.transcriptHash,
    );
    const chunks = transcriptChunks(record.messages);
    deleteFts.run(plan.contentHash);
    chunks.forEach((chunk, index) => insertFts.run(chunk, plan.contentHash, index, record.directory ?? null, record.started_at));
    upsertMeta.run(plan.contentHash, chunks.length);
  });

  const writeSummary = db.transaction((plan: Plan, summary: string) => {
    const { record } = plan;
    const parsed = toParsedSession(record, plan.contentHash, sourceLabel);
    const title = record.title && record.title !== "(cleared)" ? record.title.slice(0, 200) : generateTitle(parsed);
    const rawExcerpt = buildRawExcerpt(parsed);
    const isSubAgent = record.parent_id ? 1 : 0;
    const summaryId = plan.existingSummaryId ?? `${ORIGIN}:session:${record.session_id}`;
    if (plan.summaryAction === "update" && plan.existingSummaryId) {
      updateSummary.run(
        record.ended_at, record.model ?? null, record.directory ?? null, title, record.messages.length,
        summary, rawExcerpt, isSubAgent, plan.contentHash, plan.existingSummaryId,
      );
    } else {
      insertSummary.run(
        summaryId, record.session_id, record.started_at, record.ended_at,
        record.model ?? null, record.directory ?? null, title, record.messages.length,
        summary, rawExcerpt, isSubAgent, plan.contentHash,
      );
    }
    upsertIndex.run(
      summaryId, record.session_id, sourceLabel, record.started_at, record.ended_at,
      plan.contentHash, getLogDate(parsed), record.messages.length, isSubAgent,
      record.directory ?? "", title, record.model ?? null,
    );
  });

  for (const plan of plans) {
    if (options.signal?.aborted) throw new Error("Ingest aborted");

    if (plan.transcriptAction === "duplicate") {
      stats.duplicates++;
    } else {
      writeTranscript(plan);
      plan.transcriptAction === "update" ? stats.updated++ : stats.inserted++;
    }

    if (plan.summaryAction === "reuse") {
      stats.summaries_reused++;
      continue;
    }

    // Summaries are written per-session (not in one big transaction) so a harness
    // failure mid-batch keeps every session already summarised. Re-runs are idempotent.
    const parsed = toParsedSession(plan.record, plan.contentHash, sourceLabel);
    let summary: string;
    try {
      summary = summaryMode === "raw"
        ? rawSummary(plan.record.messages)
        : summaryMode === "template"
          ? templateSummary(parsed)
          : await summarizeSession(parsed, options.signal);
    } catch (error) {
      logger.warn({ error, sessionId: plan.record.session_id }, "Work session summary failed; using template");
      summary = templateSummary(parsed);
      stats.summary_failures++;
    }
    writeSummary(plan, summary);
    plan.summaryAction === "update" ? stats.summaries_updated++ : stats.summaries_created++;
  }
  return stats;
}

function extractJsonlFromArchive(archivePath: string): string {
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

function readSource(localPath: string): string {
  if (localPath.endsWith(".tar.gz")) return extractJsonlFromArchive(localPath);
  if (localPath.endsWith(".jsonl")) {
    if (statSync(localPath).size > MAX_JSONL_BYTES) throw new Error("JSONL exceeds size limit");
    return readFileSync(localPath, "utf8");
  }
  throw new Error("Source must be a .tar.gz archive or a .jsonl file");
}

async function ingestFromLocalPath(
  db: Database.Database,
  localPath: string,
  sourceLabel: string,
  options: IngestOptions,
): Promise<WorkTranscriptIngestResult> {
  const { records, schema } = parseTranscriptJsonl(readSource(localPath));
  const stats = await ingestTranscriptRecords(db, records, { ...options, sourceLabel });
  return {
    source: sourceLabel,
    schema,
    dates: [...new Set(records.map((record) => record.started_at?.slice(0, 10)).filter((date): date is string => Boolean(date)))].sort(),
    dry_run: Boolean(options.dryRun),
    ...stats,
  };
}

/** Ingest a local .jsonl or .tar.gz extract. */
export async function ingestWorkOpencodeFile(
  db: Database.Database,
  filePath: string,
  options: IngestOptions = {},
): Promise<WorkTranscriptIngestResult> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return ingestFromLocalPath(db, filePath, `file:${filePath}`, options);
}

/** Ingest one exact blob (.tar.gz with sha256 metadata, or a plain .jsonl). */
export async function ingestWorkOpencodeBlob(
  db: Database.Database,
  blobName: string,
  options: IngestOptions = {},
): Promise<WorkTranscriptIngestResult> {
  const isArchive = blobName.endsWith(".tar.gz");
  const isJsonl = blobName.endsWith(".jsonl");
  if (!isArchive && !isJsonl) throw new Error("Blob must be a .tar.gz archive or a .jsonl extract");

  const properties = await getBlobProperties(blobName);
  const archiveSha = properties.metadata?.sha256 ?? "";
  if (properties.size <= 0 || properties.size > (isArchive ? MAX_ARCHIVE_BYTES : MAX_JSONL_BYTES)) {
    throw new Error("Blob size is invalid");
  }
  // Archives are produced by the extractor skill and always carry sha256 metadata.
  // Plain .jsonl extracts are uploaded by hand; verify the hash only when present.
  if (isArchive && !/^[a-f0-9]{64}$/.test(archiveSha)) throw new Error("Blob is missing valid SHA-256 metadata");

  const staging = mkdtempSync(join(tmpdir(), "work-opencode-ingest-"));
  const localPath = join(staging, isArchive ? "archive.tar.gz" : "extract.jsonl");
  try {
    await downloadBlob(blobName, localPath);
    if (!existsSync(localPath) || statSync(localPath).size !== properties.size) {
      throw new Error("Downloaded size mismatch");
    }
    if (archiveSha && sha256(readFileSync(localPath)) !== archiveSha) throw new Error("Downloaded SHA-256 mismatch");
    const label = `blob:${blobName}@${properties.lastModified.toISOString()}`;
    return await ingestFromLocalPath(db, localPath, label, options);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
