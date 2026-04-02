export interface ExecutorMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  toolCalls?: number;
  costUsd?: number;
}

export interface ExecutorResult {
  output: string;
  exitCode: number;
  duration: number;
  executor: string;
  metrics?: ExecutorMetrics;
}

export interface ExecutorOptions {
  timeout?: number;
  cwd?: string;
  sessionId?: string;
}
