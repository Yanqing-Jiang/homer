#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BlobServiceClient } from "@azure/storage-blob";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = join(SCRIPT_DIR, "extract-opencode-transcripts.mjs");
const DEFAULT_PREFIX = "worklaptop/opencode-transcripts/";

function usage() {
  console.log(`Usage:
  node archive-opencode-transcripts.mjs --db <downloaded-opencode.db> [options]

Options:
  --blob-prefix <prefix>  Blob prefix (default: worklaptop/opencode-transcripts/)
  --since <ISO-or-date>   Only sessions updated at or after this time
  --session <ses_id>      Extract one session
  --include-active        Include sessions updated in the last 30 minutes
  --keep-db               Keep the downloaded source snapshot after verified upload
  --help                  Show this help

Environment:
  AZURE_STORAGE_CONNECTION_STRING  Required
  AZURE_STORAGE_CONTAINER          Optional; default homer-data`);
}

function parseArgs(argv) {
  const args = {
    dbPath: "",
    blobPrefix: DEFAULT_PREFIX,
    since: undefined,
    sessionId: undefined,
    includeActive: false,
    keepDb: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--db" && value) {
      args.dbPath = resolve(value);
      i++;
    } else if (arg === "--blob-prefix" && value) {
      args.blobPrefix = value.replace(/^\/+/, "").replace(/\/?$/, "/");
      i++;
    } else if (arg === "--since" && value) {
      args.since = value;
      i++;
    } else if (arg === "--session" && value) {
      args.sessionId = value;
      i++;
    } else if (arg === "--include-active") {
      args.includeActive = true;
    } else if (arg === "--keep-db") {
      args.keepDb = true;
    } else if (arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.dbPath) throw new Error("--db is required");
  if (!existsSync(args.dbPath)) throw new Error(`Database not found: ${args.dbPath}`);
  return args;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");

  const containerName = process.env.AZURE_STORAGE_CONTAINER || "homer-data";
  const stagingRoot = mkdtempSync(join(tmpdir(), "opencode-transcripts-"));
  const transcriptDir = join(stagingRoot, "transcripts");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `opencode-transcripts-${stamp}-${randomUUID().slice(0, 8)}.tar.gz`;
  const archivePath = join(stagingRoot, archiveName);
  const blobName = `${args.blobPrefix}${archiveName}`;
  let uploaded = false;

  try {
    const extractorArgs = [EXTRACTOR, "--db", args.dbPath, "--output", transcriptDir];
    if (args.since) extractorArgs.push("--since", args.since);
    if (args.sessionId) extractorArgs.push("--session", args.sessionId);
    if (args.includeActive) extractorArgs.push("--include-active");
    const extraction = run(process.execPath, extractorArgs);

    run("tar", ["-czf", archivePath, "-C", transcriptDir, "."]);
    const archiveSize = statSync(archivePath).size;
    const archiveSha256 = await sha256File(archivePath);

    const service = BlobServiceClient.fromConnectionString(connectionString);
    const blockBlob = service.getContainerClient(containerName).getBlockBlobClient(blobName);
    await blockBlob.uploadFile(archivePath, {
      blobHTTPHeaders: { blobContentType: "application/gzip" },
      metadata: {
        sha256: archiveSha256,
        source: "worklaptop_opencode",
        contents: "timestamped_user_assistant_text",
      },
      tier: "Cool",
    });

    const properties = await blockBlob.getProperties();
    if (properties.contentLength !== archiveSize || properties.metadata?.sha256 !== archiveSha256) {
      throw new Error("Blob verification failed: uploaded size or SHA-256 metadata does not match");
    }
    uploaded = true;

    if (!args.keepDb) rmSync(args.dbPath, { force: true });
    console.log(JSON.stringify({
      uploaded: true,
      container: containerName,
      blob: blobName,
      bytes: archiveSize,
      sha256: archiveSha256,
      source_db_removed: !args.keepDb,
      extraction,
    }));
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    if (!uploaded) {
      console.error(`Upload was not verified; source database retained at ${args.dbPath}`);
    }
  }
}

main().catch((error) => {
  console.error(`OpenCode transcript archive failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
