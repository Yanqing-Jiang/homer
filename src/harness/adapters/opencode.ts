/** OpenCode adapter — wraps the raw executeOpenCodeCLI (NOT the Sonnet-fallback variant;
 *  capability negotiation owns degradation). */
import { executeOpenCodeCLI } from "../../executors/opencode-cli.js";
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

async function run(req: PreparedHarnessRequest, resume?: string): Promise<HarnessResult> {
  const raw = await executeOpenCodeCLI(req.finalPrompt, req.context?.system ?? "", {
    model: req.model ?? undefined,
    timeout: req.timeoutMs,
    signal: req.signal,
    cwd: req.cwd,
    researchOnly: req.invocation.researchOnly,
    browserOnly: req.invocation.browserOnly,
    agent: req.invocation.agent,
    forceOpenCode: req.invocation.forceOpenCode,
    yolo: req.invocation.yolo,
    sandbox: req.invocation.sandbox,
    resume: resume ?? req.session?.sessionId,
    runId: req.runId,
    onPartial: req.stream?.onPartial,
  });
  const result = toHarnessResult("opencode", req.model, raw, "executeOpenCodeCLI");
  if (raw.sessionId) {
    result.session = { sessionId: raw.sessionId, harness: "opencode", model: raw.model ?? req.model };
  }
  return result;
}

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  descriptor(profile: InvocationProfile): HarnessDescriptor {
    return getHarnessDescriptor("opencode", profile);
  },
  validateModel(model: string | null | undefined): ModelValidation {
    return validateModelAgainstCatalog("opencode", model);
  },
  async prepare(req: HarnessRequest): Promise<PreparedHarnessRequest> {
    return prepareRequest(req);
  },
  execute: run,
  resume(session: HarnessSessionRef, req: PreparedHarnessRequest): Promise<HarnessResult> {
    return run(req, session.sessionId);
  },
};
