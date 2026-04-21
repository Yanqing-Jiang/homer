import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import {
  HOMER_AGENT_ID,
  HOMER_PHONE_NUMBER_ID,
  ELEVENLABS_API_BASE,
} from "./constants.js";
import type { StateManager } from "../state/manager.js";

export interface CallPersonInput {
  toNumber: string;
  callPurpose: string;
  recipientName?: string;
  requestedBy?: string;
  source: "telegram" | "mcp" | "scheduler" | "manual";
  sourceRef?: string;
  language?: string;
}

export interface CallPersonResult {
  intentId: string;
  conversationId?: string;
  callSid?: string;
  status: "dialing" | "failed";
  error?: string;
}

const OUTBOUND_FIRST_MESSAGE =
  "Hi {{recipient_name}}, this is Homer calling on behalf of {{requested_by}}. {{call_purpose}}";

const OUTBOUND_PROMPT_OVERRIDE = `
You are Homer, Yanqing's AI assistant, and you are on an OUTBOUND call that you initiated.

The callee did not expect this call. In your very first turn you must:
1. Identify yourself as Homer.
2. Say you are calling on behalf of {{requested_by}}.
3. Deliver this purpose clearly and completely: {{call_purpose}}

Hard rules:
- Never open with "What can I do for you?" or "How can I help?". You are the one who called them.
- Keep your opening under two sentences.
- If the callee is silent, repeat the purpose once in a shorter sentence, then end the call politely.
- Stay on topic. Do not invent purposes, commitments, or facts Yanqing did not provide.
- If the callee asks Yanqing's contact info, you may share the main line only if asked directly.
`.trim();

export async function callPerson(
  input: CallPersonInput,
  stateManager: StateManager,
): Promise<CallPersonResult> {
  const apiKey = config.voice.elevenLabsApiKey;
  const intentId = `oci_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const callPurpose = input.callPurpose?.trim() ?? "";
  if (!callPurpose) {
    return {
      intentId,
      status: "failed",
      error: "call_purpose is required and cannot be empty",
    };
  }

  const toNumber = normalizeE164(input.toNumber);
  if (!toNumber) {
    return {
      intentId,
      status: "failed",
      error: `invalid phone number: ${input.toNumber}`,
    };
  }

  const recipientName = (input.recipientName?.trim() || "there");
  const requestedBy = (input.requestedBy?.trim() || "Yanqing");
  const language = input.language ?? "en";

  const db = stateManager.getDb();
  db.prepare(
    `INSERT INTO outbound_call_intents
      (id, source, source_ref, to_number, recipient_name, call_purpose,
       requested_by, agent_id, agent_phone_number_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
  ).run(
    intentId,
    input.source,
    input.sourceRef ?? null,
    toNumber,
    recipientName,
    callPurpose,
    requestedBy,
    HOMER_AGENT_ID,
    HOMER_PHONE_NUMBER_ID,
  );

  if (!apiKey) {
    markFailed(db, intentId, "missing ELEVEN_LABS_API_KEY");
    return { intentId, status: "failed", error: "missing ELEVEN_LABS_API_KEY" };
  }

  const body = {
    agent_id: HOMER_AGENT_ID,
    agent_phone_number_id: HOMER_PHONE_NUMBER_ID,
    to_number: toNumber,
    conversation_initiation_client_data: {
      dynamic_variables: {
        call_direction: "outbound",
        recipient_name: recipientName,
        call_purpose: callPurpose,
        requested_by: requestedBy,
      },
      conversation_config_override: {
        agent: {
          prompt: { prompt: OUTBOUND_PROMPT_OVERRIDE },
          first_message: OUTBOUND_FIRST_MESSAGE,
          language,
        },
      },
    },
  };

  try {
    const response = await fetch(
      `${ELEVENLABS_API_BASE}/convai/twilio/outbound-call`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const rawText = await response.text();
    if (!response.ok) {
      const errMsg = `HTTP ${response.status}: ${rawText.slice(0, 500)}`;
      logger.error({ intentId, status: response.status, body: rawText }, "ElevenLabs outbound call failed");
      markFailed(db, intentId, errMsg);
      return { intentId, status: "failed", error: errMsg };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      const errMsg = `invalid JSON response: ${rawText.slice(0, 200)}`;
      markFailed(db, intentId, errMsg);
      return { intentId, status: "failed", error: errMsg };
    }

    const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : undefined;
    const callSid = typeof data.call_sid === "string" ? data.call_sid : undefined;

    if (!conversationId) {
      const errMsg = "no conversation_id in response";
      markFailed(db, intentId, errMsg);
      return { intentId, status: "failed", error: errMsg };
    }

    db.prepare(
      `UPDATE outbound_call_intents
         SET conversation_id = ?, call_sid = ?, status = 'dialing',
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(conversationId, callSid ?? null, intentId);

    logger.info({ intentId, conversationId, toNumber }, "Outbound call dialing");
    return { intentId, conversationId, callSid, status: "dialing" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ intentId, error }, "Outbound call network error");
    markFailed(db, intentId, errMsg);
    return { intentId, status: "failed", error: errMsg };
  }
}

function markFailed(
  db: ReturnType<StateManager["getDb"]>,
  intentId: string,
  errMsg: string,
): void {
  db.prepare(
    `UPDATE outbound_call_intents
       SET status = 'failed', provider_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(errMsg, intentId);
}

export function normalizeE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (input.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}
