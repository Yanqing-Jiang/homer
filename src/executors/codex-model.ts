const CODEX_CLI_MODEL = "gpt-5.6-terra";

export function resolveCodexModelVariant(
  model: string | undefined,
  reasoningEffort: string | undefined,
): { model: string; reasoningEffort: string } {
  if (model?.startsWith("effort:")) return { model: CODEX_CLI_MODEL, reasoningEffort: model.slice(7) };
  switch (model) {
    case undefined:
    case "":
    case CODEX_CLI_MODEL:
      return { model: CODEX_CLI_MODEL, reasoningEffort: reasoningEffort ?? "high" };
    // gpt-5.5-* retained as back-compat aliases for any stale selection rows/chains.
    case "gpt-5.6-sol-medium":
    case "gpt-5.5-medium":
      return { model: "gpt-5.6-sol", reasoningEffort: "medium" };
    case "gpt-5.6-sol-low":
      return { model: "gpt-5.6-sol", reasoningEffort: "low" };
    case "gpt-5.6-sol-xhigh":
    case "gpt-5.5-xhigh":
      return { model: "gpt-5.6-sol", reasoningEffort: "xhigh" };
    case "gpt-5.6-sol-high":
    case "gpt-5.5":
      return { model: "gpt-5.6-sol", reasoningEffort: reasoningEffort ?? "high" };
    case "gpt-5.6-luna-max":
      return { model: "gpt-5.6-luna", reasoningEffort: "max" };
    case "gpt-5.6-terra-max":
      return { model: "gpt-5.6-terra", reasoningEffort: "max" };
    case "gpt-6-astra-low":
      return { model: "gpt-6-astra", reasoningEffort: "low" };
    default:
      return { model, reasoningEffort: reasoningEffort ?? "high" };
  }
}

