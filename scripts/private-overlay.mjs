#!/usr/bin/env node
/**
 * Private overlay linker.
 *
 *   node scripts/private-overlay.mjs link [--if-present]   create/refresh symlinks declared by the manifest
 *   node scripts/private-overlay.mjs status                 show every declared link and whether git ignores it
 *   node scripts/private-overlay.mjs unlink                 remove the symlinks (private files are untouched)
 *
 * The private root is HOMER_PRIVATE_ROOT (empty disables) or the sibling
 * directory ../homer-private carrying homer-overlay.json. Only symlinks are ever
 * created or removed here; a real file or directory at a link path is refused so
 * nothing in either tree can be overwritten by accident.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "homer-overlay.json";
const [command = "status", ...flags] = process.argv.slice(2);

function resolvePrivateRoot() {
  const explicit = process.env.HOMER_PRIVATE_ROOT;
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    if (!trimmed) return null;
    return trimmed.startsWith("~/") ? path.join(process.env.HOME ?? "", trimmed.slice(2)) : path.resolve(trimmed);
  }
  const sibling = path.resolve(ROOT, "..", "homer-private");
  return existsSync(path.join(sibling, MANIFEST)) ? sibling : null;
}

const privateRoot = resolvePrivateRoot();
if (!privateRoot) {
  if (flags.includes("--if-present") || command === "status") {
    console.log("private-overlay: no private root (set HOMER_PRIVATE_ROOT or create ../homer-private/homer-overlay.json)");
    process.exit(0);
  }
  console.error("private-overlay: no private root found");
  process.exit(1);
}
const manifestPath = path.join(privateRoot, MANIFEST);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const links = Array.isArray(manifest.links) ? manifest.links : [];

function gitIgnored(relPath) {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function describe(entry) {
  const linkPath = path.join(ROOT, entry.link);
  const target = path.join(privateRoot, entry.target);
  const relTarget = path.relative(path.dirname(linkPath), target);
  let state;
  if (!existsSync(target)) state = "TARGET MISSING";
  else if (!existsSync(linkPath) && !isSymlink(linkPath)) state = "absent";
  else if (!isSymlink(linkPath)) state = "BLOCKED (real path exists)";
  else state = readlinkSync(linkPath) === relTarget ? "linked" : `STALE (-> ${readlinkSync(linkPath)})`;
  return { linkPath, target, relTarget, state };
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

let problems = 0;
for (const entry of links) {
  if (!entry || typeof entry.target !== "string" || typeof entry.link !== "string") {
    console.error(`private-overlay: bad link entry ${JSON.stringify(entry)}`); problems++; continue;
  }
  const { linkPath, relTarget, state } = describe(entry);
  const ignored = gitIgnored(entry.link);
  if (command === "status") {
    console.log(`${state.padEnd(28)} ${entry.link} -> ${relTarget}${ignored ? "" : "   [NOT GIT-IGNORED]"}`);
    if (!ignored || state.startsWith("TARGET") || state.startsWith("BLOCKED")) problems++;
    continue;
  }
  if (command === "unlink") {
    if (isSymlink(linkPath)) { unlinkSync(linkPath); console.log(`removed ${entry.link}`); }
    continue;
  }
  if (command === "link") {
    if (state === "TARGET MISSING") { console.error(`private-overlay: target missing for ${entry.link}`); problems++; continue; }
    if (state.startsWith("BLOCKED")) { console.error(`private-overlay: ${entry.link} exists and is not a symlink; move it into the private root first`); problems++; continue; }
    if (state.startsWith("STALE")) unlinkSync(linkPath);
    if (!isSymlink(linkPath)) {
      mkdirSync(path.dirname(linkPath), { recursive: true });
      symlinkSync(relTarget, linkPath);
      console.log(`linked ${entry.link} -> ${relTarget}`);
    }
    if (!ignored) { console.error(`private-overlay: ${entry.link} is NOT ignored by git — fix .gitignore before committing`); problems++; }
    continue;
  }
  console.error(`private-overlay: unknown command ${command}`); process.exit(2);
}
if (command === "link" && problems === 0) console.log(`private-overlay: ${links.length} link(s) in place from ${privateRoot}`);
process.exit(problems > 0 ? 1 : 0);
