import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "render-harness-assets.ts");
const tsx = join(repo, "node_modules", ".bin", "tsx");

function writeSkill(root: string, id: string): string {
  const dir = join(root, "skills", "skills", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "skill.md");
  writeFileSync(path, `---\nid: ${id}\ndescription: ${id} fixture\n---\n\n# ${id}\n`);
  return path;
}

function run(config: string, ...args: string[]) {
  return spawnSync(tsx, [script, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, HOMER_SKILL_ROOTS_CONFIG: config },
  });
}

function regex(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("renders configured roots separately, honors exclusions, and checks every generated root", (t) => {
  const fixture = join(tmpdir(), `homer-skill-roots-${process.pid}-${Date.now()}`);
  const first = join(fixture, "first");
  const empty = join(fixture, "empty");
  const second = join(fixture, "second");
  const config = join(fixture, "skill-roots.json");
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  mkdirSync(join(first, "skills", "aliases"), { recursive: true });
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(first, "skills", "aliases", "mcp-tools.yaml"), "logicalTools: {}\n");
  writeSkill(first, "private-skill");
  const privateSource = writeSkill(second, "private-skill");
  writeFileSync(config, JSON.stringify({
    roots: [{ path: first, exclude: ["private-skill"] }, empty, { path: second }],
  }));

  const rendered = run(config, "render");
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(existsSync(join(first, "generated", "harness", "claude", "skills", "private-skill", "SKILL.md")), false);
  const mirror = join(second, "generated", "harness", "claude", "skills", "private-skill", "SKILL.md");
  assert.match(readFileSync(mirror, "utf-8"), regex(`from ${privateSource}`));

  const listed = run(config, "list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes(privateSource));
  assert.ok(listed.stdout.includes(` ${second}\n`));
  assert.equal(run(config, "check").status, 0);

  const stale = join(first, "generated", "harness", "stale.txt");
  mkdirSync(join(first, "generated", "harness"), { recursive: true });
  writeFileSync(stale, "stale");
  const checked = run(config, "check");
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /STALE .*stale\.txt/);
});

test("rejects duplicate asset ids across roots and names both source paths", (t) => {
  const fixture = join(tmpdir(), `homer-skill-collision-${process.pid}-${Date.now()}`);
  const first = join(fixture, "first");
  const second = join(fixture, "second");
  const config = join(fixture, "skill-roots.json");
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  mkdirSync(join(first, "skills", "aliases"), { recursive: true });
  writeFileSync(join(first, "skills", "aliases", "mcp-tools.yaml"), "logicalTools: {}\n");
  const firstSource = writeSkill(first, "duplicate");
  const secondSource = writeSkill(second, "duplicate");
  writeFileSync(config, JSON.stringify({ roots: [first, second] }));

  const result = run(config, "list");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate asset id "duplicate"/);
  assert.match(result.stderr, regex(firstSource));
  assert.match(result.stderr, regex(secondSource));
});
