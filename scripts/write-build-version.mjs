#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outPath = path.join(root, "dist", ".build-version");
const sourceRoots = ["src", "package.json", "tsconfig.json"];

function git(command, fallback) {
  try {
    return execSync(command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function walk(relativePath, files) {
  const absolutePath = path.join(root, relativePath);
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolutePath).sort()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      walk(path.join(relativePath, entry), files);
    }
    return;
  }
  if (stat.isFile()) {
    files.push({
      path: relativePath.split(path.sep).join("/"),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    });
  }
}

const files = [];
for (const sourceRoot of sourceRoots) {
  walk(sourceRoot, files);
}
files.sort((a, b) => a.path.localeCompare(b.path));

const hash = createHash("sha256");
let maxSourceMtimeMs = 0;
for (const file of files) {
  maxSourceMtimeMs = Math.max(maxSourceMtimeMs, file.mtimeMs);
  hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\n`);
}

const stamp = {
  sha: git("git rev-parse --short HEAD", "unknown"),
  dirty: git("git status --short", "") !== "",
  builtAt: new Date().toISOString(),
  sourceFingerprint: hash.digest("hex"),
  maxSourceMtimeMs,
  sourceFileCount: files.length,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(stamp, null, 2)}\n`);
