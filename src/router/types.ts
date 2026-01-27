// Context types (new simplified model)
export type ContextId = "work" | "life" | "default";

// Legacy lane types for compatibility
export type LaneId = "work" | "invest" | "personal" | "learning" | "life" | "default";

export type ExecutorType = "claude" | "gemini" | "codex";

export interface RouteResult {
  lane: LaneId;
  executor: ExecutorType;
  query: string;
  prefix: string;
  forceExecutor: boolean;
}

export interface PrefixMapping {
  prefix: string;
  lane: LaneId;
  executor: ExecutorType;
  forceExecutor: boolean;
}
