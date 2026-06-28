/** Gemini adapter — two invocation paths: native API (JSON/grounding) when
 *  invocation.nativeGeminiApi, else the direct rotating CLI. The scheduler's historical
 *  "gemini via opencode" route is modeled as an opencode invocation profile, not here. */
import { executeGeminiCLIDirect } from "../../executors/gemini-cli.js";
import { executeGeminiAPI, type GeminiAPIOptions } from "../../executors/gemini.js";
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
  if (req.invocation.nativeGeminiApi) {
    const raw = await executeGeminiAPI(req.finalPrompt, {
      model: (req.model ?? undefined) as GeminiAPIOptions["model"],
      systemPrompt: req.context?.system,
      timeout: req.timeoutMs,
      responseMimeType: req.outputContract?.kind === "json" ? "application/json" : undefined,
    });
    return toHarnessResult("gemini", req.model, raw, "executeGeminiAPI");
  }
  const raw = await executeGeminiCLIDirect(req.finalPrompt, {
    model: req.model ?? undefined,
    timeout: req.timeoutMs,
    signal: req.signal,
    cwd: req.cwd,
  });
  return toHarnessResult("gemini", req.model, raw, "executeGeminiCLIDirect");
}

export const geminiAdapter: HarnessAdapter = {
  id: "gemini",
  descriptor(profile: InvocationProfile): HarnessDescriptor {
    return getHarnessDescriptor("gemini", profile);
  },
  validateModel(model: string | null | undefined): ModelValidation {
    return validateModelAgainstCatalog("gemini", model);
  },
  async prepare(req: HarnessRequest): Promise<PreparedHarnessRequest> {
    return prepareRequest(req);
  },
  execute: run,
};
