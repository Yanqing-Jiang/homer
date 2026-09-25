// Publication guard: synthetic repositories and synthetic forbidden identifiers only; local bare
// repositories stand in for remotes (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GUARD = resolve(import.meta.dirname, "../scripts/publication-guard.mjs");
const HOOK = resolve(import.meta.dirname, "../scripts/git-hooks/pre-push");
const FORBIDDEN = "zeta-forbidden-host";
const SECRET_PATTERN = "zeta-(?:private|pattern)-text";
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
delete ENV.GIT_NO_REPLACE_OBJECTS;

function fixture(policyFor = (urls) => ({ version: 1, pushUrls: urls, rules: [{ id: "synthetic-host", pattern: FORBIDDEN, flags: "i" }] })) {
  const dir = mkdtempSync(join(tmpdir(), "pubguard-"));
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  const pushRemote = join(dir, "push.git");
  mkdirSync(repo);
  const policyFile = join(dir, "policy.json");
  const policy = policyFor([remote, pushRemote, "url"]);
  if (policy !== null) writeFileSync(policyFile, typeof policy === "string" ? policy : JSON.stringify(policy));
  const env = { ...ENV, HOMER_PUBLICATION_POLICY: policyFile };
  const run = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const git = (...args) => run(repo, ...args);
  const commit = (file, content, message = `edit ${file}`) => {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
    git("add", "--", file);
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const guard = (args, input = "", extraEnv = {}) => spawnSync(process.execPath, [GUARD, ...args], { cwd: repo, env: { ...env, ...extraEnv }, input, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  return { dir, repo, remote, pushRemote, env, run, git, commit, guard, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const zero = "0".repeat(40);
const line = (local, remoteRef, remoteOid = zero) => `refs/heads/main ${local} ${remoteRef} ${remoteOid}\n`;

test("missing, empty, invalid or match-everything policy fails closed with exit 2", () => {
  const rules = [{ id: "x", pattern: FORBIDDEN }];
  for (const policy of [null, "{", { version: 1, pushUrls: ["url"], rules: [] }, { version: 2, pushUrls: ["url"], rules }, { version: 1, rules }, { version: 1, pushUrls: ["url"], rules: [{ id: "x", pattern: "(" }] }, { version: 1, pushUrls: ["url"], rules: [{ id: "x", pattern: ".*" }] }]) {
    const f = fixture(() => policy);
    try {
      const head = f.commit("a.txt", "clean\n");
      assert.equal(f.guard(["scan", head]).status, 2, JSON.stringify(policy));
    } finally { f.cleanup(); }
  }
});

test("policy and git errors never echo private patterns, URLs or git stderr", () => {
  const f = fixture((urls) => ({ version: 1, pushUrls: urls, rules: [{ id: "x", pattern: `${SECRET_PATTERN}(` }] }));
  try {
    f.commit("a.txt", "clean\n");
    const r = f.guard(["scan", "HEAD"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /rules\[0\]\.pattern does not compile \(SyntaxError\)/);
    assert.doesNotMatch(r.stderr, /zeta-/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    g.commit("a.txt", "clean\n");
    g.git("remote", "add", "origin", "https://user:zeta-credential@example.invalid/x.git");
    const r = g.guard(["release", "--commit", g.git("rev-parse", "HEAD"), "--expect-remote-oid", zero]);
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /zeta-credential|example\.invalid/);
    const bad = g.guard(["scan", "no-such-revision-zeta-secret"]);
    assert.equal(bad.status, 2);
    assert.doesNotMatch(bad.stderr, /zeta-secret|fatal/);
  } finally { g.cleanup(); }
});

test("clean history passes; content, path and message added then removed are still caught", () => {
  const f = fixture();
  try {
    const clean = f.commit("a.txt", "clean\n");
    assert.equal(f.guard(["scan", clean]).status, 0);
    f.commit("notes.txt", `ssh ${FORBIDDEN.toUpperCase()}\n`);
    f.git("rm", "-q", "notes.txt"); f.git("commit", "-q", "-m", "remove notes");
    const r = f.guard(["scan", "HEAD"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /synthetic-host\/content/);
    assert.doesNotMatch(r.stderr, new RegExp(`ssh ${FORBIDDEN}`, "i"), "matched text is never printed");
    f.commit(`scripts/${FORBIDDEN}/run.sh`, "echo hi\n");
    f.git("rm", "-q", "-r", "scripts"); f.git("commit", "-q", "-m", "tidy");
    assert.match(f.guard(["scan", "HEAD"]).stderr, /synthetic-host\/path/);
    f.commit("b.txt", "x\n", `mention ${FORBIDDEN}`);
    assert.match(f.guard(["scan", "HEAD"]).stderr, /synthetic-host\/message/);
  } finally { f.cleanup(); }
});

test("Unicode content and exact whitespace file names are matched", () => {
  const f = fixture((urls) => ({ version: 1, pushUrls: urls, rules: [
    { id: "unicode-host", pattern: "zéta-höst", scopes: ["content"] },
    { id: "trailing-space-path", pattern: "^dir/trailing\\.txt $", scopes: ["path"] },
    { id: "leading-space-path", pattern: "^ lead\\.txt$", scopes: ["path"] },
  ] }));
  try {
    f.commit("u.txt", "host: zéta-höst\n");
    f.commit("dir/trailing.txt ", "x\n");
    f.commit(" lead.txt", "y\n");
    const r = f.guard(["scan", "HEAD"]);
    assert.equal(r.status, 1);
    for (const id of ["unicode-host/content", "trailing-space-path/path", "leading-space-path/path"]) assert.match(r.stderr, new RegExp(id));
  } finally { f.cleanup(); }
});

test("objects also present on other local or remote-tracking refs are not excluded", () => {
  const f = fixture();
  try {
    f.commit("a.txt", "clean\n");
    f.git("checkout", "-q", "-b", "private");
    const bad = f.commit("host.txt", `${FORBIDDEN}\n`);
    f.git("update-ref", "refs/remotes/origin/main", bad);
    f.git("checkout", "-q", "main");
    f.git("merge", "-q", "--no-ff", "-m", "merge", "private");
    f.git("rm", "-q", "host.txt"); f.git("commit", "-q", "-m", "drop");
    assert.equal(f.guard(["scan", "main"]).status, 1);
  } finally { f.cleanup(); }
});

test("replacement objects cannot hide content; shallow and grafted histories are refused", () => {
  const f = fixture();
  try {
    f.commit("a.txt", "clean\n");
    f.commit("host.txt", `${FORBIDDEN}\n`);
    const badBlob = f.git("rev-parse", "HEAD:host.txt");
    const cleanBlob = f.git("rev-parse", "HEAD~1:a.txt");
    f.git("replace", badBlob, cleanBlob);
    assert.equal(f.guard(["scan", "HEAD"]).status, 1, "git replace must not mask the real blob");
    f.git("replace", "-d", badBlob);
    const badCommit = f.git("rev-parse", "HEAD");
    f.commit("c.txt", "later\n");
    writeFileSync(join(f.repo, ".git", "info", "grafts"), `${f.git("rev-parse", "HEAD")}\n`);
    const grafted = f.guard(["scan", "HEAD"]);
    assert.equal(grafted.status, 2);
    assert.match(grafted.stderr, /grafts/);
    rmSync(join(f.repo, ".git", "info", "grafts"));
    assert.equal(f.guard(["scan", "HEAD"], "", { GIT_GRAFT_FILE: "/dev/null" }).status, 2);
    const shallow = join(f.dir, "shallow");
    f.run(f.dir, "clone", "-q", "--depth", "1", `file://${f.repo}`, shallow);
    const r = spawnSync(process.execPath, [GUARD, "scan", "HEAD"], { cwd: shallow, env: f.env, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /shallow/);
    assert.ok(badCommit);
  } finally { f.cleanup(); }
});

test("annotated tag messages and ref names are scanned", () => {
  const f = fixture();
  try {
    f.commit("a.txt", "clean\n");
    f.git("tag", "-a", "v1", "-m", `built on ${FORBIDDEN}`);
    assert.match(f.guard(["scan", "v1"]).stderr, /synthetic-host\/message/);
    const r = f.guard(["scan", "--ref", `refs/heads/${FORBIDDEN}`, "main"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /synthetic-host\/ref/);
  } finally { f.cleanup(); }
});

test("pre-push: checks destination URL, scans force-updates, refuses deletions, non-main refs and malformed input", () => {
  const f = fixture();
  try {
    const clean = f.commit("a.txt", "clean\n");
    const hook = (input, url = "url", extra = {}) => f.guard(["pre-push", "origin", url], input, extra).status;
    assert.equal(hook(line(clean, "refs/heads/main")), 0);
    assert.equal(hook(line(clean, "refs/heads/main"), "https://mirror.example.invalid/x.git"), 1, "unlisted destination URL");
    assert.equal(hook(""), 0, "nothing to push");
    assert.equal(hook(line(clean, "refs/heads/other")), 1);
    assert.equal(hook(line(clean, "refs/tags/v1")), 1);
    assert.equal(hook("garbage\n"), 1);
    const del = `(delete) ${zero} refs/tags/old ${clean}\n`;
    assert.equal(hook(del), 1);
    assert.equal(hook(del, "url", { HOMER_PUBLICATION_ALLOW_DELETE: "refs/tags/old" }), 0);
    const bad = f.commit("b.txt", `${FORBIDDEN}\n`);
    f.git("reset", "-q", "--hard", clean);
    const rewritten = f.commit("c.txt", "clean rewrite\n");
    assert.equal(hook(line(rewritten, "refs/heads/main", bad)), 0, "force-update to clean rewritten history");
    assert.equal(hook(line(bad, "refs/heads/main", rewritten)), 1);
  } finally { f.cleanup(); }
});

test("release pins candidate and push-URL oid, dry-runs by default, pushes only main (no followed tags) through the hook", () => {
  const f = fixture();
  try {
    for (const r of [f.remote, f.pushRemote]) f.run(f.dir, "init", "-q", "--bare", "-b", "main", r);
    const first = f.commit("a.txt", "one\n");
    f.git("remote", "add", "origin", f.remote);
    f.git("push", "-q", "origin", "main");
    f.git("push", "-q", f.pushRemote, "main");
    f.git("remote", "set-url", "--push", "origin", f.pushRemote);   // fetch and push endpoints differ
    f.git("config", "push.followTags", "true");
    f.git("branch", "side");
    const second = f.commit("a.txt", "two\n");
    f.git("tag", "-a", "v2", "-m", "release tag");                 // would be sent by followTags
    mkdirSync(join(f.repo, "scripts"), { recursive: true });
    copyFileSync(GUARD, join(f.repo, "scripts", "publication-guard.mjs"));
    copyFileSync(HOOK, join(f.repo, ".git", "hooks", "pre-push"));
    chmodSync(join(f.repo, ".git", "hooks", "pre-push"), 0o755);
    const refsOf = (r) => f.run(r, "for-each-ref", "--format=%(refname) %(objectname)");

    assert.equal(f.guard(["release", "--commit", "HEAD", "--expect-remote-oid", first]).status, 2, "candidate must be a full oid");
    assert.equal(f.guard(["release", "--commit", second, "--expect-remote-oid", second]).status, 1, "stale expected oid");
    const dry = f.guard(["release", "--commit", second, "--expect-remote-oid", first]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /dry run clean/);
    assert.equal(refsOf(f.pushRemote), `refs/heads/main ${first}`, "dry run does not push");

    const pushed = f.guard(["release", "--commit", second, "--expect-remote-oid", first, "--push"]);
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.equal(refsOf(f.pushRemote), `refs/heads/main ${second}`, "only main moved at the push URL; no tag, no side branch");
    assert.equal(refsOf(f.remote), `refs/heads/main ${first}`, "fetch URL untouched");

    const bad = f.commit("b.txt", `${FORBIDDEN}\n`);
    assert.equal(f.guard(["release", "--commit", bad, "--expect-remote-oid", second, "--push"]).status, 1);
    assert.notEqual(spawnSync("git", ["push", "origin", "main"], { cwd: f.repo, env: f.env }).status, 0, "plain git push is blocked by the hook");
    assert.notEqual(spawnSync("git", ["push", "origin", "side:refs/heads/side"], { cwd: f.repo, env: f.env }).status, 0, "non-main ref refused by the hook");

    f.git("remote", "set-url", "--push", "origin", join(f.dir, "unlisted.git"));
    assert.equal(f.guard(["release", "--commit", second, "--expect-remote-oid", second]).status, 2, "push URL not in policy");
    f.git("remote", "set-url", "--add", "--push", "origin", f.pushRemote);
    assert.equal(f.guard(["release", "--commit", second, "--expect-remote-oid", second]).status, 2, "multiple push URLs refused");
  } finally { f.cleanup(); }
});

test("release refuses when the policy does not allow refs/heads/main", () => {
  const f = fixture((urls) => ({ version: 1, pushUrls: urls, allowedRefs: ["refs/heads/release"], rules: [{ id: "x", pattern: FORBIDDEN }] }));
  try {
    const head = f.commit("a.txt", "one\n");
    f.git("remote", "add", "origin", f.remote);
    assert.equal(f.guard(["release", "--commit", head, "--expect-remote-oid", zero]).status, 2);
  } finally { f.cleanup(); }
});
