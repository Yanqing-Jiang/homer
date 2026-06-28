/** Claude adapter — wraps executeClaudeCommand. */
import { executeClaudeCommand } from "../../executors/claude.js";
import { getHarnessDescriptor } from "../capabilities.js";
import type {
  HarnessAdapter,
  HarnessDescriptor,
  HarnessRequest,
  HarnessResult,
  HarnessSessionRef,
  InvocationProfile,
  ModelValidation,
  PreparedHarnessRequest,
} from "../types.js";
import { prepareRequest, toHarnessResult, validateModelAgainstCatalog } from "./shared.js";

async function run(req: PreparedHarnessRequest, sessionId?: string): Promise<HarnessResult> {
  const raw = await executeClaudeCommand(req.finalPrompt, {
    cwd: req.cwd,
    claudeSessionId: sessionId ?? req.session?.sessionId,
    model: req.model ?? undefined,
    signal: req.signal,
    timeout: req.timeoutMs,
    runId: req.runId,
    onPartial: req.stream?.onPartial,
    onEvent: req.stream?.onEvent,
    appendSystemPrompt: req.context?.system,
  });
  const result = toHarnessResult("claude", req.model, raw, "executeClaudeCommand");
  if (raw.claudeSessionId) {
    result.session = { sessionId: raw.claudeSessionId, harness: "claude", model: req.model };
  }
  return result;
}

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  descriptor(profile: InvocationProfile): HarnessDescriptor {
    return getHarnessDescriptor("claude", profile);
  },
  validateModel(model: string | null | undefined): ModelValidation {
    return validateModelAgainstCatalog("claude", model);
  },
  async prepare(req: HarnessRequest): Promise<PreparedHarnessRequest> {
    return prepareRequest(req);
  },
  execute: run,
  resume(session: HarnessSessionRef, req: PreparedHarnessRequest): Promise<HarnessResult> {
    return run(req, session.sessionId);
  },
};
