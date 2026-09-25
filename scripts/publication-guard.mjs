#!/usr/bin/env node
/**
 * Publication guard for this public repository.
 *
 *   node scripts/publication-guard.mjs scan [--ref <refname>]... <rev>...
 *   node scripts/publication-guard.mjs release --commit <oid> --expect-remote-oid <oid> [--remote origin] [--push]
 *   node scripts/publication-guard.mjs pre-push <remote> <url>        (git pre-push hook; ref updates on stdin)
 *
 * A scan covers the FULL history reachable from each proposed tip: every path any reachable
 * commit ever touched, every reachable blob, commit and annotated-tag object text, and the ref
 * names involved. Nothing is excluded because it also exists on some other local or remote ref,
 * so content added and later deleted, force-updates and brand-new refs are all caught.
 *
 * Deployment-specific rules are NOT part of this public file. They come from a private policy:
 * HOMER_PUBLICATION_POLICY, else <private root>/config/publication-policy.json (private root =
 * HOMER_PRIVATE_ROOT or the sibling ../homer-private). A missing, empty or invalid policy fails
 * closed. Findings print rule id, scope and object/path/ref only, never the matched text; errors
 * name the failing field or git subcommand, never patterns, URLs or git stderr.
 *
 * Every git call runs with replacement objects disabled, and shallow or grafted repositories are
 * refused, so the scanned objects are exactly the objects a push would send.
 *
 * `release` never stages or commits. It resolves the remote's single push URL (which must be listed
 * in the policy's pushUrls), pins a full candidate commit id and the expected current main id AT
 * THAT URL, scans, and only with --push runs exactly
 * `git push --no-follow-tags --force-with-lease=refs/heads/main:<expected> <push-url> <candidate>:refs/heads/main`.
 * The pre-push hook refuses any destination URL not in pushUrls.
 *
 * Exit codes: 0 clean, 1 findings or refused, 2 configuration/usage/git error.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPES = ["path", "content", "message", "ref"];
const ZERO = /^0+$/;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_LISTED = 50;

class ConfigError extends Error {}

const GIT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };

function git(args, input) {
  const r = spawnSync("git", args, { input, maxBuffer: 1 << 30, encoding: "buffer", env: GIT_ENV });
  if (r.status !== 0) throw new ConfigError(`git ${args[0]} failed (exit ${r.status ?? r.signal})`);
  return r.stdout;
}

/** A full-history claim is false in a shallow or grafted repository. */
function assertCompleteHistory() {
  if (process.env.GIT_GRAFT_FILE || process.env.GIT_SHALLOW_FILE) throw new ConfigError("GIT_GRAFT_FILE/GIT_SHALLOW_FILE set; refusing");
  if (git(["rev-parse", "--is-shallow-repository"]).toString().trim() !== "false") throw new ConfigError("shallow repository: full history unavailable; refusing");
  const grafts = git(["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"]).toString().trim();
  if (existsSync(grafts)) throw new ConfigError("info/grafts present: history is rewritten locally; refusing");
}

export function policyPath(env = process.env) {
  if (env.HOMER_PUBLICATION_POLICY) return path.resolve(env.HOMER_PUBLICATION_POLICY);
  const explicit = env.HOMER_PRIVATE_ROOT?.trim();
  const root = explicit ? path.resolve(explicit) : path.resolve(ROOT, "..", "homer-private");
  return path.join(root, "config", "publication-policy.json");
}

export function loadPolicy(file) {
  if (!existsSync(file)) throw new ConfigError(`publication policy not found (${file}); refusing`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ConfigError(`publication policy is not readable JSON (${e.name})`); }
  if (raw?.version !== 1) throw new ConfigError("publication policy: version must be 1");
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) throw new ConfigError("publication policy: rules must be a non-empty array");
  const ids = new Set();
  const rules = raw.rules.map((r, i) => {
    if (typeof r?.id !== "string" || !r.id || ids.has(r.id)) throw new ConfigError(`publication policy: rules[${i}].id missing or duplicate`);
    ids.add(r.id);
    if (typeof r.pattern !== "string" || !r.pattern) throw new ConfigError(`publication policy: rules[${i}].pattern missing`);
    const flags = r.flags ?? "";
    if (typeof flags !== "string" || !/^[imsu]*$/.test(flags)) throw new ConfigError(`publication policy: rules[${i}].flags unsupported`);
    let re;
    try { re = new RegExp(r.pattern, flags); } catch (e) { throw new ConfigError(`publication policy: rules[${i}].pattern does not compile (${e.name})`); }
    if (re.test("")) throw new ConfigError(`publication policy: rules[${i}].pattern matches the empty string`);
    const scopes = r.scopes ?? SCOPES;
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => !SCOPES.includes(s))) throw new ConfigError(`publication policy: rules[${i}].scopes invalid`);
    return { id: r.id, re, scopes: new Set(scopes) };
  });
  const allowedRefs = raw.allowedRefs ?? ["refs/heads/main"];
  if (!Array.isArray(allowedRefs) || allowedRefs.length === 0 || allowedRefs.some((r) => typeof r !== "string" || !r.startsWith("refs/"))) throw new ConfigError("publication policy: allowedRefs must list full ref names");
  const pushUrls = raw.pushUrls;
  if (!Array.isArray(pushUrls) || pushUrls.length === 0 || pushUrls.some((u) => typeof u !== "string" || !u)) throw new ConfigError("publication policy: pushUrls must list the permitted push URLs");
  return { rules, allowedRefs, pushUrls };
}

function catFileBatch(oids, onObject) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"], env: GIT_ENV });
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const [oid, type, size] = buf.subarray(0, nl).toString().split(" ");
        if (type === "missing" || size === undefined) { child.kill(); return reject(new ConfigError("object missing from repository")); }
        const end = nl + 1 + Number(size);
        if (buf.length < end + 1) return;
        onObject(oid, type, buf.subarray(nl + 1, end));
        buf = buf.subarray(end + 1);
      }
    });
    child.on("error", () => reject(new ConfigError("git cat-file could not start")));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new ConfigError(`git cat-file failed (exit ${code})`))));
    child.stdin.end(oids.join("\n") + "\n");
  });
}

/** Scan the full history reachable from `tips` plus the given ref names. */
export async function scan(policy, tips, refNames = []) {
  assertCompleteHistory();
  const findings = [];
  const add = (rule, scope, where) => findings.push({ rule: rule.id, scope, where });
  // texts: UTF-8 decoding for Unicode patterns plus a byte-preserving latin1 view for binary content.
  const test = (scope, texts, where) => {
    for (const rule of policy.rules) if (rule.scopes.has(scope) && [].concat(texts).some((t) => (rule.re.lastIndex = 0, rule.re.test(t)))) add(rule, scope, where);
  };
  const oids = tips.map((t) => git(["rev-parse", "--verify", "--end-of-options", `${t}^{object}`]).toString().trim());
  for (const ref of refNames) test("ref", ref, ref);

  const hints = new Map();
  const listed = git(["rev-list", "--objects", ...oids]).toString().split("\n").filter(Boolean);
  for (const line of listed) { const sp = line.indexOf(" "); hints.set(sp < 0 ? line : line.slice(0, sp), sp < 0 ? "" : line.slice(sp + 1)); }
  // Annotated tags given as tips are not always listed by rev-list; peel them explicitly.
  for (let oid of oids) {
    while (git(["cat-file", "-t", oid]).toString().trim() === "tag") { hints.set(oid, hints.get(oid) ?? ""); oid = git(["rev-parse", `${oid}^{}`]).toString().trim(); }
  }
  const counts = { commit: 0, tag: 0, blob: 0, tree: 0 };
  await catFileBatch([...hints.keys()], (oid, type, body) => {
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === "blob") test("content", [body.toString("utf8"), body.toString("latin1")], `blob ${oid}${hints.get(oid) ? ` (${hints.get(oid)})` : ""}`);
    else if (type === "commit" || type === "tag") test("message", body.toString("utf8"), `${type} ${oid}`);
  });

  const commitTips = oids.map((o) => git(["rev-parse", `${o}^{commit}`]).toString().trim());
  // Exact NUL-delimited names (no trimming: leading/trailing spaces are legal in paths).
  const names = git(["-c", "core.quotePath=false", "log", "-m", "--root", "--no-renames", "--format=%x01", "--name-only", "-z", ...commitTips]).toString("utf8");
  // Each commit emits "\x01" NUL, then "\n" before its first name; only that one "\n" is a separator.
  const paths = new Set();
  let afterHeader = false;
  for (const token of names.split("\0")) {
    if (token === "\x01" || token === "\n\x01") { afterHeader = true; continue; }
    const name = afterHeader && token.startsWith("\n") ? token.slice(1) : token;
    afterHeader = false;
    if (name !== "") paths.add(name);
  }
  for (const p of paths) test("path", p, p);
  return { findings, counts, paths: paths.size };
}

function report(result, label) {
  const { findings, counts, paths } = result;
  const byRule = {};
  for (const f of findings) byRule[`${f.rule}/${f.scope}`] = (byRule[`${f.rule}/${f.scope}`] ?? 0) + 1;
  console.error(`publication-guard: ${label}: ${counts.commit} commits, ${counts.blob} blobs, ${counts.tag ?? 0} tags, ${paths} paths scanned; ${findings.length} finding(s)`);
  for (const [k, n] of Object.entries(byRule)) console.error(`  ${k}: ${n}`);
  for (const f of findings.slice(0, MAX_LISTED)) console.error(`  - [${f.rule}/${f.scope}] ${f.where}`);
  if (findings.length > MAX_LISTED) console.error(`  ... ${findings.length - MAX_LISTED} more`);
}

async function cmdScan(args, policy) {
  const refs = [];
  const revs = [];
  for (let i = 0; i < args.length; i++) args[i] === "--ref" ? refs.push(args[++i]) : revs.push(args[i]);
  if (revs.length === 0) throw new ConfigError("scan: at least one revision required");
  const result = await scan(policy, revs, refs);
  report(result, `scan ${revs.join(" ")}`);
  return result.findings.length ? 1 : 0;
}

async function cmdPrePush(policy, stdin, url) {
  if (!policy.pushUrls.includes(url ?? "")) { console.error("publication-guard: destination URL is not in the policy's pushUrls; refusing"); return 1; }
  const allowDelete = new Set((process.env.HOMER_PUBLICATION_ALLOW_DELETE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const lines = stdin.split("\n").filter((l) => l.trim());
  let refused = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4 || !OID.test(parts[1]) || !OID.test(parts[3]) || !parts[2].startsWith("refs/")) { console.error(`publication-guard: unrecognised ref update "${line}"; refusing`); refused++; continue; }
    const [localRef, localOid, remoteRef] = parts;
    if (ZERO.test(localOid)) {
      if (allowDelete.has(remoteRef)) { console.error(`publication-guard: deletion of ${remoteRef} explicitly allowed`); continue; }
      console.error(`publication-guard: refusing to delete ${remoteRef} (set HOMER_PUBLICATION_ALLOW_DELETE=${remoteRef} for a deliberate deletion)`);
      refused++;
      continue;
    }
    if (!policy.allowedRefs.includes(remoteRef)) { console.error(`publication-guard: ${remoteRef} is not a publishable ref (${policy.allowedRefs.join(", ")}); refusing`); refused++; continue; }
    const result = await scan(policy, [localOid], [localRef, remoteRef]);
    report(result, `push ${localOid.slice(0, 12)} -> ${remoteRef}`);
    if (result.findings.length) refused++;
  }
  return refused ? 1 : 0;
}

async function cmdRelease(args, policy) {
  const opt = { remote: "origin", push: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--commit") opt.commit = args[++i];
    else if (args[i] === "--expect-remote-oid") opt.expect = args[++i];
    else if (args[i] === "--remote") opt.remote = args[++i];
    else if (args[i] === "--push") opt.push = true;
    else throw new ConfigError(`release: unknown argument ${args[i]}`);
  }
  if (!OID.test(opt.commit ?? "") || !OID.test(opt.expect ?? "")) throw new ConfigError("release: --commit and --expect-remote-oid must be full object ids");
  if (!policy.allowedRefs.includes("refs/heads/main")) throw new ConfigError("release: refs/heads/main is not in the policy's allowedRefs");
  if (git(["cat-file", "-t", opt.commit]).toString().trim() !== "commit") throw new ConfigError("release: candidate is not a commit");
  const urls = git(["remote", "get-url", "--push", "--all", "--", opt.remote]).toString().split("\n").filter(Boolean);
  if (urls.length !== 1) throw new ConfigError(`release: remote must have exactly one push URL (has ${urls.length})`);
  const url = urls[0];
  if (!policy.pushUrls.includes(url)) throw new ConfigError("release: the remote's push URL is not in the policy's pushUrls");
  const remote = git(["ls-remote", "--", url, "refs/heads/main"]).toString().trim().split(/\s+/)[0] ?? "";
  if (remote !== opt.expect) { console.error(`publication-guard: main at the push URL is ${remote || "(absent)"}, expected ${opt.expect}; refusing`); return 1; }
  const result = await scan(policy, [opt.commit], ["refs/heads/main"]);
  report(result, `release candidate ${opt.commit}`);
  if (result.findings.length) return 1;
  const lease = `--force-with-lease=refs/heads/main:${opt.expect}`;
  if (!opt.push) { console.error(`publication-guard: dry run clean; to publish rerun with --push (runs: git push --no-follow-tags ${lease} <${opt.remote} push URL> ${opt.commit}:refs/heads/main)`); return 0; }
  const r = spawnSync("git", ["push", "--no-follow-tags", lease, url, `${opt.commit}:refs/heads/main`], { stdio: "inherit", env: GIT_ENV });
  return r.status ?? 2;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    const policy = loadPolicy(policyPath());
    if (command === "scan") return await cmdScan(args, policy);
    if (command === "release") return await cmdRelease(args, policy);
    if (command === "pre-push") return await cmdPrePush(policy, readFileSync(0, "utf8"), args[1]);
    throw new ConfigError("usage: publication-guard.mjs scan|release|pre-push ...");
  } catch (e) {
    console.error(`publication-guard: ${e instanceof ConfigError ? e.message : `internal error (${e?.name ?? "unknown"})`}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
