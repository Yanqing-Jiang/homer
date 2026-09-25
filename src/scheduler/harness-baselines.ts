import { PATHS } from "../config/paths.js";
import type { ExecutorKind } from "../executors/fallback-orchestrator.js";
import { getPrivateOverlay } from "../private-overlay.js";
import type {
  HarnessSelection,
  InternalHarnessCallProfile,
} from "./executor.js";

export interface InternalJobHarnessBaseline extends HarnessSelection {
  stages?: Record<string, InternalHarnessCallProfile>;
}

const HOME_DIR = process.env.HOME ?? process.cwd();
// Former Terra jobs run on OpenCode Copilot Opus 5.5 high (Yanqing, 2026-09-24).
const OPUS_MODEL = "github-copilot/claude-opus-5.5";
const CONTENT_MODEL = "gpt-6-astra";
// Scraping-related jobs run on Astra at low effort (Yanqing, 2026-09-11).
const SCRAPE_MODEL = "gpt-6-astra-low";
const PROJECT_DIR = PATHS.homerRoot;

function opusStage(cwdOverride: string | undefined, timeoutOverride: number): InternalHarnessCallProfile {
  return {
    executor: "opencode",
    model: OPUS_MODEL,
    cwdOverride,
    timeoutOverride,
    executorOptions: {
      opencode: { variant: "high", forceOpenCode: true, researchOnly: false },
    },
  };
}

const PUBLIC_JOB_HARNESS_BASELINES = {
  "ideas-explore": {
    executor: "codex",
    model: CONTENT_MODEL,
    stages: {
      filter: opusStage(HOME_DIR, 180_000),
    },
  },
  "nightly-memory": {
    executor: "codex",
    model: CONTENT_MODEL,
    stages: {
      extract: {
        executor: "codex",
        model: CONTENT_MODEL,
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
      },
    },
  },
  "weekly-memory-consolidation": {
    executor: "codex",
    model: "gpt-6-astra",
    stages: {
      consolidate: {
        executor: "codex",
        model: "gpt-6-astra",
        cwdOverride: HOME_DIR,
        timeoutOverride: 600_000,
        executorOptions: { codex: { reasoningEffort: "high" } },
        fallbackChain: [],
      },
    },
  },
  "nightly-code-push": {
    executor: "opencode",
    model: OPUS_MODEL,
    stages: {
      // 90s, not 600s: a nicer commit message must never consume the whole job
      // budget — generateCommitMessage falls back to a generic message on timeout.
      // DEBT: this is a per-repo budget and nightly-code-push runs two repos
      // serially, so two dirty repos can spend 180s of the job's 300s declared
      // budget (watchdog at 330s) before any git work; upgrade to a job-wide
      // allowance derived from remaining time when nightly-code-push hits its
      // watchdog with both repos dirty.
      push: opusStage(PROJECT_DIR, 90_000),
    },
  },
  "outcome-tracker": {
    executor: "opencode",
    model: OPUS_MODEL,
    stages: {
      analyze: opusStage(HOME_DIR, 120_000),
    },
  },
  "content-scraper": {
    executor: "codex",
    model: SCRAPE_MODEL,
    stages: {
      extract: {
        executor: "codex",
        model: SCRAPE_MODEL,
        cwdOverride: HOME_DIR,
        timeoutOverride: 180_000,
        executorOptions: { codex: { reasoningEffort: "low" } },
      },
    },
  },
  "health-check": {
    executor: "opencode",
    model: OPUS_MODEL,
    stages: {
      triage: opusStage(undefined, 30_000),
    },
  },
} satisfies Record<string, InternalJobHarnessBaseline>;

/** Baselines declared by the private overlay manifest (`harnessBaselines`), keyed by job id. */
function privateJobHarnessBaselines(): Record<string, InternalJobHarnessBaseline> {
  return (getPrivateOverlay()?.manifest.harnessBaselines ?? {}) as Record<string, InternalJobHarnessBaseline>;
}

export const INTERNAL_JOB_HARNESS_BASELINES: Record<string, InternalJobHarnessBaseline> = {
  ...PUBLIC_JOB_HARNESS_BASELINES,
  ...privateJobHarnessBaselines(),
};

export type InternalHarnessSwappableJobId = string;

export function getInternalJobHarnessBaseline(
  jobId: string,
): InternalJobHarnessBaseline | undefined {
  return INTERNAL_JOB_HARNESS_BASELINES[jobId];
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
