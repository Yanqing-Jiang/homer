import pino from "pino";

const isMcpStdio = process.env.MCP_STDIO === "1";
const loggerOptions: pino.LoggerOptions = {
  level: isMcpStdio ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  transport:
    !isMcpStdio && process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            sync: true, // Disable buffering for immediate output
          },
        }
      : undefined,
};

export const logger = isMcpStdio
  ? pino(loggerOptions, pino.destination(2))
  : pino(loggerOptions);

export type Logger = typeof logger;
