
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ExecutorResult } from "./types.js";
import { executeOpenCodeCLI } from "./opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "./gemini-cli.js";
import { logger } from "../utils/logger.js";

// ============================================
// CONFIGURATION
// ============================================

const GEMINI_CONFIG = {
  envKey: "GEMINI_API_KEY_Primary",
  models: {
    flash: "gemini-2.0-flash",
    pro: "gemini-2.0-pro",
    flashLite: "gemini-2.0-flash-lite-preview-02-05",
    // Future models
    flash3: "gemini-3.5-flash",
    pro3: "gemini-3-pro-preview",
    pro31: "gemini-3.1-pro-preview",
  },
  defaultModel: "gemini-3.5-flash",
  fallbackModel: "gemini-3.5-flash",
} as const;

type GeminiModel = keyof typeof GEMINI_CONFIG.models | string;

// ============================================
// TYPES
// ============================================

export interface GeminiAPIOptions {
  model?: GeminiModel;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number | null; // null = use model default (no explicit cap)
  timeout?: number;
  useGrounding?: boolean;
  dynamicThreshold?: number; // 0.0 to 1.0
  reasoningEffort?: "low" | "medium" | "high"; // Added back for compatibility
  responseMimeType?: "application/json" | "text/plain";
}

export interface GeminiAPIResult extends ExecutorResult {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  groundingMetadata?: any;
  finishReason?: string;
  truncated?: boolean;
}

// ============================================
// CLIENT MANAGEMENT
// ============================================

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env[GEMINI_CONFIG.envKey] || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(`${GEMINI_CONFIG.envKey} or GEMINI_API_KEY not set in environment`);
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

function resolveModel(model?: GeminiModel): string {
  if (!model) return GEMINI_CONFIG.defaultModel;

  // Check if it's a shorthand
  if (model in GEMINI_CONFIG.models) {
    return GEMINI_CONFIG.models[model as keyof typeof GEMINI_CONFIG.models];
  }

  // Assume it's a full model name
  return model;
}

// ============================================
// MAIN EXECUTOR
// ============================================

/**
 * Execute a query using the native Google Generative AI SDK.
 * Supports Search Grounding.
 */
const RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 3_000, // 3s, 6s
  retryablePatterns: ["fetch failed", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "socket hang up", "network", "EAI_AGAIN"],
} as const;

function isTransientNetworkError(message: string): boolean {
  return RETRY_CONFIG.retryablePatterns.some((p) => message.toLowerCase().includes(p.toLowerCase()));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeGeminiAPI(
  query: string,
  options: GeminiAPIOptions = {}
): Promise<GeminiAPIResult> {
  const startTime = Date.now();
  const modelName = resolveModel(options.model);

    const {
    systemPrompt = "You are a helpful assistant. Be concise and direct.",
    temperature = 0.3,
    maxTokens,  // undefined = model default (no cap); set explicitly only when you need a hard limit
    useGrounding = false, // Default off — enable explicitly for research
  } = options;

  logger.debug(
    { model: modelName, queryLength: query.length, temperature, useGrounding },
    "Executing Native Gemini API request"
  );

  try {
    const client = getClient();
    
    // Configure tools
    const tools: any[] = [];
    if (useGrounding) {
      tools.push({
        googleSearch: {}, // Native search grounding tool
      });
    }

    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      tools,
    });

    const chatConfig: Record<string, unknown> = { temperature };
    if (maxTokens != null) {
      chatConfig.maxOutputTokens = maxTokens;
    }
    if (options.responseMimeType) {
      chatConfig.responseMimeType = options.responseMimeType;
    }
    if (options.reasoningEffort) {
      chatConfig.thinkingConfig = {
        thinkingBudget: options.reasoningEffort === "high" ? 8192 :
                        options.reasoningEffort === "medium" ? 4096 : 1024,
      };
    }

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: query }] }],
      generationConfig: chatConfig,
    });

    const response = await result.response;
    const output = response.text() || "(No response)";
    const duration = Date.now() - startTime;

    // Extract grounding metadata if available
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const finishReason = response.candidates?.[0]?.finishReason as string | undefined;
    const truncated = finishReason === "MAX_TOKENS";

    if (truncated && maxTokens !== 50) {
      // Skip warning for health check probes (maxTokens=50)
      logger.warn(
        { model: modelName, maxTokens, outputTokens: response.usageMetadata?.candidatesTokenCount },
        "Gemini response truncated by token limit"
      );
    }
    if (finishReason === "SAFETY") {
      logger.error({ model: modelName }, "Gemini response blocked by safety filter");
    }

    // Truncated JSON is always broken — return error
    if (truncated && options.responseMimeType === "application/json") {
      return {
        output: `Error: Response truncated at ${maxTokens} tokens. Increase maxTokens.`,
        exitCode: 1,
        duration,
        executor: "gemini-api",
        model: modelName,
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
        finishReason,
        truncated,
      };
    }

    logger.debug(
      {
        model: modelName,
        duration,
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
        grounded: !!groundingMetadata,
        finishReason,
      },
      "Native Gemini API request completed"
    );

    return {
      output,
      exitCode: 0,
      duration,
      executor: "gemini-api",
      model: modelName,
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      groundingMetadata,
      finishReason,
      truncated,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    // Retry transient network errors with exponential backoff
    const retryCount = (options as any)._retryCount ?? 0;
    if (isTransientNetworkError(message) && retryCount < RETRY_CONFIG.maxRetries) {
      const delayMs = RETRY_CONFIG.baseDelayMs * Math.pow(2, retryCount);
      logger.warn(
        { model: modelName, error: message, retry: retryCount + 1, maxRetries: RETRY_CONFIG.maxRetries, delayMs },
        "Transient network error — retrying"
      );
      await sleep(delayMs);
      return executeGeminiAPI(query, {
        ...options,
        _retryCount: retryCount + 1,
      } as any);
    }

    // Model-specific errors (not found, deprecated) — try fallback model
    // Exclude network errors that happen to contain "models/" in the URL
    const isModelError =
      !isTransientNetworkError(message) &&
      (message.includes("not found") || message.includes("deprecated") || message.includes("is not supported"));
    if (isModelError && modelName !== GEMINI_CONFIG.fallbackModel) {
      logger.warn({ model: modelName, error: message }, "Primary model failed, trying fallback");
      return executeGeminiAPI(query, {
        ...options,
        model: GEMINI_CONFIG.fallbackModel,
      });
    }

    logger.error({ error: message, model: modelName, duration, retryCount }, "Native Gemini API request failed");

    return {
      output: `Error: ${message}`,
      exitCode: 1,
      duration,
      executor: "gemini-api",
      model: modelName,
    };
  }
}

// ============================================
// GEMINI CLI FLASH WRAPPER
// ============================================

/**
 * Route Flash text-gen through Gemini CLI (via OpenCode routing layer).
 * Uses multi-account rotation for rate limit resilience.
 *
 * Compatible return type with executeGeminiAPI for easy swapping.
 */
export async function executeFlashViaOpenCode(
  prompt: string,
  options: { systemPrompt?: string; timeout?: number; signal?: AbortSignal; researchOnly?: boolean } = {}
): Promise<GeminiAPIResult> {
  const fullPrompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  const result = await executeOpenCodeCLI(fullPrompt, "", {
    model: `google/${GEMINI_CLI_FLASH_MODEL}`,
    forceOpenCode: true,
    researchOnly: options.researchOnly ?? true,
    timeout: options.timeout ?? 300_000,
    signal: options.signal,
  });

  return {
    output: result.output,
    exitCode: result.exitCode,
    duration: result.duration,
    executor: "gemini-flash",
    model: GEMINI_CLI_FLASH_MODEL,
    inputTokens: result.stats?.input_tokens,
    outputTokens: result.stats?.output_tokens,
  };
}

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

/**
 * Research with web grounding capability
 */
export async function researchWithGemini(
  topic: string,
  additionalContext?: string
): Promise<string> {
  const query = additionalContext
    ? `Research the following topic, considering this context:\n\nContext: ${additionalContext}\n\nTopic: ${topic}`
    : `Research the following topic thoroughly: ${topic}`;

  const result = await executeGeminiAPI(query, {
    model: "flash3",
    useGrounding: true, // Force grounding for research
    systemPrompt: `You are an expert researcher. Provide comprehensive, accurate information with:
- Key facts and insights
- Recent developments (if applicable)
- Practical implications
- Citations from web search results when available
Be thorough but organized. Always prioritize accuracy and recent data.`,
    temperature: 0.4,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  return result.output;
}

/**
 * Summarize long content
 */
export async function summarizeWithGemini(
  content: string,
  instruction?: string
): Promise<string> {
  const defaultInstruction = "Summarize the following content, highlighting key points and actionable items.";

  const result = await executeFlashViaOpenCode(
    `${instruction || defaultInstruction}\n\n---\n\n${content}`,
    {
      systemPrompt: "You are an expert at analyzing and summarizing content. Extract key insights concisely.",
      timeout: 120_000,
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  return result.output;
}

/**
 * Analyze and plan based on context
 */
export async function planWithGemini(
  goal: string,
  context: string
): Promise<{
  plan: string;
  tasks: Array<{ task: string; priority: "high" | "medium" | "low"; risk: "low" | "medium" | "high" }>;
}> {
  const result = await executeGeminiAPI(
    `Given this context:\n\n${context}\n\n---\n\nCreate a plan to achieve this goal: ${goal}\n\nReturn as JSON:\n{\n  "plan": "overview of approach",\n  "tasks": [\n    {"task": "description", "priority": "high|medium|low", "risk": "low|medium|high"}\n  ]\n}`,
    {
      model: "pro31",
      useGrounding: false,
      systemPrompt: "You are a strategic planner. Create actionable, risk-aware plans. Return valid JSON only.",
      temperature: 0.3,
      reasoningEffort: "high",
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  try {
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    return JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    logger.error({ error: parseError, output: result.output }, "Failed to parse Gemini plan response");
    throw new Error("Failed to parse planning response");
  }
}

/**
 * Generate morning briefing from overnight findings
 */
export async function generateMorningBriefing(
  findings: string,
  dailyLog: string
): Promise<string> {
  const result = await executeFlashViaOpenCode(
    `Generate a morning briefing based on overnight findings and yesterday's log.

## Overnight Findings
${findings}

## Yesterday's Daily Log
${dailyLog}

---

Create a briefing with:
1. **The Big 3** - Top 3 priorities for today with reasons
2. **Overnight Findings** - Key discoveries and insights
3. **Needs Attention** - Items requiring decisions or action
4. **Context for Today** - Relevant background for today's work

Keep it actionable and concise.`,
    {
      systemPrompt: "You are a personal assistant creating a morning briefing. Be concise, prioritized, and actionable.",
      timeout: 120_000,
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  return result.output;
}

/**
 * Health check for the native API
 */
export async function checkGeminiAPIHealth(): Promise<boolean> {
  try {
    const result = await executeGeminiAPI("Respond with the single word: OK", {
      model: "flash3",  // gemini-3.5-flash
      useGrounding: false,
      maxTokens: 50,
    });
    return result.exitCode === 0 && result.output.length > 0;
  } catch {
    return false;
  }
}
