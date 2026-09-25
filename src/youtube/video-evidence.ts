/**
 * Downloadable visual evidence for YouTube reviews.
 *
 * Videos are deliberately kept separate from transcripts: a scheduled cleanup
 * removes each evidence set (video payload, manifest, PNG frames and contact
 * sheets) 30 days after acquisition. Evidence lives on Depot.
 */

import { spawn } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { PATHS } from "../config/paths.js";

export const VIDEO_EVIDENCE_RETENTION_DAYS = 30;
export const VIDEO_EVIDENCE_FRAME_INTERVAL_SECONDS = 30;
export const VIDEO_EVIDENCE_MAX_FRAMES = 48;
export const VIDEO_EVIDENCE_ROOT = PATHS.youtubeVideoEvidence;

export interface VideoEvidenceFrame {
  timestampSec: number;
  path: string;
}

export interface VideoEvidenceAcquisition {
  acquiredAt: string;
  expiresAt: string;
  videoFile: string;
  contactSheetFiles: string[];
  frames: Array<{ timestampSec: number; file: string }>;
  durationSec: number;
  frameIntervalSec: number;
  maxFrames: number;
  /** True when the requested 30-second cadence was widened to cap work. */
  samplingTruncated: boolean;
}

interface VideoEvidenceManifest {
  version: 1;
  videoId: string;
  acquisitions: VideoEvidenceAcquisition[];
}

export interface VideoEvidenceResult {
  manifestPath: string;
  videoPath: string;
  contactSheetPaths: string[];
  frames: VideoEvidenceFrame[];
  acquiredAt: string;
  expiresAt: string;
  durationSec: number;
  samplingTruncated: boolean;
}

export interface PrepareVideoEvidenceOptions {
  root?: string;
  now?: Date;
  /** Test-only override; production uses yt-dlp. */
  ytDlpCommand?: string;
  /** Test-only override; production uses ffmpeg. */
  ffmpegCommand?: string;
}

export interface PruneVideoEvidenceOptions {
  root?: string;
  now?: Date;
}

export interface PruneVideoEvidenceResult {
  expiredAcquisitions: number;
  videoPayloadsRemoved: number;
  partialsRemoved: number;
  skippedSymlinks: number;
  evidenceSetsRemoved: number;
}

function assertVideoId(videoId: string): void {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error("YouTube video ID must be exactly 11 URL-safe characters");
  }
}

function directoryFor(root: string, videoId: string): string {
  const base = resolve(root);
  const dir = resolve(base, videoId);
  if (relative(base, dir) !== videoId) throw new Error("Unsafe video evidence path");
  return dir;
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function regularDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    if (!regularDirectory(path)) throw new Error(`Evidence directory is not a real directory: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-600)}`));
    });
  });
}

function readManifest(path: string, videoId: string): VideoEvidenceManifest {
  const manifestStat = lstatOrNull(path);
  if (manifestStat === null) return { version: 1, videoId, acquisitions: [] };
  if (!manifestStat.isFile()) throw new Error(`Evidence manifest is not a regular file: ${path}`);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as VideoEvidenceManifest;
    if (value.version === 1 && value.videoId === videoId && Array.isArray(value.acquisitions)
      && value.acquisitions.every(validAcquisitionPaths)) return value;
  } catch {
    // Do not overwrite a malformed file: video downloads are allowed to fail loudly.
  }
  throw new Error(`Invalid evidence manifest: ${path}`);
}

function writeManifest(path: string, manifest: VideoEvidenceManifest): void {
  const manifestStat = lstatOrNull(path);
  if (manifestStat && !manifestStat.isFile()) throw new Error(`Refusing to write non-regular evidence manifest: ${path}`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function isSafeName(value: unknown): value is string {
  return typeof value === "string" && basename(value) === value && value.length > 0;
}

function validAcquisitionPaths(value: unknown): value is VideoEvidenceAcquisition {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<VideoEvidenceAcquisition>;
  return isSafeName(entry.videoFile)
    && Array.isArray(entry.contactSheetFiles) && entry.contactSheetFiles.every(isSafeName)
    && Array.isArray(entry.frames) && entry.frames.every((frame) => frame && isSafeName(frame.file)
      && typeof frame.timestampSec === "number" && Number.isFinite(frame.timestampSec));
}

function toResult(dir: string, manifestPath: string, record: VideoEvidenceAcquisition): VideoEvidenceResult {
  return {
    manifestPath,
    videoPath: join(dir, record.videoFile),
    contactSheetPaths: record.contactSheetFiles.map((file) => join(dir, file)),
    frames: record.frames.map((frame) => ({ timestampSec: frame.timestampSec, path: join(dir, frame.file) })),
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
    durationSec: record.durationSec,
    samplingTruncated: record.samplingTruncated,
  };
}

function timestampsFor(durationSec: number): { timestamps: number[]; truncated: boolean; interval: number } {
  // Seeking precisely at a stream's reported duration can yield no frame.
  const lastTimestamp = Math.max(0, Math.floor(durationSec) - 1);
  const naturalCount = Math.floor(lastTimestamp / VIDEO_EVIDENCE_FRAME_INTERVAL_SECONDS) + 1;
  const count = Math.min(naturalCount, VIDEO_EVIDENCE_MAX_FRAMES);
  const interval = naturalCount > VIDEO_EVIDENCE_MAX_FRAMES
    ? lastTimestamp / Math.max(1, VIDEO_EVIDENCE_MAX_FRAMES - 1)
    : VIDEO_EVIDENCE_FRAME_INTERVAL_SECONDS;
  const timestamps = Array.from({ length: count }, (_, index) => {
    if (index === count - 1 && naturalCount > VIDEO_EVIDENCE_MAX_FRAMES) return lastTimestamp;
    return Math.min(lastTimestamp, Math.round(index * interval));
  });
  return { timestamps: [...new Set(timestamps)], truncated: naturalCount > VIDEO_EVIDENCE_MAX_FRAMES, interval };
}

function isManagedPayload(name: string): boolean {
  return /^video-[0-9]{8}T[0-9]{6}Z\.(?:mp4|mkv|webm|mov|m4v)$/i.test(name);
}

function isManagedPartial(name: string): boolean {
  return /^video-[0-9]{8}T[0-9]{6}Z\..+\.(?:part|ytdl)$/i.test(name)
    || /^video-[0-9]{8}T[0-9]{6}Z\.(?:part|ytdl)$/i.test(name);
}

function safeUnlink(dir: string, name: string): boolean {
  if (basename(name) !== name) return false;
  const file = join(dir, name);
  try {
    if (!lstatSync(file).isFile()) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function stampFromFile(name: string): string | null {
  return name.match(/^video-([0-9]{8}T[0-9]{6}Z)(?:\.|$)/)?.[1] ?? null;
}

function dateForManagedFile(dir: string, name: string): Date | null {
  const stamp = stampFromFile(name);
  if (stamp) {
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
    const parsed = new Date(iso);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  try {
    const mtime = statSync(join(dir, name)).mtime;
    return Number.isFinite(mtime.getTime()) ? mtime : null;
  } catch { return null; }
}

function isExpiredAcquisition(entry: VideoEvidenceAcquisition, now: Date): boolean {
  // Both stored dates must be valid. The deadline is recomputed from the
  // immutable acquisition date so a malformed or forged expiresAt never deletes.
  const acquired = new Date(entry.acquiredAt);
  const declaredExpiry = new Date(entry.expiresAt);
  if (!Number.isFinite(acquired.getTime()) || !Number.isFinite(declaredExpiry.getTime())) return false;
  return now.getTime() >= acquired.getTime() + VIDEO_EVIDENCE_RETENTION_DAYS * 86_400_000;
}

function isOlderThanRetention(dir: string, name: string, now: Date): boolean {
  const acquired = dateForManagedFile(dir, name);
  return acquired !== null && now.getTime() >= acquired.getTime() + VIDEO_EVIDENCE_RETENTION_DAYS * 86_400_000;
}

function contactSheetFilesFor(stamp: string, frameCount: number): string[] {
  return Array.from({ length: Math.ceil(frameCount / 24) }, (_, index) => `contact-sheet-${stamp}-${String(index + 1).padStart(3, "0")}.png`);
}

function timestampLabel(timestampSec: number, index: number): string {
  const hours = Math.floor(timestampSec / 3600);
  const minutes = Math.floor((timestampSec % 3600) / 60);
  const seconds = timestampSec % 60;
  return `${String(index + 1).padStart(3, "0")}  ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Homebrew's ffmpeg build does not include drawtext. Pillow keeps this
// deterministic, labels the panels, and composites directly from the exact
// full-resolution PNGs named in the manifest.
const CONTACT_SHEET_PYTHON = String.raw`
import json, sys
from PIL import Image, ImageDraw, ImageFont

out, font_path, panels_json = sys.argv[1:]
panels = json.loads(panels_json)
panel_w, panel_h, label_h, cols = 320, 180, 28, 4
rows = (len(panels) + cols - 1) // cols
canvas = Image.new("RGB", (cols * panel_w, rows * (panel_h + label_h)), "black")
try:
    font = ImageFont.truetype(font_path, 18)
except Exception:
    font = ImageFont.load_default()
for i, panel in enumerate(panels):
    with Image.open(panel["path"]) as source:
        image = source.convert("RGB")
        image.thumbnail((panel_w, panel_h), Image.Resampling.LANCZOS)
        x = (i % cols) * panel_w + (panel_w - image.width) // 2
        y = (i // cols) * (panel_h + label_h) + (panel_h - image.height) // 2
        canvas.paste(image, (x, y))
    label_y = (i // cols) * (panel_h + label_h) + panel_h
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((i % cols * panel_w, label_y, (i % cols + 1) * panel_w, label_y + label_h), fill="black")
    draw.text(((i % cols) * panel_w + 6, label_y + 4), panel["label"], fill="white", font=font)
canvas.save(out, "PNG", optimize=True)
`;

async function buildContactSheets(
  dir: string, record: VideoEvidenceAcquisition,
): Promise<void> {
  const font = "/System/Library/Fonts/SFCompact.ttf";
  for (const file of record.contactSheetFiles) {
    const existing = lstatOrNull(join(dir, file));
    if (existing && !existing.isFile()) throw new Error(`Refusing to overwrite non-regular contact sheet: ${file}`);
    if (existing) safeUnlink(dir, file);
  }
  for (let sheetIndex = 0; sheetIndex < record.contactSheetFiles.length; sheetIndex++) {
    const start = sheetIndex * 24;
    const chunk = record.frames.slice(start, start + 24);
    const panels = chunk.map((frame, index) => ({ path: join(dir, frame.file), label: timestampLabel(frame.timestampSec, start + index) }));
    await run("python3", ["-c", CONTACT_SHEET_PYTHON, join(dir, record.contactSheetFiles[sheetIndex]!), font, JSON.stringify(panels)], 60_000);
    if (!regularFile(join(dir, record.contactSheetFiles[sheetIndex]!))) throw new Error("Pillow did not create a contact sheet");
  }
}

async function completeEvidenceAssets(dir: string, record: VideoEvidenceAcquisition, ffmpeg: string): Promise<void> {
  for (const frame of record.frames) {
    const target = join(dir, frame.file);
    const existing = lstatOrNull(target);
    if (existing?.isFile()) continue;
    if (existing) throw new Error(`Refusing to overwrite non-regular frame: ${frame.file}`);
    await run(ffmpeg, ["-y", "-loglevel", "error", "-ss", String(frame.timestampSec), "-i", join(dir, record.videoFile), "-frames:v", "1", join(dir, frame.file)], 60_000);
    if (!regularFile(join(dir, frame.file))) throw new Error(`ffmpeg did not create frame ${frame.timestampSec}`);
  }
  if (!record.contactSheetFiles.every((file) => regularFile(join(dir, file)))) await buildContactSheets(dir, record);
}

/**
 * Download a reviewable (max 1080p) copy, capture original-resolution frames,
 * and create contact sheets. Each re-download is represented by an append-only
 * acquisition entry so the acquisition time for an existing payload is never
 * rewritten.
 */
export async function prepareVideoEvidence(
  videoId: string,
  durationSec: number,
  options: PrepareVideoEvidenceOptions = {},
): Promise<VideoEvidenceResult> {
  assertVideoId(videoId);
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new Error("durationSec must be a non-negative number");
  const root = options.root ?? VIDEO_EVIDENCE_ROOT;
  if (!options.root && !existsSync(PATHS.depotSentinel)) {
    throw new Error(`Depot not mounted (${PATHS.depotSentinel} missing); video evidence not written`);
  }
  ensureDirectory(root);
  const dir = directoryFor(root, videoId);
  ensureDirectory(dir);
  const manifestPath = join(dir, "manifest.json");
  const manifest = readManifest(manifestPath, videoId);
  const current = manifest.acquisitions.find((entry) => regularFile(join(dir, entry.videoFile)));
  if (current) {
    await completeEvidenceAssets(dir, current, options.ffmpegCommand ?? "ffmpeg");
    return toResult(dir, manifestPath, current);
  }

  const now = options.now ?? new Date();
  const acquiredAt = now.toISOString();
  const stamp = acquiredAt.replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z");
  const fileStem = `video-${stamp}`;
  const ytdlp = options.ytDlpCommand ?? "yt-dlp";
  const ffmpeg = options.ffmpegCommand ?? "ffmpeg";
  const outputTemplate = join(dir, `${fileStem}.%(ext)s`);
  for (const name of readdirSync(dir)) {
    if (name.startsWith(fileStem) && !regularFile(join(dir, name))) {
      throw new Error(`Refusing to overwrite non-regular video output: ${name}`);
    }
  }
  await run(ytdlp, [
    "--no-playlist", "--no-progress", "--quiet",
    "-f", "bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]",
    "--remux-video", "mp4",
    "-o", outputTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ], 5 * 60_000);

  const videoFile = readdirSync(dir).find((name) => isManagedPayload(name) && name.startsWith(fileStem));
  if (!videoFile || !regularFile(join(dir, videoFile))) throw new Error("yt-dlp completed without a managed video payload");
  const expiresAt = new Date(now.getTime() + VIDEO_EVIDENCE_RETENTION_DAYS * 86_400_000).toISOString();
  const { timestamps, truncated, interval } = timestampsFor(durationSec);
  const acquisition: VideoEvidenceAcquisition = {
    acquiredAt, expiresAt, videoFile,
    contactSheetFiles: contactSheetFilesFor(stamp, timestamps.length),
    frames: timestamps.map((timestampSec, index) => ({
      timestampSec,
      file: `frame-${stamp}-${String(index + 1).padStart(3, "0")}-${String(timestampSec).padStart(6, "0")}.png`,
    })),
    durationSec,
    frameIntervalSec: interval, maxFrames: VIDEO_EVIDENCE_MAX_FRAMES, samplingTruncated: truncated,
  };
  // Persist expected assets first. A later ffmpeg failure is recoverable: the
  // next run sees the payload and finishes only missing frames/sheets.
  manifest.acquisitions.push(acquisition);
  writeManifest(manifestPath, manifest);
  await completeEvidenceAssets(dir, acquisition, ffmpeg);
  return toResult(dir, manifestPath, acquisition);
}

/** Remove expired video payloads, partials and whole evidence sets (30d). */
export function pruneExpiredVideoEvidence(options: PruneVideoEvidenceOptions = {}): PruneVideoEvidenceResult {
  const root = options.root ?? VIDEO_EVIDENCE_ROOT;
  const now = options.now ?? new Date();
  const result: PruneVideoEvidenceResult = { expiredAcquisitions: 0, videoPayloadsRemoved: 0, partialsRemoved: 0, skippedSymlinks: 0, evidenceSetsRemoved: 0 };
  if (!regularDirectory(root)) return result;
  for (const videoId of readdirSync(root)) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const dir = directoryFor(root, videoId);
    let stat;
    try { stat = lstatSync(dir); } catch { continue; }
    if (stat.isSymbolicLink()) { result.skippedSymlinks++; continue; }
    if (!stat.isDirectory()) continue;
    const manifestPath = join(dir, "manifest.json");
    const manifestExists = lstatOrNull(manifestPath) !== null;
    let manifest: VideoEvidenceManifest | null = null;
    try { manifest = readManifest(manifestPath, videoId); } catch { continue; }
    const referencedPayloads = new Set(manifest.acquisitions.map((entry) => entry.videoFile));
    for (const acquisition of manifest.acquisitions) {
      if (!isExpiredAcquisition(acquisition, now)) continue;
      result.expiredAcquisitions++;
      if (isManagedPayload(acquisition.videoFile) && safeUnlink(dir, acquisition.videoFile)) result.videoPayloadsRemoved++;
    }
    // Failed downloads have no valid manifest. Timestamped file names provide
    // an immutable acquisition time; fall back to mtime only when no stamp is
    // available. A valid manifest protects all of its named payloads, even if
    // its expiry metadata is malformed.
    for (const name of readdirSync(dir)) {
      if (isManagedPartial(name) && isOlderThanRetention(dir, name, now) && safeUnlink(dir, name)) result.partialsRemoved++;
      if (!manifestExists && isManagedPayload(name) && isOlderThanRetention(dir, name, now) && safeUnlink(dir, name)) result.videoPayloadsRemoved++;
      if (manifestExists && !referencedPayloads.has(name) && isManagedPayload(name)
        && isOlderThanRetention(dir, name, now) && safeUnlink(dir, name)) result.videoPayloadsRemoved++;
    }
    // Only files the manifest names are removed; unmanaged files keep the
    // directory alive.
    if (manifest.acquisitions.length > 0
      && manifest.acquisitions.every((entry) => isExpiredAcquisition(entry, now))) {
      for (const entry of manifest.acquisitions) {
        for (const file of [...entry.contactSheetFiles, ...entry.frames.map((frame) => frame.file)]) safeUnlink(dir, file);
      }
      if (safeUnlink(dir, "manifest.json")) result.evidenceSetsRemoved++;
      try { rmdirSync(dir); } catch { /* unmanaged files remain */ }
    }
  }
  return result;
}
