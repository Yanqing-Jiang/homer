import { existsSync } from "fs";
import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { getRuntimePaths } from "../utils/runtime-paths.js";

// Load .env from project root, with HOMER_ROOT support for helper-managed launches.
const envCandidates = [
  process.env.HOMER_ENV_FILE,
  process.env.HOMER_ROOT ? resolve(process.env.HOMER_ROOT, ".env") : undefined,
  resolve(import.meta.dirname, "../../.env"),
].filter((candidate): candidate is string => Boolean(candidate));

for (const candidate of envCandidates) {
  if (existsSync(candidate)) {
    dotenvConfig({ path: candidate });
    break;
  }
}

const runtimePaths = getRuntimePaths();

const configSchema = z.object({
  telegram: z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().default(""),
    allowedChatId: z.number().int().nonnegative().default(0),
  }),
  session: z.object({
    ttlHours: z.number().int().positive().default(8),
  }),
  paths: z.object({
    lanes: z.string().default(runtimePaths.lanesDir),
    database: z.string().default(runtimePaths.databasePath),
    logs: z.string().default(runtimePaths.homerLogsDir),
    browserProfiles: z.string().default(runtimePaths.browserProfilesDir),
    uploadLanding: z.string().default(runtimePaths.uploadLandingDir),
    memory: z.string().default(runtimePaths.memoryDir),
    claudeDir: z.string().default(runtimePaths.claudeDir),
    homerData: z.string().default(runtimePaths.homerDataDir),
    homerRoot: z.string().default(runtimePaths.homerRoot),
    archive: z.string().default(runtimePaths.archiveDir),
  }),
  telephony: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().positive().default(3000),
    // Bind to 127.0.0.1 by default — Cloudflare Tunnel (or equivalent) fronts the
    // public surface. Set TELEPHONY_HOST=0.0.0.0 only for direct LAN ingress.
    host: z.string().default("127.0.0.1"),
    // Public origin used for Twilio signature validation (must match Twilio console).
    publicUrl: z.string().default("http://127.0.0.1:3000"),
  }),
  tui: z.object({
    refreshMs: z.number().int().positive().default(1000),
  }),
  weather: z.object({
    defaultLocation: z.string().default("Bellevue,WA"),
  }).optional(),
  voice: z.object({
    enabled: z.boolean().default(true),
    openaiApiKey: z.string().default(""),
    elevenLabsApiKey: z.string().default(""),
    elevenLabsVoiceId: z.string().default("21m00Tcm4TlvDq8ikWAM"),
    elevenLabsModel: z.string().default("eleven_multilingual_v2"),
    elevenLabsWebhookSecret: z.string().default(""),
  }),
  search: z.object({
    embeddingModel: z.string().default("text-embedding-3-small"),
    chunkSize: z.number().int().positive().default(512),
    chunkOverlap: z.number().int().nonnegative().default(50),
  }),
  twilio: z.object({
    accountSid: z.string().default(""),
    authToken: z.string().default(""),
    phoneNumber: z.string().default(""),
    apiKeySid: z.string().default(""),
  }),
  features: z.object({}).default({}),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function parseInteger(rawValue: string | undefined, fallback: number): number {
  const parsed = parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(): Config {
  const runtimePaths = getRuntimePaths();
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const allowedChatId = parseInteger(
    process.env.ALLOWED_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID,
    0,
  );
  const rawConfig = {
    telegram: {
      enabled: telegramBotToken.length > 0 && allowedChatId > 0,
      botToken: telegramBotToken,
      allowedChatId,
    },
    session: {
      ttlHours: parseInt(process.env.SESSION_TTL_HOURS ?? "8", 10),
    },
    paths: {
      lanes: process.env.LANES_PATH ?? runtimePaths.lanesDir,
      database: process.env.DATABASE_PATH ?? runtimePaths.databasePath,
      logs: process.env.LOGS_PATH ?? runtimePaths.homerLogsDir,
      browserProfiles: process.env.BROWSER_PROFILES_PATH ?? runtimePaths.browserProfilesDir,
      uploadLanding: process.env.UPLOAD_LANDING_PATH ?? runtimePaths.uploadLandingDir,
      memory: process.env.MEMORY_PATH ?? runtimePaths.memoryDir,
      claudeDir: process.env.CLAUDE_DIR ?? runtimePaths.claudeDir,
      homerData: process.env.HOMER_DATA_PATH ?? runtimePaths.homerDataDir,
      homerRoot: process.env.HOMER_ROOT ?? runtimePaths.homerRoot,
      archive: process.env.ARCHIVE_PATH ?? runtimePaths.archiveDir,
    },
    telephony: {
      enabled: process.env.TELEPHONY_ENABLED !== "false",
      port: parseInt(process.env.TELEPHONY_PORT ?? "3000", 10),
      host: process.env.TELEPHONY_HOST ?? "127.0.0.1",
      // Backward-compatible alias: HOMER_API_URL → TELEPHONY_PUBLIC_URL.
      publicUrl:
        process.env.TELEPHONY_PUBLIC_URL ??
        process.env.HOMER_API_URL ??
        "http://127.0.0.1:3000",
    },
    tui: {
      refreshMs: parseInt(process.env.TUI_REFRESH_MS ?? "1000", 10),
    },
    weather: {
      defaultLocation: process.env.WEATHER_LOCATION ?? "Bellevue,WA",
    },
    voice: {
      enabled: process.env.VOICE_ENABLED !== "false",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY ?? "",
      elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
      elevenLabsModel: process.env.ELEVEN_LABS_MODEL ?? "eleven_multilingual_v2",
      elevenLabsWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET ?? "",
    },
    search: {
      embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
      chunkSize: parseInt(process.env.CHUNK_SIZE ?? "512", 10),
      chunkOverlap: parseInt(process.env.CHUNK_OVERLAP ?? "50", 10),
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
      authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
      phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? "",
      apiKeySid: process.env.TWILIO_API_KEY_SID ?? "",
    },
    features: {},
    logLevel: process.env.LOG_LEVEL ?? "info",
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error("Configuration validation failed:");
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
