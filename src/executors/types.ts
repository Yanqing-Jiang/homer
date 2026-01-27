export interface ExecutorResult {
  output: string;
  exitCode: number;
  duration: number;
  executor: string;
}

export interface ExecutorOptions {
  timeout?: number;
  cwd?: string;
  sessionId?: string;
}
