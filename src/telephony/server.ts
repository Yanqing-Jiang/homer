/**
 * Telephony webhook server.
 *
 * Minimal Fastify ingress for ElevenLabs post-call summaries and Twilio inbound
 * SMS. Replaces the old `src/web/api/webhooks.ts` after the web UI was split
 * out of this repo. Only HTTP surface left in Homer-public.
 *
 * Routes:
 *   GET  /health                            — launchd/heartbeat liveness probe
 *   POST /webhooks/elevenlabs/call-complete — ElevenLabs ConvAI post-call (HMAC-SHA256)
 *   POST /webhooks/twilio/sms               — Twilio inbound SMS (HMAC-SHA1)
 *
 * Signature validation:
 *   - ElevenLabs: header `elevenlabs-signature: t=<unix>,v0=<hex>` over `${t}.${rawBody}`
 *     using `ELEVENLABS_WEBHOOK_SECRET`. 300s replay window.
 *   - Twilio:     header `x-twilio-signature` base64 HMAC-SHA1 over
 *     `${WEBHOOK_BASE}/webhooks/twilio/sms` + sorted(key+value) using `TWILIO_AUTH_TOKEN`.
 *
 * Fastify plugins: none (core only). Raw-body capture + urlencoded parser are
 * implemented locally so we don't need `@fastify/multipart` etc.
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { Readable } from "stream";
import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { PATHS } from "../config/paths.js";
import type { StateManager } from "../state/manager.js";
import { WEBHOOK_BASE, HOMER_AGENT_ID } from "./constants.js";

// =============================================================================
// Signature validators (lifted from src/web/api/webhooks.ts)
// =============================================================================

const ELEVENLABS_SIGNATURE_TOLERANCE_SECS = 300;

function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  // Twilio: HMAC-SHA1 of URL + sorted (key, value) concatenation, base64.
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function validateElevenLabsSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  // Header format: "t=<unix_timestamp>,v0=<hex_digest>"
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, ...v] = p.split("=");
      return [k, v.join("=")];
    }),
  );
  const timestamp = parts.t;
  const v0 = parts.v0;
  if (!timestamp || !v0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (isNaN(age) || age > ELEVENLABS_SIGNATURE_TOLERANCE_SECS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString()}`)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v0, "hex"));
  } catch {
    return false;
  }
}

// =============================================================================
// Server construction
// =============================================================================

export interface TelephonyServerOptions {
  stateManager: StateManager;
  bot: Bot | null;
  chatId: number;
}

// Per-request raw body storage for signature validation.
const rawBodyStore = new WeakMap<FastifyRequest, Buffer>();

export async function createTelephonyServer(
  opts: TelephonyServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  const { stateManager, bot, chatId } = opts;

  // Empty-JSON safety (matches old web server behavior).
  server.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const str = (body as string) || "";
      done(null, str.length > 0 ? JSON.parse(str) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // Capture raw body for webhook routes so HMAC validation can re-hash exactly
  // what was on the wire. The hook then re-presents the body as a fresh Readable
  // so Fastify's body parsers still see the original bytes.
  server.addHook("preParsing", async (request, _reply, payload) => {
    if (!request.url.startsWith("/webhooks/")) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);
    rawBodyStore.set(request, rawBody);
    return Readable.from(rawBody);
  });

  // Twilio uses application/x-www-form-urlencoded. Parse as buffer so the
  // route can decode via URLSearchParams (which handles `+` → space correctly,
  // unlike a hand-rolled decodeURIComponent on `&`-split pairs).
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // ---- GET /health ----------------------------------------------------------
  server.get("/health", async () => ({
    status: "healthy",
    service: "homer-telephony",
    time: new Date().toISOString(),
  }));

  // ---- POST /webhooks/elevenlabs/call-complete ------------------------------
  const callEventsDir = join(PATHS.homerData, "call-events");
  if (!existsSync(callEventsDir)) mkdirSync(callEventsDir, { recursive: true });

  server.post(
    "/webhooks/elevenlabs/call-complete",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = config.voice.elevenLabsWebhookSecret;

      // Signature check (skipped if secret unset — useful for local dev, never prod).
      if (secret) {
        const signature = (request.headers["elevenlabs-signature"] as string) || "";
        const rawBody = rawBodyStore.get(request);
        if (!rawBody || !validateElevenLabsSignature(rawBody, signature, secret)) {
          logger.warn("ElevenLabs webhook: invalid signature");
          reply.status(401).send({ error: "Invalid signature" });
          return;
        }
      }

      const payload = request.body as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") {
        logger.warn("ElevenLabs webhook: invalid payload");
        reply.status(400).send({ error: "Invalid payload" });
        return;
      }

      const eventType = typeof payload.type === "string" ? payload.type : "unknown";
      const data =
        typeof payload.data === "object" && payload.data !== null
          ? (payload.data as Record<string, unknown>)
          : undefined;
      const conversationId =
        typeof data?.conversation_id === "string" ? data.conversation_id : undefined;

      // Only transcription events trigger processing. Audio/failure events are 200-noop.
      if (eventType !== "post_call_transcription") {
        logger.info({ eventType, conversationId }, "ElevenLabs webhook: non-transcription event, ignoring");
        reply.status(200).send({ ok: true });
        return;
      }

      if (!conversationId) {
        logger.warn(
          { payload: JSON.stringify(payload).slice(0, 500) },
          "ElevenLabs webhook: no conversation_id",
        );
        reply.status(200).send({ ok: true });
        return;
      }

      // Ignore calls from agents other than Homer's.
      const agentId = typeof data?.agent_id === "string" ? data.agent_id : undefined;
      if (agentId && agentId !== HOMER_AGENT_ID) {
        logger.info(
          { agentId, conversationId },
          "ElevenLabs webhook: ignoring call from non-Homer agent",
        );
        reply.status(200).send({ ok: true });
        return;
      }

      // Persist payload to disk BEFORE 200 — this is the durable handoff
      // so background processing can recover if it crashes.
      const eventFile = join(callEventsDir, `${conversationId}.json`);
      try {
        writeFileSync(eventFile, JSON.stringify(payload), "utf-8");
      } catch (err) {
        logger.error({ error: err, conversationId }, "Failed to persist call event to disk");
        reply.status(500).send({ error: "Storage failure" });
        return;
      }

      logger.info(
        { conversationId, eventType, agentId },
        "ElevenLabs call-complete webhook received and persisted",
      );
      reply.status(200).send({ ok: true });

      const transcript = Array.isArray(data?.transcript)
        ? (data.transcript as Array<{ role: string; message: string; time_in_call_secs?: number }>)
        : [];
      const webhookData = {
        conversation_id: conversationId,
        agent_id: agentId,
        status: typeof data?.status === "string" ? data.status : undefined,
        transcript,
        analysis:
          typeof data?.analysis === "object" && data.analysis !== null
            ? (data.analysis as {
                call_successful?: string;
                transcript_summary?: string;
                call_summary_title?: string;
              })
            : undefined,
        metadata:
          typeof data?.metadata === "object" && data.metadata !== null
            ? (data.metadata as { call_duration_secs?: number; termination_reason?: string })
            : undefined,
      };

      setImmediate(async () => {
        try {
          const { verifyOutboundCall } = await import("./verify-outbound-call.js");
          const verification = verifyOutboundCall(
            {
              conversationId,
              transcript: webhookData.transcript,
              terminationReason: webhookData.metadata?.termination_reason,
              durationSecs: webhookData.metadata?.call_duration_secs,
            },
            stateManager,
          );

          const { processCallComplete } = await import("./call-summary.js");
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

          try {
            unlinkSync(eventFile);
          } catch {
            /* best-effort cleanup */
          }
        } catch (error) {
          logger.error(
            { error, conversationId },
            "Failed to process call-complete webhook (event persisted for retry)",
          );
        }
      });
    },
  );

  // ---- POST /webhooks/twilio/sms --------------------------------------------
  server.post("/webhooks/twilio/sms", async (request: FastifyRequest, reply: FastifyReply) => {
    const bodyStr = Buffer.isBuffer(request.body)
      ? request.body.toString()
      : typeof request.body === "string"
        ? request.body
        : "";

    // URLSearchParams correctly decodes `+` → space (the old hand-rolled parser
    // used decodeURIComponent on `&`-split pairs, which silently mangled spaces).
    const params: Record<string, string> = Object.fromEntries(new URLSearchParams(bodyStr));

    const twilioSignature = (request.headers["x-twilio-signature"] as string) || "";
    const webhookUrl = `${WEBHOOK_BASE}/webhooks/twilio/sms`;

    if (
      config.twilio.authToken &&
      !validateTwilioSignature(webhookUrl, params, twilioSignature, config.twilio.authToken)
    ) {
      logger.warn(
        { from: params.From, webhookUrl },
        "Twilio SMS webhook: invalid signature (check TELEPHONY_PUBLIC_URL matches Twilio console exactly)",
      );
      reply.status(403).send("Forbidden");
      return;
    }

    logger.info({ from: params.From, messageSid: params.MessageSid }, "Inbound SMS received");

    // Return empty TwiML immediately; processing happens in background.
    reply.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    setImmediate(async () => {
      try {
        const { handleInboundSms } = await import("./sms-inbound.js");
        await handleInboundSms(
          {
            from: params.From || "",
            body: params.Body || "",
            messageSid: params.MessageSid || "",
            numMedia: parseInt(params.NumMedia || "0", 10),
            mediaUrls: getMediaUrls(params),
          },
          bot,
          chatId,
        );
      } catch (error) {
        logger.error({ error, from: params.From }, "Failed to process inbound SMS");
      }
    });
  });

  return server;
}

function getMediaUrls(params: Record<string, string>): string[] {
  const urls: string[] = [];
  const n = parseInt(params.NumMedia || "0", 10);
  for (let i = 0; i < n; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Start the telephony server. On EADDRINUSE we exit cleanly (code 0) so launchd
 * doesn't restart-loop when another Homer instance is still holding port 3000.
 */
export async function startTelephonyServer(server: FastifyInstance): Promise<void> {
  const port = config.telephony.port;
  const host = config.telephony.host;
  try {
    await server.listen({ port, host });
    logger.info({ port, host, publicUrl: config.telephony.publicUrl }, "Telephony server started");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      logger.error(
        { port, host },
        `Another Homer instance is already running on port ${port}. Exiting cleanly to prevent duplicate daemons.`,
      );
      process.exit(0);
    }
    logger.error({ error }, "Failed to start telephony server");
    process.exit(1);
  }
}

export async function stopTelephonyServer(server: FastifyInstance): Promise<void> {
  await server.close();
  logger.info("Telephony server stopped");
}
