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
const CODEX_MODEL = "gpt-5.6-sol";
const OPENCODE_FAST_MODEL = "cursor/composer-2.5";
const CODEX_FALLBACK_MODEL = "gpt-5.6-sol-medium";
const IDEA_STEP_TIMEOUT = 180_000;
const LINK_PROCESS_TIMEOUT = 300_000;
const PROJECT_DIR = PATHS.homerRoot;

function codexStage(
  cwdOverride: string,
  timeoutOverride: number,
  reasoningEffort: "medium" | "high" | "xhigh" = "medium",
): InternalHarnessCallProfile {
  const model =
    reasoningEffort === "medium" ? "gpt-5.6-sol-medium" :
    reasoningEffort === "xhigh" ? "gpt-5.6-sol-xhigh" :
    CODEX_MODEL;
  return {
    executor: "codex",
    model,
    cwdOverride,
    timeoutOverride,
    executorOptions: {
      codex: { reasoningEffort },
    },
  };
}

/** Shared OpenCode primary + Codex medium fallback for YouTube classify/analyze. */
function youtubeStage(
  timeoutOverride: number,
): InternalHarnessCallProfile {
  return {
    executor: "opencode",
    model: OPENCODE_FAST_MODEL,
    cwdOverride: HOME_DIR,
    timeoutOverride,
    fallbackChain: ["codex"],
    fallbackModels: {
      codex: CODEX_FALLBACK_MODEL,
    },
    executorOptions: {
      opencode: {
        forceOpenCode: true,
        researchOnly: false,
      },
    },
  };
}

const youtubeClassifyStage: InternalHarnessCallProfile = youtubeStage(900_000);
const youtubeAnalyzeStage: InternalHarnessCallProfile = youtubeStage(300_000); // 5 min — Composer deep analysis

export const INTERNAL_JOB_HARNESS_BASELINES = {
  "ideas-explore": {
    executor: "codex",
    model: CODEX_MODEL,
    stages: {
      filter: codexStage(HOME_DIR, 180_000, "medium"),
    },
  },
  "nightly-memory": {
    executor: "codex",
    model: "gpt-5.6-sol-medium",
    stages: {
      extract: {
        executor: "codex",
        model: "gpt-5.6-sol-medium",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
    },
  },
  "weekly-memory-consolidation": {
    executor: "codex",
    model: "gpt-5.6-sol-medium",
    stages: {
      consolidate: {
        executor: "codex",
        model: "gpt-5.6-sol-medium",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
      cleanup: {
        executor: "codex",
        model: "gpt-5.6-sol-medium",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
    },
  },
  "link-processor": {
    executor: "opencode",
    model: OPENCODE_FAST_MODEL,
    stages: {
      article: {
        executor: "opencode",
        model: OPENCODE_FAST_MODEL,
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
      // Single batched judgement (triage+synthesize+critique+enrich merged).
      harvest: codexStage(TMP_DIR, IDEA_STEP_TIMEOUT, "medium"),
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
    executor: "opencode",
    model: OPENCODE_FAST_MODEL,
    stages: {
      triage: {
        executor: "opencode",
        model: OPENCODE_FAST_MODEL,
        timeoutOverride: 30_000,
      },
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
