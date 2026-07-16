/**
 * Harness Catalog — single source of truth for "which harness + which model" across the
 * scheduler job switcher, the Telegram chat switcher, the `/harness` command, and the web API.
 *
 * Validation lives here (NOT duplicated in homer-web) so the daemon, the bot, and the Fastify
 * API can never disagree on what executor/model pairs are legal. Seeded from EXECUTOR_MODELS
 * and the richer command-registry model aliases.
 */

import { GEMINI_CLI_FLASH_MODEL, GEMINI_CLI_PRO_MODEL } from "../executors/gemini-cli.js";
import { OPENCODE_DEFAULT_MODEL } from "./registry.js";

/** The five CLI harnesses that scheduled jobs and the global default can use. */
export type HarnessExecutor = "claude" | "codex" | "opencode" | "gemini" | "kimi";
/** Interactive-only executors — valid for a Telegram chat lane but never a scheduled job. */
export type InteractiveOnlyExecutor = "chatgpt";
export type CatalogExecutor = HarnessExecutor | InteractiveOnlyExecutor;

/** Where a harness selection is being applied — gates which executors are legal. */
export type HarnessScope = "scheduled-job" | "telegram-chat" | "telegram-global";

export interface HarnessModelOption {
  id: string;
  label: string;
  default?: boolean;
}

export interface HarnessCatalogEntry {
  executor: CatalogExecutor;
  label: string;
  scopes: HarnessScope[];
  /** "catalog" = pick a model from `models`; "none" = CLI owns the model (no model arg passed). */
  modelMode: "catalog" | "none";
  defaultModel: string | null;
  models: HarnessModelOption[];
}

const SCHEDULED_AND_TELEGRAM: HarnessScope[] = ["scheduled-job", "telegram-chat", "telegram-global"];

const CATALOG: Record<CatalogExecutor, HarnessCatalogEntry> = {
  claude: {
    executor: "claude",
    label: "Claude",
    scopes: SCHEDULED_AND_TELEGRAM,
    modelMode: "catalog",
    defaultModel: "opus[1m]",
    models: [
      { id: "opus[1m]", label: "Opus 1M", default: true },
      { id: "opus[high]", label: "Opus (high effort)" },
      { id: "sonnet[1m]", label: "Sonnet 1M" },
    ],
  },
  opencode: {
    executor: "opencode",
    label: "OpenCode",
    scopes: SCHEDULED_AND_TELEGRAM,
    modelMode: "catalog",
    defaultModel: OPENCODE_DEFAULT_MODEL,
    models: [
      { id: "cursor/grok-4.5-high", label: "Cursor Grok 4.5 (high)", default: true },
      { id: "cursor/grok-4.5-medium", label: "Cursor Grok 4.5 (medium)" },
      { id: "cursor/claude-opus-4-8-high", label: "Cursor Opus 4.8 (high, 1M)" },
      { id: "cursor/gpt-5.6-sol-medium", label: "Cursor GPT-5.6 Sol (medium, 1M)" },
      { id: "cursor/gpt-5.6-sol-high", label: "Cursor GPT-5.6 Sol (high, 1M)" },
      { id: "cursor/composer-2.5", label: "Cursor Composer 2.5 (fast/cheap)" },
      { id: "opencode-go/glm-5.2", label: "GLM 5.2" },
      { id: "opencode-go-2/glm-5.2", label: "GLM 5.2 (account 2)" },
      { id: "opencode-go/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "opencode-go-2/deepseek-v4-pro", label: "DeepSeek V4 Pro (account 2)" },
      { id: "opencode-go/kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "opencode-go-2/kimi-k2.7-code", label: "Kimi K2.7 Code (account 2)" },
      { id: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "github-copilot/claude-opus-4.8", label: "GitHub Copilot Opus 4.8 (high)" },
    ],
  },
  gemini: {
    executor: "gemini",
    label: "Gemini",
    scopes: SCHEDULED_AND_TELEGRAM,
    modelMode: "catalog",
    defaultModel: GEMINI_CLI_FLASH_MODEL,
    models: [
      { id: GEMINI_CLI_FLASH_MODEL, label: "Gemini Flash", default: true },
      { id: GEMINI_CLI_PRO_MODEL, label: "Gemini Pro" },
    ],
  },
  kimi: {
    executor: "kimi",
    label: "Kimi",
    scopes: SCHEDULED_AND_TELEGRAM,
    modelMode: "catalog",
    defaultModel: "kimi-k2-5",
    models: [{ id: "kimi-k2-5", label: "Kimi K2.5", default: true }],
  },
  codex: {
    executor: "codex",
    label: "Codex",
    scopes: SCHEDULED_AND_TELEGRAM,
    modelMode: "catalog",
    defaultModel: "gpt-5.6-sol",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (high)", default: true },
      { id: "gpt-5.6-sol-medium", label: "GPT-5.6 Sol (medium)" },
      { id: "gpt-5.6-sol-xhigh", label: "GPT-5.6 Sol (xhigh)" },
    ],
  },
  chatgpt: {
    executor: "chatgpt",
    label: "ChatGPT",
    scopes: ["telegram-chat"],
    modelMode: "none",
    defaultModel: null,
    models: [],
  },
};

export function getHarnessCatalog(): Record<CatalogExecutor, HarnessCatalogEntry> {
  return CATALOG;
}

export function getCatalogEntry(executor: string): HarnessCatalogEntry | undefined {
  return CATALOG[executor as CatalogExecutor];
}

const SCHEDULED_EXECUTORS = new Set<HarnessExecutor>(["claude", "codex", "opencode", "gemini", "kimi"]);

/** True for the five CLI harnesses a scheduled job can run on (excludes chatgpt). */
export function isScheduledHarnessExecutor(value: string): value is HarnessExecutor {
  return SCHEDULED_EXECUTORS.has(value as HarnessExecutor);
}

export type HarnessValidationOk = { ok: true; executor: CatalogExecutor; model: string | null };
export type HarnessValidationErr = {
  ok: false;
  code: "invalid_executor" | "unsupported_scope" | "invalid_model" | "model_not_allowed";
  message: string;
  allowedExecutors?: string[];
  allowedModels?: string[];
};

/**
 * Validate + normalize an executor/model selection for a given scope.
 * - Unknown executor -> invalid_executor.
 * - Executor not allowed in this scope (e.g. chatgpt for a job) -> unsupported_scope.
 * - modelMode "none" executor with a model string -> model_not_allowed.
 * - modelMode "catalog" executor: missing/null model normalizes to defaultModel; unknown model -> invalid_model.
 */
export function validateHarnessSelection(input: {
  executor: string;
  model?: string | null;
  scope: HarnessScope;
}): HarnessValidationOk | HarnessValidationErr {
  const entry = getCatalogEntry(input.executor);
  if (!entry) {
    return {
      ok: false,
      code: "invalid_executor",
      message: `Unknown executor "${input.executor}"`,
      allowedExecutors: Object.keys(CATALOG),
    };
  }
  if (!entry.scopes.includes(input.scope)) {
    return {
      ok: false,
      code: "unsupported_scope",
      message: `Executor "${input.executor}" is not valid for scope "${input.scope}"`,
      allowedExecutors: Object.values(CATALOG)
        .filter((e) => e.scopes.includes(input.scope))
        .map((e) => e.executor),
    };
  }

  const model = input.model ?? null;

  if (entry.modelMode === "none") {
    if (model) {
      return {
        ok: false,
        code: "model_not_allowed",
        message: `Executor "${input.executor}" is CLI-managed and takes no model argument`,
        allowedModels: [],
      };
    }
    return { ok: true, executor: entry.executor, model: null };
  }

  // modelMode === "catalog"
  if (!model) {
    return { ok: true, executor: entry.executor, model: entry.defaultModel };
  }
  if (!entry.models.some((m) => m.id === model)) {
    return {
      ok: false,
      code: "invalid_model",
      message: `Model "${model}" is not valid for executor "${input.executor}"`,
      allowedModels: entry.models.map((m) => m.id),
    };
  }
  return { ok: true, executor: entry.executor, model };
}
