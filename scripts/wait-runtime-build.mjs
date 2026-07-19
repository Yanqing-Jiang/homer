#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
function readNumberOption(name, envName, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : process.env[envName];
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const timeoutMs = readNumberOption("--timeout-ms", "BUILD_WAIT_MS", 120000);
const pollMs = readNumberOption("--poll-ms", "BUILD_WAIT_POLL_MS", 2000);
const start = Date.now();

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function comparable(build) {
  if (!build || typeof build !== "object") return null;
  return {
    sha: build.sha ?? null,
    dirty: typeof build.dirty === "boolean" ? build.dirty : null,
    sourceFingerprint: build.sourceFingerprint ?? null,
    maxSourceMtimeMs: typeof build.maxSourceMtimeMs === "number" ? build.maxSourceMtimeMs : null,
  };
}

function sameBuild(a, b) {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const diskBuild = readJson(path.join(root, "dist", ".build-version"));
if (!diskBuild) {
  console.error("refuse: dist/.build-version is missing or invalid");
  process.exit(1);
}

while (Date.now() - start < timeoutMs) {
  const stamp = readJson(path.join(root, "run", "daemon-build.json"));
  if (stamp && sameBuild(stamp.build, diskBuild) && pidAlive(stamp.pid)) {
    console.log(`activated: runtime build matched pid ${stamp.pid}`);
    process.exit(0);
  }
  const request = readJson(process.env.HOMER_RESTART_REQUEST
    ?? path.join(process.env.HOME ?? root, "Library", "Application Support", "Homer", "restart.request"));
  if (request?.version === 1 && sameBuild(request.targetBuild, diskBuild)) {
    console.log("pending-idle: build completed and restart request remains queued for a safe idle window");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

console.error("refuse: runtime build stamp did not match current dist before timeout");
console.error(`  expected: ${JSON.stringify(comparable(diskBuild))}`);
const stamp = readJson(path.join(root, "run", "daemon-build.json"));
console.error(`  actual:   ${JSON.stringify(comparable(stamp?.build))}`);
process.exit(1);
