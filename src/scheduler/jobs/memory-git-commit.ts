/**
 * DISABLED: User rule — no memory git tracking.
 * Was causing 1GB .git bloat + ETIMEDOUT cascades under load.
 * Memory version history is handled by homer.db audit trails.
 */

import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";

export async function runMemoryGitCommit(stateManager?: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  if (stateManager) {
    stateManager.clearPipelineDirty("git_commit");
  }
  const output = "Memory git commit disabled by user rule";
  logger.info(output);
  return { success: true, output };
}
