import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneExpiredVideoEvidence } from "../src/youtube/video-evidence.js";

const OLD = "2026-01-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";

function manifest(videoId: string, expiresAt: string, videoFile: string) {
  return JSON.stringify({ version: 1, videoId, acquisitions: [{
    acquiredAt: OLD, expiresAt, videoFile, contactSheetFiles: ["contact-sheet-kept.png"],
    frames: [{ timestampSec: 30, file: "frame-kept.png" }], durationSec: 60,
    frameIntervalSec: 30, maxFrames: 48, samplingTruncated: false,
  }] });
}

test("video evidence pruning removes only expired managed payloads and partials", () => {
  const root = mkdtempSync(join(tmpdir(), "homer-video-evidence-"));
  try {
    const oldId = "abcdefghijk";
    const recentId = "lmnopqrstuv";
    const oldDir = join(root, oldId);
    const recentDir = join(root, recentId);
    mkdirSync(oldDir); mkdirSync(recentDir);
    const oldVideo = "video-20260101T000000Z.mp4";
    const recentVideo = "video-20260101T000000Z.mp4";
    writeFileSync(join(oldDir, "manifest.json"), manifest(oldId, OLD, oldVideo));
    writeFileSync(join(recentDir, "manifest.json"), manifest(recentId, FUTURE, recentVideo).replace(OLD, FUTURE));
    writeFileSync(join(oldDir, oldVideo), "video");
    writeFileSync(join(recentDir, recentVideo), "video");
    writeFileSync(join(oldDir, "video-20260101T000000Z.mp4.part"), "partial");
    writeFileSync(join(oldDir, "video-20260912T000000Z.mp4.part"), "fresh partial");
    writeFileSync(join(oldDir, "frame-kept.png"), "frame");
    writeFileSync(join(oldDir, "contact-sheet-kept.png"), "sheet");
    writeFileSync(join(oldDir, "notes.txt"), "must stay");

    const result = pruneExpiredVideoEvidence({ root, now: new Date("2026-09-13T00:00:00.000Z") });
    assert.deepEqual(result, { expiredAcquisitions: 1, videoPayloadsRemoved: 1, partialsRemoved: 1, skippedSymlinks: 0 });
    assert.equal(readFileSync(join(oldDir, "manifest.json"), "utf8"), manifest(oldId, OLD, oldVideo));
    assert.equal(readFileSync(join(oldDir, "frame-kept.png"), "utf8"), "frame");
    assert.equal(readFileSync(join(oldDir, "contact-sheet-kept.png"), "utf8"), "sheet");
    assert.equal(readFileSync(join(oldDir, "notes.txt"), "utf8"), "must stay");
    assert.equal(readFileSync(join(oldDir, "video-20260912T000000Z.mp4.part"), "utf8"), "fresh partial");
    assert.equal(readFileSync(join(recentDir, recentVideo), "utf8"), "video");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid retention timestamps and referenced payloads are never pruned", () => {
  const root = mkdtempSync(join(tmpdir(), "homer-video-evidence-"));
  try {
    const id = "abcdefghijk";
    const dir = join(root, id);
    const video = "video-20260101T000000Z.mp4";
    mkdirSync(dir);
    const unsafeTimestamp = JSON.stringify({ version: 1, videoId: id, acquisitions: [{
      acquiredAt: OLD, expiresAt: "definitely-not-a-date", videoFile: video,
      contactSheetFiles: [], frames: [], durationSec: 1, frameIntervalSec: 30, maxFrames: 48, samplingTruncated: false,
    }] });
    writeFileSync(join(dir, "manifest.json"), unsafeTimestamp);
    writeFileSync(join(dir, video), "preserve");
    const result = pruneExpiredVideoEvidence({ root, now: new Date("2026-09-13T00:00:00.000Z") });
    assert.equal(result.videoPayloadsRemoved, 0);
    assert.equal(readFileSync(join(dir, video), "utf8"), "preserve");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orphaned managed payloads and partials expire from their immutable filename timestamp", () => {
  const root = mkdtempSync(join(tmpdir(), "homer-video-evidence-"));
  try {
    const id = "abcdefghijk";
    const dir = join(root, id);
    mkdirSync(dir);
    writeFileSync(join(dir, "video-20260101T000000Z.mp4"), "orphan video");
    writeFileSync(join(dir, "video-20260101T000000Z.mp4.part"), "orphan partial");
    writeFileSync(join(dir, "frame-extra-30.png"), "durable frame");
    const result = pruneExpiredVideoEvidence({ root, now: new Date("2026-09-13T00:00:00.000Z") });
    assert.equal(result.videoPayloadsRemoved, 1);
    assert.equal(result.partialsRemoved, 1);
    assert.equal(readFileSync(join(dir, "frame-extra-30.png"), "utf8"), "durable frame");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("video evidence pruning never follows a video-directory symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "homer-video-evidence-"));
  const outside = mkdtempSync(join(tmpdir(), "homer-video-evidence-outside-"));
  try {
    const id = "abcdefghijk";
    const protectedFile = join(outside, "video-20260101T000000Z.mp4");
    writeFileSync(protectedFile, "outside video");
    symlinkSync(outside, join(root, id));
    const result = pruneExpiredVideoEvidence({ root, now: new Date("2026-09-13T00:00:00.000Z") });
    assert.equal(result.skippedSymlinks, 1);
    assert.equal(readFileSync(protectedFile, "utf8"), "outside video");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("video evidence pruning refuses a symlinked manifest without touching its payload", () => {
  const root = mkdtempSync(join(tmpdir(), "homer-video-evidence-"));
  const outside = mkdtempSync(join(tmpdir(), "homer-video-evidence-outside-"));
  try {
    const id = "abcdefghijk";
    const dir = join(root, id);
    const video = "video-20260101T000000Z.mp4";
    mkdirSync(dir);
    writeFileSync(join(dir, video), "preserve");
    const outsideManifest = join(outside, "manifest.json");
    writeFileSync(outsideManifest, manifest(id, OLD, video));
    symlinkSync(outsideManifest, join(dir, "manifest.json"));
    const result = pruneExpiredVideoEvidence({ root, now: new Date("2026-09-13T00:00:00.000Z") });
    assert.equal(result.videoPayloadsRemoved, 0);
    assert.equal(readFileSync(join(dir, video), "utf8"), "preserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
