import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { WEBHOOK_BASE } from "../../telephony/constants.js";
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

function validateElevenLabsSignature(
  rawBody: Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// ============================================
// ROUTE REGISTRATION
// ============================================

export function registerWebhookRoutes(
  server: FastifyInstance,
  _stateManager: StateManager,
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

    // Parse the payload — structure: { type, event_timestamp, data: { conversation_id, transcript, analysis, ... } }
    const payload = request.body as Record<string, unknown>;
    const eventType = payload?.type as string || "unknown";
    const data = payload?.data as Record<string, unknown> | undefined;
    const conversationId = data?.conversation_id as string | undefined;

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

    logger.info({ conversationId, eventType }, "ElevenLabs call-complete webhook received");

    // Return 200 immediately, process async
    reply.status(200).send({ ok: true });

    // Process in background — pass webhook data directly to avoid re-fetching
    const webhookData = data ? {
      conversation_id: conversationId,
      agent_id: data.agent_id as string,
      status: data.status as string,
      transcript: (data.transcript || []) as Array<{ role: string; message: string; time_in_call_secs?: number }>,
      analysis: data.analysis as Record<string, unknown> | undefined,
      metadata: data.metadata as Record<string, unknown> | undefined,
    } : undefined;

    setImmediate(async () => {
      try {
        const { processCallComplete } = await import("../../telephony/call-summary.js");
        await processCallComplete(conversationId, bot, chatId, webhookData as any);
      } catch (error) {
        logger.error({ error, conversationId }, "Failed to process call-complete webhook");
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
