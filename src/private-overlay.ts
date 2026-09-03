/**
 * Private overlay — optional operator-specific code kept in a separate checkout.
 *
 * The public repository is a shell: the daemon, scheduler, executors and tooling.
 * Anything tied to one operator (their jobs, portals, skills, bins, configs) lives
 * in a private sibling repository whose `homer-overlay.json` manifest declares:
 *
 *   links               paths symlinked into this tree by scripts/private-overlay.mjs
 *                       (src -> src/private, tests -> tests/private, bins, skills, ...)
 *   jobs                registry entries for scheduled jobs the overlay implements
 *   handlersModule      dist-relative module exporting `handlers` (PrivateJobHandler map)
 *   harnessBaselines    per-job harness/model baselines merged into the public table
 *   stewardshipSurfaces module exporting browser surfaces for session keepalive
 *   smokeModules        dist-relative modules the smoke test must be able to import
 *
 * Resolution order: HOMER_PRIVATE_ROOT (empty string disables), then the sibling
 * directory `<HOMER_ROOT>/../homer-private` when it carries a manifest. Everything
 * here degrades to "no overlay" so the shell builds and boots on its own.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PrivateJobHandler } from "./scheduler/private-job-contract.js";
import { getRuntimePaths } from "./utils/runtime-paths.js";

export const PRIVATE_MANIFEST_FILENAME = "homer-overlay.json";

const LinkSchema = z.object({
  /** path inside the private root */
  target: z.string().min(1),
  /** path inside the public tree where the symlink is created */
  link: z.string().min(1),
});

const JobEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["internal", "cli", "event", "helper"]),
  handler: z.string().optional(),
  handlerFile: z.string().optional(),
  expectedInSchedule: z.boolean(),
  note: z.string().optional(),
  /** source file (relative to the public root) shown to failure-takeover agents */
  sourceFile: z.string().optional(),
  /** opt in to the scheduler's one-shot retry on transient errors (public RETRYABLE_HANDLERS equivalent) */
  retryable: z.boolean().optional(),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  links: z.array(LinkSchema).default([]),
  jobs: z.array(JobEntrySchema).default([]),
  handlersModule: z.string().optional(),
  harnessBaselines: z.record(z.string(), z.unknown()).default({}),
  stewardshipSurfacesModule: z.string().optional(),
  smokeModules: z.array(z.string()).default([]),
});

export type PrivateOverlayManifest = z.infer<typeof ManifestSchema>;
export type PrivateJobEntry = z.infer<typeof JobEntrySchema>;

export interface PrivateOverlay {
  root: string;
  manifestPath: string;
  manifest: PrivateOverlayManifest;
}

let cached: PrivateOverlay | null | undefined;

export function resolvePrivateRoot(): string | null {
  const explicit = process.env.HOMER_PRIVATE_ROOT;
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    if (!trimmed) return null;
    return trimmed.startsWith("~/") ? path.join(getRuntimePaths().homeDir, trimmed.slice(2)) : path.resolve(trimmed);
  }
  const sibling = path.resolve(getRuntimePaths().homerRoot, "..", "homer-private");
  return existsSync(path.join(sibling, PRIVATE_MANIFEST_FILENAME)) ? sibling : null;
}

/** Load (once) the manifest of the private overlay, or null when none is installed. */
export function getPrivateOverlay(): PrivateOverlay | null {
  if (cached !== undefined) return cached;
  const root = resolvePrivateRoot();
  if (!root) return (cached = null);
  const manifestPath = path.join(root, PRIVATE_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`HOMER_PRIVATE_ROOT=${root} has no ${PRIVATE_MANIFEST_FILENAME}`);
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`${manifestPath} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return (cached = { root, manifestPath, manifest: parsed.data });
}

export function hasPrivateOverlay(): boolean {
  return getPrivateOverlay() !== null;
}

/** Reset the cache (tests only). */
export function resetPrivateOverlayCache(): void {
  cached = undefined;
}

/**
 * Import a compiled overlay module. Overlay sources are linked at src/private and
 * compiled alongside the public tree, so `rel` is resolved under dist/private/.
 */
export async function importPrivateModule<T = Record<string, unknown>>(rel: string): Promise<T> {
  const url = new URL(`./private/${rel.replace(/^\/+/, "")}`, import.meta.url);
  return (await import(url.href)) as T;
}

let handlersPromise: Promise<Record<string, PrivateJobHandler>> | undefined;

/** Handler table contributed by the overlay (empty when no overlay or no handlers module). */
export function getPrivateJobHandlers(): Promise<Record<string, PrivateJobHandler>> {
  if (!handlersPromise) {
    const overlay = getPrivateOverlay();
    handlersPromise = !overlay?.manifest.handlersModule
      ? Promise.resolve({})
      : importPrivateModule<{ handlers?: Record<string, PrivateJobHandler> }>(overlay.manifest.handlersModule)
          .then((mod) => mod.handlers ?? {});
  }
  return handlersPromise;
}

/** Handler names the overlay marks `retryable` — the private counterpart of RETRYABLE_HANDLERS. */
export function getPrivateRetryableHandlers(): Set<string> {
  const names = new Set<string>();
  for (const entry of getPrivateOverlay()?.manifest.jobs ?? []) {
    if (entry.retryable && entry.handler) names.add(entry.handler);
  }
  return names;
}

export async function getPrivateJobHandler(handler: string): Promise<PrivateJobHandler | undefined> {
  const handlers = await getPrivateJobHandlers();
  return handlers[handler];
}
