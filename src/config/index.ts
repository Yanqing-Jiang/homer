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
    botToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    allowedChatId: z.number().int().positive("ALLOWED_CHAT_ID must be a positive integer"),
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
  web: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().positive().default(3000),
    // When true, bind to 0.0.0.0 and require auth for /api routes
    // When false, bind to 127.0.0.1 (localhost only, no auth)
    exposeExternally: z.boolean().default(false),
    allowedEmail: z.string().email().optional(),
    baseUrl: z.string().default("http://localhost:3000"),
    secret: z.string().default("homer-default-secret"),
  }),
  auth: z.object({
    supabaseUrl: z.string().default(""),
    supabaseJwtSecret: z.string().default(""),
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
    supabaseUrl: z.string().default(""),
    supabaseAnonKey: z.string().default(""),
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
  features: z.object({
    humanGatedMemory: z.boolean().default(false),
  }).default({}),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const runtimePaths = getRuntimePaths();
  const rawConfig = {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      allowedChatId: parseInt(process.env.ALLOWED_CHAT_ID ?? "0", 10),
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
    web: {
      enabled: process.env.WEB_ENABLED !== "false",
      port: parseInt(process.env.WEB_PORT ?? "3000", 10),
      exposeExternally: process.env.WEB_EXPOSE_EXTERNALLY === "true",
      allowedEmail: process.env.WEB_ALLOWED_EMAIL,
      baseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3000",
      secret: process.env.WEB_SECRET ?? "homer-default-secret",
    },
    auth: {
      supabaseUrl: process.env.SUPABASE_URL ?? "",
      supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET ?? "",
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
      supabaseUrl: process.env.SUPABASE_URL ?? "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
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
    features: {
      humanGatedMemory: process.env.FEATURE_HUMAN_GATED_MEMORY === "true",
    },
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
