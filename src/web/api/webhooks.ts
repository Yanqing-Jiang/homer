import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { WEBHOOK_BASE, HOMER_AGENT_ID } from "../../telephony/constants.js";
import { PATHS } from "../../config/paths.js";
import type { StateManager } from "../../state/manager.js";
import type { Bot } from "grammy";

// Store raw bodies keyed by request ID for signature validation
const rawBodyStore = new WeakMap<FastifyRequest, Buffer>();

// ============================================
// SIGNATURE VALIDATORS
// ============================================

function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string
): boolean {
  // Twilio signature: HMAC-SHA1 of URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

const ELEVENLABS_SIGNATURE_TOLERANCE_SECS = 300;

function validateElevenLabsSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string
): boolean {
  // Header format: "t=<unix_timestamp>,v0=<hex_digest>"
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, ...v] = p.split("=");
      return [k, v.join("=")];
    })
  );

  const timestamp = parts.t;
  const v0 = parts.v0;
  if (!timestamp || !v0) return false;

  // Replay protection
  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (isNaN(age) || age > ELEVENLABS_SIGNATURE_TOLERANCE_SECS) return false;

  // HMAC input: "{timestamp}.{rawBody}"
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString()}`)
    .digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v0, "hex"));
  } catch {
    return false;
  }
}

// ============================================
// ROUTE REGISTRATION
// ============================================

export function registerWebhookRoutes(
  server: FastifyInstance,
  stateManager: StateManager,
  bot: Bot | null,
  chatId: number
): void {
  // Capture raw body for webhook routes (needed for signature validation)
  server.addHook("preParsing", async (request, _reply, payload) => {
    if (request.url.startsWith("/webhooks/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks);
      rawBodyStore.set(request, rawBody);

      // Return a new readable stream from the buffer so Fastify can still parse it
      const { Readable } = await import("stream");
      return Readable.from(rawBody);
    }
    return payload;
  });

  // Register form-urlencoded parser for Twilio webhooks
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // ---- ElevenLabs: Post-call summary ----
  const callEventsDir = join(PATHS.homerData, "call-events");
  if (!existsSync(callEventsDir)) mkdirSync(callEventsDir, { recursive: true });

  server.post("/webhooks/elevenlabs/call-complete", async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = config.voice.elevenLabsWebhookSecret;

    // Validate signature if secret is configured
    if (secret) {
      const signature = request.headers["elevenlabs-signature"] as string || "";
      const rawBody = rawBodyStore.get(request);

      if (!rawBody || !validateElevenLabsSignature(rawBody, signature, secret)) {
        logger.warn("ElevenLabs webhook: invalid signature");
        reply.status(401).send({ error: "Invalid signature" });
        return;
      }
    }

    // Parse and validate payload shape
    const payload = request.body as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") {
      logger.warn("ElevenLabs webhook: invalid payload");
      reply.status(400).send({ error: "Invalid payload" });
      return;
    }

    const eventType = typeof payload.type === "string" ? payload.type : "unknown";
    const data = (typeof payload.data === "object" && payload.data !== null)
      ? payload.data as Record<string, unknown>
      : undefined;
    const conversationId = typeof data?.conversation_id === "string" ? data.conversation_id : undefined;

    // Only process transcription events (skip audio, failure)
    if (eventType !== "post_call_transcription") {
      logger.info({ eventType, conversationId }, "ElevenLabs webhook: non-transcription event, ignoring");
      reply.status(200).send({ ok: true });
      return;
    }

    if (!conversationId) {
      logger.warn({ payload: JSON.stringify(payload).slice(0, 500) }, "ElevenLabs webhook: no conversation_id");
      reply.status(200).send({ ok: true });
      return;
    }

    // Validate agent_id — only process calls from Homer's agent
    const agentId = typeof data?.agent_id === "string" ? data.agent_id : undefined;
    if (agentId && agentId !== HOMER_AGENT_ID) {
      logger.info({ agentId, conversationId }, "ElevenLabs webhook: ignoring call from non-Homer agent");
      reply.status(200).send({ ok: true });
      return;
    }

    // Durable storage: persist raw payload to disk BEFORE returning 200
    const eventFile = join(callEventsDir, `${conversationId}.json`);
    try {
      writeFileSync(eventFile, JSON.stringify(payload), "utf-8");
    } catch (err) {
      logger.error({ error: err, conversationId }, "Failed to persist call event to disk");
      reply.status(500).send({ error: "Storage failure" });
      return;
    }

    logger.info({ conversationId, eventType, agentId }, "ElevenLabs call-complete webhook received and persisted");
    reply.status(200).send({ ok: true });

    // Build typed webhook data from validated fields
    const transcript = Array.isArray(data?.transcript)
      ? (data.transcript as Array<{ role: string; message: string; time_in_call_secs?: number }>)
      : [];
    const webhookData = {
      conversation_id: conversationId,
      agent_id: agentId,
      status: typeof data?.status === "string" ? data.status : undefined,
      transcript,
      analysis: (typeof data?.analysis === "object" && data.analysis !== null)
        ? data.analysis as { call_successful?: string; transcript_summary?: string; call_summary_title?: string }
        : undefined,
      metadata: (typeof data?.metadata === "object" && data.metadata !== null)
        ? data.metadata as { call_duration_secs?: number; termination_reason?: string }
        : undefined,
    };

    // Process in background — event file on disk ensures recoverability
    setImmediate(async () => {
      try {
        const { verifyOutboundCall } = await import("../../telephony/verify-outbound-call.js");
        const verification = verifyOutboundCall(
          {
            conversationId,
            transcript: webhookData.transcript,
            terminationReason: webhookData.metadata?.termination_reason,
            durationSecs: webhookData.metadata?.call_duration_secs,
          },
          stateManager,
        );

        const { processCallComplete } = await import("../../telephony/call-summary.js");
        await processCallComplete(conversationId, bot, chatId, webhookData);

        if (verification.status === "failed" && bot) {
          const alert =
            `⚠️ Outbound call verification failed\n` +
            `Conversation: \`${conversationId}\`\n` +
            `Reason: ${verification.reason}\n` +
            (verification.firstAgentTurn
              ? `First turn: "${verification.firstAgentTurn.slice(0, 300)}"`
              : "No substantive agent turn");
          try {
            await bot.api.sendMessage(chatId, alert, { parse_mode: "Markdown" });
          } catch (e) {
            logger.warn({ e }, "Failed to send verification failure alert");
          }
        }

        try { unlinkSync(eventFile); } catch { /* best-effort cleanup */ }
      } catch (error) {
        logger.error({ error, conversationId }, "Failed to process call-complete webhook (event persisted for retry)");
      }
    });
  });

  // ---- Twilio: Inbound SMS ----
  server.post("/webhooks/twilio/sms", async (request: FastifyRequest, reply: FastifyReply) => {
    // Parse form body — request.body is a Buffer from our custom parser
    const bodyStr = Buffer.isBuffer(request.body)
      ? request.body.toString()
      : typeof request.body === "string"
        ? request.body
        : "";

    const params: Record<string, string> = {};
    for (const pair of bodyStr.split("&")) {
      const [key, ...valParts] = pair.split("=");
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(valParts.join("="));
      }
    }

    // Validate Twilio signature
    const twilioSignature = request.headers["x-twilio-signature"] as string || "";
    const webhookUrl = `${WEBHOOK_BASE}/webhooks/twilio/sms`;

    if (config.twilio.authToken && !validateTwilioSignature(webhookUrl, params, twilioSignature, config.twilio.authToken)) {
      logger.warn("Twilio SMS webhook: invalid signature");
      reply.status(403).send("Forbidden");
      return;
    }

    logger.info(
      { from: params.From, messageSid: params.MessageSid },
      "Inbound SMS received"
    );

    // Return empty TwiML immediately
    reply.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    // Process in background
    setImmediate(async () => {
      try {
        const { handleInboundSms } = await import("../../telephony/sms-inbound.js");
        await handleInboundSms(
          {
            from: params.From || "",
            body: params.Body || "",
            messageSid: params.MessageSid || "",
            numMedia: parseInt(params.NumMedia || "0", 10),
            mediaUrls: getMediaUrls(params),
          },
          bot,
          chatId
        );
      } catch (error) {
        logger.error({ error, from: params.From }, "Failed to process inbound SMS");
      }
    });
  });
}

function getMediaUrls(params: Record<string, string>): string[] {
  const urls: string[] = [];
  const numMedia = parseInt(params.NumMedia || "0", 10);
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) urls.push(url);
  }
  return urls;
}
