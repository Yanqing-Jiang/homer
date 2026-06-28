import { PATHS } from "../config/paths.js";
import type { ExecutorKind } from "../executors/fallback-orchestrator.js";
import type {
  HarnessSelection,
  InternalHarnessCallProfile,
} from "./executor.js";

export interface InternalJobHarnessBaseline extends HarnessSelection {
  stages?: Record<string, InternalHarnessCallProfile>;
}

const HOME_DIR = process.env.HOME ?? process.cwd();
const TMP_DIR = "/tmp";
const CODEX_MODEL = "gpt-5.5";
const OPENCODE_FLASH_MODEL = "google/gemini-3.5-flash";
const IDEA_STEP_TIMEOUT = 180_000;
const LINK_PROCESS_TIMEOUT = 300_000;
const PROJECT_DIR = PATHS.homerRoot;

function codexStage(
  cwdOverride: string,
  timeoutOverride: number,
  reasoningEffort: "medium" | "high" = "medium",
): InternalHarnessCallProfile {
  return {
    executor: "codex",
    model: CODEX_MODEL,
    cwdOverride,
    timeoutOverride,
    executorOptions: {
      codex: { reasoningEffort },
    },
  };
}

const youtubeClassifyStage: InternalHarnessCallProfile = {
  executor: "opencode",
  model: OPENCODE_FLASH_MODEL,
  cwdOverride: HOME_DIR,
  timeoutOverride: 900_000,
  executorOptions: {
    opencode: {
      forceOpenCode: true,
      researchOnly: false,
    },
  },
};

const youtubeAnalyzeStage: InternalHarnessCallProfile = {
  executor: "claude",
  model: "sonnet",
  cwdOverride: HOME_DIR,
  timeoutOverride: 180_000,
  fallbackChain: ["opencode"],
  fallbackModels: {
    opencode: OPENCODE_FLASH_MODEL,
  },
  executorOptions: {
    opencode: {
      forceOpenCode: true,
      researchOnly: false,
    },
  },
};

export const INTERNAL_JOB_HARNESS_BASELINES = {
  "ideas-explore": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      filter: codexStage(HOME_DIR, 180_000, "medium"),
    },
  },
  "nightly-memory": {
    executor: "claude",
    model: "opus[1m]",
    stages: {
      extract: {
        executor: "claude",
        model: "opus[1m]",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
    },
  },
  "weekly-memory-consolidation": {
    executor: "claude",
    model: "opus[1m]",
    stages: {
      consolidate: {
        executor: "claude",
        model: "opus[1m]",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
    },
  },
  "weekly-memory-cleanup": {
    executor: "claude",
    model: "opus[1m]",
    stages: {
      cleanup: {
        executor: "claude",
        model: "opus[1m]",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
    },
  },
  "homer-improvements": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      propose: codexStage(PATHS.homerRoot, 1_200_000, "high"),
    },
  },
  "overnight-youtube": {
    executor: "opencode",
    model: OPENCODE_FLASH_MODEL,
    stages: {
      classify: youtubeClassifyStage,
      analyze: youtubeAnalyzeStage,
    },
  },
  "link-processor": {
    executor: "opencode",
    model: null,
    stages: {
      article: {
        executor: "opencode",
        model: null,
        cwdOverride: TMP_DIR,
        timeoutOverride: LINK_PROCESS_TIMEOUT,
      },
      youtube_classify: youtubeClassifyStage,
      youtube_analyze: youtubeAnalyzeStage,
    },
  },
  "idea-synthesizer": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      triage: codexStage(TMP_DIR, IDEA_STEP_TIMEOUT, "medium"),
      synthesize: codexStage(TMP_DIR, IDEA_STEP_TIMEOUT, "medium"),
      critique: codexStage(TMP_DIR, IDEA_STEP_TIMEOUT, "medium"),
      enrich: codexStage(TMP_DIR, IDEA_STEP_TIMEOUT, "medium"),
    },
  },
  "idea-dedup": {
    executor: "opencode",
    model: OPENCODE_FLASH_MODEL,
    stages: {
      dedupe: {
        executor: "opencode",
        model: OPENCODE_FLASH_MODEL,
        cwdOverride: HOME_DIR,
        timeoutOverride: 300_000,
        executorOptions: {
          opencode: {
            forceOpenCode: true,
            researchOnly: false,
          },
        },
      },
    },
  },
  "nightly-code-push": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      push: codexStage(PROJECT_DIR, 600_000, "high"),
    },
  },
  "outcome-tracker": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      analyze: codexStage(HOME_DIR, 120_000, "high"),
    },
  },
  "content-scraper": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      extract: codexStage(HOME_DIR, 180_000, "medium"),
    },
  },
  "health-check": {
    executor: "claude",
    model: "sonnet",
    stages: {
      triage: {
        executor: "claude",
        model: "sonnet",
        timeoutOverride: 30_000,
      },
    },
  },
  "harness-auto-improve": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      propose: codexStage(PATHS.homerRoot, 1_200_000, "high"),
    },
  },
} satisfies Record<string, InternalJobHarnessBaseline>;

export type InternalHarnessSwappableJobId = keyof typeof INTERNAL_JOB_HARNESS_BASELINES;

export function getInternalJobHarnessBaseline(
  jobId: string,
): InternalJobHarnessBaseline | undefined {
  return INTERNAL_JOB_HARNESS_BASELINES[jobId as InternalHarnessSwappableJobId];
}

export function requireInternalJobHarnessBaseline(jobId: string): InternalJobHarnessBaseline {
  const baseline = getInternalJobHarnessBaseline(jobId);
  if (!baseline) {
    throw new Error(`No internal harness baseline registered for job: ${jobId}`);
  }
  return baseline;
}

export function isInternalHarnessSwappableJobId(
  jobId: string,
): jobId is InternalHarnessSwappableJobId {
  return jobId in INTERNAL_JOB_HARNESS_BASELINES;
}

export function mergeHarnessProfiles(
  baseline: HarnessSelection,
  profile?: InternalHarnessCallProfile,
): HarnessSelection & InternalHarnessCallProfile {
  return {
    ...baseline,
    ...profile,
    executorOptions: {
      ...baseline.executorOptions,
      ...profile?.executorOptions,
    },
    fallbackModels: {
      ...baseline.fallbackModels,
      ...profile?.fallbackModels,
    },
  };
}

export function toExecutorKind(executor: HarnessSelection["executor"]): ExecutorKind {
  return executor;
}
