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
