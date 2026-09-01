/**
 * Operator identity, read from the environment so no name, site or account is
 * hardcoded in the tree. See .env.example for the variables.
 */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const OWNER = {
  /** Short name used in prompts ("<name>'s personal AI"). */
  displayName: env("OWNER_DISPLAY_NAME") ?? "the owner",
  /** Full name; falls back to the display name. */
  fullName: env("OWNER_FULL_NAME") ?? env("OWNER_DISPLAY_NAME") ?? "the owner",
  email: env("OWNER_EMAIL"),
  phone: env("OWNER_PHONE"),
  /** Public site (origin) run by the operator, if any. */
  site: env("OWNER_SITE"),
  /** Google account used by the operator's CLI/OAuth integrations. */
  googleAccount: env("OWNER_GOOGLE_ACCOUNT"),
} as const;
