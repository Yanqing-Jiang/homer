import { callPerson } from "../../telephony/outbound-call.js";
import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

export const definitions: ToolDefinition[] = [
  {
    name: "call_person",
    description:
      "Place an outbound phone call via Homer. Homer dials the number, identifies himself on behalf of Yanqing, and delivers the provided purpose in the first sentence. Refuses to dial without a non-empty purpose. Returns intent_id and conversation_id immediately; post-call transcript is processed asynchronously via webhook.",
    inputSchema: {
      type: "object",
      properties: {
        to_number: {
          type: "string",
          description: "Phone number to call (10 digits, +1, or E.164)",
        },
        call_purpose: {
          type: "string",
          description:
            "What Homer must say in the first turn. Stated verbatim to the callee — write it as Homer should deliver it.",
        },
        recipient_name: {
          type: "string",
          description: "How Homer should address the callee. Defaults to 'there'.",
        },
        requested_by: {
          type: "string",
          description: "Who the call is on behalf of. Defaults to 'Yanqing'.",
        },
        language: {
          type: "string",
          description: "ISO language code. Defaults to 'en'.",
        },
      },
      required: ["to_number", "call_purpose"],
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolResult | null> {
  if (name !== "call_person") return null;

  const toNumber = typeof args.to_number === "string" ? args.to_number : "";
  const callPurpose = typeof args.call_purpose === "string" ? args.call_purpose : "";
  const recipientName = typeof args.recipient_name === "string" ? args.recipient_name : undefined;
  const requestedBy = typeof args.requested_by === "string" ? args.requested_by : undefined;
  const language = typeof args.language === "string" ? args.language : undefined;

  const result = await callPerson(
    {
      toNumber,
      callPurpose,
      recipientName,
      requestedBy,
      language,
      source: "mcp",
    },
    deps.getSharedStateManager(),
  );

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result.status === "failed",
  };
}
