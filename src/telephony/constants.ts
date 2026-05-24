// All values below are required at runtime via environment variables.
// See .env.example for placeholders.
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const YANQING_PHONE = process.env.OWNER_PHONE ?? "";
export const HOMER_PHONE = process.env.HOMER_PHONE ?? "";
export const HOMER_AGENT_ID = process.env.ELEVENLABS_AGENT_ID ?? "";
export const HOMER_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID ?? "";
export const SMS_MAX_LENGTH = 300;
// Telephony's public origin (used by Twilio signature validation and webhook URLs).
// Prefers TELEPHONY_PUBLIC_URL; HOMER_API_URL kept as backward-compat alias so
// existing Cloudflare Tunnel configs continue to work without env changes.
// Trailing slash is stripped because Twilio's signature is computed over the exact URL string.
export const WEBHOOK_BASE = (
  process.env.TELEPHONY_PUBLIC_URL ??
  process.env.HOMER_API_URL ??
  "http://127.0.0.1:3000"
).replace(/\/$/, "");
export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// Re-export the require helper so call sites that need a hard assertion can use it.
export { required as requireEnv };
