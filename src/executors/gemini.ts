import OpenAI from "openai";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================
// CONFIGURATION
// ============================================

const GEMINI_CONFIG = {
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  envKey: "GEMINI_API_KEY_Primary",
  models: {
    flash: "gemini-2.0-flash",
    pro: "gemini-2.0-pro",
    // Future models
    flash3: "gemini-3-flash-preview",
    pro3: "gemini-3-pro-preview",
  },
  defaultModel: "gemini-2.0-flash",
  fallbackModel: "gemini-2.0-pro",
} as const;

type GeminiModel = keyof typeof GEMINI_CONFIG.models | string;

// ============================================
// TYPES
// ============================================

export interface GeminiAPIOptions {
  model?: GeminiModel;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface GeminiAPIResult extends ExecutorResult {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

// ============================================
// CLIENT MANAGEMENT
// ============================================

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env[GEMINI_CONFIG.envKey];
    if (!apiKey) {
      throw new Error(`${GEMINI_CONFIG.envKey} not set in environment`);
    }
    client = new OpenAI({
      apiKey,
      baseURL: GEMINI_CONFIG.baseURL,
    });
  }
  return client;
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

export async function executeGeminiAPI(
  query: string,
  options: GeminiAPIOptions = {}
): Promise<GeminiAPIResult> {
  const startTime = Date.now();
  const model = resolveModel(options.model);

  const {
    systemPrompt = "You are a helpful assistant. Be concise and direct.",
    temperature = 0.3,
    maxTokens = 8192,
    timeout = 120000,
  } = options;

  logger.debug(
    { model, queryLength: query.length, temperature },
    "Executing Gemini API request"
  );

  try {
    const openaiClient = getClient();

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await openaiClient.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query },
        ],
        temperature,
        max_tokens: maxTokens,
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    const duration = Date.now() - startTime;
    const output = response.choices[0]?.message?.content || "(No response)";

    logger.debug(
      {
        model,
        duration,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "Gemini API request completed"
    );

    return {
      output,
      exitCode: 0,
      duration,
      executor: "gemini-api",
      model,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    // Check if it's a model-specific error and try fallback
    if (message.includes("model") && model !== GEMINI_CONFIG.fallbackModel) {
      logger.warn({ model, error: message }, "Primary model failed, trying fallback");
      return executeGeminiAPI(query, {
        ...options,
        model: GEMINI_CONFIG.fallbackModel,
      });
    }

    logger.error({ error: message, model, duration }, "Gemini API request failed");

    return {
      output: `Error: ${message}`,
      exitCode: 1,
      duration,
      executor: "gemini-api",
      model,
    };
  }
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
    model: "flash",
    systemPrompt: `You are an expert researcher. Provide comprehensive, accurate information with:
- Key facts and insights
- Recent developments (if applicable)
- Practical implications
- Sources or references when possible
Be thorough but organized.`,
    maxTokens: 8192,
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

  const result = await executeGeminiAPI(
    `${instruction || defaultInstruction}\n\n---\n\n${content}`,
    {
      model: "flash",
      systemPrompt: "You are an expert at analyzing and summarizing content. Extract key insights concisely.",
      maxTokens: 4096,
      temperature: 0.2,
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
      model: "pro", // Use pro for planning
      systemPrompt: "You are a strategic planner. Create actionable, risk-aware plans. Return valid JSON only.",
      maxTokens: 4096,
      temperature: 0.3,
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
  const result = await executeGeminiAPI(
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
      model: "flash",
      systemPrompt: "You are a personal assistant creating a morning briefing. Be concise, prioritized, and actionable.",
      maxTokens: 2048,
      temperature: 0.3,
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  return result.output;
}

// ============================================
// HEALTH CHECK
// ============================================

export async function checkGeminiAPIHealth(): Promise<boolean> {
  try {
    const result = await executeGeminiAPI("Say OK", {
      model: "flash",
      maxTokens: 10,
      timeout: 10000,
    });
    return result.exitCode === 0 && result.output.toLowerCase().includes("ok");
  } catch {
    return false;
  }
}
