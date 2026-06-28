/** Codex adapter — wraps executeCodexCLI. */
import { executeCodexCLI } from "../../executors/codex-cli.js";
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
  const raw = await executeCodexCLI(req.finalPrompt, {
    cwd: req.cwd,
    timeout: req.timeoutMs,
    signal: req.signal,
    sessionId: sessionId ?? req.session?.sessionId,
    model: req.model ?? undefined,
    reasoningEffort: req.invocation.reasoningEffort,
    runId: req.runId,
    onPartial: req.stream?.onPartial,
    onMessageChunk: req.stream?.onMessageChunk,
    onEvent: req.stream?.onEvent,
  });
  const result = toHarnessResult("codex", req.model, raw, "executeCodexCLI");
  if (raw.sessionId) {
    result.session = { sessionId: raw.sessionId, harness: "codex", model: req.model };
  }
  return result;
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  descriptor(profile: InvocationProfile): HarnessDescriptor {
    return getHarnessDescriptor("codex", profile);
  },
  validateModel(model: string | null | undefined): ModelValidation {
    return validateModelAgainstCatalog("codex", model);
  },
  async prepare(req: HarnessRequest): Promise<PreparedHarnessRequest> {
    return prepareRequest(req);
  },
  execute: run,
  resume(session: HarnessSessionRef, req: PreparedHarnessRequest): Promise<HarnessResult> {
    return run(req, session.sessionId);
  },
};
