import type { StateManager } from "../state/manager.js";
import { logger } from "../utils/logger.js";

export interface VerificationResult {
  status: "passed" | "failed" | "not_applicable";
  reason: string;
  purposeDelivered: boolean | null;
  firstAgentTurn?: string;
  firstUserTurn?: string;
}

interface TranscriptTurn {
  role: string;
  message: string | null;
  time_in_call_secs?: number;
}

export interface VerifyInput {
  conversationId: string;
  transcript: TranscriptTurn[];
  terminationReason?: string;
  durationSecs?: number;
}

export function verifyOutboundCall(
  input: VerifyInput,
  stateManager: StateManager,
): VerificationResult {
  const db = stateManager.getDb();

  const intent = db
    .prepare(
      `SELECT id, call_purpose, recipient_name, requested_by
         FROM outbound_call_intents
        WHERE conversation_id = ?
        LIMIT 1`,
    )
    .get(input.conversationId) as
    | { id: string; call_purpose: string; recipient_name: string; requested_by: string }
    | undefined;

  if (!intent) {
    return {
      status: "not_applicable",
      reason: "no outbound intent row for this conversation",
      purposeDelivered: null,
    };
  }

  const firstAgent = firstSubstantiveTurn(input.transcript, "agent");
  const firstUser = firstSubstantiveTurn(input.transcript, "user");

  const normalizedPurpose = normalize(intent.call_purpose);
  const normalizedFirst = normalize(firstAgent ?? "");

  const delivered = normalizedFirst.length > 0 && normalizedFirst.includes(normalizedPurpose);

  const result: VerificationResult = {
    status: delivered ? "passed" : "failed",
    reason: delivered
      ? "first agent turn contains call_purpose"
      : firstAgent
        ? "first agent turn does not contain call_purpose"
        : "no substantive agent turn found",
    purposeDelivered: delivered,
    firstAgentTurn: firstAgent ?? undefined,
    firstUserTurn: firstUser ?? undefined,
  };

  db.prepare(
    `UPDATE outbound_call_intents
       SET status = CASE WHEN ? = 'passed' THEN 'completed' ELSE 'verification_failed' END,
           verification_status = ?,
           verification_reason = ?,
           purpose_delivered = ?,
           first_agent_turn = ?,
           first_user_turn = ?,
           termination_reason = ?,
           duration_secs = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(
    result.status,
    result.status,
    result.reason,
    delivered ? 1 : 0,
    firstAgent ?? null,
    firstUser ?? null,
    input.terminationReason ?? null,
    input.durationSecs ?? null,
    intent.id,
  );

  logger.info(
    { intentId: intent.id, conversationId: input.conversationId, status: result.status },
    "Outbound call verification completed",
  );

  return result;
}

function firstSubstantiveTurn(
  transcript: TranscriptTurn[],
  role: "agent" | "user",
): string | null {
  for (const turn of transcript) {
    if (turn.role !== role) continue;
    const msg = (turn.message ?? "").trim();
    if (!msg) continue;
    if (msg === "None") continue;
    return msg;
  }
  return null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
