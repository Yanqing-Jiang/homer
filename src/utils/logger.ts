import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            sync: true, // Disable buffering for immediate output
          },
        }
      : undefined,
});

export type Logger = typeof logger;
