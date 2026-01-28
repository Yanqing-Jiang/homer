import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load .env from project root
dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

const configSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    allowedChatId: z.number().int().positive("ALLOWED_CHAT_ID must be a positive integer"),
  }),
  session: z.object({
    ttlHours: z.number().int().positive().default(4),
  }),
  paths: z.object({
    lanes: z.string().default("/Users/yj/lanes"),
    database: z.string().default("/Users/yj/homer/data/homer.db"),
    logs: z.string().default("/Users/yj/homer/logs"),
    browserProfiles: z.string().default("/Users/yj/homer/profiles"),
  }),
  web: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().positive().default(3000),
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
  }),
  search: z.object({
    supabaseUrl: z.string().default(""),
    supabaseAnonKey: z.string().default(""),
    embeddingModel: z.string().default("text-embedding-3-small"),
    chunkSize: z.number().int().positive().default(512),
    chunkOverlap: z.number().int().nonnegative().default(50),
  }),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const rawConfig = {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      allowedChatId: parseInt(process.env.ALLOWED_CHAT_ID ?? "0", 10),
    },
    session: {
      ttlHours: parseInt(process.env.SESSION_TTL_HOURS ?? "4", 10),
    },
    paths: {
      lanes: process.env.LANES_PATH ?? "/Users/yj/lanes",
      database: process.env.DATABASE_PATH ?? "/Users/yj/homer/data/homer.db",
      logs: process.env.LOGS_PATH ?? "/Users/yj/homer/logs",
      browserProfiles: process.env.BROWSER_PROFILES_PATH ?? "/Users/yj/homer/profiles",
    },
    web: {
      enabled: process.env.WEB_ENABLED !== "false",
      port: parseInt(process.env.WEB_PORT ?? "3000", 10),
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
    },
    search: {
      supabaseUrl: process.env.SUPABASE_URL ?? "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
      embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
      chunkSize: parseInt(process.env.CHUNK_SIZE ?? "512", 10),
      chunkOverlap: parseInt(process.env.CHUNK_OVERLAP ?? "50", 10),
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
