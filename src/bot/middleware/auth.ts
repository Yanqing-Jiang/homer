import type { Context, NextFunction } from "grammy";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  // Check if this is from the allowed chat
  if (chatId !== config.telegram.allowedChatId) {
    logger.warn(
      {
        chatId,
        userId,
        username,
        messageText: ctx.message?.text?.slice(0, 50),
      },
      "Unauthorized access attempt - ignoring message"
    );
    // Silently ignore - don't respond to unauthorized users
    return;
  }

  // Authorized - proceed
  logger.debug({ chatId, userId, username }, "Authorized user");
  await next();
}
