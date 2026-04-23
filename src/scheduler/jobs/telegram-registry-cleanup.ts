import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";

export async function runTelegramRegistryCleanup(stateManager: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const deleted = stateManager.deleteExpiredTelegramMessages();
    const output = `telegram_messages cleanup: ${deleted} expired rows deleted`;
    logger.info({ deleted }, output);
    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Telegram registry cleanup failed");
    return { success: false, output: "", error: message };
  }
}
