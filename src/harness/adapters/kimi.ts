/** Kimi adapter — wraps executeKimiCLI. Stateless in the current wrapper (no resume). */
import { executeKimiCLI } from "../../executors/kimi-cli.js";
import { getHarnessDescriptor } from "../capabilities.js";
import type {
  HarnessAdapter,
  HarnessDescriptor,
  HarnessRequest,
  HarnessResult,
  InvocationProfile,
  ModelValidation,
  PreparedHarnessRequest,
} from "../types.js";
import { prepareRequest, toHarnessResult, validateModelAgainstCatalog } from "./shared.js";

async function run(req: PreparedHarnessRequest): Promise<HarnessResult> {
  const raw = await executeKimiCLI(req.finalPrompt, req.context?.system ?? "", {
    model: req.model ?? undefined,
    timeout: req.timeoutMs,
    yolo: req.invocation.yolo,
    workDir: req.cwd,
    signal: req.signal,
    runId: req.runId,
  });
  return toHarnessResult("kimi", req.model, raw, "executeKimiCLI");
}

export const kimiAdapter: HarnessAdapter = {
  id: "kimi",
  descriptor(profile: InvocationProfile): HarnessDescriptor {
    return getHarnessDescriptor("kimi", profile);
  },
  validateModel(model: string | null | undefined): ModelValidation {
    return validateModelAgainstCatalog("kimi", model);
  },
  async prepare(req: HarnessRequest): Promise<PreparedHarnessRequest> {
    return prepareRequest(req);
  },
  execute: run,
};
