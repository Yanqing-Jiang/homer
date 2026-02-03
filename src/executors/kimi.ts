import OpenAI from "openai";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

// Provider configurations
const PROVIDERS = {
  moonshot: {
    baseURL: "https://api.moonshot.cn/v1",
    envKey: "MOONSHOT_API_KEY",
    models: {
      small: "moonshot-v1-8k",
      medium: "moonshot-v1-32k",
      large: "moonshot-v1-128k",
    },
    default: "moonshot-v1-128k",
  },
  nvidia: {
    baseURL: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_NIM_API_KEY",
    models: {
      small: "moonshotai/kimi-k2.5",
      medium: "moonshotai/kimi-k2.5",
      large: "moonshotai/kimi-k2.5",
    },
    default: "moonshotai/kimi-k2.5",
  },
} as const;

type Provider = keyof typeof PROVIDERS;
type ModelSize = "small" | "medium" | "large";

export interface KimiExecutorOptions {
  provider?: Provider;
  model?: string;
  modelSize?: ModelSize;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface KimiExecutorResult extends ExecutorResult {
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
}

const clients: Record<string, OpenAI> = {};

function getClient(provider: Provider): OpenAI {
  if (!clients[provider]) {
    const config = PROVIDERS[provider];
    const apiKey = process.env[config.envKey];
    if (!apiKey) {
      throw new Error(`${config.envKey} not set in environment`);
    }
    clients[provider] = new OpenAI({
      apiKey,
      baseURL: config.baseURL,
    });
  }
  return clients[provider];
}

// Auto-select provider based on available keys (prefer NVIDIA for longer expiry)
function selectProvider(): Provider {
  if (process.env.NVIDIA_NIM_API_KEY) return "nvidia";
  if (process.env.MOONSHOT_API_KEY) return "moonshot";
  throw new Error("No Kimi API key configured (NVIDIA_NIM_API_KEY or MOONSHOT_API_KEY)");
}

export async function executeKimiCommand(
  query: string,
  options: KimiExecutorOptions = {}
): Promise<KimiExecutorResult> {
  const startTime = Date.now();
  const provider = options.provider ?? selectProvider();
  const config = PROVIDERS[provider];

  // Resolve model: explicit model > modelSize > default
  const model = options.model
    ?? (options.modelSize ? config.models[options.modelSize] : config.default);

  const {
    systemPrompt = "You are a helpful assistant. Be concise and direct.",
    temperature = 0.3,
    maxTokens = 4096,
  } = options;

  logger.debug(
    { provider, model, queryLength: query.length, temperature },
    "Executing Kimi request"
  );

  try {
    const client = getClient(provider);

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature,
      max_tokens: maxTokens,
    });

    const duration = Date.now() - startTime;
    const output = response.choices[0]?.message?.content || "(No response)";

    logger.debug(
      {
        provider,
        model,
        duration,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "Kimi request completed"
    );

    return {
      output,
      exitCode: 0,
      duration,
      executor: "kimi",
      provider,
      model,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, provider, model, duration }, "Kimi request failed");

    return {
      output: `Error: ${message}`,
      exitCode: 1,
      duration,
      executor: "kimi",
      provider,
      model,
    };
  }
}

// Convenience function for long-context summarization
export async function summarizeWithKimi(
  content: string,
  instruction: string,
  provider?: Provider
): Promise<string> {
  const result = await executeKimiCommand(
    `${instruction}\n\n---\n\n${content}`,
    {
      provider,
      modelSize: "large",
      systemPrompt:
        "You are an expert at analyzing and summarizing content. Extract key insights, decisions, and actionable items. Be thorough but concise.",
      maxTokens: 8192,
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  return result.output;
}

// Convenience function for memory extraction from daily logs
export async function extractMemoryFacts(
  dailyLogContent: string,
  provider?: Provider
): Promise<{
  promotions: Array<{
    content: string;
    file: "me" | "work" | "life" | "preferences" | "tools";
    section?: string;
  }>;
  summary: string;
}> {
  const result = await executeKimiCommand(
    `Analyze this daily log and extract facts that should be saved to permanent memory.

Categories:
- me: Identity, personal goals, HOMER config
- work: Career, projects, contacts, professional context
- life: Life context, routines, personal relationships
- preferences: Communication style, technical preferences
- tools: Tool configurations, workflows, integrations

For each fact, provide:
1. The content to save (concise, standalone statement)
2. Which file it belongs to
3. Optional section header if it fits under a specific topic

Also provide a brief summary of the day's key activities.

Return as JSON:
{
  "promotions": [
    {"content": "...", "file": "work", "section": "Projects"}
  ],
  "summary": "..."
}

---

${dailyLogContent}`,
    {
      provider,
      modelSize: "large",
      systemPrompt:
        "You are a memory curator. Extract lasting facts from daily logs. Only include information worth remembering long-term. Be selective - not everything needs to be saved.",
      temperature: 0.2,
      maxTokens: 4096,
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  try {
    // Extract JSON from response (might be wrapped in markdown code block)
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    return JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    logger.error({ error: parseError, output: result.output }, "Failed to parse Kimi response");
    throw new Error("Failed to parse memory extraction response");
  }
}
