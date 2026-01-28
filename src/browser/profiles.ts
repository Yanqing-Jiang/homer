import { join } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import type { BrowserProfile } from "./types.js";
import type Database from "better-sqlite3";

/**
 * Initialize browser profiles table
 */
export function initBrowserProfilesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_profiles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      profile_path TEXT NOT NULL,
      auth_state TEXT DEFAULT 'none',
      headless_capable INTEGER DEFAULT 0,
      last_used_at INTEGER NOT NULL
    );
  `);
  logger.debug("Browser profiles table initialized");
}

/**
 * Get or create a browser profile
 */
export async function getOrCreateProfile(
  db: Database.Database,
  profilesPath: string,
  name: string
): Promise<BrowserProfile> {
  // Check if profile exists
  const existing = db
    .prepare(
      `SELECT id, name, profile_path as profilePath, auth_state as authState,
              headless_capable as headlessCapable, last_used_at as lastUsedAt
       FROM browser_profiles WHERE name = ?`
    )
    .get(name) as BrowserProfile | undefined;

  if (existing) {
    return {
      ...existing,
      headlessCapable: Boolean(existing.headlessCapable),
    };
  }

  // Create new profile
  const id = randomUUID();
  const profilePath = join(profilesPath, name);

  // Ensure profile directory exists
  if (!existsSync(profilePath)) {
    await mkdir(profilePath, { recursive: true });
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO browser_profiles (id, name, profile_path, auth_state, headless_capable, last_used_at)
     VALUES (?, ?, ?, 'none', 0, ?)`
  ).run(id, name, profilePath, now);

  logger.info({ id, name, profilePath }, "Created browser profile");

  return {
    id,
    name,
    profilePath,
    authState: "none",
    headlessCapable: false,
    lastUsedAt: now,
  };
}

/**
 * Update profile auth state
 */
export function updateProfileAuthState(
  db: Database.Database,
  name: string,
  authState: BrowserProfile["authState"],
  headlessCapable: boolean = false
): void {
  db.prepare(
    `UPDATE browser_profiles
     SET auth_state = ?, headless_capable = ?, last_used_at = ?
     WHERE name = ?`
  ).run(authState, headlessCapable ? 1 : 0, Date.now(), name);
}

/**
 * Update profile last used timestamp
 */
export function touchProfile(db: Database.Database, name: string): void {
  db.prepare(`UPDATE browser_profiles SET last_used_at = ? WHERE name = ?`).run(
    Date.now(),
    name
  );
}

/**
 * List all profiles
 */
export function listProfiles(db: Database.Database): BrowserProfile[] {
  return (
    db
      .prepare(
        `SELECT id, name, profile_path as profilePath, auth_state as authState,
              headless_capable as headlessCapable, last_used_at as lastUsedAt
       FROM browser_profiles ORDER BY last_used_at DESC`
      )
      .all() as BrowserProfile[]
  ).map((p) => ({
    ...p,
    headlessCapable: Boolean(p.headlessCapable),
  }));
}

/**
 * Get profile by name
 */
export function getProfile(
  db: Database.Database,
  name: string
): BrowserProfile | null {
  const profile = db
    .prepare(
      `SELECT id, name, profile_path as profilePath, auth_state as authState,
              headless_capable as headlessCapable, last_used_at as lastUsedAt
       FROM browser_profiles WHERE name = ?`
    )
    .get(name) as BrowserProfile | undefined;

  if (!profile) return null;

  return {
    ...profile,
    headlessCapable: Boolean(profile.headlessCapable),
  };
}
